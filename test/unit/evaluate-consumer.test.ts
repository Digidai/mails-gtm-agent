import { describe, test, expect, mock } from 'bun:test'
import { evaluateConsumer } from '../../src/queue/evaluate-consumer'

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

describe('evaluateConsumer', () => {
  test('skips when campaign not found', async () => {
    const queued: unknown[] = []
    const env = {
      DB: mockD1(() => null),
      SEND_QUEUE: { send: mock(async (m: unknown) => { queued.push(m) }) },
      OPENROUTER_API_KEY: 'key',
      DAILY_SEND_LIMIT: '100',
    } as any

    const batch = {
      messages: [{ body: { type: 'evaluate', campaign_id: 'c1', contact_id: 'x1' }, ack: mock(() => {}), retry: mock(() => {}) }],
    } as any

    await evaluateConsumer(batch, env)
    expect(batch.messages[0].ack).toHaveBeenCalled()
    expect(queued.length).toBe(0)
  })

  test('skips when campaign is paused', async () => {
    const queued: unknown[] = []
    const env = {
      DB: mockD1((sql) => {
        if (sql.includes('FROM campaigns')) return { id: 'c1', status: 'paused', engine: 'agent' }
        return null
      }),
      SEND_QUEUE: { send: mock(async (m: unknown) => { queued.push(m) }) },
      OPENROUTER_API_KEY: 'key',
      DAILY_SEND_LIMIT: '100',
    } as any

    const batch = {
      messages: [{ body: { type: 'evaluate', campaign_id: 'c1', contact_id: 'x1' }, ack: mock(() => {}), retry: mock(() => {}) }],
    } as any

    await evaluateConsumer(batch, env)
    expect(batch.messages[0].ack).toHaveBeenCalled()
    expect(queued.length).toBe(0)
  })

  test('retries on unexpected error', async () => {
    const env = {
      DB: { prepare: () => { throw new Error('DB down') } },
      OPENROUTER_API_KEY: 'key',
      DAILY_SEND_LIMIT: '100',
    } as any

    const batch = {
      messages: [{ body: { type: 'evaluate', campaign_id: 'c1', contact_id: 'x1' }, ack: mock(() => {}), retry: mock(() => {}) }],
    } as any

    await evaluateConsumer(batch, env)
    expect(batch.messages[0].retry).toHaveBeenCalled()
  })
})
