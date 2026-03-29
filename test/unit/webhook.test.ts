import { describe, test, expect } from 'bun:test'
import { handleWebhookEvent } from '../../src/events/webhook'
import { Env, Campaign } from '../../src/types'

async function sign(body: string, secret: string): Promise<string> {
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

function createMockDB(config: {
  campaign?: Partial<Campaign> | null
  contact?: { id: string; status: string } | null
}) {
  const insertedEvents: any[] = []
  const updatedContacts: any[] = []

  return {
    db: {
      prepare: (sql: string) => {
        // Campaign lookup
        if (sql.includes('SELECT * FROM campaigns WHERE id')) {
          return {
            bind: () => ({
              first: async () => config.campaign || null,
            }),
          }
        }

        // Contact lookup
        if (sql.includes('campaign_contacts') && sql.includes('email')) {
          return {
            bind: () => ({
              first: async () => config.contact || null,
            }),
          }
        }

        // Event insert
        if (sql.includes('INSERT INTO events')) {
          return {
            bind: (...args: any[]) => {
              insertedEvents.push(args)
              return {
                run: async () => ({ meta: { changes: 1 } }),
              }
            },
          }
        }

        // Contact update
        if (sql.includes('UPDATE campaign_contacts')) {
          return {
            bind: (...args: any[]) => {
              updatedContacts.push(args)
              return {
                run: async () => ({ meta: { changes: 1 } }),
              }
            },
          }
        }

        return {
          bind: () => ({
            first: async () => null,
            all: async () => ({ results: [] }),
            run: async () => ({ meta: { changes: 0 } }),
          }),
        }
      },
    },
    insertedEvents,
    updatedContacts,
  }
}

describe('Webhook Event Handler', () => {
  const SECRET = 'test-webhook-secret'

  test('records signup event with valid signature', async () => {
    const mock = createMockDB({
      campaign: {
        id: 'campaign-1',
        webhook_secret: SECRET,
      } as Campaign,
      contact: { id: 'contact-1', status: 'active' },
    })

    const body = JSON.stringify({
      email: 'alice@acme.com',
      event: 'signup',
      timestamp: Math.floor(Date.now() / 1000),
      data: { plan: 'pro' },
    })

    const signature = await sign(body, SECRET)

    const request = new Request('https://test.com/webhook/event/campaign-1', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Webhook-Signature': signature,
      },
      body,
    })

    const env = { DB: mock.db } as any
    const response = await handleWebhookEvent(request, 'campaign-1', env)
    const data = await response.json() as any

    expect(response.status).toBe(200)
    expect(data.status).toBe('recorded')
    expect(data.event_id).toBeTruthy()
    expect(mock.insertedEvents).toHaveLength(1)
    // Should update contact to converted
    expect(mock.updatedContacts).toHaveLength(1)
  })

  test('rejects invalid signature', async () => {
    const mock = createMockDB({
      campaign: {
        id: 'campaign-1',
        webhook_secret: SECRET,
      } as Campaign,
    })

    const body = JSON.stringify({
      email: 'alice@acme.com',
      event: 'signup',
      timestamp: Math.floor(Date.now() / 1000),
    })

    const request = new Request('https://test.com/webhook/event/campaign-1', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Webhook-Signature': 'invalid-signature',
      },
      body,
    })

    const env = { DB: mock.db } as any
    const response = await handleWebhookEvent(request, 'campaign-1', env)

    expect(response.status).toBe(401)
  })

  test('rejects missing signature', async () => {
    const mock = createMockDB({
      campaign: {
        id: 'campaign-1',
        webhook_secret: SECRET,
      } as Campaign,
    })

    const body = JSON.stringify({
      email: 'alice@acme.com',
      event: 'signup',
      timestamp: Math.floor(Date.now() / 1000),
    })

    const request = new Request('https://test.com/webhook/event/campaign-1', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body,
    })

    const env = { DB: mock.db } as any
    const response = await handleWebhookEvent(request, 'campaign-1', env)

    expect(response.status).toBe(401)
  })

  test('returns 404 for unknown campaign', async () => {
    const mock = createMockDB({ campaign: null })

    const body = JSON.stringify({
      email: 'alice@acme.com',
      event: 'signup',
    })

    const request = new Request('https://test.com/webhook/event/nonexistent', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body,
    })

    const env = { DB: mock.db } as any
    const response = await handleWebhookEvent(request, 'nonexistent', env)

    expect(response.status).toBe(404)
  })

  test('returns 400 for invalid event type', async () => {
    const mock = createMockDB({
      campaign: {
        id: 'campaign-1',
        webhook_secret: SECRET,
      } as Campaign,
    })

    const body = JSON.stringify({
      email: 'alice@acme.com',
      event: 'invalid_event',
      timestamp: Math.floor(Date.now() / 1000),
    })

    const signature = await sign(body, SECRET)

    const request = new Request('https://test.com/webhook/event/campaign-1', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Webhook-Signature': signature,
      },
      body,
    })

    const env = { DB: mock.db } as any
    const response = await handleWebhookEvent(request, 'campaign-1', env)

    expect(response.status).toBe(400)
  })

  test('returns 404 for unknown contact', async () => {
    const mock = createMockDB({
      campaign: {
        id: 'campaign-1',
        webhook_secret: SECRET,
      } as Campaign,
      contact: null,
    })

    const body = JSON.stringify({
      email: 'unknown@acme.com',
      event: 'signup',
      timestamp: Math.floor(Date.now() / 1000),
    })

    const signature = await sign(body, SECRET)

    const request = new Request('https://test.com/webhook/event/campaign-1', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Webhook-Signature': signature,
      },
      body,
    })

    const env = { DB: mock.db } as any
    const response = await handleWebhookEvent(request, 'campaign-1', env)

    expect(response.status).toBe(404)
  })

  test('rejects webhook without timestamp (replay protection)', async () => {
    const mock = createMockDB({
      campaign: {
        id: 'campaign-1',
        webhook_secret: SECRET,
      } as Campaign,
      contact: { id: 'contact-1', status: 'active' },
    })

    const body = JSON.stringify({
      email: 'alice@acme.com',
      event: 'signup',
      // no timestamp
    })

    const signature = await sign(body, SECRET)

    const request = new Request('https://test.com/webhook/event/campaign-1', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Webhook-Signature': signature,
      },
      body,
    })

    const env = { DB: mock.db } as any
    const response = await handleWebhookEvent(request, 'campaign-1', env)

    expect(response.status).toBe(400)
    const data = await response.json() as any
    expect(data.error).toContain('timestamp')
  })

  test('rejects webhook with stale timestamp', async () => {
    const mock = createMockDB({
      campaign: {
        id: 'campaign-1',
        webhook_secret: SECRET,
      } as Campaign,
      contact: { id: 'contact-1', status: 'active' },
    })

    const body = JSON.stringify({
      email: 'alice@acme.com',
      event: 'signup',
      timestamp: Math.floor(Date.now() / 1000) - 600, // 10 minutes ago
    })

    const signature = await sign(body, SECRET)

    const request = new Request('https://test.com/webhook/event/campaign-1', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Webhook-Signature': signature,
      },
      body,
    })

    const env = { DB: mock.db } as any
    const response = await handleWebhookEvent(request, 'campaign-1', env)

    expect(response.status).toBe(401)
  })
})
