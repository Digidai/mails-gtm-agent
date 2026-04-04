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
  let body: any
  try {
    body = await request.json()
  } catch {
    return json({ error: 'Invalid JSON body' }, 400)
  }
  const email = body.email?.toLowerCase()

  if (!email) {
    return json({ error: 'Missing email' }, 400)
  }

  // Use D1 batch for atomic deletion — all statements succeed or fail together.
  // Order matters: delete child records before parent (campaign_contacts).
  const suppressionId = crypto.randomUUID().replace(/-/g, '')

  const results = await env.DB.batch([
    // 1. Delete from send_log (child of campaign_contacts)
    env.DB.prepare(
      'DELETE FROM send_log WHERE contact_id IN (SELECT id FROM campaign_contacts WHERE email = ?)'
    ).bind(email),
    // 2. Delete from events
    env.DB.prepare(
      'DELETE FROM events WHERE contact_id IN (SELECT id FROM campaign_contacts WHERE email = ?)'
    ).bind(email),
    // 3. Delete from decision_log
    env.DB.prepare(
      'DELETE FROM decision_log WHERE contact_id IN (SELECT id FROM campaign_contacts WHERE email = ?)'
    ).bind(email),
    // 4. Delete from tracked_links
    env.DB.prepare(
      'DELETE FROM tracked_links WHERE contact_id IN (SELECT id FROM campaign_contacts WHERE email = ?)'
    ).bind(email),
    // 4.5. Delete from conversations
    env.DB.prepare(
      'DELETE FROM conversations WHERE contact_id IN (SELECT id FROM campaign_contacts WHERE email = ?)'
    ).bind(email),
    // 4.6. Delete from processed_messages (cleanup dedup records by contact_id)
    env.DB.prepare(
      'DELETE FROM processed_messages WHERE contact_id IN (SELECT id FROM campaign_contacts WHERE email = ?)'
    ).bind(email),
    // 4.7. Delete from processed_messages by send_log message_id (covers null contact_id / old data)
    env.DB.prepare(
      "DELETE FROM processed_messages WHERE msg_id IN (SELECT message_id FROM send_log WHERE contact_id IN (SELECT id FROM campaign_contacts WHERE email = ?))"
    ).bind(email),
    // 5. Delete from campaign_contacts (parent)
    env.DB.prepare(
      'DELETE FROM campaign_contacts WHERE email = ?'
    ).bind(email),
    // 6. Delete from unsubscribes
    env.DB.prepare(
      'DELETE FROM unsubscribes WHERE email = ?'
    ).bind(email),
    // 7. Add global suppression record
    env.DB.prepare(
      "INSERT INTO unsubscribes (id, email, campaign_id, reason) VALUES (?, ?, '__global__', 'GDPR deletion request') ON CONFLICT(email, campaign_id) DO NOTHING"
    ).bind(suppressionId, email),
  ])

  return json({
    email,
    deleted: {
      send_logs: results[0].meta?.changes || 0,
      events: results[1].meta?.changes || 0,
      decisions: results[2].meta?.changes || 0,
      tracked_links: results[3].meta?.changes || 0,
      conversations: results[4].meta?.changes || 0,
      processed_messages: (results[5].meta?.changes || 0) + (results[6].meta?.changes || 0),
      contacts: results[7].meta?.changes || 0,
      unsubscribes: results[8].meta?.changes || 0,
    },
    note: 'Email has been added to global suppression list',
  })
}
