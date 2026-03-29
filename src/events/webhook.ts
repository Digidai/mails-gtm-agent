import { Env, Campaign } from '../types'
import { recordEvent } from './record'
import { notifyOwner } from '../notify'

/**
 * Verify HMAC-SHA256 webhook signature.
 */
async function verifyWebhookSignature(
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

  // Constant-time comparison
  if (expected.length !== signature.length) return false
  let diff = 0
  for (let i = 0; i < expected.length; i++) {
    diff |= expected.charCodeAt(i) ^ signature.charCodeAt(i)
  }
  return diff === 0
}

/**
 * Handle POST /webhook/event/:campaign_id
 * Accepts external conversion events (signup, payment, etc.)
 */
export async function handleWebhookEvent(
  request: Request,
  campaignId: string,
  env: Env,
): Promise<Response> {
  // 1. Get campaign and its webhook_secret
  const campaign = await env.DB.prepare(
    'SELECT * FROM campaigns WHERE id = ?',
  ).bind(campaignId).first<Campaign>()

  if (!campaign) {
    return jsonResponse({ error: 'Campaign not found' }, 404)
  }

  if (!campaign.webhook_secret) {
    return jsonResponse({ error: 'Webhook not configured for this campaign' }, 400)
  }

  // 2. Verify HMAC signature
  const signature = request.headers.get('X-Webhook-Signature') || ''
  const bodyText = await request.text()

  if (!signature) {
    return jsonResponse({ error: 'Missing X-Webhook-Signature header' }, 401)
  }

  const valid = await verifyWebhookSignature(bodyText, signature, campaign.webhook_secret)
  if (!valid) {
    return jsonResponse({ error: 'Invalid signature' }, 401)
  }

  // 3. Parse event payload
  let payload: { email: string; event: string; timestamp?: number; data?: Record<string, unknown> }
  try {
    payload = JSON.parse(bodyText)
  } catch {
    return jsonResponse({ error: 'Invalid JSON body' }, 400)
  }

  // 3.5. Replay attack protection: reject events with stale timestamps (> 5 minutes)
  if (payload.timestamp) {
    const now = Math.floor(Date.now() / 1000)
    const age = Math.abs(now - payload.timestamp)
    if (age > 300) { // 5 minutes
      return jsonResponse({ error: 'Webhook timestamp too old or too far in the future (max 5 minutes skew)' }, 401)
    }
  }

  if (!payload.email || !payload.event) {
    return jsonResponse({ error: 'Missing email or event field' }, 400)
  }

  const validEvents = ['signup', 'payment', 'custom']
  if (!validEvents.includes(payload.event)) {
    return jsonResponse({ error: `Invalid event type. Must be one of: ${validEvents.join(', ')}` }, 400)
  }

  // 4. Find matching contact
  const contact = await env.DB.prepare(
    'SELECT id, status FROM campaign_contacts WHERE campaign_id = ? AND email = ?',
  ).bind(campaignId, payload.email.toLowerCase()).first<{ id: string; status: string }>()

  if (!contact) {
    return jsonResponse({ error: 'Contact not found in this campaign' }, 404)
  }

  // 5. Record event
  const eventId = await recordEvent(env, campaignId, contact.id, payload.event, payload.data || {})

  // 6. Update contact status for conversion events
  if (payload.event === 'signup' || payload.event === 'payment') {
    const now = new Date().toISOString()
    await env.DB.prepare(`
      UPDATE campaign_contacts
      SET status = 'converted', converted_at = ?, conversion_type = ?, updated_at = ?
      WHERE id = ? AND status NOT IN ('unsubscribed', 'bounced')
    `).bind(now, payload.event, now, contact.id).run()

    // Notify campaign owner of conversion
    try {
      await notifyOwner(env, campaign, 'conversion', {
        contactEmail: payload.email,
        conversionType: payload.event,
      })
    } catch {
      // Notification failure is non-critical
    }
  }

  return jsonResponse({ event_id: eventId, status: 'recorded' })
}

function jsonResponse(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}
