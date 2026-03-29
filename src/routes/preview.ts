import { Env, Campaign, CampaignContact, CampaignStep } from '../types'
import { generateEmail } from '../llm/generate'

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}

export async function handlePreviewRoutes(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url)
  const path = url.pathname
  const method = request.method

  // POST /api/campaign/:id/preview
  const match = path.match(/^\/api\/campaign\/([a-f0-9]+)\/preview$/)
  if (match && method === 'POST') {
    return previewEmails(match[1], request, env)
  }

  return json({ error: 'Not Found' }, 404)
}

async function previewEmails(campaignId: string, request: Request, env: Env): Promise<Response> {
  // 1. Get campaign
  const campaign = await env.DB.prepare('SELECT * FROM campaigns WHERE id = ?').bind(campaignId).first<Campaign>()
  if (!campaign) {
    return json({ error: 'Campaign not found' }, 404)
  }

  // 2. Parse count from request body
  const body = await request.json() as any
  const count = Math.min(Math.max(body.count || 3, 1), 10) // clamp 1-10

  // 3. Get first N pending contacts
  const contacts = await env.DB.prepare(`
    SELECT * FROM campaign_contacts
    WHERE campaign_id = ? AND status = 'pending'
    ORDER BY created_at ASC
    LIMIT ?
  `).bind(campaignId, count).all<CampaignContact>()

  if (!contacts.results?.length) {
    return json({ error: 'No pending contacts found for this campaign' }, 404)
  }

  // 4. Generate emails for each contact (do NOT send)
  const previews: Array<{
    contact: { email: string; name: string | null; company: string | null; role: string | null }
    generated: { subject: string; body: string }
  }> = []

  for (const contact of contacts.results) {
    const stepNumber = contact.current_step || 0
    const generated = await generateEmail(env, campaign, contact, stepNumber)

    previews.push({
      contact: {
        email: contact.email,
        name: contact.name,
        company: contact.company,
        role: contact.role,
      },
      generated: {
        subject: generated.subject,
        body: generated.body,
      },
    })
  }

  return json({ previews })
}
