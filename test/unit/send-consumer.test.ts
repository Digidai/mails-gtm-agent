import { describe, test, expect, mock } from 'bun:test'
import { sendConsumer } from '../../src/queue/send-consumer'

function mockD1(handler: (sql: string, binds: unknown[]) => any) {
  return {
    prepare: (sql: string) => {
      const resolve = (binds: unknown[]) => ({
        all: async () => handler(sql, binds) ?? { results: [] },
        first: async () => {
          const r = handler(sql, binds)
          return r?.results?.[0] ?? r ?? null
        },
        run: async () => ({ meta: { changes: 1 } }),
      })
      return { ...resolve([]), bind: (...args: unknown[]) => resolve(args) }
    },
    batch: async () => {},
  }
}

describe('sendConsumer — compliance verification', () => {
  test('agent send includes compliance footer + List-Unsubscribe headers', async () => {
    const sentPayloads: any[] = []
    const env = {
      DB: mockD1((sql) => {
        if (sql.includes('FROM send_log WHERE decision_id')) return null // not sent yet
        if (sql.includes('FROM campaigns')) return { id: 'c1', status: 'active', physical_address: '123 Main St, SF CA', from_email: 'hi@test.com', dry_run: false }
        if (sql.includes('FROM campaign_contacts')) return { id: 'x1', status: 'pending', emails_sent: 0 }
        if (sql.includes('FROM unsubscribes')) return null
        if (sql.includes('daily_stats')) return null
        return null
      }),
      MAILS_WORKER: {
        fetch: mock(async (req: Request) => {
          const body = await req.json()
          sentPayloads.push(body)
          return new Response(JSON.stringify({ id: 'msg1' }), { status: 200 })
        }),
      },
      MAILS_API_URL: 'https://test.workers.dev',
      MAILS_API_KEY: 'key',
      MAILS_MAILBOX: 'test@mails0.com',
      DAILY_SEND_LIMIT: '100',
      UNSUBSCRIBE_SECRET: 'abcdefghijklmnopqrstuvwxyz123456',
      UNSUBSCRIBE_BASE_URL: 'https://gtm.test.dev',
    } as any

    const batch = {
      messages: [{
        body: {
          type: 'agent_send', campaign_id: 'c1', contact_id: 'x1',
          mailbox: 'hi@test.com', to: 'alice@acme.com',
          subject: 'Hello', body: 'Test body', decision_id: 'd1',
        },
        ack: mock(() => {}),
        retry: mock(() => {}),
      }],
    } as any

    await sendConsumer(batch, env)

    expect(sentPayloads.length).toBe(1)
    expect(sentPayloads[0].text).toContain('123 Main St') // Physical address in footer
    expect(sentPayloads[0].text).toContain('Unsubscribe') // Unsub link in footer
    expect(sentPayloads[0].headers['List-Unsubscribe']).toContain('https://gtm.test.dev/unsubscribe')
    expect(sentPayloads[0].headers['List-Unsubscribe-Post']).toBe('List-Unsubscribe=One-Click')
    expect(batch.messages[0].ack).toHaveBeenCalled()
  })

  test('refuses to send without physical address', async () => {
    const env = {
      DB: mockD1((sql) => {
        if (sql.includes('FROM send_log WHERE decision_id')) return null
        if (sql.includes('FROM campaigns')) return { id: 'c1', status: 'active', physical_address: '', dry_run: false }
        if (sql.includes('FROM campaign_contacts')) return { id: 'x1', status: 'pending' }
        return null
      }),
      MAILS_WORKER: { fetch: mock(async () => new Response('{}', { status: 200 })) },
      DAILY_SEND_LIMIT: '100',
      UNSUBSCRIBE_SECRET: 'abcdefghijklmnopqrstuvwxyz123456',
      UNSUBSCRIBE_BASE_URL: 'https://gtm.test.dev',
    } as any

    const batch = {
      messages: [{
        body: { type: 'agent_send', campaign_id: 'c1', contact_id: 'x1', mailbox: 'hi@test.com', to: 'a@b.com', subject: 'Hi', body: 'Test', decision_id: 'd1' },
        ack: mock(() => {}),
        retry: mock(() => {}),
      }],
    } as any

    await sendConsumer(batch, env)
    expect(batch.messages[0].ack).toHaveBeenCalled()
    expect(env.MAILS_WORKER.fetch).not.toHaveBeenCalled() // Should NOT send
  })
})
