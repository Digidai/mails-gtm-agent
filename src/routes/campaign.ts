import { Env, Campaign, CampaignStep, KnowledgeBase } from '../types'
import { generateKnowledgeBase } from '../knowledge/generate'
import { createProvider } from '../llm/provider'

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

  // GET /api/campaign/:id/events
  const eventsMatch = path.match(/^\/api\/campaign\/([a-f0-9]+)\/events$/)
  if (eventsMatch && method === 'GET') {
    return getCampaignEvents(eventsMatch[1], url, env)
  }

  // GET /api/campaign/:id/decisions
  const decisionsMatch = path.match(/^\/api\/campaign\/([a-f0-9]+)\/decisions$/)
  if (decisionsMatch && method === 'GET') {
    return getCampaignDecisions(decisionsMatch[1], url, env)
  }

  // POST /api/campaign/:id/knowledge
  const knowledgePostMatch = path.match(/^\/api\/campaign\/([a-f0-9]+)\/knowledge$/)
  if (knowledgePostMatch && method === 'POST') {
    return updateKnowledge(knowledgePostMatch[1], request, env)
  }

  // POST /api/campaign/:id/knowledge/refresh
  const knowledgeRefreshMatch = path.match(/^\/api\/campaign\/([a-f0-9]+)\/knowledge\/refresh$/)
  if (knowledgeRefreshMatch && method === 'POST') {
    return refreshKnowledge(knowledgeRefreshMatch[1], env)
  }

  return json({ error: 'Not Found' }, 404)
}

async function createCampaign(request: Request, env: Env): Promise<Response> {
  const body = await request.json() as any

  const engine = body.engine || 'agent'

  if (engine === 'sequence') {
    // v1 sequence campaign: require name, product_name, product_description
    const required = ['name', 'product_name', 'product_description']
    for (const field of required) {
      if (!body[field]) {
        return json({ error: `Missing required field: ${field}` }, 400)
      }
    }
  } else {
    // v2 agent campaign: require name and either knowledge_base or product_name+product_description
    if (!body.name) {
      return json({ error: 'Missing required field: name' }, 400)
    }
    if (!body.knowledge_base && !body.product_name && !body.product_url) {
      return json({ error: 'Agent campaigns require knowledge_base, product_name, or product_url' }, 400)
    }
  }

  // Validate conversion_url and product_url are safe http(s) URLs
  if (body.conversion_url) {
    if (!/^https?:\/\//i.test(body.conversion_url)) {
      body.conversion_url = 'https://' + body.conversion_url
    }
    try {
      const parsed = new URL(body.conversion_url)
      if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
        return json({ error: 'conversion_url must use http or https protocol' }, 400)
      }
    } catch {
      return json({ error: 'conversion_url is not a valid URL' }, 400)
    }
  }

  if (body.product_url) {
    // Auto-prepend https:// if no protocol is specified
    if (!/^https?:\/\//i.test(body.product_url)) {
      body.product_url = 'https://' + body.product_url
    }
    try {
      const parsed = new URL(body.product_url)
      if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
        return json({ error: 'product_url must use http or https protocol' }, 400)
      }
    } catch {
      return json({ error: 'product_url is not a valid URL' }, 400)
    }
  }

  // Determine from_email: explicit > env > reject
  const fromEmail = body.from_email || env.MAILS_MAILBOX
  if (!fromEmail) {
    return json({ error: 'from_email is required (or set MAILS_MAILBOX environment variable)' }, 400)
  }

  const steps: CampaignStep[] = body.steps || [
    { delay_days: 0, subject_template: '', body_template: '' },
    { delay_days: 3, subject_template: '', body_template: '' },
    { delay_days: 5, subject_template: '', body_template: '' },
  ]

  const id = crypto.randomUUID().replace(/-/g, '')
  const webhookSecret = crypto.randomUUID()

  // Handle knowledge_base
  let knowledgeBase = body.knowledge_base || '{}'
  let knowledgeBaseStatus = 'pending'
  if (typeof knowledgeBase === 'object') {
    knowledgeBase = JSON.stringify(knowledgeBase)
    knowledgeBaseStatus = 'manual'
  } else if (typeof knowledgeBase === 'string' && knowledgeBase !== '{}') {
    knowledgeBaseStatus = 'manual'
  }

  await env.DB.prepare(`
    INSERT INTO campaigns (
      id, name, product_name, product_description, from_email, physical_address,
      ai_generate, warmup_enabled, warmup_start_volume, warmup_increment, steps,
      engine, product_url, conversion_url, knowledge_base, knowledge_base_status,
      max_emails, min_interval_days, webhook_secret, dry_run, webhook_callback_url
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).bind(
    id,
    body.name,
    body.product_name || '',
    body.product_description || '',
    fromEmail,
    body.physical_address || '',
    body.ai_generate !== undefined ? (body.ai_generate ? 1 : 0) : 1,
    body.warmup_enabled !== undefined ? (body.warmup_enabled ? 1 : 0) : 1,
    body.warmup_start_volume || 10,
    body.warmup_increment || 5,
    JSON.stringify(steps),
    engine,
    body.product_url || null,
    body.conversion_url || null,
    knowledgeBase,
    knowledgeBaseStatus,
    body.max_emails || 6,
    body.min_interval_days || 2,
    webhookSecret,
    body.dry_run ? 1 : 0,
    body.webhook_callback_url || null,
  ).run()

  // If product_url is provided, try to generate knowledge base asynchronously
  if (body.product_url && engine === 'agent') {
    try {
      await env.DB.prepare(
        "UPDATE campaigns SET knowledge_base_status = 'generating' WHERE id = ?",
      ).bind(id).run()

      const kb = await generateKnowledgeBase(body.product_url, createProvider(env))

      await env.DB.prepare(
        "UPDATE campaigns SET knowledge_base = ?, knowledge_base_status = 'ready' WHERE id = ?",
      ).bind(JSON.stringify(kb), id).run()
    } catch (kbErr) {
      console.error(`[campaign] Knowledge base generation failed for campaign ${id}:`, kbErr)
      await env.DB.prepare(
        "UPDATE campaigns SET knowledge_base_status = 'failed', updated_at = datetime('now') WHERE id = ?"
      ).bind(id).run()
      // Don't throw — campaign was created, KB can be retried
    }
  }

  const response: Record<string, unknown> = {
    id,
    engine,
    status: 'created',
    webhook_secret: webhookSecret,
  }

  return json(response, 201)
}

async function listCampaigns(env: Env): Promise<Response> {
  const result = await env.DB.prepare(`
    SELECT c.*,
      (SELECT COUNT(*) FROM campaign_contacts WHERE campaign_id = c.id) as total_contacts,
      (SELECT COUNT(*) FROM campaign_contacts WHERE campaign_id = c.id AND status IN ('sent', 'active')) as sent_count,
      (SELECT COUNT(*) FROM campaign_contacts WHERE campaign_id = c.id AND status IN ('replied', 'interested')) as reply_count,
      (SELECT COUNT(*) FROM campaign_contacts WHERE campaign_id = c.id AND status = 'interested') as interested_count,
      (SELECT COUNT(*) FROM campaign_contacts WHERE campaign_id = c.id AND status = 'converted') as converted_count
    FROM campaigns c
    ORDER BY c.created_at DESC
  `).all()

  return json({ campaigns: result.results })
}

async function getCampaign(id: string, env: Env): Promise<Response> {
  const campaign = await env.DB.prepare('SELECT * FROM campaigns WHERE id = ?').bind(id).first<Campaign>()
  if (!campaign) {
    return json({ error: 'Campaign not found' }, 404)
  }

  // Self-heal stale 'generating' status: if updated_at is more than 2 minutes ago,
  // the generation likely timed out (Worker killed). Reset to 'failed' so the user
  // can retry via /knowledge/refresh.
  if (campaign.knowledge_base_status === 'generating') {
    const updatedAt = new Date(campaign.updated_at).getTime()
    const twoMinutesAgo = Date.now() - 2 * 60 * 1000
    if (updatedAt < twoMinutesAgo) {
      await env.DB.prepare(
        "UPDATE campaigns SET knowledge_base_status = 'failed', updated_at = datetime('now') WHERE id = ? AND knowledge_base_status = 'generating'",
      ).bind(id).run()
      ;(campaign as any).knowledge_base_status = 'failed'
    }
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

  const contactCount = await env.DB.prepare(
    'SELECT COUNT(*) as count FROM campaign_contacts WHERE campaign_id = ?'
  ).bind(id).first<{ count: number }>()

  if (!contactCount?.count) {
    return json({ error: 'Cannot start campaign with 0 contacts. Import contacts first.' }, 400)
  }

  if (!campaign.physical_address || !campaign.physical_address.trim()) {
    return json({ error: 'CAN-SPAM compliance requires a physical mailing address. Update campaign with physical_address.' }, 400)
  }

  const now = new Date().toISOString()

  if (campaign.engine === 'agent') {
    // v2: set status to active, contacts stay as 'pending' (agent-cron will pick them up)
    await env.DB.prepare(`
      UPDATE campaigns SET status = 'active', warmup_started_at = COALESCE(warmup_started_at, ?), updated_at = ? WHERE id = ?
    `).bind(now, now, id).run()
  } else {
    // v1: sequence engine
    if (!campaign.warmup_started_at && campaign.warmup_enabled) {
      // handled in the query
    }

    await env.DB.prepare(`
      UPDATE campaigns SET status = 'active', warmup_started_at = COALESCE(warmup_started_at, ?), updated_at = ? WHERE id = ?
    `).bind(now, now, id).run()

    await env.DB.prepare(`
      UPDATE campaign_contacts SET next_send_at = ? WHERE campaign_id = ? AND status = 'pending' AND next_send_at IS NULL
    `).bind(now, id).run()
  }

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

async function getCampaignEvents(id: string, url: URL, env: Env): Promise<Response> {
  const campaign = await env.DB.prepare('SELECT id FROM campaigns WHERE id = ?').bind(id).first()
  if (!campaign) {
    return json({ error: 'Campaign not found' }, 404)
  }

  const limit = Math.min(parseInt(url.searchParams.get('limit') || '50', 10), 500)
  const offset = parseInt(url.searchParams.get('offset') || '0', 10)
  const contactId = url.searchParams.get('contact_id')

  let query = 'SELECT * FROM events WHERE campaign_id = ?'
  const params: any[] = [id]

  if (contactId) {
    query += ' AND contact_id = ?'
    params.push(contactId)
  }

  query += ' ORDER BY created_at DESC LIMIT ? OFFSET ?'
  params.push(limit, offset)

  const result = await env.DB.prepare(query).bind(...params).all()

  return json({ events: result.results })
}

async function getCampaignDecisions(id: string, url: URL, env: Env): Promise<Response> {
  const campaign = await env.DB.prepare('SELECT id FROM campaigns WHERE id = ?').bind(id).first()
  if (!campaign) {
    return json({ error: 'Campaign not found' }, 404)
  }

  const limit = Math.min(parseInt(url.searchParams.get('limit') || '50', 10), 500)
  const offset = parseInt(url.searchParams.get('offset') || '0', 10)
  const contactId = url.searchParams.get('contact_id')

  let query = 'SELECT * FROM decision_log WHERE campaign_id = ?'
  const params: any[] = [id]

  if (contactId) {
    query += ' AND contact_id = ?'
    params.push(contactId)
  }

  query += ' ORDER BY created_at DESC LIMIT ? OFFSET ?'
  params.push(limit, offset)

  const result = await env.DB.prepare(query).bind(...params).all()

  return json({ decisions: result.results })
}

async function updateKnowledge(id: string, request: Request, env: Env): Promise<Response> {
  const campaign = await env.DB.prepare('SELECT id FROM campaigns WHERE id = ?').bind(id).first()
  if (!campaign) {
    return json({ error: 'Campaign not found' }, 404)
  }

  const body = await request.json() as any

  if (!body.knowledge_base || typeof body.knowledge_base !== 'object') {
    return json({ error: 'knowledge_base must be a JSON object' }, 400)
  }

  await env.DB.prepare(
    "UPDATE campaigns SET knowledge_base = ?, knowledge_base_status = 'manual', updated_at = datetime('now') WHERE id = ?",
  ).bind(JSON.stringify(body.knowledge_base), id).run()

  return json({ id, knowledge_base_status: 'manual' })
}

async function refreshKnowledge(id: string, env: Env): Promise<Response> {
  const campaign = await env.DB.prepare(
    'SELECT id, product_url FROM campaigns WHERE id = ?',
  ).bind(id).first<{ id: string; product_url: string | null }>()

  if (!campaign) {
    return json({ error: 'Campaign not found' }, 404)
  }

  if (!campaign.product_url) {
    return json({ error: 'No product_url configured for this campaign' }, 400)
  }

  try {
    await env.DB.prepare(
      "UPDATE campaigns SET knowledge_base_status = 'generating' WHERE id = ?",
    ).bind(id).run()

    const kb = await generateKnowledgeBase(campaign.product_url, createProvider(env))

    await env.DB.prepare(
      "UPDATE campaigns SET knowledge_base = ?, knowledge_base_status = 'ready', updated_at = datetime('now') WHERE id = ?",
    ).bind(JSON.stringify(kb), id).run()

    return json({ id, knowledge_base_status: 'ready', knowledge_base: kb })
  } catch (err) {
    await env.DB.prepare(
      "UPDATE campaigns SET knowledge_base_status = 'failed', updated_at = datetime('now') WHERE id = ?",
    ).bind(id).run()

    return json({ error: `Knowledge generation failed: ${(err as Error).message}` }, 500)
  }
}
