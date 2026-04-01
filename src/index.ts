import { Env, EvaluateMessage } from './types'
import { handleCampaignRoutes } from './routes/campaign'
import { handleContactsRoutes } from './routes/contacts'
import { handleUnsubscribeRoute } from './routes/unsubscribe'
import { handleGdprRoutes } from './routes/gdpr'
import { handleStepsRoutes } from './routes/steps'
import { handleStatsRoutes } from './routes/stats'
import { handlePreviewRoutes } from './routes/preview'
import { sendCron } from './scheduler/send-cron'
import { agentCron } from './scheduler/agent-cron'
import { replyCron } from './scheduler/reply-cron'
import { summaryCron } from './scheduler/summary-cron'
import { sendConsumer } from './queue/send-consumer'
import { evaluateConsumer } from './queue/evaluate-consumer'
import { handleWebhookEvent } from './events/webhook'
import { recordEvent } from './events/record'

const CORS_HEADERS: Record<string, string> = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  'Access-Control-Max-Age': '86400',
}

function jsonResponse(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json', ...CORS_HEADERS },
  })
}

/** Constant-time string comparison to prevent timing attacks on auth tokens.
 *  Hashes both inputs first so the comparison always runs in fixed time,
 *  regardless of whether the input lengths differ. */
async function timingSafeEqual(a: string, b: string): Promise<boolean> {
  const encoder = new TextEncoder()
  const hashA = new Uint8Array(await crypto.subtle.digest('SHA-256', encoder.encode(a)))
  const hashB = new Uint8Array(await crypto.subtle.digest('SHA-256', encoder.encode(b)))
  let diff = 0
  for (let i = 0; i < hashA.length; i++) {
    diff |= hashA[i] ^ hashB[i]
  }
  return diff === 0
}

/**
 * Authenticate API requests via ADMIN_TOKEN.
 *
 * SECURITY NOTE: This is a single-tenant auth model. One ADMIN_TOKEN grants
 * full access to ALL campaigns. This is acceptable for single-user/single-org
 * deployments (one Worker instance per customer). For multi-tenant use, this
 * must be replaced with per-campaign or per-user auth (e.g., JWT with campaign_id claims).
 */
async function checkAuth(request: Request, env: Env): Promise<boolean> {
  const auth = request.headers.get('Authorization')
  if (!auth || !auth.startsWith('Bearer ')) return false
  const token = auth.slice(7) // "Bearer ".length === 7
  return timingSafeEqual(token, env.ADMIN_TOKEN)
}

async function setDefaults(env: Env, url?: URL): Promise<void> {
  env.MAILS_API_URL = env.MAILS_API_URL || 'https://mails-worker.genedai.workers.dev'
  if (!env.UNSUBSCRIBE_SECRET) {
    console.error('[SECURITY] UNSUBSCRIBE_SECRET not set! Deriving from ADMIN_TOKEN (not recommended for production)')
    // Derive a separate key rather than reusing ADMIN_TOKEN directly
    const encoder = new TextEncoder()
    const keyData = await crypto.subtle.digest('SHA-256', encoder.encode('unsubscribe:' + env.ADMIN_TOKEN))
    env.UNSUBSCRIBE_SECRET = Array.from(new Uint8Array(keyData)).map(b => b.toString(16).padStart(2, '0')).join('')
  }
  env.MAILS_MAILBOX = env.MAILS_MAILBOX || ''
  env.DAILY_SEND_LIMIT = env.DAILY_SEND_LIMIT || '100'
  env.MAX_CSV_SIZE = env.MAX_CSV_SIZE || '5242880'
  if (!env.UNSUBSCRIBE_BASE_URL) {
    env.UNSUBSCRIBE_BASE_URL = url?.origin || 'https://mails-gtm-agent.genedai.workers.dev'
  }
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url)
    const path = url.pathname

    // Handle CORS preflight
    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: CORS_HEADERS })
    }

    await setDefaults(env, url)

    // ===== PUBLIC ENDPOINTS (no auth) =====

    // Unsubscribe page
    if (path === '/unsubscribe') {
      return handleUnsubscribeRoute(request, env)
    }

    // Health check
    if (path === '/' || path === '/health') {
      return jsonResponse({ status: 'ok', service: 'mails-gtm-agent', version: 'v2' })
    }

    // Link tracking redirect: GET /t/:id
    const trackMatch = path.match(/^\/t\/([a-f0-9]+)$/)
    if (trackMatch && request.method === 'GET') {
      return handleTrackingRedirect(trackMatch[1], request, env)
    }

    // Webhook: POST /webhook/event/:campaign_id
    const webhookMatch = path.match(/^\/webhook\/event\/([a-f0-9]+)$/)
    if (webhookMatch && request.method === 'POST') {
      return handleWebhookEvent(request, webhookMatch[1], env)
    }

    // ===== AUTHENTICATED API ENDPOINTS =====

    if (path.startsWith('/api/')) {
      if (!(await checkAuth(request, env))) {
        return jsonResponse({ error: 'Unauthorized' }, 401)
      }

      // Campaign sub-routes — match before generic campaign routes
      if (/^\/api\/campaign\/[a-f0-9]+\/steps$/.test(path)) {
        return handleStepsRoutes(request, env)
      }
      if (/^\/api\/campaign\/[a-f0-9]+\/stats$/.test(path)) {
        return handleStatsRoutes(request, env)
      }
      if (/^\/api\/campaign\/[a-f0-9]+\/preview$/.test(path)) {
        return handlePreviewRoutes(request, env)
      }

      // Campaign routes (includes events, decisions, knowledge)
      if (path.startsWith('/api/campaign')) {
        return handleCampaignRoutes(request, env)
      }

      // Contacts routes
      if (path.startsWith('/api/contacts')) {
        return handleContactsRoutes(request, env)
      }

      // GDPR routes
      if (path.startsWith('/api/gdpr')) {
        return handleGdprRoutes(request, env)
      }
    }

    return jsonResponse({ error: 'Not Found' }, 404)
  },

  async scheduled(event: ScheduledEvent, env: Env, ctx: ExecutionContext): Promise<void> {
    await setDefaults(env)

    const minute = new Date(event.scheduledTime).getMinutes()

    // All crons run from the single * * * * * trigger for reliability
    // v1 sequence engine (every minute)
    ctx.waitUntil(sendCron(env))

    // v2 agent engine (every 10 minutes)
    if (minute % 10 === 0) {
      ctx.waitUntil(agentCron(env))
    }

    // Reply processing (every 5 minutes)
    if (minute % 5 === 0) {
      ctx.waitUntil(replyCron(env))
    }

    // Daily summary (once per day at 09:00 UTC)
    const hour = new Date(event.scheduledTime).getUTCHours()
    if (hour === 9 && minute === 0) {
      ctx.waitUntil(summaryCron(env))
    }
  },

  async queue(batch: MessageBatch, env: Env): Promise<void> {
    await setDefaults(env)

    // Check queue name to route to correct consumer
    const queueName = (batch as any).queue || ''

    if (queueName === 'mails-gtm-evaluate' || (batch.messages[0]?.body as any)?.type === 'evaluate') {
      await evaluateConsumer(batch as MessageBatch<EvaluateMessage>, env)
    } else {
      await sendConsumer(batch, env)
    }
  },
}

/**
 * Validate that a URL is safe to redirect to (prevent open redirect / protocol injection).
 * Only allow http: and https: schemes.
 */
function isSafeRedirectUrl(url: string): boolean {
  try {
    const parsed = new URL(url)
    return parsed.protocol === 'http:' || parsed.protocol === 'https:'
  } catch {
    return false
  }
}

/**
 * Handle GET /t/:id — link tracking redirect
 * 1. Look up tracked link
 * 2. Validate redirect URL safety
 * 3. Record click event (deduplicated)
 * 4. 302 redirect to original URL
 */
async function handleTrackingRedirect(linkId: string, request: Request, env: Env): Promise<Response> {
  // Look up tracked link
  const link = await env.DB.prepare(
    'SELECT * FROM tracked_links WHERE id = ?',
  ).bind(linkId).first<{
    id: string
    campaign_id: string
    contact_id: string
    original_url: string
  }>()

  if (!link) {
    return new Response('Not Found', { status: 404 })
  }

  // Validate redirect URL to prevent open redirect / javascript: injection
  if (!isSafeRedirectUrl(link.original_url)) {
    console.error(`Blocked unsafe redirect URL: ${link.original_url} (tracking_id=${linkId})`)
    return new Response('Bad Request: unsafe redirect URL', { status: 400 })
  }

  // Deduplicate: only record the first click per tracked link
  try {
    const alreadyClicked = await env.DB.prepare(
      "SELECT id FROM events WHERE contact_id = ? AND event_type = 'link_click' AND event_data LIKE ? LIMIT 1",
    ).bind(link.contact_id, `%"tracking_id":"${linkId}"%`).first()

    if (!alreadyClicked) {
      await recordEvent(env, link.campaign_id, link.contact_id, 'link_click', {
        url: link.original_url,
        tracking_id: linkId,
      })

      // Update contact last_click_at
      await env.DB.prepare(
        "UPDATE campaign_contacts SET last_click_at = datetime('now'), updated_at = datetime('now') WHERE id = ?",
      ).bind(link.contact_id).run()
    }
  } catch (err) {
    // Don't block redirect on event recording failure
    console.error('Failed to record click event:', err)
  }

  // 302 redirect to original URL
  return new Response(null, {
    status: 302,
    headers: { 'Location': link.original_url },
  })
}
