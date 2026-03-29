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

/** Constant-time string comparison to prevent timing attacks on auth tokens */
function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false
  let diff = 0
  for (let i = 0; i < a.length; i++) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i)
  }
  return diff === 0
}

function checkAuth(request: Request, env: Env): boolean {
  const auth = request.headers.get('Authorization')
  if (!auth || !auth.startsWith('Bearer ')) return false
  const token = auth.slice(7) // "Bearer ".length === 7
  return timingSafeEqual(token, env.ADMIN_TOKEN)
}

function setDefaults(env: Env, url?: URL): void {
  env.MAILS_API_URL = env.MAILS_API_URL || 'https://mails-worker.genedai.workers.dev'
  env.UNSUBSCRIBE_SECRET = env.UNSUBSCRIBE_SECRET || env.ADMIN_TOKEN
  env.DAILY_SEND_LIMIT = env.DAILY_SEND_LIMIT || '100'
  env.MAX_CSV_SIZE = env.MAX_CSV_SIZE || '5242880'
  if (url) {
    env.UNSUBSCRIBE_BASE_URL = env.UNSUBSCRIBE_BASE_URL || url.origin
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

    setDefaults(env, url)

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
      if (!checkAuth(request, env)) {
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
    setDefaults(env)

    if (event.cron === '* * * * *') {
      // v1 sequence engine cron (every minute)
      ctx.waitUntil(sendCron(env))
    }
    if (event.cron === '*/10 * * * *') {
      // v2 agent engine cron (every 10 minutes)
      ctx.waitUntil(agentCron(env))
    }
    if (event.cron === '*/5 * * * *') {
      // Reply processing (both engines)
      ctx.waitUntil(replyCron(env))
    }
  },

  async queue(batch: MessageBatch, env: Env): Promise<void> {
    setDefaults(env)

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
 * Handle GET /t/:id — link tracking redirect
 * 1. Look up tracked link
 * 2. Record click event
 * 3. 302 redirect to original URL
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

  // Simple rate limiting: check IP + link_id
  // (In production, use KV for rate limiting. For now, always record.)
  try {
    await recordEvent(env, link.campaign_id, link.contact_id, 'link_click', {
      url: link.original_url,
      tracking_id: linkId,
    })

    // Update contact last_click_at
    await env.DB.prepare(
      "UPDATE campaign_contacts SET last_click_at = datetime('now'), updated_at = datetime('now') WHERE id = ?",
    ).bind(link.contact_id).run()
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
