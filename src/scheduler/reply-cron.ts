import { Env, Campaign, CampaignContact, IntentType, KnowledgeBase } from '../types'
import { classifyReply } from '../llm/classify'
import { generateReply } from '../llm/reply'
import { reviewEmail, buildSafeEmail } from '../llm/review'
import { recordEvent } from '../events/record'
import { notifyOwner } from '../notify'
import { mailsFetch } from '../mails-api'
import { recordContactMessage, recordAgentMessage, getConversationHistory } from '../conversations/context'
import { generateUnsubscribeToken, generateUnsubscribeUrl } from '../compliance/unsubscribe'
import { generateListUnsubscribeHeaders, generateComplianceFooter, generateComplianceFooterHtml } from '../compliance/headers'
import { replaceLinksWithTrackingDual } from '../tracking/links'
import { TERMINAL_STATUSES } from '../queue/send-consumer'

/**
 * Auto-responder header patterns — more reliable than LLM classification
 * for detecting automated messages.
 */
const AUTO_RESPONDER_HEADERS: Record<string, (v: string) => boolean> = {
  'auto-submitted': (v) => v.toLowerCase() !== 'no',
  'precedence': (v) => ['bulk', 'junk', 'list', 'auto_reply'].includes(v.toLowerCase()),
  'x-autoreply': () => true,
  'x-autorespond': () => true,
  'x-auto-response-suppress': () => true,
}

/**
 * Check if an email is an auto-response based on headers.
 * Returns true if any auto-responder header is detected.
 */
export function isAutoResponder(headers: Record<string, string> | undefined | null): boolean {
  if (!headers) return false
  for (const [headerName, check] of Object.entries(AUTO_RESPONDER_HEADERS)) {
    const value = headers[headerName] || headers[headerName.toLowerCase()]
    if (value && check(value)) return true
  }
  return false
}

/**
 * Atomically claim an LLM quota slot for a campaign.
 * Returns true if a slot was successfully claimed, false if the limit is reached.
 * Resets the daily counter if daily_llm_reset_at is stale (before today).
 */
async function claimLlmQuota(env: Env, campaignId: string): Promise<boolean> {
  const today = new Date().toISOString().slice(0, 10)

  // First, try to reset if the reset date is stale (before today)
  await env.DB.prepare(
    "UPDATE campaigns SET daily_llm_calls = 0, daily_llm_reset_at = ? WHERE id = ? AND (daily_llm_reset_at IS NULL OR daily_llm_reset_at < ?)"
  ).bind(today, campaignId, today).run()

  // Atomically claim a slot
  const result = await env.DB.prepare(
    "UPDATE campaigns SET daily_llm_calls = daily_llm_calls + 1 WHERE id = ? AND daily_llm_calls < daily_llm_limit"
  ).bind(campaignId).run()

  return !!(result.meta?.changes)
}

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

  // Fetch inbound emails once for all campaigns (limit=100 from API, process max 10 per cron)
  const res = await mailsFetch(env, '/v1/inbox?direction=inbound&limit=100')

  if (!res.ok) {
    const errBody = await res.text().catch(() => '')
    console.error(`[reply-cron] Failed to fetch inbox: ${res.status} Body=${errBody.slice(0,200)}`)
    return
  }

  const data = await res.json() as any
  const allMessages = data.messages || data.emails || []

  const MAX_REPLIES_PER_CRON = 10

  const filtered = allMessages.filter((msg: any) => {
    const receivedAt = msg.received_at || msg.created_at || ''
    return receivedAt > since
  })

  // Sort oldest-first so we process in chronological order.
  // This prevents the cursor from jumping past unprocessed older messages
  // when MAX_REPLIES_PER_CRON limits how many we handle per cycle.
  filtered.sort((a: any, b: any) => {
    const ta = a.received_at || a.created_at || ''
    const tb = b.received_at || b.created_at || ''
    return ta < tb ? -1 : ta > tb ? 1 : 0
  })

  // Process at most MAX_REPLIES_PER_CRON per cron run to avoid Workers timeout.
  // Remaining messages will be picked up on the next 5-minute cron cycle.
  const messages = filtered.slice(0, MAX_REPLIES_PER_CRON)

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

    let fromEmail = extractEmail(msg.from || msg.from_address || '')

    // If from_address is a bounce/relay address (e.g. Resend's envelope sender),
    // fetch full email headers to get the real RFC822 From header.
    if (!fromEmail || fromEmail.includes('@send.') || fromEmail.includes('bounces+')) {
      if (msg.id) {
        try {
          const emailRes = await mailsFetch(env, `/v1/email?id=${msg.id}`)
          if (emailRes.ok) {
            const emailData = await emailRes.json() as any
            const headerFrom = emailData.headers?.from || emailData.headers?.From || ''
            const realFrom = extractEmail(headerFrom)
            if (realFrom) fromEmail = realFrom
          }
        } catch (err) {
          console.error(`[reply-cron] Failed to fetch email headers for bounce resolution:`, err)
        }
      }
    }

    if (!fromEmail) {
      // No valid sender — still count as processed (not an error)
      if (msgReceivedAt && (!lastSuccessfulReceivedAt || msgReceivedAt > lastSuccessfulReceivedAt)) {
        lastSuccessfulReceivedAt = msgReceivedAt
      }
      continue
    }

    // Fix #2: Atomic dedup via INSERT OR IGNORE on processed_messages table.
    // Only proceed if the insert succeeds (i.e., msg_id was not already processed).
    if (msg.id) {
      const insertResult = await env.DB.prepare(
        "INSERT OR IGNORE INTO processed_messages (msg_id, created_at) VALUES (?, datetime('now'))"
      ).bind(msg.id).run()
      if (!insertResult.meta?.changes) {
        // Already processed — skip
        if (msgReceivedAt && (!lastSuccessfulReceivedAt || msgReceivedAt > lastSuccessfulReceivedAt)) {
          lastSuccessfulReceivedAt = msgReceivedAt
        }
        continue
      }
    }

    // Fix #5: Self-reply protection — skip if the sender is our own mailbox
    if (fromEmail.toLowerCase() === env.MAILS_MAILBOX?.toLowerCase()) {
      if (msgReceivedAt && (!lastSuccessfulReceivedAt || msgReceivedAt > lastSuccessfulReceivedAt)) {
        lastSuccessfulReceivedAt = msgReceivedAt
      }
      continue
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

    // Fix #5 (part 2): Check against all matched campaigns' from_email
    const allFromEmails = new Set(contacts.results.map(c => c._from_email?.toLowerCase()).filter(Boolean))
    if (allFromEmails.has(fromEmail.toLowerCase())) {
      console.log(`[reply-cron] Skipping self-reply from ${fromEmail}`)
      if (msgReceivedAt && (!lastSuccessfulReceivedAt || msgReceivedAt > lastSuccessfulReceivedAt)) {
        lastSuccessfulReceivedAt = msgReceivedAt
      }
      continue
    }

    // Fix #4: Check auto-responder headers before LLM classification
    const msgHeaders = msg.headers || msg.header || null
    let detectedAutoResponder = isAutoResponder(msgHeaders)

    // Fetch full email body (inbox list doesn't include body_text)
    let replyText = msg.text || msg.body_text || msg.body || msg.snippet || ''
    if (!replyText && msg.id) {
      try {
        const emailRes = await mailsFetch(env, `/v1/email?id=${msg.id}`)
        if (emailRes.ok) {
          const emailData = await emailRes.json() as any
          replyText = emailData.body_text || emailData.body || ''
          // Also check headers from the detailed email fetch if not already detected
          if (!detectedAutoResponder && isAutoResponder(emailData.headers)) {
            detectedAutoResponder = true
          }
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

    // Fix #4: If auto-responder detected via headers, skip LLM and use auto_reply directly
    let effectiveIntent: IntentType
    let classification: { intent: IntentType; confidence: number; resume_date: string | null }

    if (detectedAutoResponder) {
      console.log(`[reply-cron] Auto-responder detected via headers for ${fromEmail}, skipping LLM classification`)
      classification = { intent: 'auto_reply' as IntentType, confidence: 1.0, resume_date: null }
      effectiveIntent = 'auto_reply'
    } else {
      // Fix #1: Check LLM quota before classification
      // Use the first matched contact's campaign for quota (all share the same msg)
      const quotaCampaignId = contacts.results[0]._campaign_id
      if (!await claimLlmQuota(env, quotaCampaignId)) {
        console.warn(`[reply-cron] LLM quota exhausted for campaign ${quotaCampaignId}, skipping classification of ${fromEmail}`)
        // Do not advance cursor — retry on next cron run when quota resets
        continue
      }

      // Classify the reply once
      classification = await classifyReply(env, replyText)
      effectiveIntent = classification.confidence < 0.7 ? 'unclear' as IntentType : classification.intent
    }

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

        // v2.1: Record contact message to conversations table (with content dedup to avoid
        // duplicate entries when the same reply arrives as multiple inbox entries)
        const recentConvs = await getConversationHistory(env, contact.id, campaign.id)
        const lastContactMsg = [...recentConvs].reverse().find(m => m.role === 'contact')
        const isDuplicateContent = lastContactMsg && lastContactMsg.content.trim() === replyText.trim()
        if (!isDuplicateContent) {
          await recordContactMessage(env, campaign.id, contact.id, replyText, msg.id || null)
        }

        // Execute action based on intent (skip if duplicate content to avoid double-processing)
        if (!isDuplicateContent) {
          await handleIntent(env, campaign, contact, effectiveIntent, classification.confidence, classification.resume_date, replyText, msg)
        }
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
      // Record wasted quota for debugging
      try {
        await recordEvent(env, campaign.id, contact.id, 'auto_reply_wasted', {
          reason: (err as Error).message?.slice(0, 200) || 'Unknown error',
        })
      } catch { /* best-effort */ }
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
  // Fix #3: Atomic auto_reply_count claim — only proceed if we successfully increment
  const maxReplies = campaign.max_auto_replies ?? 5
  const claimResult = await env.DB.prepare(
    "UPDATE campaign_contacts SET auto_reply_count = auto_reply_count + 1, updated_at = datetime('now') WHERE id = ? AND auto_reply_count < ?"
  ).bind(contact.id, maxReplies).run()

  if (!claimResult.meta?.changes) {
    console.log(`[reply-cron] Auto-reply limit reached for contact ${contact.id}, skipping reply`)
    await notifyOwner(env, campaign, 'conversation_stopped', {
      contactEmail: contact.email,
      contactName: contact.name,
      reason: `Auto-reply limit reached (${maxReplies} replies)`,
    })
    return
  }

  // For not_interested / wrong_person: send a polite goodbye and stop.
  // No need to waste an LLM call — these are terminal intents.
  if (intent === 'not_interested' || intent === 'wrong_person') {
    await sendFinalMessage(env, campaign, contact, originalMsg)
    return
  }

  // For not_now: send a brief acknowledgment, do NOT call LLM (avoid should_stop risk).
  if (intent === 'not_now') {
    const NOT_NOW_REPLIES = [
      'No rush at all. I will check back with you then.',
      'Makes sense. I will follow up when the timing is better.',
      'Understood. Will reach out again down the road.',
    ]
    const notNowMsg = NOT_NOW_REPLIES[Math.floor(Math.random() * NOT_NOW_REPLIES.length)]
    try {
      await sendAutoReply(env, campaign, contact, notNowMsg, originalMsg)
      await recordAgentMessage(env, campaign.id, contact.id, notNowMsg, `Re: ${originalMsg.subject || 'Follow up'}`, null)
    } catch (err) {
      console.error(`[reply-cron] not_now reply failed for ${contact.id}:`, err)
    }
    return
  }

  // Fix #1: Check LLM quota before generateReply
  if (!await claimLlmQuota(env, campaign.id)) {
    console.warn(`[reply-cron] LLM quota exhausted for campaign ${campaign.id}, skipping reply generation for ${contact.id}`)
    return
  }

  // Get conversation history (scoped to this campaign)
  const history = await getConversationHistory(env, contact.id, campaign.id)

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

  // --- Reviewer Agent: check reply accuracy before sending ---
  let finalReplyBody = result.reply
  if (await claimLlmQuota(env, campaign.id)) {
    try {
      const reviewResult = await reviewEmail(
        env,
        kb,
        `Re: ${originalMsg.subject || 'Follow up'}`,
        result.reply,
        contact.name || contact.email,
        campaign.product_name,
      )

      await recordEvent(env, campaign.id, contact.id, 'email_reviewed', {
        approved: reviewResult.approved,
        issues: reviewResult.issues,
        corrected: !!reviewResult.corrected_body,
        context: 'auto_reply',
      })

      if (!reviewResult.approved) {
        if (reviewResult.corrected_body) {
          finalReplyBody = reviewResult.corrected_body
          console.log(`[reply-cron] Reply for contact ${contact.id} corrected by reviewer`)
        } else {
          const safeEmail = buildSafeEmail(kb, contact.name || contact.email)
          finalReplyBody = safeEmail.body
          console.log(`[reply-cron] Reply for contact ${contact.id} rejected by reviewer, using safe template`)
        }
      }
    } catch (err) {
      console.error(`[reply-cron] Review failed for contact ${contact.id}, proceeding with original:`, err)
    }
  }

  // Send the generated reply
  await sendAutoReply(env, campaign, contact, finalReplyBody, originalMsg)

  // Record agent reply to conversations
  await recordAgentMessage(
    env,
    campaign.id,
    contact.id,
    finalReplyBody,
    `Re: ${originalMsg.subject || 'Follow up'}`,
    null, // message_id filled after send — best effort
  )

  // auto_reply_count already atomically incremented above (Fix #3)
  // Check if we've now hit the limit
  const newCount = (contact.auto_reply_count ?? 0) + 1
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
  // Fix #8: Build threading headers with proper References chain and case-insensitive header lookup
  const headers: Record<string, string> = {}
  if (originalMsg.id) {
    try {
      const emailRes = await mailsFetch(env, `/v1/email?id=${originalMsg.id}`)
      if (emailRes.ok) {
        const emailData = await emailRes.json() as any

        // Case-insensitive header lookup
        const rawHeaders = emailData.headers || {}
        const normalizedHeaders: Record<string, string> = {}
        for (const [k, v] of Object.entries(rawHeaders)) {
          normalizedHeaders[k.toLowerCase()] = v as string
        }

        const msgId = emailData.message_id || normalizedHeaders['message-id']
        if (msgId) {
          headers['In-Reply-To'] = msgId

          // Build References chain: preserve existing References and append the current Message-ID
          const existingRefs = normalizedHeaders['references'] || ''
          if (existingRefs) {
            // Append the new message-id to the existing chain
            headers['References'] = `${existingRefs} ${msgId}`
          } else {
            headers['References'] = msgId
          }
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

  // Fix #6: Replace links with tracking and build HTML version
  let htmlBody: string | undefined
  if (!campaign.dry_run) {
    const baseUrl = env.UNSUBSCRIBE_BASE_URL || 'https://mails-gtm-agent.genedai.workers.dev'
    const { html } = await replaceLinksWithTrackingDual(
      replyBody,
      contact.id,
      campaign.id,
      baseUrl,
      env,
    )
    htmlBody = html
  }

  // Add compliance footer (text keeps original URLs, HTML has tracked <a> tags)
  const fullBody = replyBody + generateComplianceFooter(campaign.physical_address, unsubUrl)
  const fullHtml = htmlBody
    ? htmlBody + generateComplianceFooterHtml(campaign.physical_address, unsubUrl)
    : undefined

  // Dry-run mode: log but don't actually send
  if (campaign.dry_run) {
    console.log(`[reply-cron] DRY RUN: would send auto-reply to ${contact.email}: ${replyBody.slice(0, 100)}...`)
    return
  }

  // Send via mails-agent API (text + html for clean display)
  const sendPayload: Record<string, unknown> = {
    from: campaign.from_email || env.MAILS_MAILBOX,
    to: [contact.email],
    subject: `Re: ${originalMsg.subject || 'Follow up'}`,
    text: fullBody,
    headers,
  }
  if (fullHtml) sendPayload.html = fullHtml

  const sendRes = await mailsFetch(env, '/v1/send', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(sendPayload),
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
  const GOODBYE_VARIANTS = [
    'Thanks for letting me know. No worries at all.',
    'Got it, appreciate you taking the time to reply.',
    'Understood. If things change down the road, you know where to find us.',
    'No problem. Wishing you and the team all the best.',
    'Thanks for the reply. I will not follow up further.',
  ]
  const finalMsg = GOODBYE_VARIANTS[Math.floor(Math.random() * GOODBYE_VARIANTS.length)]

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

  // Mark contact as stopped.
  // NOTE: auto_reply_count is NOT incremented here because it was already
  // atomically incremented in processAutoReply() before calling this function.
  // Double-incrementing was a bug that inflated the counter.
  await env.DB.prepare(
    "UPDATE campaign_contacts SET status = 'stopped', updated_at = datetime('now') WHERE id = ?"
  ).bind(contact.id).run()
}

function extractEmail(str: string): string | null {
  const match = str.match(/([^\s<>]+@[^\s<>]+\.[^\s<>]+)/)
  return match ? match[1].toLowerCase() : null
}
