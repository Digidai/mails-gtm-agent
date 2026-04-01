import { describe, test, expect } from 'bun:test'
import { getAngleStats } from '../../src/agent/decide'
import { Env } from '../../src/types'

function mockEnv(rows: Array<{ angle: string; total: number; clicks: number; conversions: number; interested: number }>): Env {
  return {
    DB: {
      prepare: () => ({
        bind: () => ({
          all: async () => ({ results: rows }),
        }),
      }),
    },
  } as any
}

function mockEnvError(): Env {
  return {
    DB: {
      prepare: () => {
        throw new Error('DB error')
      },
    },
  } as any
}

describe('getAngleStats', () => {
  test('returns formatted stats when data exists', async () => {
    const env = mockEnv([
      { angle: 'product_intro', total: 10, clicks: 5, conversions: 2, interested: 1 },
      { angle: 'case_study', total: 8, clicks: 2, conversions: 0, interested: 0 },
    ])

    const result = await getAngleStats(env, 'camp1')
    expect(result).toContain('product_intro')
    expect(result).toContain('10 sent')
    expect(result).toContain('5 clicked (50%)')
    expect(result).toContain('2 converted (20%)')
    expect(result).toContain('case_study')
  })

  test('returns empty string when no data', async () => {
    const env = mockEnv([])
    const result = await getAngleStats(env, 'camp1')
    expect(result).toBe('')
  })

  test('returns empty string on DB error', async () => {
    const env = mockEnvError()
    const result = await getAngleStats(env, 'camp1')
    expect(result).toBe('')
  })

  test('calculates rates correctly with zero sends', async () => {
    const env = mockEnv([
      { angle: 'test', total: 0, clicks: 0, conversions: 0, interested: 0 },
    ])
    const result = await getAngleStats(env, 'camp1')
    expect(result).toContain('0%')
  })
})
