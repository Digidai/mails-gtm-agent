import { describe, test, expect, mock, beforeEach } from 'bun:test'
import { classifyReply } from '../../src/llm/classify'
import { Env, IntentType } from '../../src/types'

// Mock fetch globally
const originalFetch = globalThis.fetch

function mockEnv(): Env {
  return {
    OPENROUTER_API_KEY: 'test-key',
    MAILS_API_URL: 'https://test.example.com',
    MAILS_API_KEY: 'test-mails-key',
    MAILS_MAILBOX: 'test@example.com',
    ADMIN_TOKEN: 'test-admin',
    UNSUBSCRIBE_BASE_URL: 'https://test.example.com',
    DAILY_SEND_LIMIT: '100',
    DB: {} as any,
    SEND_QUEUE: {} as any,
  }
}

function mockLLMResponse(intent: IntentType, confidence = 0.9, resume_date: string | null = null) {
  return {
    choices: [{
      message: {
        content: JSON.stringify({ intent, confidence, resume_date }),
      },
    }],
  }
}

describe('Reply Classifier', () => {
  beforeEach(() => {
    globalThis.fetch = originalFetch
  })

  test('classifies interested reply', async () => {
    globalThis.fetch = (async () => new Response(JSON.stringify(
      mockLLMResponse('interested', 0.95)
    ))) as any

    const result = await classifyReply(mockEnv(), "Yes, I'd love to learn more! Can we schedule a call?")
    expect(result.intent).toBe('interested')
    expect(result.confidence).toBe(0.95)
  })

  test('classifies not_now reply with resume date', async () => {
    globalThis.fetch = (async () => new Response(JSON.stringify(
      mockLLMResponse('not_now', 0.85, '2026-04-15')
    ))) as any

    const result = await classifyReply(mockEnv(), "Interesting but we're in the middle of Q1 planning. Can you reach out in April?")
    expect(result.intent).toBe('not_now')
    expect(result.resume_date).toBe('2026-04-15')
  })

  test('classifies not_interested reply', async () => {
    globalThis.fetch = (async () => new Response(JSON.stringify(
      mockLLMResponse('not_interested', 0.9)
    ))) as any

    const result = await classifyReply(mockEnv(), "Thanks but we're not looking for this kind of solution.")
    expect(result.intent).toBe('not_interested')
  })

  test('classifies wrong_person reply', async () => {
    globalThis.fetch = (async () => new Response(JSON.stringify(
      mockLLMResponse('wrong_person', 0.8)
    ))) as any

    const result = await classifyReply(mockEnv(), "I'm not the right person. You should contact John in procurement.")
    expect(result.intent).toBe('wrong_person')
  })

  test('classifies out_of_office reply', async () => {
    globalThis.fetch = (async () => new Response(JSON.stringify(
      mockLLMResponse('out_of_office', 0.95)
    ))) as any

    const result = await classifyReply(mockEnv(), "I'm out of office until March 30. I'll respond when I return.")
    expect(result.intent).toBe('out_of_office')
  })

  test('classifies unsubscribe reply', async () => {
    globalThis.fetch = (async () => new Response(JSON.stringify(
      mockLLMResponse('unsubscribe', 0.95)
    ))) as any

    const result = await classifyReply(mockEnv(), "Please remove me from your mailing list.")
    expect(result.intent).toBe('unsubscribe')
  })

  test('classifies auto_reply', async () => {
    globalThis.fetch = (async () => new Response(JSON.stringify(
      mockLLMResponse('auto_reply', 0.9)
    ))) as any

    const result = await classifyReply(mockEnv(), "This is an automated response. Your email has been received.")
    expect(result.intent).toBe('auto_reply')
  })

  test('classifies do_not_contact reply', async () => {
    globalThis.fetch = (async () => new Response(JSON.stringify(
      mockLLMResponse('do_not_contact', 0.95)
    ))) as any

    const result = await classifyReply(mockEnv(), "Stop emailing me or I will report this as spam.")
    expect(result.intent).toBe('do_not_contact')
  })

  test('falls back to unclear on LLM failure', async () => {
    globalThis.fetch = (async () => new Response('Server Error', { status: 500 })) as any

    const result = await classifyReply(mockEnv(), "Some reply text")
    expect(result.intent).toBe('unclear')
    expect(result.confidence).toBe(0)
  })

  test('falls back to unclear on invalid JSON', async () => {
    globalThis.fetch = (async () => new Response(JSON.stringify({
      choices: [{ message: { content: 'not valid json at all' } }],
    }))) as any

    const result = await classifyReply(mockEnv(), "Some reply text")
    expect(result.intent).toBe('unclear')
  })

  test('handles LLM response wrapped in markdown code block', async () => {
    globalThis.fetch = (async () => new Response(JSON.stringify({
      choices: [{ message: { content: '```json\n{"intent": "interested", "confidence": 0.9, "resume_date": null}\n```' } }],
    }))) as any

    const result = await classifyReply(mockEnv(), "Yes, I'd love to hear more")
    expect(result.intent).toBe('interested')
  })
})
