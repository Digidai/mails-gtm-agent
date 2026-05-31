import { Env } from '../types'

/**
 * GET /api/admin/info — single-call health + config dashboard.
 *
 * Designed for AI agent observability: one curl reveals secrets-configured,
 * LLM resolution, queue depth, active campaigns, recent errors. Agents can
 * grep this output to decide whether the deployment is ready, whether a
 * secret is missing, or whether a recent change introduced errors.
 *
 * Auth: Bearer ADMIN_TOKEN (same as all /api/* routes).
 */
export async function handleAdminInfo(request: Request, env: Env): Promise<Response> {
  if (request.method !== 'GET') {
    return Response.json({ error: 'Method not allowed' }, { status: 405 })
  }

  // ── 1. Worker version / build info (best effort) ──
  const version = (typeof globalThis !== 'undefined' && (globalThis as any).WORKER_VERSION) || 'unknown'

  // ── 2. Secrets/config status (we can only check PRESENCE, not values) ──
  const requiredSecrets = [
    'MAILS_API_KEY',
    'MAILS_MAILBOX',
    'MAILS_API_URL',
    'ADMIN_TOKEN',
    'UNSUBSCRIBE_SECRET',
    'UNSUBSCRIBE_BASE_URL',
  ] as const
  const optionalSecrets = ['WEBHOOK_SECRET', 'LLM_MODEL', 'LLM_BASE_URL'] as const
  const llmKeyAliases = ['LLM_API_KEY', 'EASYROUTER_API_KEY', 'OPENROUTER_API_KEY'] as const

  const has = (k: string) => typeof (env as any)[k] === 'string' && ((env as any)[k] as string).length > 0
  const present = (arr: readonly string[]) => arr.filter(has)
  const missing = (arr: readonly string[]) => arr.filter(k => !has(k))

  const llmKeyConfigured = llmKeyAliases.some(has)
  const llmProvider = (() => {
    if (env.LLM_BASE_URL) {
      try { return new URL(env.LLM_BASE_URL).hostname } catch { return 'custom' }
    }
    if (env.EASYROUTER_API_KEY) return 'easyrouter.io'
    if (env.OPENROUTER_API_KEY) return 'openrouter.ai (deprecated)'
    return 'easyrouter.io (default)'
  })()

  // ── 3. Live counts from D1 (cheap aggregate queries) ──
  let activeCampaigns = 0
  let totalCampaigns = 0
  let totalContacts = 0
  let activeContacts = 0
  let sendsToday = 0
  let dlqDepth = 0
  let recentErrors: Array<{ when: string; type: string; campaign_id: string | null }> = []
  let scheduledRepliesPending = 0
  let dbReachable = false

  try {
    const today = new Date().toISOString().slice(0, 10)
    const summary = await env.DB.prepare(`
      SELECT
        (SELECT COUNT(*) FROM campaigns) AS campaigns_total,
        (SELECT COUNT(*) FROM campaigns WHERE status='active') AS campaigns_active,
        (SELECT COUNT(*) FROM campaign_contacts) AS contacts_total,
        (SELECT COUNT(*) FROM campaign_contacts WHERE status='active') AS contacts_active,
        (SELECT COALESCE(sent_count, 0) FROM daily_stats WHERE campaign_id='__global__' AND date=?) AS sends_today,
        (SELECT COUNT(*) FROM scheduled_replies WHERE sent=0) AS scheduled_pending
    `).bind(today).first<{
      campaigns_total: number
      campaigns_active: number
      contacts_total: number
      contacts_active: number
      sends_today: number
      scheduled_pending: number
    }>()
    if (summary) {
      totalCampaigns = summary.campaigns_total
      activeCampaigns = summary.campaigns_active
      totalContacts = summary.contacts_total
      activeContacts = summary.contacts_active
      sendsToday = summary.sends_today
      scheduledRepliesPending = summary.scheduled_pending
      dbReachable = true
    }

    // Recent error-like events (last hour)
    const errRows = await env.DB.prepare(`
      SELECT created_at, event_type, campaign_id
      FROM events
      WHERE event_type IN ('campaign_error', 'contact_error', 'dlq_failure', 'content_blocked')
        AND datetime(created_at) > datetime('now', '-1 hour')
      ORDER BY created_at DESC
      LIMIT 10
    `).all<{ created_at: string; event_type: string; campaign_id: string | null }>()
    recentErrors = (errRows.results ?? []).map(r => ({
      when: r.created_at,
      type: r.event_type,
      campaign_id: r.campaign_id,
    }))
  } catch (err) {
    console.error('[admin/info] D1 query failed:', err instanceof Error ? err.message : String(err))
    // dbReachable stays false; clients can detect via reachable: false
  }

  // ── 4. Compose response ──
  return Response.json({
    ok: true,
    version,
    timestamp: new Date().toISOString(),
    db: {
      reachable: dbReachable,
    },
    secrets: {
      required_present: present(requiredSecrets),
      required_missing: missing(requiredSecrets),
      optional_present: present(optionalSecrets),
      llm_key_configured: llmKeyConfigured,
      llm_key_source: llmKeyConfigured
        ? (env.LLM_API_KEY ? 'LLM_API_KEY'
          : env.EASYROUTER_API_KEY ? 'EASYROUTER_API_KEY'
          : 'OPENROUTER_API_KEY (deprecated)')
        : null,
    },
    llm: {
      provider: llmProvider,
      model: env.LLM_MODEL || 'anthropic/claude-sonnet-4 (default)',
      base_url: env.LLM_BASE_URL || null,
    },
    state: {
      campaigns_total: totalCampaigns,
      campaigns_active: activeCampaigns,
      contacts_total: totalContacts,
      contacts_active: activeContacts,
      sends_today: sendsToday,
      scheduled_replies_pending: scheduledRepliesPending,
      dlq_depth: dlqDepth, // placeholder — Cloudflare doesn't expose queue depth via API yet
    },
    recent_errors_1h: recentErrors,
    // Read-only diagnostic flags that a calling agent can grep
    health: {
      missing_required_secrets: missing(requiredSecrets).length > 0,
      llm_not_configured: !llmKeyConfigured,
      db_unreachable: !dbReachable,
      has_recent_errors: recentErrors.length > 0,
    },
  })
}
