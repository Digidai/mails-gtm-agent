import { Env, Campaign, CampaignContact, IntentType, KnowledgeBase } from '../types'
import { classifyReply } from '../llm/classify'
import { createProvider } from '../llm/provider'
import { mailsFetch } from '../mails-api'
import { recordEvent } from '../events/record'
import { recordContactMessage, getConversationHistory } from '../conversations/context'
import { TERMINAL_STATUSES } from '../state-machine'
import { claimLlmQuota } from '../utils/llm-quota'
import {
  isAutoResponder,
  canAutoReply,
  handleIntent,
  extractEmail,
} from '../scheduler/reply-cron'

/**
 * Verify HMAC-SHA256 webhook signature from mails-agent.
 */
async function verifySignature(
  body: string,
  signature: string,
  secret: string,
): Promise<boolean> {
  const encoder = new TextEncoder()
  const key = await crypto.subtle.importKey(
    'raw',
    encoder.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  )
  const sig = await crypto.subtle.sign('HMAC', key, encoder.encode(body))
  const expected = Array.from(new Uint8Array(sig))
    .map(b => b.toString(16).padStart(2, '0'))
    .join('')

  // Constant-time comparison via SHA-256 hashing to prevent length leakage
  const hashExpected = new Uint8Array(await crypto.subtle.digest('SHA-256', encoder.encode(expected)))
  const hashSignature = new Uint8Array(await crypto.subtle.digest('SHA-256', encoder.encode(signature)))
  let diff = 0
  for (let i = 0; i < hashExpected.length; i++) {
    diff |= hashExpected[i] ^ hashSignature[i]
  }
  return diff === 0
}

function jsonResponse(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}

/**
 * Handle inbound email webhook from mails-agent.
 * This is the event-driven replacement for reply-cron polling.
 * Reply-cron still runs as a fallback safety net.
 */
export async function handleInboundWebhook(
  request: Request,
  env: Env,
): Promise<Response> {
  // 1. Verify HMAC signature
  const signature = request.headers.get('X-Webhook-Signature') || ''
  if (!signature) {
    return jsonResponse({ error: 'Missing X-Webhook-Signature header' }, 401)
  }

  if (!env.WEBHOOK_SECRET) {
    console.error('[inbound-webhook] WEBHOOK_SECRET not configured')
    return jsonResponse({ error: 'Webhook not configured' }, 500)
  }

  const bodyText = await request.text()
  const valid = await verifySignature(bodyText, signature, env.WEBHOOK_SECRET)
  if (!valid) {
    return jsonResponse({ error: 'Invalid signature' }, 401)
  }

  // 2. Parse webhook payload
  let payload: {
    event: string
    email_id?: string
    mailbox?: string
    from?: string
    to?: string | string[]
    subject?: string
    received_at?: string
    message_id?: string
  }
  try {
    payload = JSON.parse(bodyText)
  } catch {
    return jsonResponse({ error: 'Invalid JSON body' }, 400)
  }

  // 3. Verify this is a message.received event
  if (payload.event !== 'message.received') {
    // Not an inbound message event — acknowledge but skip
    return jsonResponse({ status: 'skipped', reason: 'not a message.received event' })
  }

  // 4. Validate required fields
  if (!payload.from) {
    return jsonResponse({ error: 'Missing from field' }, 400)
  }

  const fromEmail = extractEmail(payload.from)
  if (!fromEmail) {
    return jsonResponse({ status: 'skipped', reason: 'invalid sender address' })
  }

  // 5. Self-reply protection: skip if sender is our own mailbox
  if (fromEmail.toLowerCase() === env.MAILS_MAILBOX?.toLowerCase()) {
    return jsonResponse({ status: 'skipped', reason: 'self-reply' })
  }

  // 6. Dedup check via processed_messages table (read-only; write deferred to after successful processing)
  const msgId = payload.email_id || payload.message_id
  if (msgId) {
    const existing = await env.DB.prepare(
      "SELECT 1 FROM processed_messages WHERE msg_id = ?"
    ).bind(msgId).first()
    if (existing) {
      return jsonResponse({ status: 'skipped', reason: 'duplicate' })
    }
  }

  // 7. Fetch full email data early — needed for thread matching (In-Reply-To) and body text
  let replyText = ''
  let detectedAutoResponder = false
  let inReplyTo = ''
  const emailId = payload.email_id
  if (emailId) {
    try {
      const emailRes = await mailsFetch(env, `/v1/email?id=${emailId}`)
      if (emailRes.ok) {
        const emailData = await emailRes.json() as any
        replyText = emailData.body_text || emailData.body || ''
        detectedAutoResponder = isAutoResponder(emailData.headers)
        // Extract In-Reply-To for thread-based contact matching
        const rawHeaders = emailData.headers || {}
        inReplyTo = rawHeaders['in-reply-to'] || rawHeaders['In-Reply-To'] || ''
      }
    } catch (err) {
      console.error(`[inbound-webhook] Failed to fetch email data for ${emailId}:`, err)
    }
  }

  // 8. Match sender to campaign_contacts
  // Thread matching: ORDER BY prefers contact whose sent_message_id matches In-Reply-To
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
    ORDER BY
      CASE WHEN cc.sent_message_id = ? THEN 0 ELSE 1 END,
      cc.last_sent_at DESC
    LIMIT 1
  `).bind(fromEmail.toLowerCase(), inReplyTo).all<CampaignContact & {
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
    return jsonResponse({ status: 'skipped', reason: 'no matching contact' })
  }

  // Self-reply check against campaign from_email
  const allFromEmails = new Set(contacts.results.map(c => c._from_email?.toLowerCase()).filter(Boolean))
  if (allFromEmails.has(fromEmail.toLowerCase())) {
    console.log(`[inbound-webhook] Skipping self-reply from ${fromEmail}`)
    return jsonResponse({ status: 'skipped', reason: 'self-reply' })
  }

  if (!replyText.trim()) {
    console.warn(`[inbound-webhook] Empty reply body from ${fromEmail}, skipping`)
    return jsonResponse({ status: 'skipped', reason: 'empty body' })
  }

  // 9. Classify intent via LLM (with quota check)
  const provider = createProvider(env)
  let effectiveIntent: IntentType
  let classification: { intent: IntentType; confidence: number; resume_date: string | null }

  if (detectedAutoResponder) {
    console.log(`[inbound-webhook] Auto-responder detected via headers for ${fromEmail}`)
    classification = { intent: 'auto_reply' as IntentType, confidence: 1.0, resume_date: null }
    effectiveIntent = 'auto_reply'
  } else {
    const quotaCampaignId = contacts.results[0]._campaign_id
    if (!await claimLlmQuota(env, quotaCampaignId)) {
      console.warn(`[inbound-webhook] LLM quota exhausted for campaign ${quotaCampaignId}, skipping classification`)
      return jsonResponse({ status: 'skipped', reason: 'llm quota exhausted' })
    }

    classification = await classifyReply(provider, replyText)
    effectiveIntent = classification.confidence < 0.7 ? 'unclear' as IntentType : classification.intent
  }

  // 10. Process for the matched contact (reuses handleIntent from reply-cron)
  // Build a minimal msg-like object for handleIntent/sendAutoReply compatibility
  const msg = {
    id: emailId || null,
    subject: payload.subject || '',
    from: payload.from,
  }

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

      // Record reply event
      await recordEvent(env, campaign.id, contact.id, 'reply', {
        msg_id: msgId || null,
        intent: effectiveIntent,
        confidence: classification.confidence,
        resume_date: classification.resume_date,
        snippet: replyText.slice(0, 200),
        source: 'webhook',
      })

      // Record contact message (with content dedup)
      const recentConvs = await getConversationHistory(env, contact.id, campaign.id)
      const lastContactMsg = [...recentConvs].reverse().find(m => m.role === 'contact')
      const isDuplicateContent = lastContactMsg && lastContactMsg.content.trim() === replyText.trim()
      if (!isDuplicateContent) {
        await recordContactMessage(env, campaign.id, contact.id, replyText, msgId || null)
      }

      // Execute action based on intent (skip if duplicate content)
      if (!isDuplicateContent) {
        await handleIntent(env, provider, campaign, contact, effectiveIntent, classification.confidence, classification.resume_date, replyText, msg)
      }
    } catch (err) {
      console.error(`[inbound-webhook] Processing error for contact ${contact.id}:`, err)
    }
  }

  // 11. Mark as processed only after successful handling
  if (msgId) {
    await env.DB.prepare(
      "INSERT OR IGNORE INTO processed_messages (msg_id, created_at) VALUES (?, datetime('now'))"
    ).bind(msgId).run()
  }

  // 12. Always return 200 OK — webhook should not retry
  return jsonResponse({ status: 'processed', intent: effectiveIntent })
}
