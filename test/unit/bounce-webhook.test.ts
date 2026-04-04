import { describe, test, expect } from 'bun:test'
import { handleBounceWebhook } from '../../src/routes/bounce-webhook'
import { Env } from '../../src/types'

const ADMIN_TOKEN = 'test-admin-token'

function createMockDB(config: {
  contacts?: Array<{ id: string; campaign_id: string; status: string }>
  contactStatuses?: Record<string, string>
}) {
  const insertedEvents: any[] = []
  const updatedContacts: any[] = []
  const statuses = config.contactStatuses || {}
  for (const c of config.contacts || []) {
    statuses[c.id] = c.status
  }

  return {
    db: {
      prepare: (sql: string) => {
        // Find contacts by email across all campaigns
        if (sql.includes('FROM campaign_contacts cc WHERE cc.email')) {
          return {
            bind: () => ({
              all: async () => ({ results: config.contacts || [] }),
            }),
          }
        }

        // Global suppression insert (unsubscribes)
        if (sql.includes('INSERT INTO unsubscribes')) {
          return {
            bind: (...args: any[]) => ({
              run: async () => ({ meta: { changes: 1 } }),
            }),
          }
        }

        // State machine: SELECT status for contact
        if (sql.includes('SELECT status FROM campaign_contacts WHERE id')) {
          return {
            bind: (id: string) => ({
              first: async () => {
                const s = statuses[id]
                return s ? { status: s } : null
              },
            }),
          }
        }

        // State machine: UPDATE contact status
        if (sql.includes('UPDATE campaign_contacts SET status')) {
          return {
            bind: (...args: any[]) => {
              const newStatus = args[0]
              const contactId = args[args.length - 1]
              updatedContacts.push({ contactId, newStatus })
              // Update in-memory status
              statuses[contactId] = newStatus
              return {
                run: async () => ({ meta: { changes: 1 } }),
              }
            },
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

function makeRequest(body: unknown, token?: string): Request {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' }
  if (token) {
    headers['Authorization'] = `Bearer ${token}`
  }
  return new Request('https://test.com/webhook/bounce', {
    method: 'POST',
    headers,
    body: typeof body === 'string' ? body : JSON.stringify(body),
  })
}

describe('Bounce Webhook Handler', () => {
  test('valid bounce marks contacts as bounced and records events', async () => {
    const mock = createMockDB({
      contacts: [
        { id: 'contact-1', campaign_id: 'campaign-1', status: 'active' },
        { id: 'contact-2', campaign_id: 'campaign-2', status: 'pending' },
      ],
    })

    const request = makeRequest(
      { email: 'alice@acme.com', type: 'bounce', reason: 'Mailbox not found' },
      ADMIN_TOKEN,
    )

    const env = { DB: mock.db, ADMIN_TOKEN } as any
    const response = await handleBounceWebhook(request, env)
    const data = await response.json() as any

    expect(response.status).toBe(200)
    expect(data.ok).toBe(true)
    expect(data.matched).toBe(2)
    expect(data.updated).toBe(2)
    expect(mock.updatedContacts).toHaveLength(2)
    expect(mock.insertedEvents).toHaveLength(2)
  })

  test('missing email field returns 400', async () => {
    const mock = createMockDB({ contacts: [] })
    const request = makeRequest({ type: 'bounce' }, ADMIN_TOKEN)

    const env = { DB: mock.db, ADMIN_TOKEN } as any
    const response = await handleBounceWebhook(request, env)
    const data = await response.json() as any

    expect(response.status).toBe(400)
    expect(data.error).toContain('Missing email')
  })

  test('invalid JSON returns 400', async () => {
    const mock = createMockDB({ contacts: [] })
    const request = new Request('https://test.com/webhook/bounce', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${ADMIN_TOKEN}`,
      },
      body: 'not json {{',
    })

    const env = { DB: mock.db, ADMIN_TOKEN } as any
    const response = await handleBounceWebhook(request, env)
    const data = await response.json() as any

    expect(response.status).toBe(400)
    expect(data.error).toContain('Invalid JSON')
  })

  test('unknown email returns 200 with matched=0', async () => {
    const mock = createMockDB({ contacts: [] })
    const request = makeRequest(
      { email: 'unknown@nowhere.com', type: 'bounce' },
      ADMIN_TOKEN,
    )

    const env = { DB: mock.db, ADMIN_TOKEN } as any
    const response = await handleBounceWebhook(request, env)
    const data = await response.json() as any

    expect(response.status).toBe(200)
    expect(data.ok).toBe(true)
    expect(data.matched).toBe(0)
  })

  test('missing auth returns 401', async () => {
    const mock = createMockDB({ contacts: [] })
    const request = new Request('https://test.com/webhook/bounce', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'alice@acme.com' }),
    })

    const env = { DB: mock.db, ADMIN_TOKEN } as any
    const response = await handleBounceWebhook(request, env)

    expect(response.status).toBe(401)
  })

  test('wrong token returns 401', async () => {
    const mock = createMockDB({ contacts: [] })
    const request = makeRequest(
      { email: 'alice@acme.com' },
      'wrong-token',
    )

    const env = { DB: mock.db, ADMIN_TOKEN } as any
    const response = await handleBounceWebhook(request, env)

    expect(response.status).toBe(401)
  })

  test('state machine blocks bounce for do_not_contact contacts', async () => {
    const mock = createMockDB({
      contacts: [
        { id: 'contact-1', campaign_id: 'campaign-1', status: 'do_not_contact' },
      ],
      contactStatuses: { 'contact-1': 'do_not_contact' },
    })

    const request = makeRequest(
      { email: 'alice@acme.com', type: 'bounce', reason: 'Hard bounce' },
      ADMIN_TOKEN,
    )

    const env = { DB: mock.db, ADMIN_TOKEN } as any
    const response = await handleBounceWebhook(request, env)
    const data = await response.json() as any

    expect(response.status).toBe(200)
    expect(data.matched).toBe(1)
    // Should NOT be updated because do_not_contact has higher priority
    expect(data.updated).toBe(0)
    // No event recorded for blocked transitions
    expect(mock.insertedEvents).toHaveLength(0)
  })

  test('state machine blocks bounce for unsubscribed contacts', async () => {
    const mock = createMockDB({
      contacts: [
        { id: 'contact-1', campaign_id: 'campaign-1', status: 'unsubscribed' },
      ],
      contactStatuses: { 'contact-1': 'unsubscribed' },
    })

    const request = makeRequest(
      { email: 'alice@acme.com', type: 'bounce' },
      ADMIN_TOKEN,
    )

    const env = { DB: mock.db, ADMIN_TOKEN } as any
    const response = await handleBounceWebhook(request, env)
    const data = await response.json() as any

    expect(response.status).toBe(200)
    expect(data.matched).toBe(1)
    expect(data.updated).toBe(0)
  })
})
