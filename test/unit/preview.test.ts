import { describe, test, expect, beforeEach } from 'bun:test'
import { handlePreviewRoutes } from '../../src/routes/preview'
import { Env, CampaignContact } from '../../src/types'

const originalFetch = globalThis.fetch

function createMockDB(config: {
  campaign?: any
  pendingContacts?: CampaignContact[]
}) {
  return {
    prepare: (sql: string) => {
      // Campaign lookup
      if (sql.includes('SELECT * FROM campaigns WHERE id')) {
        return {
          bind: (..._args: any[]) => ({
            first: async <T = any>() => config.campaign as T | null,
          }),
        }
      }

      // Pending contacts
      if (sql.includes('campaign_contacts') && sql.includes('pending')) {
        return {
          bind: (..._args: any[]) => ({
            all: async <T = any>() => ({
              results: (config.pendingContacts || []) as T[],
            }),
          }),
        }
      }

      return {
        bind: (..._args: any[]) => ({
          first: async () => null,
          all: async () => ({ results: [] }),
          run: async () => ({ meta: { changes: 0 } }),
        }),
      }
    },
  }
}

function mockEnv(dbConfig: Parameters<typeof createMockDB>[0] = {}): Env {
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
    DB: createMockDB(dbConfig) as any,
    SEND_QUEUE: {} as any,
  }
}

function mockContact(overrides: Partial<CampaignContact> = {}): CampaignContact {
  return {
    id: 'contact-1',
    campaign_id: 'abc123',
    email: 'alice@acme.com',
    name: 'Alice',
    company: 'Acme Corp',
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

describe('Preview API', () => {
  beforeEach(() => {
    globalThis.fetch = originalFetch
  })

  test('POST /api/campaign/:id/preview - generates previews via LLM', async () => {
    // Mock the LLM call
    globalThis.fetch = (async () => new Response(JSON.stringify({
      choices: [{
        message: {
          content: JSON.stringify({
            subject: "Quick question about Acme's workflow",
            body: "Hi Alice, I noticed Acme Corp recently...",
          }),
        },
      }],
    }))) as any

    const contacts = [
      mockContact({ id: 'c1', email: 'alice@acme.com', name: 'Alice', company: 'Acme Corp' }),
      mockContact({ id: 'c2', email: 'bob@startup.io', name: 'Bob', company: 'Startup Inc' }),
    ]

    const env = mockEnv({
      campaign: {
        id: 'abc123',
        name: 'Launch',
        product_name: 'SuperSaaS',
        product_description: 'AI analytics platform',
        ai_generate: 1,
        steps: JSON.stringify([
          { delay_days: 0, subject_template: 'Hi {{name}}', body_template: 'Hello {{name}} at {{company}}' },
        ]),
      },
      pendingContacts: contacts,
    })

    const request = new Request('https://test.com/api/campaign/abc123/preview', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ count: 2 }),
    })

    const response = await handlePreviewRoutes(request, env)
    const data = await response.json() as any

    expect(response.status).toBe(200)
    expect(data.previews).toHaveLength(2)
    expect(data.previews[0].contact.email).toBe('alice@acme.com')
    expect(data.previews[0].contact.name).toBe('Alice')
    expect(data.previews[0].generated.subject).toBeTruthy()
    expect(data.previews[0].generated.body).toBeTruthy()
  })

  test('POST /api/campaign/:id/preview - falls back to template on LLM failure', async () => {
    globalThis.fetch = (async () => new Response('Error', { status: 500 })) as any

    const env = mockEnv({
      campaign: {
        id: 'abc123',
        name: 'Launch',
        product_name: 'SuperSaaS',
        product_description: 'AI analytics platform',
        ai_generate: 1,
        steps: JSON.stringify([
          { delay_days: 0, subject_template: 'Hi {{name}}', body_template: 'Hello {{name}} at {{company}}' },
        ]),
      },
      pendingContacts: [
        mockContact({ email: 'alice@acme.com', name: 'Alice', company: 'Acme Corp' }),
      ],
    })

    const request = new Request('https://test.com/api/campaign/abc123/preview', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ count: 1 }),
    })

    const response = await handlePreviewRoutes(request, env)
    const data = await response.json() as any

    expect(response.status).toBe(200)
    expect(data.previews).toHaveLength(1)
    // Should use template fallback
    expect(data.previews[0].generated.subject).toBe('Hi Alice')
    expect(data.previews[0].generated.body).toBe('Hello Alice at Acme Corp')
  })

  test('POST /api/campaign/:id/preview - 404 for missing campaign', async () => {
    const env = mockEnv({})

    const request = new Request('https://test.com/api/campaign/missing/preview', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ count: 1 }),
    })

    const response = await handlePreviewRoutes(request, env)
    expect(response.status).toBe(404)
  })

  test('POST /api/campaign/:id/preview - 404 when no pending contacts', async () => {
    const env = mockEnv({
      campaign: {
        id: 'abc123',
        name: 'Launch',
        product_name: 'SuperSaaS',
        product_description: 'AI analytics platform',
        ai_generate: 1,
        steps: '[]',
      },
      pendingContacts: [],
    })

    const request = new Request('https://test.com/api/campaign/abc123/preview', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ count: 3 }),
    })

    const response = await handlePreviewRoutes(request, env)
    expect(response.status).toBe(404)
  })

  test('POST /api/campaign/:id/preview - clamps count to 1-10', async () => {
    globalThis.fetch = (async () => new Response(JSON.stringify({
      choices: [{
        message: {
          content: JSON.stringify({ subject: 'Test', body: 'Test body' }),
        },
      }],
    }))) as any

    const env = mockEnv({
      campaign: {
        id: 'abc123',
        name: 'Launch',
        product_name: 'SuperSaaS',
        product_description: 'AI analytics platform',
        ai_generate: 1,
        steps: JSON.stringify([{ delay_days: 0, subject_template: '', body_template: '' }]),
      },
      pendingContacts: [mockContact()],
    })

    // Count = 100 should be clamped to 10, but only 1 contact available
    const request = new Request('https://test.com/api/campaign/abc123/preview', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ count: 100 }),
    })

    const response = await handlePreviewRoutes(request, env)
    const data = await response.json() as any

    expect(response.status).toBe(200)
    // Only 1 contact available, so 1 preview
    expect(data.previews).toHaveLength(1)
  })
})
