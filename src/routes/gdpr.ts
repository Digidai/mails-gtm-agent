import { Env } from '../types'

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}

export async function handleGdprRoutes(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url)
  const path = url.pathname
  const method = request.method

  // POST /api/gdpr/delete
  if (path === '/api/gdpr/delete' && method === 'POST') {
    return deleteUserData(request, env)
  }

  return json({ error: 'Not Found' }, 404)
}

async function deleteUserData(request: Request, env: Env): Promise<Response> {
  const body = await request.json() as any
  const email = body.email?.toLowerCase()

  if (!email) {
    return json({ error: 'Missing email' }, 400)
  }

  // 1. Get all contact IDs for this email (needed for cascading deletes)
  const contactIds = await env.DB.prepare(
    'SELECT id FROM campaign_contacts WHERE email = ?'
  ).bind(email).all<{ id: string }>()

  const ids = (contactIds.results || []).map(r => r.id)

  // 2. Delete from send_log
  const sendLogResult = await env.DB.prepare(
    'DELETE FROM send_log WHERE contact_id IN (SELECT id FROM campaign_contacts WHERE email = ?)'
  ).bind(email).run()

  // 3. Delete from events (v2)
  let eventsDeleted = 0
  if (ids.length > 0) {
    const eventsResult = await env.DB.prepare(
      'DELETE FROM events WHERE contact_id IN (SELECT id FROM campaign_contacts WHERE email = ?)'
    ).bind(email).run()
    eventsDeleted = eventsResult.meta?.changes || 0
  }

  // 4. Delete from decision_log (v2)
  let decisionsDeleted = 0
  if (ids.length > 0) {
    const decisionsResult = await env.DB.prepare(
      'DELETE FROM decision_log WHERE contact_id IN (SELECT id FROM campaign_contacts WHERE email = ?)'
    ).bind(email).run()
    decisionsDeleted = decisionsResult.meta?.changes || 0
  }

  // 5. Delete from tracked_links (v2)
  let linksDeleted = 0
  if (ids.length > 0) {
    const linksResult = await env.DB.prepare(
      'DELETE FROM tracked_links WHERE contact_id IN (SELECT id FROM campaign_contacts WHERE email = ?)'
    ).bind(email).run()
    linksDeleted = linksResult.meta?.changes || 0
  }

  // 6. Delete from campaign_contacts
  const contactsResult = await env.DB.prepare(
    'DELETE FROM campaign_contacts WHERE email = ?'
  ).bind(email).run()

  // 7. Delete from unsubscribes
  const unsubResult = await env.DB.prepare(
    'DELETE FROM unsubscribes WHERE email = ?'
  ).bind(email).run()

  // 8. Add to unsubscribes as a global block (use __global__ for consistent suppression)
  await env.DB.prepare(`
    INSERT INTO unsubscribes (id, email, campaign_id, reason)
    VALUES (?, ?, '__global__', 'GDPR deletion request')
    ON CONFLICT(email, campaign_id) DO NOTHING
  `).bind(
    crypto.randomUUID().replace(/-/g, ''),
    email,
  ).run()

  return json({
    email,
    deleted: {
      contacts: contactsResult.meta?.changes || 0,
      send_logs: sendLogResult.meta?.changes || 0,
      events: eventsDeleted,
      decisions: decisionsDeleted,
      tracked_links: linksDeleted,
      unsubscribes: unsubResult.meta?.changes || 0,
    },
    note: 'Email has been added to global suppression list',
  })
}
