import { describe, test, expect, mock } from 'bun:test'
import { sendCron } from '../../src/scheduler/send-cron'

function mockD1(handler: (sql: string, binds: unknown[]) => any) {
  return {
    prepare: (sql: string) => {
      const resolve = (binds: unknown[]) => ({
        all: async () => handler(sql, binds),
        first: async () => {
          const r = handler(sql, binds)
          return r?.results?.[0] ?? r ?? null
        },
        run: async () => ({ meta: { changes: 1 } }),
      })
      return { ...resolve([]), bind: (...args: unknown[]) => resolve(args) }
    },
  }
}

describe('sendCron', () => {
  test('enqueues pending contacts from sequence campaigns', async () => {
    const queued: unknown[] = []
    const env = {
      DB: mockD1((sql) => {
        if (sql.includes("engine = 'sequence'")) return { results: [{ id: 'c1', status: 'active', engine: 'sequence', warmup_enabled: false }] }
        if (sql.includes('COUNT(*)')) return { count: 0 }
        if (sql.includes("status = 'pending'")) return { results: [{ id: 'x1', campaign_id: 'c1', current_step: 0 }] }
        return { results: [] }
      }),
      SEND_QUEUE: { send: mock(async (m: unknown) => { queued.push(m) }) },
      DAILY_SEND_LIMIT: '100',
    } as any

    await sendCron(env)
    expect(queued.length).toBe(1)
    expect((queued[0] as any).step_number).toBe(0)
  })

  test('respects global daily send limit', async () => {
    const queued: unknown[] = []
    const env = {
      DB: mockD1((sql) => {
        if (sql.includes("engine = 'sequence'")) return { results: [{ id: 'c1', status: 'active', engine: 'sequence' }] }
        if (sql.includes('COUNT(*)')) return { count: 100 }
        return { results: [] }
      }),
      SEND_QUEUE: { send: mock(async (m: unknown) => { queued.push(m) }) },
      DAILY_SEND_LIMIT: '100',
    } as any

    await sendCron(env)
    expect(queued.length).toBe(0) // limit reached
  })
})
