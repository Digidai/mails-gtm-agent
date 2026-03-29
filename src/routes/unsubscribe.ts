import { Env } from '../types'
import { verifyUnsubscribeToken } from '../compliance/unsubscribe'

export async function handleUnsubscribeRoute(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url)
  const token = url.searchParams.get('token')

  if (!token) {
    return new Response(unsubscribeHtml('Invalid link', 'The unsubscribe link is missing or malformed.', false), {
      status: 400,
      headers: { 'Content-Type': 'text/html; charset=utf-8' },
    })
  }

  const payload = await verifyUnsubscribeToken(token, env.UNSUBSCRIBE_SECRET)

  if (!payload) {
    return new Response(unsubscribeHtml('Invalid link', 'This unsubscribe link is expired or invalid.', false), {
      status: 400,
      headers: { 'Content-Type': 'text/html; charset=utf-8' },
    })
  }

  // Record unsubscribe — campaign-specific + global
  try {
    // Campaign-specific record
    await env.DB.prepare(`
      INSERT INTO unsubscribes (id, email, campaign_id)
      VALUES (?, ?, ?)
      ON CONFLICT(email, campaign_id) DO NOTHING
    `).bind(
      crypto.randomUUID().replace(/-/g, ''),
      payload.email,
      payload.campaign_id,
    ).run()

    // Global record — ensures no other campaign can email this contact
    await env.DB.prepare(`
      INSERT INTO unsubscribes (id, email, campaign_id, reason)
      VALUES (?, ?, '__global__', 'Unsubscribed via link')
      ON CONFLICT(email, campaign_id) DO NOTHING
    `).bind(
      crypto.randomUUID().replace(/-/g, ''),
      payload.email,
    ).run()

    // Update contact status across ALL campaigns for this email
    await env.DB.prepare(`
      UPDATE campaign_contacts SET status = 'unsubscribed', updated_at = datetime('now')
      WHERE email = ?
    `).bind(payload.email).run()
  } catch (err) {
    console.error('Unsubscribe error:', err)
  }

  return new Response(
    unsubscribeHtml('Unsubscribed', 'You have been successfully unsubscribed. You will no longer receive emails from this campaign.', true),
    {
      status: 200,
      headers: { 'Content-Type': 'text/html; charset=utf-8' },
    },
  )
}

function escapeHtml(str: string): string {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

function unsubscribeHtml(title: string, message: string, success: boolean): string {
  const safeTitle = escapeHtml(title)
  const safeMessage = escapeHtml(message)
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${safeTitle}</title>
  <style>
    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
      display: flex;
      justify-content: center;
      align-items: center;
      min-height: 100vh;
      margin: 0;
      background: #f5f5f5;
    }
    .card {
      background: white;
      padding: 2rem;
      border-radius: 8px;
      box-shadow: 0 2px 8px rgba(0,0,0,0.1);
      max-width: 400px;
      text-align: center;
    }
    .icon { font-size: 3rem; margin-bottom: 1rem; }
    h1 { margin: 0 0 0.5rem; font-size: 1.5rem; }
    p { color: #666; line-height: 1.5; }
  </style>
</head>
<body>
  <div class="card">
    <div class="icon">${success ? '&#10003;' : '&#10007;'}</div>
    <h1>${safeTitle}</h1>
    <p>${safeMessage}</p>
  </div>
</body>
</html>`
}
