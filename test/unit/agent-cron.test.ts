import { describe, test, expect, mock } from 'bun:test'
import { agentCron } from '../../src/scheduler/agent-cron'

/** D1 mock that supports both prepare().all() and prepare().bind().all() */
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

describe('agentCron', () => {
  test('enqueues pending contacts for active agent campaigns', async () => {
    const queued: unknown[] = []
    const env = {
      DB: mockD1((sql) => {
        if (sql.includes("engine = 'agent'")) return { results: [{ id: 'c1', status: 'active', engine: 'agent', daily_llm_calls: 0, daily_llm_limit: 100, daily_llm_reset_at: null }] }
        if (sql.includes("status IN ('pending'")) return { results: [{ id: 'x1', campaign_id: 'c1' }] }
        return { results: [] }
      }),
      EVALUATE_QUEUE: { send: mock(async (m: unknown) => { queued.push(m) }) },
      DAILY_SEND_LIMIT: '100',
    } as any

    await agentCron(env)
    expect(queued.length).toBe(1)
    expect((queued[0] as any).type).toBe('evaluate')
  })

  test('skips when no active agent campaigns', async () => {
    const queued: unknown[] = []
    const env = {
      DB: mockD1(() => ({ results: [] })),
      EVALUATE_QUEUE: { send: mock(async (m: unknown) => { queued.push(m) }) },
      DAILY_SEND_LIMIT: '100',
    } as any

    await agentCron(env)
    expect(queued.length).toBe(0)
  })
})
