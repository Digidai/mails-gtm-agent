import { describe, test, expect, beforeEach, afterEach } from 'bun:test'
import { callLLM } from '../../src/llm/openrouter'
import { Env } from '../../src/types'

const originalFetch = globalThis.fetch

function mockEnv(): Env {
  return {
    OPENROUTER_API_KEY: 'test-key',
    MAILS_API_URL: 'https://test.example.com',
    MAILS_API_KEY: 'test-mails-key',
    MAILS_MAILBOX: 'test@example.com',
    ADMIN_TOKEN: 'test-admin',
    UNSUBSCRIBE_SECRET: 'test-unsub-secret',
    UNSUBSCRIBE_BASE_URL: 'https://test.example.com',
    DAILY_SEND_LIMIT: '100',
    MAX_CSV_SIZE: '5242880',
    DB: {} as any,
    SEND_QUEUE: {} as any,
    EVALUATE_QUEUE: {} as any,
  }
}

function successResponse(content: string = 'Hello world') {
  return new Response(JSON.stringify({
    choices: [{ message: { content } }],
  }))
}

describe('callLLM retry logic', () => {
  afterEach(() => {
    globalThis.fetch = originalFetch
  })

  test('happy path: returns content on first attempt', async () => {
    globalThis.fetch = (async () => successResponse('Test response')) as any

    const result = await callLLM(mockEnv(), 'system', 'user')
    expect(result).toBe('Test response')
  })

  test('429 -> retry -> success on 2nd attempt', async () => {
    let attempt = 0
    globalThis.fetch = (async () => {
      attempt++
      if (attempt === 1) {
        return new Response('Rate limited', { status: 429 })
      }
      return successResponse('Retry succeeded')
    }) as any

    const result = await callLLM(mockEnv(), 'system', 'user')
    expect(result).toBe('Retry succeeded')
    expect(attempt).toBe(2)
  })

  test('429 -> all retries exhausted -> throw', async () => {
    let attempt = 0
    globalThis.fetch = (async () => {
      attempt++
      return new Response('Rate limited', { status: 429 })
    }) as any

    await expect(callLLM(mockEnv(), 'system', 'user')).rejects.toThrow('429')
    expect(attempt).toBe(3) // initial + 2 retries
  })

  test('non-429 error (500) -> no retry, immediate throw', async () => {
    let attempt = 0
    globalThis.fetch = (async () => {
      attempt++
      return new Response('Internal Server Error', { status: 500 })
    }) as any

    await expect(callLLM(mockEnv(), 'system', 'user')).rejects.toThrow('OpenRouter API error 500')
    expect(attempt).toBe(1) // no retry
  })

  test('timeout -> AbortError, no retry', async () => {
    let attempt = 0
    globalThis.fetch = (async (_url: string, opts?: any) => {
      attempt++
      // Simulate an abort: reject immediately with AbortError
      // In production the 10s setTimeout triggers controller.abort() which causes this
      throw new DOMException('The operation was aborted.', 'AbortError')
    }) as any

    await expect(callLLM(mockEnv(), 'system', 'user')).rejects.toThrow('aborted')
    expect(attempt).toBe(1) // no retry on timeout/abort
  })

  test('429 on first two attempts, success on third', async () => {
    let attempt = 0
    globalThis.fetch = (async () => {
      attempt++
      if (attempt <= 2) {
        return new Response('Rate limited', { status: 429 })
      }
      return successResponse('Third time lucky')
    }) as any

    const result = await callLLM(mockEnv(), 'system', 'user')
    expect(result).toBe('Third time lucky')
    expect(attempt).toBe(3)
  })

  test('empty content throws without retry', async () => {
    globalThis.fetch = (async () => new Response(JSON.stringify({
      choices: [{ message: { content: '' } }],
    }))) as any

    await expect(callLLM(mockEnv(), 'system', 'user')).rejects.toThrow('empty or invalid content')
  })
})
