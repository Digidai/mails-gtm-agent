import { Env } from './types'

/**
 * Call mails-agent API. Uses Service Binding if available (avoids Cloudflare
 * error 1042 on worker-to-worker calls), falls back to HTTP fetch.
 */
export async function mailsFetch(env: Env, path: string, init?: RequestInit): Promise<Response> {
  const headers = {
    'Authorization': `Bearer ${env.MAILS_API_KEY}`,
    ...(init?.headers || {}),
  }

  if (env.MAILS_WORKER) {
    // Service binding: call mails-worker directly (no HTTP, no 1042)
    return env.MAILS_WORKER.fetch(
      new Request(`https://mails-worker.internal${path}`, { ...init, headers }),
    )
  }

  // Fallback: HTTP fetch (works from local dev, fails with 1042 in same-account Workers)
  return fetch(`${env.MAILS_API_URL}${path}`, { ...init, headers })
}
