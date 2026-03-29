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
import { TERMINAL_STATUSES } from './send-consumer'

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

/**
 * Check if today's global send count has reached the DAILY_SEND_LIMIT.
 */
async function isGlobalSendLimitReached(env: Env): Promise<boolean> {
  const limit = parseInt(env.DAILY_SEND_LIMIT || '100', 10)
  const today = new Date().toISOString().slice(0, 10)
  const row = await env.DB.prepare(
    "SELECT COALESCE(SUM(sent_count), 0) as total FROM daily_stats WHERE date = ?",
  ).bind(today).first<{ total: number }>()

  const totalSent = row?.total ?? 0
  return totalSent >= limit
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
  if (TERMINAL_STATUSES.includes(contact.status as typeof TERMINAL_STATUSES[number])) return

  // 4. Fetch recent events (last 20, chronological) for this campaign
  const eventsResult = await env.DB.prepare(
    'SELECT * FROM events WHERE campaign_id = ? AND contact_id = ? ORDER BY created_at DESC LIMIT 20',
  ).bind(campaign_id, contact_id).all<Event>()

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

  // 7. Increment daily LLM calls only when LLM was actually called
  if (decision.llm_called) {
    await env.DB.prepare(
      'UPDATE campaigns SET daily_llm_calls = daily_llm_calls + 1 WHERE id = ?',
    ).bind(campaign_id).run()
  }

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

  // 9. Re-check contact status to avoid race with reply-cron
  //    (reply-cron may have changed status to unsubscribed/interested/stopped while we were deciding)
  const freshContact = await env.DB.prepare(
    'SELECT status FROM campaign_contacts WHERE id = ?',
  ).bind(contact_id).first<{ status: string }>()

  if (freshContact) {
    if (TERMINAL_STATUSES.includes(freshContact.status as typeof TERMINAL_STATUSES[number])) {
      console.log(`Contact ${contact_id} status changed to '${freshContact.status}' during evaluation, aborting action`)
      return
    }
  }

  // 10. Act on decision
  switch (decision.action) {
    case 'send': {
      if (!decision.email) break

      // 10a. Check global daily send limit before sending
      if (await isGlobalSendLimitReached(env)) {
        console.log(`Global daily send limit reached, deferring send for contact ${contact_id}`)
        // Treat as wait — re-evaluate tomorrow
        const nextCheck = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString()
        await env.DB.prepare(
          "UPDATE campaign_contacts SET status = 'active', next_check_at = ?, updated_at = datetime('now') WHERE id = ?",
        ).bind(nextCheck, contact_id).run()
        break
      }

      // Content safety: reject emails containing HTML (should be plain text) or suspicious patterns
      const emailText = `${decision.email.subject} ${decision.email.body}`
      if (/<script|<iframe|<object|<embed/i.test(emailText)) {
        console.error(`Content safety: LLM generated HTML/script content for contact ${contact_id}, blocking send`)
        await recordEvent(env, campaign_id, contact_id, 'content_blocked', {
          reason: 'HTML/script content detected in LLM output',
          subject: decision.email.subject,
        })
        break
      }

      // Validate that the LLM didn't embed a different email address in the subject/body as a redirect target
      // (defense against prompt injection trying to exfiltrate data)
      const emailAddressPattern = /[\w.-]+@[\w.-]+\.\w+/g
      const foundEmails = emailText.match(emailAddressPattern) || []
      const allowedEmails = new Set([
        contact.email.toLowerCase(),
        (campaign.from_email || '').toLowerCase(),
      ].filter(Boolean))
      const suspiciousEmails = foundEmails.filter(e => !allowedEmails.has(e.toLowerCase()))
      if (suspiciousEmails.length > 0) {
        console.warn(`Content check: LLM output contains unexpected email addresses: ${suspiciousEmails.join(', ')} (contact: ${contact_id})`)
        // Log but don't block -- could be legitimate mentions of team members, etc.
        await recordEvent(env, campaign_id, contact_id, 'content_warning', {
          reason: 'Unexpected email addresses in LLM output',
          found: suspiciousEmails,
        })
      }

      let emailBody = decision.email.body

      // Only create tracked links for non-dry-run campaigns.
      // Dry-run tracked links would be reachable via /t/:id, leaking tracking URLs.
      if (!campaign.dry_run) {
        const baseUrl = env.UNSUBSCRIBE_BASE_URL || 'https://mails-gtm-agent.workers.dev'
        const { body: trackedBody } = await replaceLinksWithTracking(
          decision.email.body,
          contact_id,
          campaign_id,
          baseUrl,
          env,
        )
        emailBody = trackedBody
      }

      // Fix 7: Update contact status FIRST, then enqueue.
      // If DB update fails, we don't enqueue (preventing duplicate evaluation).
      // If enqueue fails after DB update, the contact is in 'active' status with
      // a stale next_check_at, so the next cron cycle will re-enqueue it.
      await env.DB.prepare(
        "UPDATE campaign_contacts SET status = 'active', next_check_at = NULL, updated_at = datetime('now') WHERE id = ?",
      ).bind(contact_id).run()

      // Enqueue to send queue
      const sendMessage: AgentSendMessage = {
        type: 'agent_send',
        campaign_id,
        contact_id,
        mailbox: campaign.from_email || env.MAILS_MAILBOX,
        to: contact.email,
        subject: decision.email.subject,
        body: emailBody,
        angle: decision.email.angle,
        decision_id: decisionId,
      }

      await env.SEND_QUEUE.send(sendMessage)
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
