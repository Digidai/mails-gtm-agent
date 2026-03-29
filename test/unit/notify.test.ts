import { describe, test, expect, beforeEach } from 'bun:test'
import { notifyOwner } from '../../src/notify'
import { Env, Campaign } from '../../src/types'

const originalFetch = globalThis.fetch

function mockCampaign(overrides: Partial<Campaign> = {}): Campaign {
  return {
    id: 'campaign-1',
    name: 'Test Campaign',
    product_name: 'TestProduct',
    product_description: 'A test product',
    from_email: 'owner@example.com',
    physical_address: '123 Main St',
    status: 'active',
    ai_generate: 1,
    warmup_enabled: 0,
    warmup_start_volume: 10,
    warmup_increment: 5,
    warmup_started_at: null,
    steps: '[]',
    last_inbox_check_at: null,
    engine: 'agent',
    product_url: null,
    conversion_url: 'https://example.com',
    knowledge_base: '{}',
    knowledge_base_status: 'manual',
    max_emails: 6,
    min_interval_days: 2,
    webhook_secret: null,
    dry_run: 0,
    daily_llm_calls: 0,
    daily_llm_limit: 100,
    daily_llm_reset_at: null,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    ...overrides,
  }
}

function mockEnv(): Env {
  return {
    OPENROUTER_API_KEY: 'test-key',
    MAILS_API_URL: 'https://test.example.com',
    MAILS_API_KEY: 'test-mails-key',
    MAILS_MAILBOX: 'system@example.com',
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

describe('Notify Owner', () => {
  beforeEach(() => {
    globalThis.fetch = originalFetch
  })

  test('sends interested reply notification', async () => {
    let sentPayload: any = null
    globalThis.fetch = (async (_url: string, opts?: any) => {
      sentPayload = JSON.parse(opts.body)
      return new Response(JSON.stringify({ id: 'msg-1' }))
    }) as any

    await notifyOwner(mockEnv(), mockCampaign(), 'interested_reply', {
      contactEmail: 'alice@acme.com',
      contactName: 'Alice',
      replyText: 'Yes, I would love to learn more!',
    })

    expect(sentPayload).not.toBeNull()
    expect(sentPayload.to).toContain('owner@example.com')
    expect(sentPayload.subject).toContain('Interested reply')
    expect(sentPayload.text).toContain('Alice')
    expect(sentPayload.text).toContain('alice@acme.com')
  })

  test('sends conversion notification', async () => {
    let sentPayload: any = null
    globalThis.fetch = (async (_url: string, opts?: any) => {
      sentPayload = JSON.parse(opts.body)
      return new Response(JSON.stringify({ id: 'msg-1' }))
    }) as any

    await notifyOwner(mockEnv(), mockCampaign(), 'conversion', {
      contactEmail: 'alice@acme.com',
      contactName: 'Alice',
      conversionType: 'payment',
    })

    expect(sentPayload).not.toBeNull()
    expect(sentPayload.subject).toContain('Conversion')
    expect(sentPayload.subject).toContain('payment')
    expect(sentPayload.text).toContain('converted')
  })

  test('does not throw on notification failure', async () => {
    globalThis.fetch = (async () => {
      throw new Error('Network error')
    }) as any

    // Should not throw
    await notifyOwner(mockEnv(), mockCampaign(), 'interested_reply', {
      contactEmail: 'alice@acme.com',
    })
  })
})
