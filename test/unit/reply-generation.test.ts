import { describe, test, expect, beforeEach, afterEach } from 'bun:test'
import { generateReply } from '../../src/llm/reply'
import { Env, Campaign, CampaignContact, ConversationMessage, KnowledgeBase } from '../../src/types'
import { createProvider } from '../../src/llm/provider'

const originalFetch = globalThis.fetch

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

function mockCampaign(overrides: Partial<Campaign> = {}): Campaign {
  return {
    id: 'campaign-1',
    name: 'Test Campaign',
    product_name: 'mails-agent',
    product_description: 'Email infrastructure for AI agents',
    from_email: 'hi@mails0.com',
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
    product_url: 'https://mails0.com',
    conversion_url: 'https://mails0.com/start',
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
    status: 'interested',
    current_step: 0,
    next_send_at: null,
    last_sent_at: new Date().toISOString(),
    sent_message_id: null,
    resume_at: null,
    reply_intent: 'interested',
    reply_confidence: 0.95,
    emails_sent: 1,
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

describe('Reply Generation', () => {
  afterEach(() => {
    globalThis.fetch = originalFetch
  })

  test('generates a reply from LLM response', async () => {
    globalThis.fetch = (async (_url: string, opts?: any) => {
      return new Response(JSON.stringify({
        choices: [{
          message: {
            content: JSON.stringify({
              reply: 'Great question! mails-agent is free and self-hosted, unlike AgentMail which costs $97/mo.',
              knowledge_gap: null,
              should_stop: false,
            }),
          },
        }],
      }))
    }) as any

    const history: ConversationMessage[] = [
      { role: 'agent', content: 'Hi Alice, check out mails-agent!', created_at: '2026-03-28T10:00:00Z' },
    ]
    const kb: KnowledgeBase = { product_name: 'mails-agent', pricing: 'Free' }

    const result = await generateReply(
      createProvider(mockEnv()), mockCampaign(), mockContact(),
      'How does this compare to AgentMail?', history, 'interested', kb,
    )

    expect(result.reply).toContain('mails-agent')
    expect(result.knowledge_gap).toBeNull()
    expect(result.should_stop).toBe(false)
  })

  test('detects knowledge gap', async () => {
    globalThis.fetch = (async (_url: string, opts?: any) => {
      return new Response(JSON.stringify({
        choices: [{
          message: {
            content: JSON.stringify({
              reply: "That's a great question. Let me check with the team about IMAP support.",
              knowledge_gap: 'IMAP support - not documented in knowledge base',
              should_stop: false,
            }),
          },
        }],
      }))
    }) as any

    const result = await generateReply(
      createProvider(mockEnv()), mockCampaign(), mockContact(),
      'Does mails-agent support IMAP?', [], 'interested', {},
    )

    expect(result.knowledge_gap).toBeTruthy()
    expect(result.knowledge_gap).toContain('IMAP')
    expect(result.should_stop).toBe(false)
  })

  test('detects should_stop when contact wants to end conversation', async () => {
    globalThis.fetch = (async (_url: string, opts?: any) => {
      return new Response(JSON.stringify({
        choices: [{
          message: {
            content: JSON.stringify({
              reply: 'Of course, I understand. Feel free to reach out anytime.',
              knowledge_gap: null,
              should_stop: true,
            }),
          },
        }],
      }))
    }) as any

    const result = await generateReply(
      createProvider(mockEnv()), mockCampaign(), mockContact(),
      'Can I talk to a real person instead?', [], 'interested', {},
    )

    expect(result.should_stop).toBe(true)
  })

  test('returns fallback reply on LLM failure', async () => {
    globalThis.fetch = (async () => {
      throw new Error('Network error')
    }) as any

    const result = await generateReply(
      createProvider(mockEnv()), mockCampaign(), mockContact(),
      'Tell me more', [], 'interested', {},
    )

    expect(result.reply).toBeTruthy()
    expect(result.reply).toContain('get back to you')
    expect(result.knowledge_gap).toBeTruthy()
    expect(result.should_stop).toBe(false)
  })

  test('returns fallback reply on malformed LLM output', async () => {
    globalThis.fetch = (async (_url: string, opts?: any) => {
      return new Response(JSON.stringify({
        choices: [{
          message: {
            content: 'This is not valid JSON at all',
          },
        }],
      }))
    }) as any

    const result = await generateReply(
      createProvider(mockEnv()), mockCampaign(), mockContact(),
      'Tell me more', [], 'interested', {},
    )

    expect(result.reply).toBeTruthy()
    expect(result.should_stop).toBe(false)
  })

  test('includes conversation history in LLM prompt', async () => {
    let capturedBody: any = null
    globalThis.fetch = (async (_url: string, opts?: any) => {
      capturedBody = JSON.parse(opts.body)
      return new Response(JSON.stringify({
        choices: [{
          message: {
            content: JSON.stringify({
              reply: 'Yes, migration takes just 2 minutes.',
              knowledge_gap: null,
              should_stop: false,
            }),
          },
        }],
      }))
    }) as any

    const history: ConversationMessage[] = [
      { role: 'agent', content: 'Hi Alice, mails-agent gives your AI agents email.', created_at: '2026-03-28T10:00:00Z' },
      { role: 'contact', content: 'How does it compare to AgentMail?', created_at: '2026-03-28T11:00:00Z' },
      { role: 'agent', content: 'Key differences: free vs $97/mo.', created_at: '2026-03-28T11:05:00Z' },
    ]

    await generateReply(
      createProvider(mockEnv()), mockCampaign(), mockContact(),
      'Can it replace Resend?', history, 'interested', { product_name: 'mails-agent' },
    )

    expect(capturedBody).not.toBeNull()
    // Conversation history and latest reply are in user prompt (messages[1])
    // for security (untrusted content separated from system instructions)
    const userPrompt = capturedBody.messages[1].content
    expect(userPrompt).toContain('[Agent] Hi Alice')
    expect(userPrompt).toContain('[Alice] How does it compare')
    expect(userPrompt).toContain('Can it replace Resend?')
  })

  test('handles should_stop as non-boolean gracefully', async () => {
    globalThis.fetch = (async (_url: string, opts?: any) => {
      return new Response(JSON.stringify({
        choices: [{
          message: {
            content: JSON.stringify({
              reply: 'Sure thing!',
              knowledge_gap: null,
              should_stop: 'yes', // wrong type
            }),
          },
        }],
      }))
    }) as any

    const result = await generateReply(
      createProvider(mockEnv()), mockCampaign(), mockContact(),
      'Tell me more', [], 'interested', {},
    )

    // should_stop should be false because 'yes' !== true
    expect(result.should_stop).toBe(false)
  })
})
