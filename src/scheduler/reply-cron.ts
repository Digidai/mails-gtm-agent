import { Env, Campaign, CampaignContact, IntentType } from '../types'
import { classifyReply } from '../llm/classify'
import { recordEvent } from '../events/record'
import { notifyOwner } from '../notify'
import { mailsFetch } from '../mails-api'

/**
 * Reply cron — runs globally once (not per-campaign).
 * Fetches all inbound emails since the last check, then matches each
 * reply to the correct campaign_contact(s) by from_address.
 */
export async function replyCron(env: Env): Promise<void> {
  console.log(`[reply-cron] Starting reply check... binding=${!!env.MAILS_WORKER}`)
  try {
    await _replyCron(env)
    console.log('[reply-cron] Completed successfully')
  } catch (err) {
    console.error('[reply-cron] Fatal error:', err)
  }
}

async function _replyCron(env: Env): Promise<void> {
  // Use a global KV-style marker stored in an arbitrary active campaign,
  // or fall back to the most recent last_inbox_check_at across all campaigns.
  const sinceRow = await env.DB.prepare(
    "SELECT MAX(last_inbox_check_at) as last_check FROM campaigns WHERE status = 'active'"
  ).first<{ last_check: string | null }>()

  const since = sinceRow?.last_check || new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString()

  // Fetch inbound emails once for all campaigns
  const res = await mailsFetch(env, '/v1/inbox?direction=inbound&limit=100')

  if (!res.ok) {
    const errBody = await res.text().catch(() => '')
    console.error(`[reply-cron] Failed to fetch inbox: ${res.status} Body=${errBody.slice(0,200)}`)
    return
  }

  const data = await res.json() as any
  const allMessages = data.messages || data.emails || []

  const messages = allMessages.filter((msg: any) => {
    const receivedAt = msg.received_at || msg.created_at || ''
    return receivedAt > since
  })

  if (!messages.length) {
    // Update all active campaigns' last_inbox_check_at
    await env.DB.prepare(
      "UPDATE campaigns SET last_inbox_check_at = datetime('now') WHERE status = 'active'"
    ).run()
    return
  }

  for (const msg of messages) {
    const fromEmail = extractEmail(msg.from || msg.from_address || '')
    if (!fromEmail) continue

    // Find ALL matching contacts across ALL active campaigns
    const contacts = await env.DB.prepare(`
      SELECT cc.*, c.engine, c.id as _campaign_id, c.name as _campaign_name
      FROM campaign_contacts cc
      JOIN campaigns c ON c.id = cc.campaign_id
      WHERE cc.email = ? AND c.status = 'active'
        AND cc.status IN ('sent', 'replied', 'active', 'interested', 'pending')
    `).bind(fromEmail.toLowerCase()).all<CampaignContact & { engine: string; _campaign_id: string; _campaign_name: string }>()

    if (!contacts.results?.length) continue

    // Fetch full email body (inbox list doesn't include body_text)
    let replyText = msg.text || msg.body_text || msg.body || msg.snippet || ''
    if (!replyText && msg.id) {
      try {
        const emailRes = await mailsFetch(env, `/v1/email?id=${msg.id}`)
        if (emailRes.ok) {
          const emailData = await emailRes.json() as any
          replyText = emailData.body_text || emailData.body || ''
        }
      } catch (err) {
        console.error(`Failed to fetch email body for ${msg.id}:`, err)
      }
    }

    if (!replyText.trim()) {
      console.warn(`Empty reply body from ${fromEmail}, skipping classification`)
      continue
    }

    // Classify the reply once (shared across campaigns)
    const classification = await classifyReply(env, replyText)
    const effectiveIntent = classification.confidence < 0.7 ? 'unclear' as IntentType : classification.intent

    // Process for each matching contact
    for (const contact of contacts.results) {
      try {
        const campaign = {
          id: contact._campaign_id,
          name: contact._campaign_name,
          engine: contact.engine,
        } as Campaign

        // Record reply event
        await recordEvent(env, campaign.id, contact.id, 'reply', {
          intent: effectiveIntent,
          confidence: classification.confidence,
          resume_date: classification.resume_date,
          snippet: replyText.slice(0, 200),
        })

        // Execute action based on intent
        await handleIntent(env, campaign, contact, effectiveIntent, classification.confidence, classification.resume_date, replyText)
      } catch (err) {
        console.error(`Reply processing error for contact ${contact.id}:`, err)
      }
    }
  }

  // Update all active campaigns' last_inbox_check_at
  await env.DB.prepare(
    "UPDATE campaigns SET last_inbox_check_at = datetime('now') WHERE status = 'active'"
  ).run()
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

      // Campaign-specific unsubscribe record
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

      // Global unsubscribe record — blocks all campaigns
      await env.DB.prepare(`
        INSERT INTO unsubscribes (id, email, campaign_id, reason)
        VALUES (?, ?, '__global__', ?)
        ON CONFLICT(email, campaign_id) DO NOTHING
      `).bind(
        crypto.randomUUID().replace(/-/g, ''),
        contact.email,
        `Reply classified as: ${intent}`,
      ).run()

      // Mark as unsubscribed across ALL campaigns
      await env.DB.prepare(`
        UPDATE campaign_contacts
        SET status = 'unsubscribed', updated_at = ?
        WHERE email = ? AND status NOT IN ('unsubscribed', 'do_not_contact')
      `).bind(now, contact.email).run()
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
