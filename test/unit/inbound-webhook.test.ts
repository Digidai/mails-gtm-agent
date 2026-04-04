import { describe, test, expect, mock, beforeEach } from 'bun:test'
import { handleInboundWebhook } from '../../src/routes/inbound-webhook'
import { Env } from '../../src/types'

const WEBHOOK_SECRET = 'test-inbound-webhook-secret'

async function signPayload(body: string, secret: string): Promise<string> {
  const encoder = new TextEncoder()
  const key = await crypto.subtle.importKey(
    'raw',
    encoder.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  )
  const sig = await crypto.subtle.sign('HMAC', key, encoder.encode(body))
  return Array.from(new Uint8Array(sig))
    .map(b => b.toString(16).padStart(2, '0'))
    .join('')
}

/**
 * Create a mock D1 database that handles the SQL queries used by handleInboundWebhook.
 */
function createMockDB(config: {
  dedupInserted?: boolean   // true = msg_id was new (not duplicate)
  contactResults?: any[]    // campaign_contacts JOIN campaigns rows
  emailBody?: string        // body returned by mailsFetch /v1/email
  emailHeaders?: Record<string, string>
}) {
  const recordedQueries: Array<{ sql: string; binds: any[] }> = []

  return {
    db: {
      prepare: (sql: string) => ({
        bind: (...args: any[]) => {
          recordedQueries.push({ sql, binds: args })

          // processed_messages SELECT dedup check
          if (sql.includes('SELECT 1 FROM processed_messages')) {
            return {
              first: async () => config.dedupInserted === false ? { '1': 1 } : null,
            }
          }

          // processed_messages INSERT OR IGNORE (post-processing write)
          if (sql.includes('INSERT OR IGNORE INTO processed_messages')) {
            return {
              run: async () => ({
                meta: { changes: 1 },
              }),
            }
          }

          // campaign_contacts query
          if (sql.includes('campaign_contacts cc') && sql.includes('JOIN campaigns')) {
            return {
              all: async () => ({
                results: config.contactResults || [],
              }),
            }
          }

          // conversations query (getConversationHistory)
          if (sql.includes('conversations') && sql.includes('ORDER BY')) {
            return {
              all: async () => ({ results: [] }),
            }
          }

          // INSERT INTO events
          if (sql.includes('INSERT INTO events')) {
            return {
              run: async () => ({ meta: { changes: 1 } }),
            }
          }

          // INSERT INTO conversations
          if (sql.includes('INSERT INTO conversations')) {
            return {
              run: async () => ({ meta: { changes: 1 } }),
            }
          }

          // UPDATE campaigns (LLM quota)
          if (sql.includes('UPDATE campaigns')) {
            return {
              run: async () => ({ meta: { changes: 1 } }),
            }
          }

          // UPDATE campaign_contacts
          if (sql.includes('UPDATE campaign_contacts')) {
            return {
              run: async () => ({ meta: { changes: 1 } }),
            }
          }

          // INSERT INTO unsubscribes
          if (sql.includes('INSERT INTO unsubscribes')) {
            return {
              run: async () => ({ meta: { changes: 1 } }),
            }
          }

          // Default fallback
          return {
            first: async () => null,
            all: async () => ({ results: [] }),
            run: async () => ({ meta: { changes: 0 } }),
          }
        },
      }),
    },
    recordedQueries,
  }
}

function makeContact(overrides: Record<string, any> = {}) {
  return {
    id: 'contact-1',
    campaign_id: 'campaign-1',
    email: 'alice@acme.com',
    name: 'Alice',
    company: 'Acme',
    role: 'CTO',
    custom_fields: '{}',
    status: 'sent',
    current_step: 1,
    next_send_at: null,
    last_sent_at: new Date().toISOString(),
    sent_message_id: null,
    resume_at: null,
    reply_intent: null,
    reply_confidence: null,
    emails_sent: 1,
    last_click_at: null,
    converted_at: null,
    conversion_type: null,
    next_check_at: null,
    last_enqueued_at: null,
    auto_reply_count: 0,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    // Joined campaign fields
    engine: 'agent',
    _campaign_id: 'campaign-1',
    _campaign_name: 'Test Campaign',
    _kb: '{}',
    _conversion_url: 'https://example.com',
    _product_url: null,
    _product_name: 'TestProduct',
    _max_auto_replies: 5,
    _from_email: 'hi@test.com',
    _physical_address: '123 Main St',
    _product_description: 'A test product',
    _dry_run: 0,
    ...overrides,
  }
}

/**
 * Build a mock env that stubs mailsFetch (via MAILS_WORKER service binding)
 * and the classifyReply LLM call.
 */
function createMockEnv(mockDB: any, overrides: Partial<Env> = {}): any {
  return {
    DB: mockDB.db,
    WEBHOOK_SECRET,
    MAILS_MAILBOX: 'hi@test.com',
    MAILS_API_KEY: 'test-key',
    MAILS_API_URL: 'https://mails.test',
    ADMIN_TOKEN: 'test-admin',
    UNSUBSCRIBE_SECRET: 'test-unsub-secret',
    UNSUBSCRIBE_BASE_URL: 'https://mails-gtm-agent.test',
    OPENROUTER_API_KEY: 'test-openrouter',
    DAILY_SEND_LIMIT: '100',
    MAX_CSV_SIZE: '5242880',
    // Service binding mock — returns email body
    MAILS_WORKER: {
      fetch: async (req: Request) => {
        const url = new URL(req.url)
        if (url.pathname.startsWith('/v1/email')) {
          return new Response(JSON.stringify({
            body_text: 'I am interested in learning more about your product.',
            body: 'I am interested in learning more about your product.',
            headers: {},
          }), { status: 200 })
        }
        if (url.pathname.startsWith('/v1/send')) {
          return new Response(JSON.stringify({ id: 'sent-1' }), { status: 200 })
        }
        return new Response('Not found', { status: 404 })
      },
    },
    ...overrides,
  }
}

async function makeRequest(payload: Record<string, any>, secret = WEBHOOK_SECRET): Promise<Request> {
  const body = JSON.stringify(payload)
  const signature = await signPayload(body, secret)
  return new Request('https://test.com/webhook/inbound', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Webhook-Signature': signature,
    },
    body,
  })
}

// Mock the LLM classify module so we don't actually call OpenRouter
import * as classifyModule from '../../src/llm/classify'
mock.module('../../src/llm/classify', () => ({
  classifyReply: async () => ({
    intent: 'interested',
    confidence: 0.95,
    resume_date: null,
  }),
}))

describe('Inbound Webhook Handler', () => {
  test('valid webhook with correct HMAC processes reply and returns 200', async () => {
    const mockDB = createMockDB({
      dedupInserted: true,
      contactResults: [makeContact()],
      emailBody: 'I am interested in learning more.',
    })
    const env = createMockEnv(mockDB)

    const request = await makeRequest({
      event: 'message.received',
      email_id: 'email-123',
      from: 'alice@acme.com',
      to: 'hi@test.com',
      subject: 'Re: Our product',
      received_at: new Date().toISOString(),
    })

    const response = await handleInboundWebhook(request, env)
    const data = await response.json() as any

    expect(response.status).toBe(200)
    expect(data.status).toBe('processed')
    expect(data.intent).toBeTruthy()

    // Verify dedup insert was attempted
    const dedupQuery = mockDB.recordedQueries.find(q => q.sql.includes('processed_messages'))
    expect(dedupQuery).toBeTruthy()

    // Verify event was recorded
    const eventQuery = mockDB.recordedQueries.find(q => q.sql.includes('INSERT INTO events'))
    expect(eventQuery).toBeTruthy()
  })

  test('invalid HMAC signature returns 401', async () => {
    const mockDB = createMockDB({})
    const env = createMockEnv(mockDB)

    const body = JSON.stringify({
      event: 'message.received',
      email_id: 'email-123',
      from: 'alice@acme.com',
    })

    const request = new Request('https://test.com/webhook/inbound', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Webhook-Signature': 'invalid-signature-here',
      },
      body,
    })

    const response = await handleInboundWebhook(request, env)
    expect(response.status).toBe(401)
  })

  test('missing signature returns 401', async () => {
    const mockDB = createMockDB({})
    const env = createMockEnv(mockDB)

    const request = new Request('https://test.com/webhook/inbound', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ event: 'message.received', from: 'alice@acme.com' }),
    })

    const response = await handleInboundWebhook(request, env)
    expect(response.status).toBe(401)
  })

  test('duplicate message (already in processed_messages) skips and returns 200', async () => {
    const mockDB = createMockDB({
      dedupInserted: false, // Already processed
      contactResults: [makeContact()],
    })
    const env = createMockEnv(mockDB)

    const request = await makeRequest({
      event: 'message.received',
      email_id: 'email-already-processed',
      from: 'alice@acme.com',
      subject: 'Re: Hello',
    })

    const response = await handleInboundWebhook(request, env)
    const data = await response.json() as any

    expect(response.status).toBe(200)
    expect(data.status).toBe('skipped')
    expect(data.reason).toBe('duplicate')

    // Verify no event was recorded (skipped before processing)
    const eventQuery = mockDB.recordedQueries.find(q => q.sql.includes('INSERT INTO events'))
    expect(eventQuery).toBeUndefined()
  })

  test('unknown sender (no matching contact) skips and returns 200', async () => {
    const mockDB = createMockDB({
      dedupInserted: true,
      contactResults: [], // No matching contacts
    })
    const env = createMockEnv(mockDB)

    const request = await makeRequest({
      event: 'message.received',
      email_id: 'email-456',
      from: 'unknown@stranger.com',
      subject: 'Hi there',
    })

    const response = await handleInboundWebhook(request, env)
    const data = await response.json() as any

    expect(response.status).toBe(200)
    expect(data.status).toBe('skipped')
    expect(data.reason).toBe('no matching contact')
  })

  test('malformed payload (missing from field) returns 400', async () => {
    const mockDB = createMockDB({})
    const env = createMockEnv(mockDB)

    const request = await makeRequest({
      event: 'message.received',
      email_id: 'email-789',
      // missing 'from' field
      subject: 'Re: Something',
    })

    const response = await handleInboundWebhook(request, env)
    expect(response.status).toBe(400)
  })

  test('self-reply (sender is our mailbox) skips and returns 200', async () => {
    const mockDB = createMockDB({})
    const env = createMockEnv(mockDB)

    const request = await makeRequest({
      event: 'message.received',
      email_id: 'email-self',
      from: 'hi@test.com', // Same as MAILS_MAILBOX
      subject: 'Re: Test',
    })

    const response = await handleInboundWebhook(request, env)
    const data = await response.json() as any

    expect(response.status).toBe(200)
    expect(data.status).toBe('skipped')
    expect(data.reason).toBe('self-reply')
  })

  test('non message.received event skips gracefully', async () => {
    const mockDB = createMockDB({})
    const env = createMockEnv(mockDB)

    const request = await makeRequest({
      event: 'message.sent',
      email_id: 'email-outbound',
      from: 'hi@test.com',
    })

    const response = await handleInboundWebhook(request, env)
    const data = await response.json() as any

    expect(response.status).toBe(200)
    expect(data.status).toBe('skipped')
    expect(data.reason).toBe('not a message.received event')
  })

  test('invalid JSON body returns 400', async () => {
    const mockDB = createMockDB({})
    const env = createMockEnv(mockDB)

    const body = 'not-valid-json{'
    const signature = await signPayload(body, WEBHOOK_SECRET)

    const request = new Request('https://test.com/webhook/inbound', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Webhook-Signature': signature,
      },
      body,
    })

    const response = await handleInboundWebhook(request, env)
    expect(response.status).toBe(400)
  })

  test('self-reply via campaign from_email skips and returns 200', async () => {
    // Test where sender matches the campaign's from_email (not the global MAILS_MAILBOX)
    const mockDB = createMockDB({
      dedupInserted: true,
      contactResults: [makeContact({ _from_email: 'sender@campaign.com' })],
    })
    const env = createMockEnv(mockDB)

    const request = await makeRequest({
      event: 'message.received',
      email_id: 'email-campaign-self',
      from: 'sender@campaign.com',
      subject: 'Re: Campaign email',
    })

    const response = await handleInboundWebhook(request, env)
    const data = await response.json() as any

    expect(response.status).toBe(200)
    expect(data.status).toBe('skipped')
    expect(data.reason).toBe('self-reply')
  })

  test('WEBHOOK_SECRET not configured returns 500', async () => {
    const mockDB = createMockDB({})
    const env = createMockEnv(mockDB, { WEBHOOK_SECRET: undefined } as any)
    // Remove the secret entirely
    delete (env as any).WEBHOOK_SECRET

    const request = await makeRequest({
      event: 'message.received',
      from: 'alice@acme.com',
    })

    const response = await handleInboundWebhook(request, env)
    expect(response.status).toBe(500)
  })
})
