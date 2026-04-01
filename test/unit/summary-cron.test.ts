import { describe, test, expect } from 'bun:test'
import { summaryCron } from '../../src/scheduler/summary-cron'
import { Env } from '../../src/types'

let sentEmails: Array<{ to: string[]; subject: string; text: string }> = []

function mockEnv(campaigns: any[] = []): Env {
  sentEmails = []

  return {
    MAILS_MAILBOX: 'agent@test.com',
    MAILS_API_URL: 'https://test.example.com',
    MAILS_API_KEY: 'test-key',
    MAILS_WORKER: {
      fetch: async (req: Request) => {
        const url = new URL(req.url)
        if (url.pathname === '/v1/send' && req.method === 'POST') {
          const body = await req.json() as any
          sentEmails.push(body)
          return new Response(JSON.stringify({ ok: true }), { status: 200 })
        }
        return new Response('Not Found', { status: 404 })
      },
    },
    DB: {
      prepare: (sql: string) => {
        const queryResult = {
          all: async () => {
            if (sql.includes("status = 'active' AND engine = 'agent'")) {
              return { results: campaigns }
            }
            if (sql.includes('interested')) {
              return { results: [] }
            }
            return { results: [] }
          },
          first: async () => {
            if (sql.includes('daily_stats')) return { count: 5 }
            if (sql.includes('link_click')) return { count: 2 }
            if (sql.includes("event_type = 'reply'")) return { count: 1 }
            if (sql.includes('converted_at')) return { count: 0 }
            if (sql.includes('COUNT(*)')) return { total: 50, interested: 3, converted: 1, active: 40 }
            return null
          },
        }
        return {
          ...queryResult,
          bind: (..._args: any[]) => queryResult,
        }
      },
    },
  } as any
}

describe('summaryCron', () => {
  test('sends summary email for active campaigns', async () => {
    const env = mockEnv([{
      id: 'camp1', name: 'Test Campaign', from_email: 'owner@test.com',
      status: 'active', engine: 'agent',
    }])

    await summaryCron(env)

    expect(sentEmails.length).toBe(1)
    expect(sentEmails[0].subject).toContain('[mails-gtm] Daily summary')
    expect(sentEmails[0].subject).toContain('Test Campaign')
    expect(sentEmails[0].text).toContain('Emails sent: 5')
    expect(sentEmails[0].text).toContain('Link clicks: 2')
  })

  test('skips when no active campaigns', async () => {
    const env = mockEnv([])
    await summaryCron(env)
    expect(sentEmails.length).toBe(0)
  })
})
