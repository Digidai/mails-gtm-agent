import { describe, test, expect, beforeEach } from 'bun:test'
import { makeDecision } from '../../src/agent/decide'
import { Env, Campaign, CampaignContact, Event, KnowledgeBase } from '../../src/types'
import { createProvider } from '../../src/llm/provider'

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

function mockCampaign(overrides: Partial<Campaign> = {}): Campaign {
  return {
    id: 'campaign-1',
    name: 'Test Campaign',
    product_name: 'TestProduct',
    product_description: 'A test product',
    from_email: 'test@example.com',
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
    conversion_url: 'https://example.com/signup',
    knowledge_base: '{}',
    knowledge_base_status: 'manual',
    max_emails: 6,
    min_interval_days: 2,
    webhook_secret: null,
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

function mockContact(overrides: Partial<CampaignContact> = {}): CampaignContact {
  return {
    id: 'contact-1',
    campaign_id: 'campaign-1',
    email: 'alice@acme.com',
    name: 'Alice',
    company: 'Acme',
    role: 'CTO',
    custom_fields: '{}',
    status: 'pending',
    current_step: 0,
    next_send_at: null,
    last_sent_at: null,
    sent_message_id: null,
    resume_at: null,
    reply_intent: null,
    reply_confidence: null,
    emails_sent: 0,
    last_click_at: null,
    converted_at: null,
    conversion_type: null,
    next_check_at: null,
    last_enqueued_at: null,
    auto_reply_count: 0,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    ...overrides,
  }
}

function mockEvent(overrides: Partial<Event> = {}): Event {
  return {
    id: crypto.randomUUID(),
    campaign_id: 'campaign-1',
    contact_id: 'contact-1',
    event_type: 'email_sent',
    event_data: '{}',
    created_at: new Date().toISOString(),
    ...overrides,
  }
}

const mockKb: KnowledgeBase = {
  product_name: 'TestProduct',
  tagline: 'Test tagline',
  description: 'A great product for testing',
  features: ['Feature 1', 'Feature 2'],
  pricing: 'Free tier available',
}

describe('Agent Decision Engine', () => {
  beforeEach(() => {
    globalThis.fetch = originalFetch
  })

  test('returns stop for terminal status contact', async () => {
    const result = await makeDecision(
      mockEnv(),
      createProvider(mockEnv()),
      mockCampaign(),
      mockContact({ status: 'converted' }),
      [],
      mockKb,
    )
    expect(result.action).toBe('stop')
    expect(result.reasoning).toContain('terminal status')
  })

  test('returns stop when max_emails reached', async () => {
    const result = await makeDecision(
      mockEnv(),
      createProvider(mockEnv()),
      mockCampaign({ max_emails: 3 }),
      mockContact({ emails_sent: 3 }),
      [],
      mockKb,
    )
    expect(result.action).toBe('stop')
    expect(result.reasoning).toContain('Maximum email limit')
  })

  test('returns wait when min interval not met', async () => {
    const oneHourAgo = new Date(Date.now() - 1 * 60 * 60 * 1000).toISOString()
    const result = await makeDecision(
      mockEnv(),
      createProvider(mockEnv()),
      mockCampaign({ min_interval_days: 2 }),
      mockContact({ last_sent_at: oneHourAgo }),
      [],
      mockKb,
    )
    expect(result.action).toBe('wait')
    expect(result.reasoning).toContain('Minimum interval')
  })

  test('calls LLM and returns send decision', async () => {
    globalThis.fetch = (async () => new Response(JSON.stringify({
      choices: [{
        message: {
          content: JSON.stringify({
            action: 'send',
            reasoning: 'First touch, no prior contact.',
            email: {
              angle: 'first_touch',
              subject: 'Quick question about Acme',
              body: 'Hi Alice, I noticed Acme is growing. TestProduct can help.',
            },
          }),
        },
      }],
    }))) as any

    const result = await makeDecision(
      mockEnv(),
      createProvider(mockEnv()),
      mockCampaign(),
      mockContact(),
      [],
      mockKb,
    )

    expect(result.action).toBe('send')
    expect(result.email?.subject).toContain('Acme')
    expect(result.email?.angle).toBe('first_touch')
  })

  test('calls LLM and returns wait decision', async () => {
    globalThis.fetch = (async () => new Response(JSON.stringify({
      choices: [{
        message: {
          content: JSON.stringify({
            action: 'wait',
            reasoning: 'Too soon since last email.',
            wait_days: 5,
          }),
        },
      }],
    }))) as any

    const result = await makeDecision(
      mockEnv(),
      createProvider(mockEnv()),
      mockCampaign(),
      mockContact({ emails_sent: 1 }),
      [],
      mockKb,
    )

    expect(result.action).toBe('wait')
    expect(result.wait_days).toBe(5)
  })

  test('falls back to wait on LLM error', async () => {
    globalThis.fetch = (async () => new Response('Server Error', { status: 500 })) as any

    const result = await makeDecision(
      mockEnv(),
      createProvider(mockEnv()),
      mockCampaign(),
      mockContact(),
      [],
      mockKb,
    )

    expect(result.action).toBe('wait')
    expect(result.reasoning).toContain('LLM decision failed')
  })

  test('falls back to wait on invalid JSON from LLM', async () => {
    globalThis.fetch = (async () => new Response(JSON.stringify({
      choices: [{
        message: {
          content: 'I think we should wait a bit longer.',
        },
      }],
    }))) as any

    const result = await makeDecision(
      mockEnv(),
      createProvider(mockEnv()),
      mockCampaign(),
      mockContact(),
      [],
      mockKb,
    )

    expect(result.action).toBe('wait')
    expect(result.reasoning).toContain('LLM decision failed')
  })

  test('handles LLM response in markdown code block', async () => {
    globalThis.fetch = (async () => new Response(JSON.stringify({
      choices: [{
        message: {
          content: '```json\n{"action": "send", "reasoning": "First touch", "email": {"angle": "first_touch", "subject": "Hello", "body": "Hi there"}}\n```',
        },
      }],
    }))) as any

    const result = await makeDecision(
      mockEnv(),
      createProvider(mockEnv()),
      mockCampaign(),
      mockContact(),
      [],
      mockKb,
    )

    expect(result.action).toBe('send')
    expect(result.email?.subject).toBe('Hello')
  })

  test('defaults wait_days to 3 if not provided', async () => {
    globalThis.fetch = (async () => new Response(JSON.stringify({
      choices: [{
        message: {
          content: JSON.stringify({
            action: 'wait',
            reasoning: 'Let them think about it.',
          }),
        },
      }],
    }))) as any

    const result = await makeDecision(
      mockEnv(),
      createProvider(mockEnv()),
      mockCampaign(),
      mockContact({ emails_sent: 1 }),
      [],
      mockKb,
    )

    expect(result.action).toBe('wait')
    expect(result.wait_days).toBe(3)
  })
})
