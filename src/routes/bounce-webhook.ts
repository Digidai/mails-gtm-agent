import { Env } from '../types'
import { updateContactStatus } from '../state-machine'
import { recordEvent } from '../events/record'

/**
 * Handle bounce webhook from email provider (e.g., Resend).
 * Marks the contact as bounced and records the event.
 *
 * Expected payload:
 * { email: string, type: "bounce"|"complaint", reason?: string, timestamp?: string }
 */
export async function handleBounceWebhook(
  request: Request,
  env: Env,
): Promise<Response> {
  // 1. Auth: verify ADMIN_TOKEN (bounce webhooks come from our own infrastructure)
  const auth = request.headers.get('Authorization')
  if (!auth || !auth.startsWith('Bearer ')) {
    return new Response(JSON.stringify({ error: 'Unauthorized' }), { status: 401 })
  }
  // Use simple comparison for admin token (this is an internal webhook)
  const token = auth.slice(7)
  if (token !== env.ADMIN_TOKEN) {
    return new Response(JSON.stringify({ error: 'Unauthorized' }), { status: 401 })
  }

  // 2. Parse payload
  let body: { email: string; type?: string; reason?: string; timestamp?: string }
  try {
    body = await request.json()
  } catch {
    return new Response(JSON.stringify({ error: 'Invalid JSON' }), { status: 400 })
  }

  if (!body.email) {
    return new Response(JSON.stringify({ error: 'Missing email field' }), { status: 400 })
  }

  const email = body.email.toLowerCase().trim()
  const bounceType = body.type || 'bounce'
  const reason = body.reason || 'Unknown'

  // 3. Find all contacts with this email across active campaigns
  const contacts = await env.DB.prepare(
    "SELECT cc.id, cc.campaign_id, cc.status FROM campaign_contacts cc JOIN campaigns c ON c.id = cc.campaign_id WHERE cc.email = ? AND c.status = 'active'"
  ).bind(email).all<{ id: string; campaign_id: string; status: string }>()

  if (!contacts.results?.length) {
    return new Response(JSON.stringify({ ok: true, matched: 0 }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    })
  }

  let updated = 0
  for (const contact of contacts.results) {
    // Use state machine — respects priority (won't override do_not_contact/unsubscribed)
    const transitioned = await updateContactStatus(env.DB, contact.id, 'bounced')
    if (transitioned) {
      updated++
      await recordEvent(env, contact.campaign_id, contact.id, 'bounce', {
        type: bounceType,
        reason: reason.slice(0, 500),
        source: 'webhook',
      })
    }
  }

  return new Response(JSON.stringify({ ok: true, matched: contacts.results.length, updated }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  })
}
