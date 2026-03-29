import { Env, Campaign, CampaignStep } from '../types'

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}

export async function handleCampaignRoutes(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url)
  const path = url.pathname
  const method = request.method

  // POST /api/campaign/create
  if (path === '/api/campaign/create' && method === 'POST') {
    return createCampaign(request, env)
  }

  // GET /api/campaign/list
  if (path === '/api/campaign/list' && method === 'GET') {
    return listCampaigns(env)
  }

  // GET /api/campaign/:id
  const detailMatch = path.match(/^\/api\/campaign\/([a-f0-9]+)$/)
  if (detailMatch && method === 'GET') {
    return getCampaign(detailMatch[1], env)
  }

  // POST /api/campaign/:id/start
  const startMatch = path.match(/^\/api\/campaign\/([a-f0-9]+)\/start$/)
  if (startMatch && method === 'POST') {
    return startCampaign(startMatch[1], env)
  }

  // POST /api/campaign/:id/pause
  const pauseMatch = path.match(/^\/api\/campaign\/([a-f0-9]+)\/pause$/)
  if (pauseMatch && method === 'POST') {
    return pauseCampaign(pauseMatch[1], env)
  }

  return json({ error: 'Not Found' }, 404)
}

async function createCampaign(request: Request, env: Env): Promise<Response> {
  const body = await request.json() as any

  const required = ['name', 'product_name', 'product_description']
  for (const field of required) {
    if (!body[field]) {
      return json({ error: `Missing required field: ${field}` }, 400)
    }
  }

  // Validate steps if provided
  const steps: CampaignStep[] = body.steps || [
    { delay_days: 0, subject_template: '', body_template: '' },
    { delay_days: 3, subject_template: '', body_template: '' },
    { delay_days: 5, subject_template: '', body_template: '' },
  ]

  const id = crypto.randomUUID().replace(/-/g, '')

  await env.DB.prepare(`
    INSERT INTO campaigns (id, name, product_name, product_description, from_email, physical_address, ai_generate, warmup_enabled, warmup_start_volume, warmup_increment, steps)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).bind(
    id,
    body.name,
    body.product_name,
    body.product_description,
    body.from_email || env.MAILS_MAILBOX,
    body.physical_address || '',
    body.ai_generate !== undefined ? (body.ai_generate ? 1 : 0) : 1,
    body.warmup_enabled !== undefined ? (body.warmup_enabled ? 1 : 0) : 1,
    body.warmup_start_volume || 10,
    body.warmup_increment || 5,
    JSON.stringify(steps),
  ).run()

  return json({ id, status: 'created' }, 201)
}

async function listCampaigns(env: Env): Promise<Response> {
  const result = await env.DB.prepare(`
    SELECT c.*,
      (SELECT COUNT(*) FROM campaign_contacts WHERE campaign_id = c.id) as total_contacts,
      (SELECT COUNT(*) FROM campaign_contacts WHERE campaign_id = c.id AND status = 'sent') as sent_count,
      (SELECT COUNT(*) FROM campaign_contacts WHERE campaign_id = c.id AND status = 'replied') as reply_count,
      (SELECT COUNT(*) FROM campaign_contacts WHERE campaign_id = c.id AND status = 'interested') as interested_count
    FROM campaigns c
    ORDER BY c.created_at DESC
  `).all()

  return json({ campaigns: result.results })
}

async function getCampaign(id: string, env: Env): Promise<Response> {
  const campaign = await env.DB.prepare('SELECT * FROM campaigns WHERE id = ?').bind(id).first()
  if (!campaign) {
    return json({ error: 'Campaign not found' }, 404)
  }

  const stats = await env.DB.prepare(`
    SELECT
      status,
      COUNT(*) as count
    FROM campaign_contacts
    WHERE campaign_id = ?
    GROUP BY status
  `).bind(id).all()

  const contacts = await env.DB.prepare(`
    SELECT * FROM campaign_contacts WHERE campaign_id = ? ORDER BY created_at DESC LIMIT 100
  `).bind(id).all()

  return json({
    campaign,
    stats: stats.results,
    contacts: contacts.results,
  })
}

async function startCampaign(id: string, env: Env): Promise<Response> {
  const campaign = await env.DB.prepare('SELECT * FROM campaigns WHERE id = ?').bind(id).first<Campaign>()
  if (!campaign) {
    return json({ error: 'Campaign not found' }, 404)
  }

  if (campaign.status !== 'draft' && campaign.status !== 'paused') {
    return json({ error: `Cannot start campaign in ${campaign.status} status` }, 400)
  }

  const now = new Date().toISOString()
  const updates: Record<string, string> = {
    status: 'active',
    updated_at: now,
  }

  // Set warmup start date if not already set
  if (!campaign.warmup_started_at && campaign.warmup_enabled) {
    updates.warmup_started_at = now
  }

  await env.DB.prepare(`
    UPDATE campaigns SET status = 'active', warmup_started_at = COALESCE(warmup_started_at, ?), updated_at = ? WHERE id = ?
  `).bind(now, now, id).run()

  // Set next_send_at for pending contacts that don't have one
  await env.DB.prepare(`
    UPDATE campaign_contacts SET next_send_at = ? WHERE campaign_id = ? AND status = 'pending' AND next_send_at IS NULL
  `).bind(now, id).run()

  return json({ id, status: 'active' })
}

async function pauseCampaign(id: string, env: Env): Promise<Response> {
  const campaign = await env.DB.prepare('SELECT * FROM campaigns WHERE id = ?').bind(id).first<Campaign>()
  if (!campaign) {
    return json({ error: 'Campaign not found' }, 404)
  }

  if (campaign.status !== 'active') {
    return json({ error: `Cannot pause campaign in ${campaign.status} status` }, 400)
  }

  await env.DB.prepare(`
    UPDATE campaigns SET status = 'paused', updated_at = datetime('now') WHERE id = ?
  `).bind(id).run()

  return json({ id, status: 'paused' })
}
