import { describe, test, expect } from 'bun:test'
import { handleUnsubscribeRoute } from '../../src/routes/unsubscribe'
import { generateUnsubscribeToken } from '../../src/compliance/unsubscribe'

const SECRET = 'test-unsub-secret'

function createMockEnv(secret = SECRET) {
  const dbOps: any[] = []
  return {
    env: {
      UNSUBSCRIBE_SECRET: secret,
      DB: {
        prepare: (sql: string) => ({
          bind: (...args: any[]) => {
            dbOps.push({ sql, args })
            return {
              run: async () => ({ meta: { changes: 1 } }),
            }
          },
        }),
      },
    } as any,
    dbOps,
  }
}

describe('Unsubscribe Route', () => {
  test('GET shows confirmation page (does not unsubscribe)', async () => {
    const token = await generateUnsubscribeToken('alice@example.com', 'camp-1', SECRET)
    const { env, dbOps } = createMockEnv()

    const request = new Request(`https://test.com/unsubscribe?token=${token}`, {
      method: 'GET',
    })

    const response = await handleUnsubscribeRoute(request, env)
    const html = await response.text()

    expect(response.status).toBe(200)
    expect(html).toContain('Confirm Unsubscribe')
    expect(html).toContain('form')
    expect(html).toContain('method="POST"')
    // Should NOT have written to DB
    expect(dbOps).toHaveLength(0)
  })

  test('POST executes unsubscribe', async () => {
    const token = await generateUnsubscribeToken('alice@example.com', 'camp-1', SECRET)
    const { env, dbOps } = createMockEnv()

    const request = new Request(`https://test.com/unsubscribe?token=${token}`, {
      method: 'POST',
    })

    const response = await handleUnsubscribeRoute(request, env)
    const html = await response.text()

    expect(response.status).toBe(200)
    expect(html).toContain('Unsubscribed')
    expect(html).toContain('successfully')
    // Should have written to DB (campaign-specific + global + contact update)
    expect(dbOps.length).toBeGreaterThanOrEqual(3)
  })

  test('returns 400 for missing token', async () => {
    const { env } = createMockEnv()
    const request = new Request('https://test.com/unsubscribe', { method: 'GET' })
    const response = await handleUnsubscribeRoute(request, env)

    expect(response.status).toBe(400)
    const html = await response.text()
    expect(html).toContain('Invalid link')
  })

  test('returns 400 for invalid token', async () => {
    const { env } = createMockEnv()
    const request = new Request('https://test.com/unsubscribe?token=invalid', { method: 'GET' })
    const response = await handleUnsubscribeRoute(request, env)

    expect(response.status).toBe(400)
    const html = await response.text()
    expect(html).toContain('expired or invalid')
  })

  test('masks email in confirmation page', async () => {
    const token = await generateUnsubscribeToken('alice@example.com', 'camp-1', SECRET)
    const { env } = createMockEnv()

    const request = new Request(`https://test.com/unsubscribe?token=${token}`, {
      method: 'GET',
    })

    const response = await handleUnsubscribeRoute(request, env)
    const html = await response.text()

    // Email should be masked (a***e@example.com)
    expect(html).toContain('a***e@example.com')
    expect(html).not.toContain('alice@example.com')
  })
})
