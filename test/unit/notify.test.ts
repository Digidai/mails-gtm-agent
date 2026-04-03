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
    webhook_callback_url: null,
    dry_run: 0,
    daily_llm_calls: 0,
    daily_llm_limit: 100,
    daily_llm_reset_at: null,
    max_auto_replies: 5,
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

  test('sends campaign_error notification', async () => {
    let sentPayload: any = null
    globalThis.fetch = (async (_url: string, opts?: any) => {
      sentPayload = JSON.parse(opts.body)
      return new Response(JSON.stringify({ id: 'msg-1' }))
    }) as any

    await notifyOwner(mockEnv(), mockCampaign(), 'campaign_error', {
      contactEmail: 'alice@acme.com',
      errorMessage: 'Send API returned 401: Unauthorized. Campaign has been paused.',
    })

    expect(sentPayload).not.toBeNull()
    expect(sentPayload.subject).toContain('Campaign paused')
    expect(sentPayload.text).toContain('automatically paused')
    expect(sentPayload.text).toContain('401')
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

  test('fires webhook callback when campaign has webhook_callback_url', async () => {
    const calls: { url: string; body: any }[] = []
    globalThis.fetch = (async (url: string, opts?: any) => {
      calls.push({ url, body: opts?.body ? JSON.parse(opts.body) : null })
      return new Response(JSON.stringify({ id: 'msg-1' }))
    }) as any

    await notifyOwner(
      mockEnv(),
      mockCampaign({ webhook_callback_url: 'https://hooks.example.com/callback' }),
      'interested_reply',
      {
        contactEmail: 'alice@acme.com',
        contactName: 'Alice',
        replyText: 'I am interested!',
      },
    )

    // Should have 2 fetch calls: 1 email + 1 webhook
    expect(calls.length).toBe(2)

    // Second call should be the webhook
    const webhookCall = calls[1]
    expect(webhookCall.url).toBe('https://hooks.example.com/callback')
    expect(webhookCall.body.event).toBe('interested_reply')
    expect(webhookCall.body.campaign_id).toBe('campaign-1')
    expect(webhookCall.body.data.contactEmail).toBe('alice@acme.com')
  })

  test('does not fire webhook when campaign has no webhook_callback_url', async () => {
    const calls: string[] = []
    globalThis.fetch = (async (url: string, opts?: any) => {
      calls.push(url)
      return new Response(JSON.stringify({ id: 'msg-1' }))
    }) as any

    await notifyOwner(
      mockEnv(),
      mockCampaign({ webhook_callback_url: null }),
      'conversion',
      {
        contactEmail: 'alice@acme.com',
        conversionType: 'signup',
      },
    )

    // Only 1 fetch call (the email), no webhook
    expect(calls.length).toBe(1)
  })

  test('webhook failure does not block email notification', async () => {
    let emailSent = false
    let callCount = 0
    globalThis.fetch = (async (url: string, opts?: any) => {
      callCount++
      if (callCount === 1) {
        // Email send succeeds
        emailSent = true
        return new Response(JSON.stringify({ id: 'msg-1' }))
      }
      // Webhook call fails
      throw new Error('Webhook endpoint down')
    }) as any

    // Should not throw
    await notifyOwner(
      mockEnv(),
      mockCampaign({ webhook_callback_url: 'https://hooks.example.com/broken' }),
      'conversion',
      {
        contactEmail: 'alice@acme.com',
        conversionType: 'payment',
      },
    )

    expect(emailSent).toBe(true)
  })
})
