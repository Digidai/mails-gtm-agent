import { Env } from './types'
import { handleCampaignRoutes } from './routes/campaign'
import { handleContactsRoutes } from './routes/contacts'
import { handleUnsubscribeRoute } from './routes/unsubscribe'
import { handleGdprRoutes } from './routes/gdpr'
import { sendCron } from './scheduler/send-cron'
import { replyCron } from './scheduler/reply-cron'
import { sendConsumer } from './queue/send-consumer'

function jsonResponse(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}

function checkAuth(request: Request, env: Env): boolean {
  const auth = request.headers.get('Authorization')
  if (!auth) return false
  const token = auth.replace('Bearer ', '')
  return token === env.ADMIN_TOKEN
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url)
    const path = url.pathname

    // Set defaults
    env.MAILS_API_URL = env.MAILS_API_URL || 'https://mails-worker.genedai.workers.dev'
    env.UNSUBSCRIBE_BASE_URL = env.UNSUBSCRIBE_BASE_URL || url.origin
    env.DAILY_SEND_LIMIT = env.DAILY_SEND_LIMIT || '100'

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
    env.DAILY_SEND_LIMIT = env.DAILY_SEND_LIMIT || '100'

    if (event.cron === '* * * * *') {
      ctx.waitUntil(sendCron(env))
    }
    if (event.cron === '*/5 * * * *') {
      ctx.waitUntil(replyCron(env))
    }
  },

  async queue(batch: MessageBatch, env: Env): Promise<void> {
    env.MAILS_API_URL = env.MAILS_API_URL || 'https://mails-worker.genedai.workers.dev'
    env.DAILY_SEND_LIMIT = env.DAILY_SEND_LIMIT || '100'
    await sendConsumer(batch, env)
  },
}
