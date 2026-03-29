import { Env, Campaign, CampaignStep } from '../types'

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}

export async function handleStatsRoutes(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url)
  const path = url.pathname
  const method = request.method

  // GET /api/campaign/:id/stats
  const match = path.match(/^\/api\/campaign\/([a-f0-9]+)\/stats$/)
  if (match && method === 'GET') {
    return getCampaignStats(match[1], env)
  }

  return json({ error: 'Not Found' }, 404)
}

async function getCampaignStats(campaignId: string, env: Env): Promise<Response> {
  // 1. Get campaign
  const campaign = await env.DB.prepare('SELECT * FROM campaigns WHERE id = ?').bind(campaignId).first<Campaign>()
  if (!campaign) {
    return json({ error: 'Campaign not found' }, 404)
  }

  // 2. Get total contacts
  const totalRow = await env.DB.prepare(
    'SELECT COUNT(*) as count FROM campaign_contacts WHERE campaign_id = ?'
  ).bind(campaignId).first<{ count: number }>()
  const totalContacts = totalRow?.count || 0

  // 3. Get contacts grouped by status
  const statusRows = await env.DB.prepare(`
    SELECT status, COUNT(*) as count
    FROM campaign_contacts
    WHERE campaign_id = ?
    GROUP BY status
  `).bind(campaignId).all<{ status: string; count: number }>()

  const byStatus: Record<string, number> = {}
  for (const row of statusRows.results || []) {
    byStatus[row.status] = row.count
  }

  // 4. Get per-step stats
  const steps: CampaignStep[] = JSON.parse(campaign.steps || '[]')
  const stepStats: Array<{ step_number: number; sent: number; pending: number }> = []

  if (steps.length > 0) {
    // Count sent per step from send_log
    const sentPerStep = await env.DB.prepare(`
      SELECT step_number, COUNT(*) as count
      FROM send_log
      WHERE campaign_id = ? AND status = 'sent'
      GROUP BY step_number
    `).bind(campaignId).all<{ step_number: number; count: number }>()

    const sentMap: Record<number, number> = {}
    for (const row of sentPerStep.results || []) {
      sentMap[row.step_number] = row.count
    }

    // Count pending per step from campaign_contacts
    const pendingPerStep = await env.DB.prepare(`
      SELECT current_step, COUNT(*) as count
      FROM campaign_contacts
      WHERE campaign_id = ? AND status = 'pending'
      GROUP BY current_step
    `).bind(campaignId).all<{ current_step: number; count: number }>()

    const pendingMap: Record<number, number> = {}
    for (const row of pendingPerStep.results || []) {
      pendingMap[row.current_step] = row.count
    }

    for (let i = 0; i < steps.length; i++) {
      const stepNum = typeof (steps[i] as any).step_number === 'number' ? (steps[i] as any).step_number : i + 1
      stepStats.push({
        step_number: stepNum,
        sent: sentMap[stepNum] || 0,
        pending: pendingMap[stepNum] || 0,
      })
    }
  }

  // 5. Get today's sent count + daily limit
  const today = new Date().toISOString().slice(0, 10)
  const todaySentRow = await env.DB.prepare(`
    SELECT COALESCE(sent_count, 0) as count
    FROM daily_stats
    WHERE campaign_id = ? AND date = ?
  `).bind(campaignId, today).first<{ count: number }>()
  const todaySent = todaySentRow?.count || 0

  const dailyLimit = parseInt(env.DAILY_SEND_LIMIT || '100', 10)

  return json({
    campaign_id: campaignId,
    name: campaign.name,
    status: campaign.status,
    total_contacts: totalContacts,
    by_status: byStatus,
    steps: stepStats,
    today_sent: todaySent,
    daily_limit: dailyLimit,
  })
}
