import { Env } from '../types'
import { parseCsv } from '../utils/csv'

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}

export async function handleContactsRoutes(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url)
  const path = url.pathname
  const method = request.method

  // POST /api/contacts/import
  if (path === '/api/contacts/import' && method === 'POST') {
    return importContacts(request, env)
  }

  return json({ error: 'Not Found' }, 404)
}

async function importContacts(request: Request, env: Env): Promise<Response> {
  const contentType = request.headers.get('Content-Type') || ''

  let csvText: string
  let campaignId: string

  if (contentType.includes('multipart/form-data')) {
    const formData = await request.formData()
    const file = formData.get('file')
    campaignId = formData.get('campaign_id') as string

    if (!file || !(file instanceof File)) {
      return json({ error: 'No CSV file uploaded' }, 400)
    }
    csvText = await file.text()
  } else {
    const body = await request.json() as any
    csvText = body.csv
    campaignId = body.campaign_id
  }

  if (!campaignId) {
    return json({ error: 'Missing campaign_id' }, 400)
  }

  if (!csvText || !csvText.trim()) {
    return json({ error: 'Empty CSV data' }, 400)
  }

  // Verify campaign exists
  const campaign = await env.DB.prepare('SELECT id FROM campaigns WHERE id = ?').bind(campaignId).first()
  if (!campaign) {
    return json({ error: 'Campaign not found' }, 404)
  }

  // Check for globally unsubscribed emails
  const unsubscribed = await env.DB.prepare('SELECT email FROM unsubscribes').all()
  const unsubSet = new Set((unsubscribed.results || []).map((r: any) => r.email.toLowerCase()))

  const { contacts, errors, duplicates } = parseCsv(csvText)

  let imported = 0
  let skipped = 0
  const importErrors: string[] = [...errors]

  for (const contact of contacts) {
    // Skip unsubscribed
    if (unsubSet.has(contact.email.toLowerCase())) {
      skipped++
      continue
    }

    // Build custom fields
    const customFields: Record<string, string> = {}
    for (const [key, value] of Object.entries(contact)) {
      if (!['email', 'name', 'company', 'role'].includes(key) && value) {
        customFields[key] = value
      }
    }

    try {
      await env.DB.prepare(`
        INSERT INTO campaign_contacts (id, campaign_id, email, name, company, role, custom_fields)
        VALUES (?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(campaign_id, email) DO NOTHING
      `).bind(
        crypto.randomUUID().replace(/-/g, ''),
        campaignId,
        contact.email,
        contact.name || null,
        contact.company || null,
        contact.role || null,
        JSON.stringify(customFields),
      ).run()
      imported++
    } catch (err: any) {
      importErrors.push(`Failed to import ${contact.email}: ${err.message}`)
    }
  }

  return json({
    imported,
    duplicates,
    skipped_unsubscribed: skipped,
    errors: importErrors,
    total_in_csv: contacts.length + duplicates,
  })
}
