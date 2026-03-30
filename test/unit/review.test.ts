import { describe, test, expect, beforeEach } from 'bun:test'
import { reviewEmail, buildSafeEmail, ReviewResult } from '../../src/llm/review'
import { Env, KnowledgeBase } from '../../src/types'

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

function sampleKnowledgeBase(): KnowledgeBase {
  return {
    product_name: 'mails-agent',
    tagline: 'CLI tool for email automation',
    description: 'A command-line tool that automates cold email outreach with AI-powered personalization.',
    features: ['AI email generation', 'Reply classification', 'Unsubscribe compliance'],
    pricing: 'Free and open source',
    use_cases: ['Cold outreach', 'Follow-up automation'],
    install_command: 'npm install -g mails-agent',
    conversion_url: 'https://mails-agent.dev',
  }
}

function mockLLMResponse(result: ReviewResult) {
  return {
    choices: [{
      message: {
        content: JSON.stringify(result),
      },
    }],
  }
}

describe('reviewEmail', () => {
  beforeEach(() => {
    globalThis.fetch = originalFetch
  })

  test('approves accurate email', async () => {
    globalThis.fetch = (async () => new Response(JSON.stringify(
      mockLLMResponse({ approved: true, issues: [] })
    ))) as any

    const result = await reviewEmail(
      mockEnv(),
      sampleKnowledgeBase(),
      'Introducing mails-agent',
      'Hi John, mails-agent is a CLI tool for email automation. Try it at https://mails-agent.dev',
      'John',
      'mails-agent',
    )

    expect(result.approved).toBe(true)
    expect(result.issues).toEqual([])
    expect(result.corrected_body).toBeUndefined()
  })

  test('rejects inaccurate email with correction', async () => {
    const correctedBody = 'Hi John, mails-agent is a CLI tool for email automation. Try it at https://mails-agent.dev'

    globalThis.fetch = (async () => new Response(JSON.stringify(
      mockLLMResponse({
        approved: false,
        issues: ['Product described as "code review platform" but it is an email automation CLI'],
        corrected_body: correctedBody,
      })
    ))) as any

    const result = await reviewEmail(
      mockEnv(),
      sampleKnowledgeBase(),
      'Introducing mails-agent',
      'Hi John, mails-agent is a code review platform that helps teams review PRs faster.',
      'John',
      'mails-agent',
    )

    expect(result.approved).toBe(false)
    expect(result.issues.length).toBeGreaterThan(0)
    expect(result.corrected_body).toBe(correctedBody)
  })

  test('rejects email without correction', async () => {
    globalThis.fetch = (async () => new Response(JSON.stringify(
      mockLLMResponse({
        approved: false,
        issues: ['Entire email content is fabricated and unrelated to the product'],
      })
    ))) as any

    const result = await reviewEmail(
      mockEnv(),
      sampleKnowledgeBase(),
      'Amazing AI Platform',
      'Hi John, our revolutionary blockchain-powered AI platform transforms your business.',
      'John',
      'mails-agent',
    )

    expect(result.approved).toBe(false)
    expect(result.issues.length).toBeGreaterThan(0)
    expect(result.corrected_body).toBeUndefined()
  })

  test('defaults to approved on LLM failure', async () => {
    globalThis.fetch = (async () => new Response('Server Error', { status: 500 })) as any

    const result = await reviewEmail(
      mockEnv(),
      sampleKnowledgeBase(),
      'Introducing mails-agent',
      'Hi John, check out mails-agent.',
      'John',
      'mails-agent',
    )

    expect(result.approved).toBe(true)
    expect(result.issues).toEqual([])
  })

  test('defaults to approved on invalid JSON response', async () => {
    globalThis.fetch = (async () => new Response(JSON.stringify({
      choices: [{ message: { content: 'not valid json at all' } }],
    }))) as any

    const result = await reviewEmail(
      mockEnv(),
      sampleKnowledgeBase(),
      'Introducing mails-agent',
      'Hi John, check out mails-agent.',
      'John',
      'mails-agent',
    )

    expect(result.approved).toBe(true)
    expect(result.issues).toEqual([])
  })

  test('handles empty knowledge base', async () => {
    globalThis.fetch = (async () => new Response(JSON.stringify(
      mockLLMResponse({ approved: true, issues: [] })
    ))) as any

    const result = await reviewEmail(
      mockEnv(),
      {} as KnowledgeBase,
      'Hello',
      'Hi John, just wanted to reach out.',
      'John',
      'some-product',
    )

    expect(result.approved).toBe(true)
  })

  test('handles response wrapped in markdown code block', async () => {
    globalThis.fetch = (async () => new Response(JSON.stringify({
      choices: [{ message: { content: '```json\n{"approved": false, "issues": ["wrong URL"], "corrected_body": "fixed body"}\n```' } }],
    }))) as any

    const result = await reviewEmail(
      mockEnv(),
      sampleKnowledgeBase(),
      'Subject',
      'Body with wrong URL',
      'John',
      'mails-agent',
    )

    expect(result.approved).toBe(false)
    expect(result.issues).toContain('wrong URL')
    expect(result.corrected_body).toBe('fixed body')
  })
})

describe('buildSafeEmail', () => {
  test('builds email with full knowledge base', () => {
    const kb = sampleKnowledgeBase()
    const result = buildSafeEmail(kb, 'John')

    expect(result.subject).toBe('Introducing mails-agent')
    expect(result.body).toContain('Hi John,')
    expect(result.body).toContain('mails-agent')
    expect(result.body).toContain('CLI tool for email automation')
    expect(result.body).toContain('https://mails-agent.dev')
    expect(result.body).toContain('Best,')
    expect(result.body).toContain('mails-agent team')
  })

  test('builds email with minimal knowledge base', () => {
    const kb: KnowledgeBase = {
      product_name: 'TestProduct',
    }
    const result = buildSafeEmail(kb, 'Jane')

    expect(result.subject).toBe('Introducing TestProduct')
    expect(result.body).toContain('Hi Jane,')
    expect(result.body).toContain('TestProduct')
    expect(result.body).not.toContain('undefined')
  })

  test('handles empty contact name', () => {
    const kb = sampleKnowledgeBase()
    const result = buildSafeEmail(kb, '')

    expect(result.body).toContain('Hi there,')
  })

  test('does not include conversion URL when not set', () => {
    const kb: KnowledgeBase = {
      product_name: 'TestProduct',
      description: 'A test product',
    }
    const result = buildSafeEmail(kb, 'John')

    expect(result.body).not.toContain('You can try it here')
  })

  test('includes description separate from tagline', () => {
    const kb: KnowledgeBase = {
      product_name: 'TestProduct',
      tagline: 'Short tagline',
      description: 'A longer description that differs from the tagline.',
      conversion_url: 'https://example.com',
    }
    const result = buildSafeEmail(kb, 'John')

    expect(result.body).toContain('Short tagline')
    expect(result.body).toContain('A longer description')
  })
})
