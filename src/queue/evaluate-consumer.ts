import {
  Env,
  EvaluateMessage,
  AgentSendMessage,
  Campaign,
  CampaignContact,
  Event,
  KnowledgeBase,
} from '../types'
import { makeDecision } from '../agent/decide'
import { replaceLinksWithTracking } from '../tracking/links'
import { recordEvent } from '../events/record'

/**
 * Evaluate-consumer: processes evaluate-queue messages.
 * For each contact, collects context, calls the Agent decision engine,
 * and acts on the decision (send/wait/stop).
 */
export async function evaluateConsumer(
  batch: MessageBatch<EvaluateMessage>,
  env: Env,
): Promise<void> {
  for (const msg of batch.messages) {
    try {
      await processEvaluateMessage(msg.body, env)
      msg.ack()
    } catch (err) {
      console.error('Evaluate consumer error:', err)
      msg.retry()
    }
  }
}

async function processEvaluateMessage(
  message: EvaluateMessage,
  env: Env,
): Promise<void> {
  const { campaign_id, contact_id } = message

  // 1. Fetch campaign
  const campaign = await env.DB.prepare(
    'SELECT * FROM campaigns WHERE id = ?',
  ).bind(campaign_id).first<Campaign>()

  if (!campaign || campaign.status !== 'active') return

  // 2. Check daily LLM limit
  if (campaign.daily_llm_calls >= campaign.daily_llm_limit) {
    console.log(`Campaign ${campaign_id}: daily LLM limit reached, skipping contact ${contact_id}`)
    return
  }

  // 3. Fetch contact
  const contact = await env.DB.prepare(
    'SELECT * FROM campaign_contacts WHERE id = ?',
  ).bind(contact_id).first<CampaignContact>()

  if (!contact) return

  // Skip terminal statuses
  const terminalStatuses = ['converted', 'stopped', 'unsubscribed', 'bounced', 'do_not_contact']
  if (terminalStatuses.includes(contact.status)) return

  // 4. Fetch recent events (last 20, chronological)
  const eventsResult = await env.DB.prepare(
    'SELECT * FROM events WHERE contact_id = ? ORDER BY created_at DESC LIMIT 20',
  ).bind(contact_id).all<Event>()

  const events = (eventsResult.results || []).reverse() // chronological order

  // 5. Parse knowledge base
  let knowledgeBase: KnowledgeBase = {}
  try {
    knowledgeBase = JSON.parse(campaign.knowledge_base || '{}')
  } catch {
    // Fallback to product_name + description
    knowledgeBase = {
      product_name: campaign.product_name,
      description: campaign.product_description,
    }
  }

  // Ensure conversion_url is in knowledge base
  if (campaign.conversion_url) {
    knowledgeBase.conversion_url = campaign.conversion_url
  }

  // 6. Call Agent decision engine
  const decision = await makeDecision(env, campaign, contact, events, knowledgeBase)

  // 7. Increment daily LLM calls
  await env.DB.prepare(
    'UPDATE campaigns SET daily_llm_calls = daily_llm_calls + 1 WHERE id = ?',
  ).bind(campaign_id).run()

  // 8. Record decision log
  const decisionId = crypto.randomUUID().replace(/-/g, '')
  const now = new Date().toISOString()
  await env.DB.prepare(
    'INSERT INTO decision_log (id, campaign_id, contact_id, action, reasoning, email_angle, email_subject, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
  ).bind(
    decisionId,
    campaign_id,
    contact_id,
    decision.action,
    decision.reasoning,
    decision.email?.angle || null,
    decision.email?.subject || null,
    now,
  ).run()

  // 9. Act on decision
  switch (decision.action) {
    case 'send': {
      if (!decision.email) break

      // Replace links with tracking links
      const baseUrl = env.UNSUBSCRIBE_BASE_URL || 'https://mails-gtm-agent.workers.dev'
      const { body: trackedBody } = await replaceLinksWithTracking(
        decision.email.body,
        contact_id,
        campaign_id,
        baseUrl,
        env,
      )

      // Enqueue to send queue
      const sendMessage: AgentSendMessage = {
        type: 'agent_send',
        campaign_id,
        contact_id,
        mailbox: campaign.from_email || env.MAILS_MAILBOX,
        to: contact.email,
        subject: decision.email.subject,
        body: trackedBody,
        angle: decision.email.angle,
        decision_id: decisionId,
      }

      await env.SEND_QUEUE.send(sendMessage)

      // Update contact status
      await env.DB.prepare(
        "UPDATE campaign_contacts SET status = 'active', updated_at = datetime('now') WHERE id = ?",
      ).bind(contact_id).run()
      break
    }

    case 'wait': {
      const waitDays = decision.wait_days || 3
      const nextCheck = new Date(Date.now() + waitDays * 24 * 60 * 60 * 1000).toISOString()
      await env.DB.prepare(
        "UPDATE campaign_contacts SET status = 'active', next_check_at = ?, updated_at = datetime('now') WHERE id = ?",
      ).bind(nextCheck, contact_id).run()
      break
    }

    case 'stop': {
      await env.DB.prepare(
        "UPDATE campaign_contacts SET status = 'stopped', updated_at = datetime('now') WHERE id = ?",
      ).bind(contact_id).run()
      break
    }
  }
}
