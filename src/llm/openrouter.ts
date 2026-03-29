import { Env } from '../types'

const OPENROUTER_URL = 'https://openrouter.ai/api/v1/chat/completions'
const LLM_TIMEOUT_MS = 30_000

export async function callLLM(env: Env, systemPrompt: string, userPrompt: string): Promise<string> {
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
        model: 'anthropic/claude-sonnet-4',
        max_tokens: 1024,
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userPrompt },
        ],
      }),
      signal: controller.signal,
    })

    if (res.status === 429) {
      throw new Error('OpenRouter rate limited (429). Retry later.')
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
  } finally {
    clearTimeout(timeoutId)
  }
}
