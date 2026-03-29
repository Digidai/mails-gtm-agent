import { Env, Campaign, CampaignContact, IntentType } from '../types'
import { classifyReply } from '../llm/classify'
import { recordEvent } from '../events/record'
import { notifyOwner } from '../notify'

export async function replyCron(env: Env): Promise<void> {
  // Get active campaigns
  const campaigns = await env.DB.prepare(
    "SELECT * FROM campaigns WHERE status = 'active'"
  ).all<Campaign>()

  if (!campaigns.results?.length) return

  for (const campaign of campaigns.results) {
    try {
      await processReplies(env, campaign)
    } catch (err) {
      console.error(`Reply cron error for campaign ${campaign.id}:`, err)
    }
  }
}

async function processReplies(env: Env, campaign: Campaign): Promise<void> {
  const since = campaign.last_inbox_check_at || campaign.created_at
  const apiUrl = env.MAILS_API_URL

  // Fetch inbound emails
  const res = await fetch(`${apiUrl}/api/inbox?direction=inbound&limit=100`, {
    headers: {
      'Authorization': `Bearer ${env.MAILS_API_KEY}`,
    },
  })

  if (!res.ok) {
    console.error(`Failed to fetch inbox: ${res.status}`)
    return
  }

  const data = await res.json() as any
  const allMessages = data.messages || data.emails || []

  const messages = allMessages.filter((msg: any) => {
    const receivedAt = msg.received_at || msg.created_at || ''
    return receivedAt > since
  })

  if (!messages.length) {
    await env.DB.prepare(
      "UPDATE campaigns SET last_inbox_check_at = datetime('now') WHERE id = ?"
    ).bind(campaign.id).run()
    return
  }

  for (const msg of messages) {
    const fromEmail = extractEmail(msg.from || msg.from_address || '')
    if (!fromEmail) continue

    // Find matching contact — support both v1 and v2 statuses
    const contact = await env.DB.prepare(`
      SELECT * FROM campaign_contacts
      WHERE campaign_id = ? AND email = ? AND status IN ('sent', 'replied', 'active', 'interested', 'pending')
    `).bind(campaign.id, fromEmail.toLowerCase()).first<CampaignContact>()

    if (!contact) continue

    // Classify the reply
    const replyText = msg.text || msg.body || msg.snippet || ''
    const classification = await classifyReply(env, replyText)

    const effectiveIntent = classification.confidence < 0.7 ? 'unclear' as IntentType : classification.intent

    // Record reply event (v2)
    await recordEvent(env, campaign.id, contact.id, 'reply', {
      intent: effectiveIntent,
      confidence: classification.confidence,
      resume_date: classification.resume_date,
      snippet: replyText.slice(0, 200),
    })

    // Execute action based on intent
    await handleIntent(env, campaign, contact, effectiveIntent, classification.confidence, classification.resume_date, replyText)
  }

  // Update last check time
  await env.DB.prepare(
    "UPDATE campaigns SET last_inbox_check_at = datetime('now') WHERE id = ?"
  ).bind(campaign.id).run()
}

async function handleIntent(
  env: Env,
  campaign: Campaign,
  contact: CampaignContact,
  intent: IntentType,
  confidence: number,
  resumeDate: string | null,
  replyText: string,
): Promise<void> {
  const now = new Date().toISOString()
  const isAgentEngine = campaign.engine === 'agent'

  switch (intent) {
    case 'interested':
      if (isAgentEngine) {
        // v2: set status to interested, clear next_check_at so agent re-evaluates soon
        await env.DB.prepare(`
          UPDATE campaign_contacts
          SET status = 'interested', reply_intent = ?, reply_confidence = ?, next_check_at = NULL, updated_at = ?
          WHERE id = ?
        `).bind(intent, confidence, now, contact.id).run()

        // Send notification
        await notifyOwner(env, campaign, 'interested_reply', {
          contactEmail: contact.email,
          contactName: contact.name,
          replyText,
        })
      } else {
        // v1
        await env.DB.prepare(`
          UPDATE campaign_contacts
          SET status = 'interested', reply_intent = ?, reply_confidence = ?, updated_at = ?
          WHERE id = ?
        `).bind(intent, confidence, now, contact.id).run()
      }
      break

    case 'not_now': {
      const resume = resumeDate || new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10)
      await env.DB.prepare(`
        UPDATE campaign_contacts
        SET status = 'not_now', reply_intent = ?, reply_confidence = ?, resume_at = ?, updated_at = ?
        WHERE id = ?
      `).bind(intent, confidence, resume, now, contact.id).run()
      break
    }

    case 'not_interested':
      if (isAgentEngine) {
        await env.DB.prepare(`
          UPDATE campaign_contacts
          SET status = 'stopped', reply_intent = ?, reply_confidence = ?, updated_at = ?
          WHERE id = ?
        `).bind(intent, confidence, now, contact.id).run()
      } else {
        await env.DB.prepare(`
          UPDATE campaign_contacts
          SET status = 'not_interested', reply_intent = ?, reply_confidence = ?, updated_at = ?
          WHERE id = ?
        `).bind(intent, confidence, now, contact.id).run()
      }
      break

    case 'wrong_person':
      await env.DB.prepare(`
        UPDATE campaign_contacts
        SET status = 'wrong_person', reply_intent = ?, reply_confidence = ?, updated_at = ?
        WHERE id = ?
      `).bind(intent, confidence, now, contact.id).run()
      break

    case 'unsubscribe':
    case 'do_not_contact':
      await env.DB.prepare(`
        UPDATE campaign_contacts
        SET status = ${isAgentEngine ? "'unsubscribed'" : "'do_not_contact'"}, reply_intent = ?, reply_confidence = ?, updated_at = ?
        WHERE id = ?
      `).bind(intent, confidence, now, contact.id).run()
      await env.DB.prepare(`
        INSERT INTO unsubscribes (id, email, campaign_id, reason)
        VALUES (?, ?, ?, ?)
        ON CONFLICT(email, campaign_id) DO NOTHING
      `).bind(
        crypto.randomUUID().replace(/-/g, ''),
        contact.email,
        campaign.id,
        `Reply classified as: ${intent}`,
      ).run()
      break

    case 'out_of_office':
    case 'auto_reply':
      await env.DB.prepare(`
        UPDATE campaign_contacts
        SET reply_intent = ?, reply_confidence = ?, updated_at = ?
        WHERE id = ?
      `).bind(intent, confidence, now, contact.id).run()
      break

    case 'unclear':
    default:
      if (isAgentEngine) {
        // v2: set to active so agent can decide
        await env.DB.prepare(`
          UPDATE campaign_contacts
          SET status = 'active', reply_intent = ?, reply_confidence = ?, next_check_at = NULL, updated_at = ?
          WHERE id = ?
        `).bind(intent, confidence, now, contact.id).run()
      } else {
        await env.DB.prepare(`
          UPDATE campaign_contacts
          SET status = 'replied', reply_intent = ?, reply_confidence = ?, updated_at = ?
          WHERE id = ?
        `).bind(intent, confidence, now, contact.id).run()
      }
      break
  }
}

function extractEmail(str: string): string | null {
  const match = str.match(/([^\s<>]+@[^\s<>]+\.[^\s<>]+)/)
  return match ? match[1].toLowerCase() : null
}
