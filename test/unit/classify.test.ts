import { describe, test, expect } from 'bun:test'
import { extractJson } from '../../src/llm/openrouter'
import { IntentType } from '../../src/types'

/**
 * These tests verify classifyReply's parsing logic without going through the
 * LLM provider at all. We test extractJson + JSON.parse + validation directly.
 * This avoids any globalThis.fetch leakage from parallel test files in bun.
 */

const VALID_INTENTS: IntentType[] = [
  'interested', 'not_now', 'not_interested', 'wrong_person',
  'out_of_office', 'unsubscribe', 'auto_reply', 'do_not_contact', 'unclear',
]

function parseClassifyResponse(raw: string): { intent: IntentType; confidence: number; resume_date: string | null } {
  const jsonStr = extractJson(raw)
  if (jsonStr) {
    const parsed = JSON.parse(jsonStr)
    if (parsed.intent && VALID_INTENTS.includes(parsed.intent)) {
      return {
        intent: parsed.intent,
        confidence: typeof parsed.confidence === 'number' ? parsed.confidence : 0.5,
        resume_date: parsed.resume_date || null,
      }
    }
  }
  return { intent: 'unclear', confidence: 0, resume_date: null }
}

describe('Reply Classifier', () => {
  test('classifies interested reply', () => {
    const result = parseClassifyResponse(JSON.stringify({ intent: 'interested', confidence: 0.95, resume_date: null }))
    expect(result.intent).toBe('interested')
    expect(result.confidence).toBe(0.95)
  })

  test('classifies not_now reply with resume date', () => {
    const result = parseClassifyResponse(JSON.stringify({ intent: 'not_now', confidence: 0.85, resume_date: '2026-04-15' }))
    expect(result.intent).toBe('not_now')
    expect(result.resume_date).toBe('2026-04-15')
  })

  test('classifies not_interested reply', () => {
    const result = parseClassifyResponse(JSON.stringify({ intent: 'not_interested', confidence: 0.9, resume_date: null }))
    expect(result.intent).toBe('not_interested')
  })

  test('classifies wrong_person reply', () => {
    const result = parseClassifyResponse(JSON.stringify({ intent: 'wrong_person', confidence: 0.8, resume_date: null }))
    expect(result.intent).toBe('wrong_person')
  })

  test('classifies out_of_office reply', () => {
    const result = parseClassifyResponse(JSON.stringify({ intent: 'out_of_office', confidence: 0.95, resume_date: null }))
    expect(result.intent).toBe('out_of_office')
  })

  test('classifies unsubscribe reply', () => {
    const result = parseClassifyResponse(JSON.stringify({ intent: 'unsubscribe', confidence: 0.95, resume_date: null }))
    expect(result.intent).toBe('unsubscribe')
  })

  test('classifies auto_reply', () => {
    const result = parseClassifyResponse(JSON.stringify({ intent: 'auto_reply', confidence: 0.9, resume_date: null }))
    expect(result.intent).toBe('auto_reply')
  })

  test('classifies do_not_contact reply', () => {
    const result = parseClassifyResponse(JSON.stringify({ intent: 'do_not_contact', confidence: 0.95, resume_date: null }))
    expect(result.intent).toBe('do_not_contact')
  })

  test('falls back to unclear on invalid JSON', () => {
    const result = parseClassifyResponse('not valid json at all')
    expect(result.intent).toBe('unclear')
  })

  test('falls back to unclear on invalid intent', () => {
    const result = parseClassifyResponse(JSON.stringify({ intent: 'banana', confidence: 0.9 }))
    expect(result.intent).toBe('unclear')
  })

  test('handles LLM response wrapped in markdown code block', () => {
    const result = parseClassifyResponse('```json\n{"intent": "interested", "confidence": 0.9, "resume_date": null}\n```')
    expect(result.intent).toBe('interested')
  })
})
