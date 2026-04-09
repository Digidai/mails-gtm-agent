import { describe, test, expect, mock } from 'bun:test'
import { replySendCron } from '../../src/scheduler/reply-send-cron'

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

describe('replySendCron', () => {
  test('skips when no pending scheduled replies', async () => {
    const env = {
      DB: mockD1(() => ({ results: [] })),
      MAILS_WORKER: { fetch: mock(async () => new Response('{}', { status: 200 })) },
    } as any

    await replySendCron(env)
    expect(env.MAILS_WORKER.fetch).not.toHaveBeenCalled()
  })

  test('skips reply if campaign is no longer active', async () => {
    const env = {
      DB: mockD1((sql) => {
        if (sql.includes('scheduled_replies')) return {
          results: [{ id: 'sr1', campaign_id: 'c1', contact_id: 'x1', reply_body: 'hi', reply_subject: 'Re: hi', send_at: '2026-01-01', sent: 0 }],
        }
        if (sql.includes('FROM campaigns')) return { id: 'c1', status: 'paused', physical_address: '123 Main', from_email: 'hi@t.com' }
        return null
      }),
      MAILS_WORKER: { fetch: mock(async () => new Response('{}', { status: 200 })) },
    } as any

    await replySendCron(env)
    // Should NOT call mails-worker to send
    expect(env.MAILS_WORKER.fetch).not.toHaveBeenCalled()
  })
})
