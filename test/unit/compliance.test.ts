import { describe, test, expect } from 'bun:test'
import {
  generateUnsubscribeToken,
  verifyUnsubscribeToken,
  generateUnsubscribeUrl,
} from '../../src/compliance/unsubscribe'
import {
  generateListUnsubscribeHeaders,
  generateComplianceFooter,
} from '../../src/compliance/headers'

const SECRET = 'test-secret-key-for-testing'

describe('Unsubscribe Token', () => {
  test('generates and verifies a valid token', async () => {
    const token = await generateUnsubscribeToken('alice@example.com', 'campaign-1', SECRET)
    expect(token).toContain('.')
    expect(token.split('.')).toHaveLength(2)

    const payload = await verifyUnsubscribeToken(token, SECRET)
    expect(payload).not.toBeNull()
    expect(payload!.email).toBe('alice@example.com')
    expect(payload!.campaign_id).toBe('campaign-1')
  })

  test('rejects token with wrong secret', async () => {
    const token = await generateUnsubscribeToken('alice@example.com', 'campaign-1', SECRET)
    const payload = await verifyUnsubscribeToken(token, 'wrong-secret')
    expect(payload).toBeNull()
  })

  test('rejects tampered token', async () => {
    const token = await generateUnsubscribeToken('alice@example.com', 'campaign-1', SECRET)
    const tampered = token.slice(0, -5) + 'XXXXX'
    const payload = await verifyUnsubscribeToken(tampered, SECRET)
    expect(payload).toBeNull()
  })

  test('rejects malformed token', async () => {
    const payload = await verifyUnsubscribeToken('not-a-valid-token', SECRET)
    expect(payload).toBeNull()
  })

  test('rejects empty token', async () => {
    const payload = await verifyUnsubscribeToken('', SECRET)
    expect(payload).toBeNull()
  })
})

describe('Unsubscribe URL', () => {
  test('generates correct URL', () => {
    const url = generateUnsubscribeUrl('https://example.com', 'abc123.sig456')
    expect(url).toBe('https://example.com/unsubscribe?token=abc123.sig456')
  })
})

describe('List-Unsubscribe Headers', () => {
  test('generates List-Unsubscribe header without Post (avoids Gmail bulk classification)', () => {
    const headers = generateListUnsubscribeHeaders('https://example.com/unsubscribe?token=abc')
    expect(headers['List-Unsubscribe']).toBe('<https://example.com/unsubscribe?token=abc>')
    // List-Unsubscribe-Post is intentionally omitted to avoid Gmail bulk classification
    expect(headers['List-Unsubscribe-Post']).toBeUndefined()
  })
})

describe('Compliance Footer', () => {
  test('includes physical address and unsubscribe link', () => {
    const footer = generateComplianceFooter('123 Main St, NY 10001', 'https://unsub.example.com')
    expect(footer).toContain('123 Main St, NY 10001')
    expect(footer).toContain('https://unsub.example.com')
  })

  test('handles missing physical address', () => {
    const footer = generateComplianceFooter('', 'https://unsub.example.com')
    expect(footer).toContain('Physical address not configured')
    expect(footer).toContain('https://unsub.example.com')
  })
})
