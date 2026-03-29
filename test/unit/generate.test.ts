import { describe, test, expect, beforeEach } from 'bun:test'
import { generateEmail, applyTemplate } from '../../src/llm/generate'
import { Env, Campaign, CampaignContact } from '../../src/types'

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
  }
}

function mockCampaign(overrides: Partial<Campaign> = {}): Campaign {
  return {
    id: 'campaign-1',
    name: 'Test Campaign',
    product_name: 'SuperSaaS',
    product_description: 'An AI-powered analytics platform',
    from_email: 'sales@example.com',
    physical_address: '123 Main St',
    status: 'active',
    ai_generate: 1,
    warmup_enabled: 1,
    warmup_start_volume: 10,
    warmup_increment: 5,
    warmup_started_at: null,
    steps: JSON.stringify([
      { delay_days: 0, subject_template: 'Hello {{name}}', body_template: 'Hi {{name}}, check out SuperSaaS for {{company}}.' },
      { delay_days: 3, subject_template: 'Following up', body_template: 'Hi {{name}}, just following up.' },
    ]),
    last_inbox_check_at: null,
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
    company: 'Acme Inc',
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
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    ...overrides,
  }
}

describe('Email Generator', () => {
  beforeEach(() => {
    globalThis.fetch = originalFetch
  })

  test('generates email via LLM', async () => {
    globalThis.fetch = (async () => new Response(JSON.stringify({
      choices: [{
        message: {
          content: JSON.stringify({
            subject: 'Boost Acme Inc analytics with SuperSaaS',
            body: 'Hi Alice, I noticed Acme Inc is growing fast. SuperSaaS can help you make data-driven decisions.',
          }),
        },
      }],
    }))) as any

    const result = await generateEmail(mockEnv(), mockCampaign(), mockContact(), 0)
    expect(result.subject).toContain('Acme')
    expect(result.body).toContain('Alice')
  })

  test('falls back to template on LLM failure', async () => {
    globalThis.fetch = (async () => new Response('Error', { status: 500 })) as any

    const result = await generateEmail(mockEnv(), mockCampaign(), mockContact(), 0)
    expect(result.subject).toBe('Hello Alice')
    expect(result.body).toContain('Alice')
    expect(result.body).toContain('Acme Inc')
  })

  test('uses template directly when ai_generate is false', async () => {
    const campaign = mockCampaign({ ai_generate: 0 })
    const result = await generateEmail(mockEnv(), campaign, mockContact(), 0)
    expect(result.subject).toBe('Hello Alice')
    expect(result.body).toContain('Acme Inc')
  })

  test('generates default email when no steps defined', async () => {
    const campaign = mockCampaign({ ai_generate: 0, steps: '[]' })

    globalThis.fetch = (async () => new Response('Error', { status: 500 })) as any

    const result = await generateEmail(mockEnv(), campaign, mockContact(), 0)
    expect(result.subject).toContain('SuperSaaS')
    expect(result.body).toContain('Alice')
  })

  test('handles LLM response in markdown code block', async () => {
    globalThis.fetch = (async () => new Response(JSON.stringify({
      choices: [{
        message: {
          content: '```json\n{"subject": "Test Subject", "body": "Test Body"}\n```',
        },
      }],
    }))) as any

    const result = await generateEmail(mockEnv(), mockCampaign(), mockContact(), 0)
    expect(result.subject).toBe('Test Subject')
    expect(result.body).toBe('Test Body')
  })
})

describe('Template Application', () => {
  test('replaces all variables', () => {
    const contact = mockContact()
    const result = applyTemplate('Hello {{name}} from {{company}}, {{role}} - {{email}}', contact)
    expect(result).toBe('Hello Alice from Acme Inc, CTO - alice@acme.com')
  })

  test('handles missing fields gracefully', () => {
    const contact = mockContact({ name: null, company: null, role: null })
    const result = applyTemplate('Hello {{name}} from {{company}}', contact)
    expect(result).toBe('Hello  from ')
  })

  test('replaces custom fields', () => {
    const contact = mockContact({ custom_fields: '{"industry": "Tech", "city": "SF"}' })
    const result = applyTemplate('{{name}} in {{industry}}, {{city}}', contact)
    expect(result).toBe('Alice in Tech, SF')
  })
})
