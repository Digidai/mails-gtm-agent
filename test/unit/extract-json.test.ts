import { describe, test, expect } from 'bun:test'
import { extractJson } from '../../src/llm/openrouter'

describe('extractJson', () => {
  test('extracts simple JSON object', () => {
    const result = extractJson('{"action": "send", "reasoning": "test"}')
    expect(result).toBe('{"action": "send", "reasoning": "test"}')
  })

  test('extracts JSON from markdown code block', () => {
    const input = 'Here is the result:\n```json\n{"action": "wait", "wait_days": 3}\n```\nDone.'
    const result = extractJson(input)
    expect(JSON.parse(result!)).toEqual({ action: 'wait', wait_days: 3 })
  })

  test('extracts first JSON object when multiple exist', () => {
    const input = 'First: {"a": 1} Second: {"b": 2}'
    const result = extractJson(input)
    expect(JSON.parse(result!)).toEqual({ a: 1 })
  })

  test('handles nested braces correctly', () => {
    const input = '{"action": "send", "email": {"subject": "Hi", "body": "Hello {name}"}}'
    const result = extractJson(input)
    expect(JSON.parse(result!)).toEqual({
      action: 'send',
      email: { subject: 'Hi', body: 'Hello {name}' },
    })
  })

  test('handles braces inside strings', () => {
    const input = '{"body": "Use { and } in your code"}'
    const result = extractJson(input)
    expect(JSON.parse(result!)).toEqual({ body: 'Use { and } in your code' })
  })

  test('handles escaped quotes in strings', () => {
    const input = '{"body": "She said \\"hello\\""}'
    const result = extractJson(input)
    expect(JSON.parse(result!)).toEqual({ body: 'She said "hello"' })
  })

  test('returns null for no JSON', () => {
    expect(extractJson('no json here')).toBeNull()
  })

  test('returns null for empty string', () => {
    expect(extractJson('')).toBeNull()
  })

  test('handles greedy match case correctly', () => {
    // This is the case where the old regex would fail:
    // Two separate JSON objects separated by text
    const input = 'Result: {"intent": "interested"} Additional context: the user seems engaged {ref: 123}'
    const result = extractJson(input)
    expect(JSON.parse(result!)).toEqual({ intent: 'interested' })
  })
})
