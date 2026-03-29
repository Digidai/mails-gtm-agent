import { describe, test, expect } from 'bun:test'
import { isExcludedUrl } from '../../src/tracking/links'

describe('Link Tracking - Exclusion', () => {
  test('excludes unsubscribe URLs', () => {
    expect(isExcludedUrl('https://example.com/unsubscribe')).toBe(true)
    expect(isExcludedUrl('https://example.com/UNSUBSCRIBE')).toBe(true)
    expect(isExcludedUrl('https://example.com/email-unsubscribe?token=abc')).toBe(true)
  })

  test('excludes opt-out URLs', () => {
    expect(isExcludedUrl('https://example.com/opt-out')).toBe(true)
    expect(isExcludedUrl('https://example.com/opt_out')).toBe(true)
  })

  test('excludes privacy policy URLs', () => {
    expect(isExcludedUrl('https://example.com/privacy-policy')).toBe(true)
    expect(isExcludedUrl('https://example.com/privacy')).toBe(true)
  })

  test('excludes manage preferences URLs', () => {
    expect(isExcludedUrl('https://example.com/manage-preferences')).toBe(true)
  })

  test('excludes list-unsubscribe URLs', () => {
    expect(isExcludedUrl('https://example.com/list-unsubscribe')).toBe(true)
  })

  test('does NOT exclude normal product URLs', () => {
    expect(isExcludedUrl('https://mails0.com')).toBe(false)
    expect(isExcludedUrl('https://example.com/pricing')).toBe(false)
    expect(isExcludedUrl('https://github.com/Digidai/mails')).toBe(false)
    expect(isExcludedUrl('https://example.com/signup')).toBe(false)
  })
})

describe('Link Tracking - URL Replacement', () => {
  // We test replaceLinksWithTracking with a mocked env/DB
  test('replaces URLs in text body', async () => {
    const batchCalls: any[] = []
    const mockEnv = {
      DB: {
        prepare: () => ({
          bind: () => ({
            run: async () => ({ meta: { changes: 1 } }),
          }),
        }),
        batch: async (stmts: any[]) => {
          batchCalls.push(stmts)
          return stmts.map(() => ({ meta: { changes: 1 } }))
        },
      },
    } as any

    // Import and test
    const { replaceLinksWithTracking } = await import('../../src/tracking/links')

    const body = 'Check out https://mails0.com for more info.\nAlso see https://mails0.com/docs for docs.'
    const result = await replaceLinksWithTracking(
      body, 'contact-1', 'campaign-1', 'https://gtm.example.com', mockEnv,
    )

    // Should have replaced 2 unique URLs
    expect(result.linkIds).toHaveLength(2)
    expect(result.body).not.toContain('https://mails0.com')
    expect(result.body).toContain('https://gtm.example.com/t/')
    // DB.batch should have been called once with 2 statements
    expect(batchCalls).toHaveLength(1)
    expect(batchCalls[0]).toHaveLength(2)
  })

  test('preserves unsubscribe URLs', async () => {
    const mockEnv = {
      DB: {
        prepare: () => ({
          bind: () => ({
            run: async () => ({ meta: { changes: 1 } }),
          }),
        }),
        batch: async (stmts: any[]) => stmts.map(() => ({ meta: { changes: 1 } })),
      },
    } as any

    const { replaceLinksWithTracking } = await import('../../src/tracking/links')

    const body = 'Visit https://mails0.com\nTo unsubscribe: https://example.com/unsubscribe?token=abc'
    const result = await replaceLinksWithTracking(
      body, 'contact-1', 'campaign-1', 'https://gtm.example.com', mockEnv,
    )

    // Only 1 URL should be tracked (mails0.com), unsubscribe link preserved
    expect(result.linkIds).toHaveLength(1)
    expect(result.body).toContain('https://example.com/unsubscribe?token=abc')
  })

  test('handles body with no URLs', async () => {
    const mockEnv = {
      DB: {
        prepare: () => ({
          bind: () => ({ run: async () => ({ meta: { changes: 1 } }) }),
        }),
        batch: async () => [],
      },
    } as any

    const { replaceLinksWithTracking } = await import('../../src/tracking/links')

    const body = 'Hello Alice, just wanted to check in.'
    const result = await replaceLinksWithTracking(
      body, 'contact-1', 'campaign-1', 'https://gtm.example.com', mockEnv,
    )

    expect(result.linkIds).toHaveLength(0)
    expect(result.body).toBe(body)
  })
})
