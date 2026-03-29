import { describe, test, expect } from 'bun:test'
import { handleStatsRoutes } from '../../src/routes/stats'
import { Env } from '../../src/types'

function createMockDB(config: {
  campaign?: any
  totalContacts?: number
  statusCounts?: Array<{ status: string; count: number }>
  sentPerStep?: Array<{ step_number: number; count: number }>
  pendingPerStep?: Array<{ current_step: number; count: number }>
  todaySent?: number
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

      // Total contacts count
      if (sql.includes('COUNT(*)') && sql.includes('campaign_contacts WHERE campaign_id') && !sql.includes('GROUP BY')) {
        return {
          bind: (..._args: any[]) => ({
            first: async <T = any>() => ({ count: config.totalContacts ?? 0 }) as T,
          }),
        }
      }

      // Status group by
      if (sql.includes('GROUP BY status')) {
        return {
          bind: (..._args: any[]) => ({
            all: async <T = any>() => ({
              results: (config.statusCounts || []) as T[],
            }),
          }),
        }
      }

      // Sent per step
      if (sql.includes('GROUP BY step_number')) {
        return {
          bind: (..._args: any[]) => ({
            all: async <T = any>() => ({
              results: (config.sentPerStep || []) as T[],
            }),
          }),
        }
      }

      // Pending per step
      if (sql.includes('GROUP BY current_step')) {
        return {
          bind: (..._args: any[]) => ({
            all: async <T = any>() => ({
              results: (config.pendingPerStep || []) as T[],
            }),
          }),
        }
      }

      // Daily stats
      if (sql.includes('daily_stats')) {
        return {
          bind: (..._args: any[]) => ({
            first: async <T = any>() => ({ count: config.todaySent ?? 0 }) as T,
          }),
        }
      }

      // Default fallback
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
    DAILY_SEND_LIMIT: '50',
    MAX_CSV_SIZE: '5242880',
    DB: createMockDB(dbConfig) as any,
    SEND_QUEUE: {} as any,
    EVALUATE_QUEUE: {} as any,
  }
}

describe('Stats API', () => {
  test('GET /api/campaign/:id/stats - returns full stats', async () => {
    const env = mockEnv({
      campaign: {
        id: 'abc123',
        name: 'Launch',
        status: 'active',
        steps: JSON.stringify([
          { step_number: 1, delay_days: 0 },
          { step_number: 2, delay_days: 3 },
          { step_number: 3, delay_days: 7 },
        ]),
      },
      totalContacts: 150,
      statusCounts: [
        { status: 'pending', count: 80 },
        { status: 'sent', count: 40 },
        { status: 'replied', count: 15 },
        { status: 'bounced', count: 3 },
        { status: 'unsubscribed', count: 2 },
        { status: 'interested', count: 3 },
        { status: 'not_now', count: 1 },
        { status: 'not_interested', count: 1 },
        { status: 'queued', count: 5 },
      ],
      sentPerStep: [
        { step_number: 1, count: 65 },
        { step_number: 2, count: 30 },
        { step_number: 3, count: 10 },
      ],
      pendingPerStep: [
        { current_step: 1, count: 85 },
        { current_step: 2, count: 35 },
        { current_step: 3, count: 20 },
      ],
      todaySent: 12,
    })

    const request = new Request('https://test.com/api/campaign/abc123/stats', { method: 'GET' })
    const response = await handleStatsRoutes(request, env)
    const data = await response.json() as any

    expect(response.status).toBe(200)
    expect(data.campaign_id).toBe('abc123')
    expect(data.name).toBe('Launch')
    expect(data.status).toBe('active')
    expect(data.total_contacts).toBe(150)
    expect(data.by_status.pending).toBe(80)
    expect(data.by_status.sent).toBe(40)
    expect(data.by_status.replied).toBe(15)
    expect(data.by_status.bounced).toBe(3)
    expect(data.by_status.interested).toBe(3)
    expect(data.steps).toHaveLength(3)
    expect(data.steps[0].step_number).toBe(1)
    expect(data.steps[0].sent).toBe(65)
    expect(data.steps[0].pending).toBe(85)
    expect(data.steps[1].step_number).toBe(2)
    expect(data.steps[1].sent).toBe(30)
    expect(data.steps[1].pending).toBe(35)
    expect(data.steps[2].step_number).toBe(3)
    expect(data.steps[2].sent).toBe(10)
    expect(data.steps[2].pending).toBe(20)
    expect(data.today_sent).toBe(12)
    expect(data.daily_limit).toBe(50)
  })

  test('GET /api/campaign/:id/stats - 404 for missing campaign', async () => {
    const env = mockEnv({})

    const request = new Request('https://test.com/api/campaign/missing/stats', { method: 'GET' })
    const response = await handleStatsRoutes(request, env)

    expect(response.status).toBe(404)
  })

  test('GET /api/campaign/:id/stats - handles campaign with no contacts', async () => {
    const env = mockEnv({
      campaign: {
        id: 'abc123',
        name: 'Empty',
        status: 'draft',
        steps: '[]',
      },
      totalContacts: 0,
      statusCounts: [],
      todaySent: 0,
    })

    const request = new Request('https://test.com/api/campaign/abc123/stats', { method: 'GET' })
    const response = await handleStatsRoutes(request, env)
    const data = await response.json() as any

    expect(response.status).toBe(200)
    expect(data.total_contacts).toBe(0)
    expect(data.by_status).toEqual({})
    expect(data.steps).toEqual([])
    expect(data.today_sent).toBe(0)
  })

  test('GET /api/campaign/:id/stats - aggregates by_status correctly', async () => {
    const env = mockEnv({
      campaign: {
        id: 'abc123',
        name: 'Test',
        status: 'active',
        steps: '[]',
      },
      totalContacts: 10,
      statusCounts: [
        { status: 'pending', count: 5 },
        { status: 'sent', count: 3 },
        { status: 'replied', count: 2 },
      ],
      todaySent: 3,
    })

    const request = new Request('https://test.com/api/campaign/abc123/stats', { method: 'GET' })
    const response = await handleStatsRoutes(request, env)
    const data = await response.json() as any

    expect(data.by_status.pending).toBe(5)
    expect(data.by_status.sent).toBe(3)
    expect(data.by_status.replied).toBe(2)
    // Keys not present should be undefined
    expect(data.by_status.bounced).toBeUndefined()
  })
})
