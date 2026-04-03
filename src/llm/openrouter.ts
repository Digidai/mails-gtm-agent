import { Env } from '../types'

const OPENROUTER_URL = 'https://openrouter.ai/api/v1/chat/completions'
const LLM_TIMEOUT_MS = 10_000
const MAX_RETRIES = 2
const RETRY_DELAYS = [1000, 3000] // 1s, 3s backoff

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

export async function callLLM(env: Env, systemPrompt: string, userPrompt: string): Promise<string> {
  let lastError: Error | null = null

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    if (attempt > 0) {
      await new Promise(r => setTimeout(r, RETRY_DELAYS[attempt - 1]))
    }

    const controller = new AbortController()
    const timeoutId = setTimeout(() => controller.abort(), LLM_TIMEOUT_MS)

    try {
      const res = await fetch(OPENROUTER_URL, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${env.OPENROUTER_API_KEY}`,
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
        lastError = new Error('OpenRouter rate limited (429)')
        if (attempt < MAX_RETRIES) {
          console.warn(`[LLM] 429 rate limited, retrying in ${RETRY_DELAYS[attempt]}ms (attempt ${attempt + 1}/${MAX_RETRIES + 1})`)
          continue
        }
        throw lastError
      }

      if (!res.ok) {
        const text = await res.text()
        throw new Error(`OpenRouter API error ${res.status}: ${text}`)
      }

      const data = await res.json() as any
      const content = data?.choices?.[0]?.message?.content
      if (typeof content !== 'string' || !content.trim()) {
        throw new Error('OpenRouter returned empty or invalid content')
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
