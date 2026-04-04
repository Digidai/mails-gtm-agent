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

  // GET /api/contacts/list
  if (path === '/api/contacts/list' && method === 'GET') {
    return listContacts(url, env)
  }

  return json({ error: 'Not Found' }, 404)
}

async function listContacts(url: URL, env: Env): Promise<Response> {
  const campaignId = url.searchParams.get('campaign_id')
  if (!campaignId) {
    return json({ error: 'Missing campaign_id query parameter' }, 400)
  }

  const status = url.searchParams.get('status')
  const limit = Math.min(parseInt(url.searchParams.get('limit') || '50', 10), 500)
  const offset = parseInt(url.searchParams.get('offset') || '0', 10)

  let query = 'SELECT * FROM campaign_contacts WHERE campaign_id = ?'
  const params: any[] = [campaignId]

  if (status) {
    query += ' AND status = ?'
    params.push(status)
  }

  query += ' ORDER BY created_at DESC LIMIT ? OFFSET ?'
  params.push(limit, offset)

  const stmt = env.DB.prepare(query)
  const result = await stmt.bind(...params).all()

  // Get total count for pagination
  let countQuery = 'SELECT COUNT(*) as count FROM campaign_contacts WHERE campaign_id = ?'
  const countParams: any[] = [campaignId]
  if (status) {
    countQuery += ' AND status = ?'
    countParams.push(status)
  }
  const countResult = await env.DB.prepare(countQuery).bind(...countParams).first<{ count: number }>()

  return json({
    contacts: result.results,
    total: countResult?.count || 0,
    limit,
    offset,
  })
}

async function importContacts(request: Request, env: Env): Promise<Response> {
  const contentType = request.headers.get('Content-Type') || ''

  let csvText: string
  let campaignId: string

  if (contentType.includes('multipart/form-data')) {
    const formData = await request.formData()
    const file = formData.get('file') as unknown
    campaignId = formData.get('campaign_id') as string

    if (!file || typeof file === 'string') {
      return json({ error: 'No CSV file uploaded' }, 400)
    }
    csvText = await (file as Blob).text()
  } else if (contentType.includes('text/csv')) {
    // Support raw CSV body with campaign_id in query params
    const url = new URL(request.url)
    campaignId = url.searchParams.get('campaign_id') || ''
    csvText = await request.text()
  } else {
    // Default: JSON body with { csv, campaign_id }
    let body: any
    try {
      body = await request.json()
    } catch {
      return json({ error: 'Invalid JSON body' }, 400)
    }
    csvText = body.csv
    campaignId = body.campaign_id
  }

  if (!campaignId) {
    return json({ error: 'Missing campaign_id' }, 400)
  }

  if (!csvText || !csvText.trim()) {
    return json({ error: 'Empty CSV data' }, 400)
  }

  // Enforce CSV size limit to prevent OOM
  const maxCsvSize = parseInt(env.MAX_CSV_SIZE || '5242880', 10)
  if (csvText.length > maxCsvSize) {
    return json({ error: `CSV too large (${(csvText.length / 1024 / 1024).toFixed(1)}MB). Max: ${(maxCsvSize / 1024 / 1024).toFixed(1)}MB` }, 400)
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

  // Enforce row count limit to prevent D1 write overload and Workers CPU timeout
  const MAX_CONTACTS_PER_IMPORT = parseInt(env.MAX_CONTACTS_PER_IMPORT || '10000', 10)
  if (contacts.length > MAX_CONTACTS_PER_IMPORT) {
    return json({
      error: `Too many contacts: ${contacts.length}. Maximum ${MAX_CONTACTS_PER_IMPORT} per import.`,
    }, 400)
  }

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
      // R2-9: Check meta.changes to only count rows actually inserted (not ON CONFLICT skips)
      const result = await env.DB.prepare(`
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
      if (result.meta?.changes) {
        imported++
      }
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
