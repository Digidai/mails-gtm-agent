import { describe, test, expect } from 'bun:test'
import { handleAdminInfo } from '../../src/routes/admin'

function mockEnv(overrides: Record<string, unknown> = {}): any {
  const baseDb = {
    prepare: () => ({
      bind: () => ({
        first: async () => ({
          campaigns_total: 3,
          campaigns_active: 2,
          contacts_total: 50,
          contacts_active: 30,
          sends_today: 12,
          scheduled_pending: 1,
        }),
        all: async () => ({ results: [] }),
      }),
    }),
  }
  return {
    DB: baseDb,
    MAILS_API_KEY: 'mk_test',
    MAILS_MAILBOX: 'a@b.com',
    MAILS_API_URL: 'https://api.mails0.com',
    ADMIN_TOKEN: 'admin-token-test',
    UNSUBSCRIBE_SECRET: 'unsub-secret-test',
    UNSUBSCRIBE_BASE_URL: 'https://example.com',
    LLM_API_KEY: 'llm-key-test',
    LLM_MODEL: 'claude-sonnet-4-6',
    ...overrides,
  }
}

describe('GET /api/admin/info', () => {
  test('returns 405 on non-GET', async () => {
    const res = await handleAdminInfo(new Request('http://x/api/admin/info', { method: 'POST' }), mockEnv())
    expect(res.status).toBe(405)
  })

  test('reports all required secrets present', async () => {
    const res = await handleAdminInfo(new Request('http://x/api/admin/info'), mockEnv())
    expect(res.status).toBe(200)
    const data = await res.json() as any
    expect(data.ok).toBe(true)
    expect(data.secrets.required_missing).toEqual([])
    expect(data.secrets.llm_key_configured).toBe(true)
    expect(data.secrets.llm_key_source).toBe('LLM_API_KEY')
  })

  test('flags missing required secrets', async () => {
    const env = mockEnv()
    delete env.MAILS_API_KEY
    delete env.UNSUBSCRIBE_SECRET
    const res = await handleAdminInfo(new Request('http://x/api/admin/info'), env)
    const data = await res.json() as any
    expect(data.secrets.required_missing).toContain('MAILS_API_KEY')
    expect(data.secrets.required_missing).toContain('UNSUBSCRIBE_SECRET')
    expect(data.health.missing_required_secrets).toBe(true)
  })

  test('flags LLM not configured when no key alias is set', async () => {
    const env = mockEnv()
    delete env.LLM_API_KEY
    const res = await handleAdminInfo(new Request('http://x/api/admin/info'), env)
    const data = await res.json() as any
    expect(data.secrets.llm_key_configured).toBe(false)
    expect(data.health.llm_not_configured).toBe(true)
  })

  test('resolves llm_key_source from deprecated OPENROUTER_API_KEY', async () => {
    const env = mockEnv()
    delete env.LLM_API_KEY
    env.OPENROUTER_API_KEY = 'sk-or-legacy'
    const res = await handleAdminInfo(new Request('http://x/api/admin/info'), env)
    const data = await res.json() as any
    expect(data.secrets.llm_key_configured).toBe(true)
    expect(data.secrets.llm_key_source).toContain('OPENROUTER_API_KEY')
    expect(data.llm.provider).toContain('openrouter')
  })

  test('reports DB-reachable counts', async () => {
    const res = await handleAdminInfo(new Request('http://x/api/admin/info'), mockEnv())
    const data = await res.json() as any
    expect(data.db.reachable).toBe(true)
    expect(data.state.campaigns_active).toBe(2)
    expect(data.state.sends_today).toBe(12)
  })

  test('handles DB unreachable gracefully', async () => {
    const env = mockEnv()
    env.DB = {
      prepare: () => ({
        bind: () => ({
          first: async () => { throw new Error('D1_ERROR') },
          all: async () => { throw new Error('D1_ERROR') },
        }),
      }),
    }
    const res = await handleAdminInfo(new Request('http://x/api/admin/info'), env)
    expect(res.status).toBe(200)
    const data = await res.json() as any
    expect(data.db.reachable).toBe(false)
    expect(data.health.db_unreachable).toBe(true)
  })

  test('llm.provider parses LLM_BASE_URL hostname', async () => {
    const env = mockEnv({ LLM_BASE_URL: 'https://api.openai.com/v1/chat/completions' })
    const res = await handleAdminInfo(new Request('http://x/api/admin/info'), env)
    const data = await res.json() as any
    expect(data.llm.provider).toBe('api.openai.com')
  })
})
