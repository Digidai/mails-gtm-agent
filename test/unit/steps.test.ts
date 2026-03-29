import { describe, test, expect, beforeEach } from 'bun:test'

// We test the steps route handler directly by constructing Request objects
// and mocking the Env/DB

interface MockStatement {
  bind: (...args: any[]) => MockStatement
  run: () => Promise<{ meta: { changes: number } }>
  first: <T = any>() => Promise<T | null>
  all: <T = any>() => Promise<{ results: T[] }>
}

function createMockDB(data: Record<string, any> = {}) {
  const statements: string[] = []
  let storedSteps = data.campaign?.steps || data.steps || '[]'

  const mockStatement: MockStatement = {
    bind: function (..._args: any[]) { return this },
    run: async () => {
      return { meta: { changes: 1 } }
    },
    first: async <T = any>() => {
      return (data.campaign || null) as T | null
    },
    all: async <T = any>() => {
      return { results: [] as T[] }
    },
  }

  return {
    prepare: (sql: string) => {
      statements.push(sql)

      // If it's an update query for steps, capture it
      if (sql.includes('UPDATE campaigns SET steps')) {
        return {
          bind: (...args: any[]) => {
            if (args[0]) storedSteps = args[0]
            return {
              run: async () => ({ meta: { changes: 1 } }),
            }
          },
        }
      }

      // If querying campaign
      if (sql.includes('SELECT') && sql.includes('campaigns')) {
        return {
          bind: (..._args: any[]) => ({
            first: async <T = any>() => {
              if (!data.campaign) return null
              return { ...data.campaign, steps: storedSteps } as T
            },
          }),
        }
      }

      return mockStatement
    },
    _statements: statements,
  }
}

// Import after mocking
import { handleStepsRoutes } from '../../src/routes/steps'
import { Env } from '../../src/types'

function mockEnv(dbOverrides: Record<string, any> = {}): Env {
  return {
    OPENROUTER_API_KEY: 'test-key',
    MAILS_API_URL: 'https://test.example.com',
    MAILS_API_KEY: 'test-mails-key',
    MAILS_MAILBOX: 'test@example.com',
    ADMIN_TOKEN: 'test-admin',
    UNSUBSCRIBE_SECRET: 'test-unsub-secret',
    UNSUBSCRIBE_BASE_URL: 'https://test.example.com',
    DAILY_SEND_LIMIT: '100',
    MAX_CSV_SIZE: '5242880',
    DB: createMockDB(dbOverrides) as any,
    SEND_QUEUE: {} as any,
  }
}

describe('Steps API', () => {
  test('POST /api/campaign/:id/steps - creates steps successfully', async () => {
    const env = mockEnv({
      campaign: { id: 'abc123', name: 'Test', steps: '[]' },
    })

    const body = {
      steps: [
        { step_number: 1, delay_days: 0, subject_template: 'Hi {{name}}', body_template: 'Hello!', ai_generate: false },
        { step_number: 2, delay_days: 3, subject_template: null, body_template: null, ai_generate: true },
        { step_number: 3, delay_days: 7, subject_template: 'Last chance', body_template: 'Final email', ai_generate: false },
      ],
    }

    const request = new Request('https://test.com/api/campaign/abc123/steps', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })

    const response = await handleStepsRoutes(request, env)
    const data = await response.json() as any

    expect(response.status).toBe(200)
    expect(data.steps).toHaveLength(3)
    expect(data.steps[0].step_number).toBe(1)
    expect(data.steps[0].delay_days).toBe(0)
    expect(data.steps[1].ai_generate).toBe(true)
    expect(data.steps[2].step_number).toBe(3)
  })

  test('POST /api/campaign/:id/steps - rejects non-increasing step_number', async () => {
    const env = mockEnv({
      campaign: { id: 'abc123', name: 'Test', steps: '[]' },
    })

    const body = {
      steps: [
        { step_number: 2, delay_days: 0, subject_template: 'Hi', body_template: 'Hello', ai_generate: false },
        { step_number: 1, delay_days: 3, subject_template: 'Re', body_template: 'Follow up', ai_generate: false },
      ],
    }

    const request = new Request('https://test.com/api/campaign/abc123/steps', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })

    const response = await handleStepsRoutes(request, env)
    expect(response.status).toBe(400)
    const data = await response.json() as any
    expect(data.error).toContain('step_number')
  })

  test('POST /api/campaign/:id/steps - rejects empty steps array', async () => {
    const env = mockEnv({
      campaign: { id: 'abc123', name: 'Test', steps: '[]' },
    })

    const request = new Request('https://test.com/api/campaign/abc123/steps', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ steps: [] }),
    })

    const response = await handleStepsRoutes(request, env)
    expect(response.status).toBe(400)
  })

  test('POST /api/campaign/:id/steps - rejects non-AI step without templates', async () => {
    const env = mockEnv({
      campaign: { id: 'abc123', name: 'Test', steps: '[]' },
    })

    const body = {
      steps: [
        { step_number: 1, delay_days: 0, subject_template: null, body_template: null, ai_generate: false },
      ],
    }

    const request = new Request('https://test.com/api/campaign/abc123/steps', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })

    const response = await handleStepsRoutes(request, env)
    expect(response.status).toBe(400)
    const data = await response.json() as any
    expect(data.error).toContain('subject_template')
  })

  test('POST /api/campaign/:id/steps - 404 for missing campaign', async () => {
    const env = mockEnv({}) // no campaign

    const body = {
      steps: [
        { step_number: 1, delay_days: 0, subject_template: 'Hi', body_template: 'Hello', ai_generate: false },
      ],
    }

    const request = new Request('https://test.com/api/campaign/missing/steps', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })

    const response = await handleStepsRoutes(request, env)
    expect(response.status).toBe(404)
  })

  test('GET /api/campaign/:id/steps - returns steps', async () => {
    const steps = [
      { step_number: 1, delay_days: 0, subject_template: 'Hi', body_template: 'Hello', ai_generate: false },
      { step_number: 2, delay_days: 3, subject_template: '', body_template: '', ai_generate: true },
    ]
    const env = mockEnv({
      campaign: { id: 'abc123', name: 'Test', steps: JSON.stringify(steps) },
    })

    const request = new Request('https://test.com/api/campaign/abc123/steps', {
      method: 'GET',
    })

    const response = await handleStepsRoutes(request, env)
    const data = await response.json() as any

    expect(response.status).toBe(200)
    expect(data.steps).toHaveLength(2)
    expect(data.campaign_id).toBe('abc123')
  })

  test('POST overwrites previous steps', async () => {
    const env = mockEnv({
      campaign: {
        id: 'abc123',
        name: 'Test',
        steps: JSON.stringify([
          { step_number: 1, delay_days: 0, subject_template: 'Old', body_template: 'Old body', ai_generate: false },
        ]),
      },
    })

    const body = {
      steps: [
        { step_number: 1, delay_days: 0, subject_template: 'New', body_template: 'New body', ai_generate: false },
        { step_number: 2, delay_days: 5, subject_template: null, body_template: null, ai_generate: true },
      ],
    }

    const request = new Request('https://test.com/api/campaign/abc123/steps', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })

    const response = await handleStepsRoutes(request, env)
    const data = await response.json() as any

    expect(response.status).toBe(200)
    expect(data.steps).toHaveLength(2)
    expect(data.steps[0].subject_template).toBe('New')
  })
})
