import { Env } from '../types'

const OPENROUTER_URL = 'https://openrouter.ai/api/v1/chat/completions'

export async function callLLM(env: Env, systemPrompt: string, userPrompt: string): Promise<string> {
  const res = await fetch(OPENROUTER_URL, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${env.OPENROUTER_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: 'anthropic/claude-sonnet-4.6',
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userPrompt },
      ],
    }),
  })

  if (!res.ok) {
    const text = await res.text()
    throw new Error(`OpenRouter API error ${res.status}: ${text}`)
  }

  const data = await res.json() as any
  return data.choices[0].message.content
}
