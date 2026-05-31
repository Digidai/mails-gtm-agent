import { Env } from '../types'

const DEFAULT_BASE_URL = 'https://easyrouter.io/v1/chat/completions'
const OPENROUTER_BASE_URL = 'https://openrouter.ai/api/v1/chat/completions'
const LLM_TIMEOUT_MS = 20_000
const MAX_RETRIES = 2
const RETRY_DELAYS = [1000, 3000] // 1s, 3s backoff

/**
 * Resolve the LLM provider config (API key + base URL) from env.
 *
 * Order of preference (first hit wins):
 * 1. LLM_API_KEY + LLM_BASE_URL — generic, provider-agnostic. Recommended.
 * 2. EASYROUTER_API_KEY (alone) — auto-routes to easyrouter.io.
 * 3. OPENROUTER_API_KEY (alone) — backward compat, auto-routes to openrouter.ai
 *    and emits a one-time deprecation warning.
 *
 * The default base URL is EasyRouter. Override via LLM_BASE_URL to point at
 * any OpenAI-API-compatible gateway (OpenAI itself, OpenRouter, EasyRouter,
 * a self-hosted vLLM/LiteLLM, etc.).
 */
function resolveLlmConfig(env: Env): { apiKey: string; baseUrl: string } {
  if (env.LLM_API_KEY) {
    return {
      apiKey: env.LLM_API_KEY,
      baseUrl: env.LLM_BASE_URL || DEFAULT_BASE_URL,
    }
  }
  if (env.EASYROUTER_API_KEY) {
    return {
      apiKey: env.EASYROUTER_API_KEY,
      baseUrl: env.LLM_BASE_URL || DEFAULT_BASE_URL,
    }
  }
  if (env.OPENROUTER_API_KEY) {
    if (!_warnedDeprecation) {
      console.warn(
        '[LLM] OPENROUTER_API_KEY is deprecated — set LLM_API_KEY (and optionally LLM_BASE_URL) instead. ' +
        'Routing requests to openrouter.ai for backward compatibility.',
      )
      _warnedDeprecation = true
    }
    return {
      apiKey: env.OPENROUTER_API_KEY,
      baseUrl: env.LLM_BASE_URL || OPENROUTER_BASE_URL,
    }
  }
  throw new Error(
    'No LLM API key configured. Set LLM_API_KEY (preferred) or EASYROUTER_API_KEY ' +
    'via `wrangler secret put`. See README for details.',
  )
}
let _warnedDeprecation = false

/**
 * Extract the first balanced JSON object from a string.
 * Unlike the greedy regex /\{[\s\S]*\}/, this correctly handles nested braces
 * and won't accidentally match from the first { to the last } across multiple objects.
 */
export function extractJson(text: string): string | null {
  const start = text.indexOf('{')
  if (start === -1) return null

  let depth = 0
  let inString = false
  let escape = false

  for (let i = start; i < text.length; i++) {
    const ch = text[i]

    if (escape) {
      escape = false
      continue
    }

    if (ch === '\\' && inString) {
      escape = true
      continue
    }

    if (ch === '"') {
      inString = !inString
      continue
    }

    if (inString) continue

    if (ch === '{') depth++
    else if (ch === '}') {
      depth--
      if (depth === 0) {
        return text.slice(start, i + 1)
      }
    }
  }

  // Fallback: if balanced extraction fails, try greedy regex
  const fallback = text.match(/\{[\s\S]*\}/)
  return fallback ? fallback[0] : null
}

/**
 * Call the configured LLM with a system + user prompt. Returns the assistant
 * message content. Retries on 429 with 1s / 3s backoff. Throws on hard
 * failures after MAX_RETRIES.
 *
 * Provider is whichever OpenAI-API-compatible gateway is configured (see
 * resolveLlmConfig). Defaults to EasyRouter; supports OpenRouter/OpenAI/etc
 * via LLM_BASE_URL.
 */
export async function callLLM(env: Env, systemPrompt: string, userPrompt: string): Promise<string> {
  const { apiKey, baseUrl } = resolveLlmConfig(env)
  let lastError: Error | null = null

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    if (attempt > 0) {
      await new Promise(r => setTimeout(r, RETRY_DELAYS[attempt - 1]))
    }

    const controller = new AbortController()
    const timeoutId = setTimeout(() => controller.abort(), LLM_TIMEOUT_MS)

    try {
      const res = await fetch(baseUrl, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          model: env?.LLM_MODEL || 'anthropic/claude-sonnet-4',
          max_tokens: 1024,
          messages: [
            { role: 'system', content: systemPrompt },
            { role: 'user', content: userPrompt },
          ],
        }),
        signal: controller.signal,
      })

      if (res.status === 429) {
        lastError = new Error('LLM provider rate limited (429)')
        if (attempt < MAX_RETRIES) {
          console.warn(`[LLM] 429 rate limited, retrying in ${RETRY_DELAYS[attempt]}ms (attempt ${attempt + 1}/${MAX_RETRIES + 1})`)
          continue
        }
        throw lastError
      }

      if (!res.ok) {
        const text = await res.text()
        throw new Error(`LLM API error ${res.status}: ${text}`)
      }

      const data = await res.json() as any
      const content = data?.choices?.[0]?.message?.content
      if (typeof content !== 'string' || !content.trim()) {
        throw new Error('LLM returned empty or invalid content')
      }
      return content
    } catch (err) {
      if (err instanceof Error && err.message.includes('429') && attempt < MAX_RETRIES) {
        lastError = err
        continue
      }
      throw err
    } finally {
      clearTimeout(timeoutId)
    }
  }

  throw lastError || new Error('LLM call failed after all retries')
}
