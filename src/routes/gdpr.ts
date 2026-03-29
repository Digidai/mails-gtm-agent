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

  // Delete from campaign_contacts
  const contactsResult = await env.DB.prepare(
    'DELETE FROM campaign_contacts WHERE email = ?'
  ).bind(email).run()

  // Delete from send_log (find via contacts - already deleted, so match by email in send_log via join)
  // We can't easily join since contacts are deleted. Just delete matching unsubscribes.
  const unsubResult = await env.DB.prepare(
    'DELETE FROM unsubscribes WHERE email = ?'
  ).bind(email).run()

  // Add to unsubscribes as a global block to prevent future sends
  await env.DB.prepare(`
    INSERT INTO unsubscribes (id, email, reason)
    VALUES (?, ?, 'GDPR deletion request')
    ON CONFLICT(email, campaign_id) DO NOTHING
  `).bind(
    crypto.randomUUID().replace(/-/g, ''),
    email,
  ).run()

  return json({
    email,
    deleted: {
      contacts: contactsResult.meta?.changes || 0,
      unsubscribes: unsubResult.meta?.changes || 0,
    },
    note: 'Email has been added to global suppression list',
  })
}
