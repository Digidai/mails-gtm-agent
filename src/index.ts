import { Env } from './types'
import { handleCampaignRoutes } from './routes/campaign'
import { handleContactsRoutes } from './routes/contacts'
import { handleUnsubscribeRoute } from './routes/unsubscribe'
import { handleGdprRoutes } from './routes/gdpr'
import { handleStepsRoutes } from './routes/steps'
import { handleStatsRoutes } from './routes/stats'
import { handlePreviewRoutes } from './routes/preview'
import { sendCron } from './scheduler/send-cron'
import { replyCron } from './scheduler/reply-cron'
import { sendConsumer } from './queue/send-consumer'

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

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url)
    const path = url.pathname

    // Handle CORS preflight
    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: CORS_HEADERS })
    }

    // Set defaults
    env.MAILS_API_URL = env.MAILS_API_URL || 'https://mails-worker.genedai.workers.dev'
    env.UNSUBSCRIBE_BASE_URL = env.UNSUBSCRIBE_BASE_URL || url.origin
    env.UNSUBSCRIBE_SECRET = env.UNSUBSCRIBE_SECRET || env.ADMIN_TOKEN // fallback for backwards compat
    env.DAILY_SEND_LIMIT = env.DAILY_SEND_LIMIT || '100'
    env.MAX_CSV_SIZE = env.MAX_CSV_SIZE || '5242880'

    // Public endpoint: unsubscribe
    if (path === '/unsubscribe') {
      return handleUnsubscribeRoute(request, env)
    }

    // Health check
    if (path === '/' || path === '/health') {
      return jsonResponse({ status: 'ok', service: 'mails-gtm-agent' })
    }

    // All /api/* routes require auth
    if (path.startsWith('/api/')) {
      if (!checkAuth(request, env)) {
        return jsonResponse({ error: 'Unauthorized' }, 401)
      }

      // Campaign sub-routes (steps, stats, preview) — match before generic campaign routes
      if (/^\/api\/campaign\/[a-f0-9]+\/steps$/.test(path)) {
        return handleStepsRoutes(request, env)
      }
      if (/^\/api\/campaign\/[a-f0-9]+\/stats$/.test(path)) {
        return handleStatsRoutes(request, env)
      }
      if (/^\/api\/campaign\/[a-f0-9]+\/preview$/.test(path)) {
        return handlePreviewRoutes(request, env)
      }

      // Campaign routes
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
    env.MAILS_API_URL = env.MAILS_API_URL || 'https://mails-worker.genedai.workers.dev'
    env.UNSUBSCRIBE_SECRET = env.UNSUBSCRIBE_SECRET || env.ADMIN_TOKEN
    env.DAILY_SEND_LIMIT = env.DAILY_SEND_LIMIT || '100'
    env.MAX_CSV_SIZE = env.MAX_CSV_SIZE || '5242880'

    if (event.cron === '* * * * *') {
      ctx.waitUntil(sendCron(env))
    }
    if (event.cron === '*/5 * * * *') {
      ctx.waitUntil(replyCron(env))
    }
  },

  async queue(batch: MessageBatch, env: Env): Promise<void> {
    env.MAILS_API_URL = env.MAILS_API_URL || 'https://mails-worker.genedai.workers.dev'
    env.UNSUBSCRIBE_SECRET = env.UNSUBSCRIBE_SECRET || env.ADMIN_TOKEN
    env.DAILY_SEND_LIMIT = env.DAILY_SEND_LIMIT || '100'
    env.MAX_CSV_SIZE = env.MAX_CSV_SIZE || '5242880'
    await sendConsumer(batch, env)
  },
}
