import { Env, KnowledgeBase } from '../types'
import { callLLM } from '../llm/openrouter'

const EXTRACT_SYSTEM_PROMPT = `Extract product information from this markdown content.
Return ONLY valid JSON:
{
  "product_name": "...",
  "tagline": "one-line description",
  "description": "2-3 sentence description",
  "features": ["feature 1", "feature 2", ...],
  "pricing": "pricing info or 'not found'",
  "use_cases": ["use case 1", ...],
  "install_command": "install command or null",
  "quick_start_steps": ["step 1", "step 2", ...],
  "faq": [{"q": "...", "a": "..."}, ...],
  "competitors": ["competitor 1", ...]
}`

/**
 * Generate a knowledge base from a product URL.
 * 1. Fetch page content as markdown via md.genedai.me
 * 2. Use LLM to extract structured product knowledge
 */
export async function generateKnowledgeBase(
  productUrl: string,
  env: Env,
): Promise<KnowledgeBase> {
  // 1. Fetch markdown via md.genedai.me (with 15s timeout)
  const mdController = new AbortController()
  const mdTimeout = setTimeout(() => mdController.abort(), 15_000)
  let mdRes: Response
  try {
    mdRes = await fetch(
      `https://md.genedai.me/url?url=${encodeURIComponent(productUrl)}&clean=true`,
      { signal: mdController.signal },
    )
  } finally {
    clearTimeout(mdTimeout)
  }

  if (!mdRes.ok) {
    throw new Error(`Failed to fetch product page: ${mdRes.status}`)
  }

  const markdown = await mdRes.text()

  if (!markdown || markdown.trim().length < 50) {
    throw new Error('Product page returned insufficient content')
  }

  // 2. Use LLM to extract structured knowledge (limit to 15k chars to control token cost)
  const raw = await callLLM(env, EXTRACT_SYSTEM_PROMPT, markdown.slice(0, 15000))

  // Parse JSON from LLM response
  const jsonMatch = raw.match(/\{[\s\S]*\}/)
  if (!jsonMatch) {
    throw new Error('LLM did not return valid JSON')
  }

  const parsed = JSON.parse(jsonMatch[0]) as KnowledgeBase

  // Validate minimum fields
  if (!parsed.product_name && !parsed.description) {
    throw new Error('LLM extraction returned empty product info')
  }

  return parsed
}

/**
 * Truncate knowledge base JSON to fit within token budget.
 * Target: ~3000 tokens (~12000 chars)
 */
export function truncateKnowledgeBase(kb: KnowledgeBase, maxChars = 12000): string {
  const json = JSON.stringify(kb, null, 2)
  if (json.length <= maxChars) return json

  // Progressively trim: FAQ first, then features, then use_cases
  const trimmed = { ...kb }

  if (trimmed.faq && trimmed.faq.length > 3) {
    trimmed.faq = trimmed.faq.slice(0, 3)
  }

  let result = JSON.stringify(trimmed, null, 2)
  if (result.length <= maxChars) return result

  if (trimmed.features && trimmed.features.length > 5) {
    trimmed.features = trimmed.features.slice(0, 5)
  }

  result = JSON.stringify(trimmed, null, 2)
  if (result.length <= maxChars) return result

  if (trimmed.use_cases && trimmed.use_cases.length > 3) {
    trimmed.use_cases = trimmed.use_cases.slice(0, 3)
  }

  if (trimmed.testimonials) {
    delete trimmed.testimonials
  }

  result = JSON.stringify(trimmed, null, 2)
  if (result.length <= maxChars) return result

  // Final fallback: hard truncate
  return result.slice(0, maxChars)
}
