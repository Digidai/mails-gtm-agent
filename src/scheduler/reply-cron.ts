import { Env, Campaign, CampaignContact, IntentType, KnowledgeBase } from '../types'
import { classifyReply } from '../llm/classify'
import { generateReply } from '../llm/reply'
import { recordEvent } from '../events/record'
import { notifyOwner } from '../notify'
import { mailsFetch } from '../mails-api'
import { recordContactMessage, recordAgentMessage, getConversationHistory } from '../conversations/context'
import { generateUnsubscribeToken, generateUnsubscribeUrl } from '../compliance/unsubscribe'
import { generateListUnsubscribeHeaders, generateComplianceFooter } from '../compliance/headers'
import { TERMINAL_STATUSES } from '../queue/send-consumer'

/**
 * Reply cron — runs globally once (not per-campaign).
 * Fetches all inbound emails since the last check, then matches each
 * reply to the correct campaign_contact(s) by from_address.
 *
 * v2.1: After classifying intent, generates contextual auto-replies
 * using conversation history and knowledge base.
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

  // P1-4: Track the timestamp of the last successfully processed message
  // instead of blindly advancing to now()
  let lastSuccessfulReceivedAt: string | null = null

  for (const msg of messages) {
    const msgReceivedAt = msg.received_at || msg.created_at || ''

    const fromEmail = extractEmail(msg.from || msg.from_address || '')
    if (!fromEmail) {
      // No valid sender — still count as processed (not an error)
      if (msgReceivedAt && (!lastSuccessfulReceivedAt || msgReceivedAt > lastSuccessfulReceivedAt)) {
        lastSuccessfulReceivedAt = msgReceivedAt
      }
      continue
    }

    // Dedup: skip if this exact email (by msg.id) was already processed
    if (msg.id) {
      const alreadyProcessed = await env.DB.prepare(
        "SELECT id FROM events WHERE event_data LIKE ? LIMIT 1"
      ).bind(`%"msg_id":"${msg.id}"%`).first()
      if (alreadyProcessed) {
        if (msgReceivedAt && (!lastSuccessfulReceivedAt || msgReceivedAt > lastSuccessfulReceivedAt)) {
          lastSuccessfulReceivedAt = msgReceivedAt
        }
        continue
      }
    }

    // Only match contacts in non-terminal, non-already-classified states.
    // v2.1: Also match 'interested' contacts for conversational follow-up
    const contacts = await env.DB.prepare(`
      SELECT cc.*, c.engine, c.id as _campaign_id, c.name as _campaign_name,
             c.knowledge_base as _kb, c.conversion_url as _conversion_url,
             c.product_url as _product_url, c.product_name as _product_name,
             c.max_auto_replies as _max_auto_replies, c.from_email as _from_email,
             c.physical_address as _physical_address, c.product_description as _product_description,
             c.dry_run as _dry_run
      FROM campaign_contacts cc
      JOIN campaigns c ON c.id = cc.campaign_id
      WHERE cc.email = ? AND c.status = 'active'
        AND cc.status IN ('sent', 'replied', 'active', 'interested', 'not_now', 'wrong_person')
        AND cc.last_sent_at IS NOT NULL
      ORDER BY cc.last_sent_at DESC
      LIMIT 1
    `).bind(fromEmail.toLowerCase()).all<CampaignContact & {
      engine: string
      _campaign_id: string
      _campaign_name: string
      _kb: string
      _conversion_url: string | null
      _product_url: string | null
      _product_name: string
      _max_auto_replies: number
      _from_email: string
      _physical_address: string
      _product_description: string
      _dry_run: number
    }>()

    if (!contacts.results?.length) {
      // No matching contacts — still count as processed
      if (msgReceivedAt && (!lastSuccessfulReceivedAt || msgReceivedAt > lastSuccessfulReceivedAt)) {
        lastSuccessfulReceivedAt = msgReceivedAt
      }
      continue
    }

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
      // Still count as processed (not a failure)
      if (msgReceivedAt && (!lastSuccessfulReceivedAt || msgReceivedAt > lastSuccessfulReceivedAt)) {
        lastSuccessfulReceivedAt = msgReceivedAt
      }
      continue
    }

    // Classify the reply once
    const classification = await classifyReply(env, replyText)
    const effectiveIntent = classification.confidence < 0.7 ? 'unclear' as IntentType : classification.intent

    let msgProcessedOk = true

    // Process for the matched contact
    for (const contact of contacts.results) {
      try {
        const campaign = {
          id: contact._campaign_id,
          name: contact._campaign_name,
          engine: contact.engine,
          product_name: contact._product_name,
          product_description: contact._product_description,
          from_email: contact._from_email,
          physical_address: contact._physical_address,
          conversion_url: contact._conversion_url,
          product_url: contact._product_url,
          knowledge_base: contact._kb,
          max_auto_replies: contact._max_auto_replies ?? 5,
          dry_run: contact._dry_run ?? 0,
        } as Campaign

        // Record reply event (include msg_id for dedup)
        await recordEvent(env, campaign.id, contact.id, 'reply', {
          msg_id: msg.id || null,
          intent: effectiveIntent,
          confidence: classification.confidence,
          resume_date: classification.resume_date,
          snippet: replyText.slice(0, 200),
        })

        // v2.1: Record contact message to conversations table
        await recordContactMessage(env, campaign.id, contact.id, replyText, msg.id || null)

        // Execute action based on intent
        await handleIntent(env, campaign, contact, effectiveIntent, classification.confidence, classification.resume_date, replyText, msg)
      } catch (err) {
        console.error(`Reply processing error for contact ${contact.id}:`, err)
        msgProcessedOk = false
      }
    }

    // P1-4: Only advance cursor for successfully processed messages
    if (msgProcessedOk && msgReceivedAt && (!lastSuccessfulReceivedAt || msgReceivedAt > lastSuccessfulReceivedAt)) {
      lastSuccessfulReceivedAt = msgReceivedAt
    }
  }

  // P1-4: Only advance cursor to the last successfully processed message's timestamp
  if (lastSuccessfulReceivedAt) {
    await env.DB.prepare(
      "UPDATE campaigns SET last_inbox_check_at = ? WHERE status = 'active'"
    ).bind(lastSuccessfulReceivedAt).run()
  }
}

/**
 * Determine whether the agent should auto-reply to this contact.
 */
export function canAutoReply(
  contact: CampaignContact,
  campaign: Campaign,
  intent: IntentType,
): boolean {
  // Terminal statuses — do not reply
  if (TERMINAL_STATUSES.includes(contact.status as typeof TERMINAL_STATUSES[number])) return false

  // Exceeded auto-reply limit
  const maxReplies = campaign.max_auto_replies ?? 5
  if ((contact.auto_reply_count ?? 0) >= maxReplies) return false

  // Unsubscribe / do_not_contact — never auto-reply
  if (['unsubscribe', 'do_not_contact'].includes(intent)) return false

  // Auto-reply / out_of_office — do not reply to automated messages
  if (['auto_reply', 'out_of_office'].includes(intent)) return false

  // Unclear intent with low confidence — don't reply
  if (intent === 'unclear') return false

  // Remaining intents can be replied to: interested, not_now, not_interested, wrong_person
  return true
}

async function handleIntent(
  env: Env,
  campaign: Campaign,
  contact: CampaignContact,
  intent: IntentType,
  confidence: number,
  resumeDate: string | null,
  replyText: string,
  originalMsg: any,
): Promise<void> {
  const now = new Date().toISOString()
  const isAgentEngine = campaign.engine === 'agent'

  // v2.1: Check if we should auto-reply (only for agent engine)
  const shouldReply = isAgentEngine && canAutoReply(contact, campaign, intent)

  // First: update contact status based on intent (v1 + v2 shared logic)
  switch (intent) {
    case 'interested':
      if (isAgentEngine) {
        await env.DB.prepare(`
          UPDATE campaign_contacts
          SET status = 'interested', reply_intent = ?, reply_confidence = ?, next_check_at = NULL, updated_at = ?
          WHERE id = ?
        `).bind(intent, confidence, now, contact.id).run()
      } else {
        await env.DB.prepare(`
          UPDATE campaign_contacts
          SET status = 'interested', reply_intent = ?, reply_confidence = ?, updated_at = ?
          WHERE id = ?
        `).bind(intent, confidence, now, contact.id).run()
      }

      // Send notification (v1 + v2 both notify on interested reply)
      if (!shouldReply) {
        await notifyOwner(env, campaign, 'interested_reply', {
          contactEmail: contact.email,
          contactName: contact.name,
          replyText,
        })
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

  // v2.1: Generate and send auto-reply for agent engine
  if (shouldReply) {
    try {
      await processAutoReply(env, campaign, contact, replyText, intent, originalMsg)
    } catch (err) {
      console.error(`[reply-cron] Auto-reply failed for contact ${contact.id}:`, err)
    }
  }
}

/**
 * v2.1: Generate a contextual reply and send it.
 */
async function processAutoReply(
  env: Env,
  campaign: Campaign,
  contact: CampaignContact,
  replyText: string,
  intent: IntentType,
  originalMsg: any,
): Promise<void> {
  // Get conversation history
  const history = await getConversationHistory(env, contact.id)

  // Parse knowledge base
  let kb: KnowledgeBase = {}
  try {
    kb = JSON.parse(campaign.knowledge_base || '{}')
  } catch {
    console.warn(`[reply-cron] Failed to parse knowledge_base for campaign ${campaign.id}`)
  }

  // Generate reply
  const result = await generateReply(env, campaign, contact, replyText, history, intent, kb)

  if (result.should_stop) {
    // Contact wants to stop or talk to a human
    await sendFinalMessage(env, campaign, contact, originalMsg)
    await notifyOwner(env, campaign, 'conversation_stopped', {
      contactEmail: contact.email,
      contactName: contact.name,
      reason: 'Contact requested to stop or talk to a human',
    })
    return
  }

  // For not_interested intent: send a polite final reply and stop
  if (intent === 'not_interested') {
    await sendFinalMessage(env, campaign, contact, originalMsg)
    return
  }

  // Send the generated reply
  await sendAutoReply(env, campaign, contact, result.reply, originalMsg)

  // Record agent reply to conversations
  await recordAgentMessage(
    env,
    campaign.id,
    contact.id,
    result.reply,
    `Re: ${originalMsg.subject || 'Follow up'}`,
    null, // message_id filled after send — best effort
  )

  // Increment auto_reply_count
  await incrementAutoReplyCount(env, contact.id)

  // Check if we've now hit the limit
  const newCount = (contact.auto_reply_count ?? 0) + 1
  const maxReplies = campaign.max_auto_replies ?? 5
  if (newCount >= maxReplies) {
    await notifyOwner(env, campaign, 'conversation_stopped', {
      contactEmail: contact.email,
      contactName: contact.name,
      reason: `Auto-reply limit reached (${maxReplies} replies)`,
    })
  }

  // Notify owner about interested replies (after sending auto-reply)
  if (intent === 'interested') {
    await notifyOwner(env, campaign, 'interested_reply', {
      contactEmail: contact.email,
      contactName: contact.name,
      replyText,
    })
  }

  // Knowledge gap notification
  if (result.knowledge_gap) {
    await notifyOwner(env, campaign, 'knowledge_gap', {
      contactEmail: contact.email,
      contactName: contact.name,
      gap: result.knowledge_gap,
    })
  }
}

/**
 * Send an auto-reply with threading headers and compliance.
 */
async function sendAutoReply(
  env: Env,
  campaign: Campaign,
  contact: CampaignContact,
  replyBody: string,
  originalMsg: any,
): Promise<void> {
  // Build threading headers
  const headers: Record<string, string> = {}
  if (originalMsg.id) {
    try {
      const emailRes = await mailsFetch(env, `/v1/email?id=${originalMsg.id}`)
      if (emailRes.ok) {
        const emailData = await emailRes.json() as any
        const msgId = emailData.message_id || emailData.headers?.['message-id']
        if (msgId) {
          headers['In-Reply-To'] = msgId
          headers['References'] = msgId
        }
      }
    } catch (err) {
      console.error(`[reply-cron] Failed to fetch original email for threading:`, err)
    }
  }

  // Generate compliance elements
  const unsubToken = await generateUnsubscribeToken(contact.email, campaign.id, env.UNSUBSCRIBE_SECRET)
  const unsubUrl = generateUnsubscribeUrl(env.UNSUBSCRIBE_BASE_URL, unsubToken)
  const unsubHeaders = generateListUnsubscribeHeaders(unsubUrl)
  Object.assign(headers, unsubHeaders)

  // Add compliance footer
  const fullBody = replyBody + generateComplianceFooter(campaign.physical_address, unsubUrl)

  // Send via mails-agent API
  const sendRes = await mailsFetch(env, '/v1/send', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      from: campaign.from_email || env.MAILS_MAILBOX,
      to: [contact.email],
      subject: `Re: ${originalMsg.subject || 'Follow up'}`,
      text: fullBody,
      headers,
    }),
  })

  if (!sendRes.ok) {
    const errText = await sendRes.text().catch(() => '')
    console.error(`[reply-cron] Auto-reply send failed for ${contact.email}: ${sendRes.status} ${errText.slice(0, 200)}`)
    throw new Error(`Auto-reply send failed: ${sendRes.status}`)
  }

  console.log(`[reply-cron] Auto-reply sent to ${contact.email}`)
}

/**
 * Send a final "goodbye" message and mark the contact as stopped.
 */
async function sendFinalMessage(
  env: Env,
  campaign: Campaign,
  contact: CampaignContact,
  originalMsg: any,
): Promise<void> {
  const finalMsg = 'Thank you for your time. Feel free to reach out if you need anything in the future.'

  try {
    await sendAutoReply(env, campaign, contact, finalMsg, originalMsg)
  } catch (err) {
    console.error(`[reply-cron] Failed to send final message to ${contact.email}:`, err)
  }

  // Record final message to conversations
  await recordAgentMessage(
    env,
    campaign.id,
    contact.id,
    finalMsg,
    `Re: ${originalMsg.subject || 'Follow up'}`,
    null,
  )

  // Mark contact as stopped
  await env.DB.prepare(
    "UPDATE campaign_contacts SET status = 'stopped', auto_reply_count = auto_reply_count + 1, updated_at = datetime('now') WHERE id = ?"
  ).bind(contact.id).run()
}

/**
 * Increment the auto_reply_count for a contact.
 */
async function incrementAutoReplyCount(env: Env, contactId: string): Promise<void> {
  await env.DB.prepare(
    "UPDATE campaign_contacts SET auto_reply_count = auto_reply_count + 1, updated_at = datetime('now') WHERE id = ?"
  ).bind(contactId).run()
}

function extractEmail(str: string): string | null {
  const match = str.match(/([^\s<>]+@[^\s<>]+\.[^\s<>]+)/)
  return match ? match[1].toLowerCase() : null
}
