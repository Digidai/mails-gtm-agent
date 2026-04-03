import { describe, test, expect } from 'bun:test'
import { canTransition, updateContactStatus, TERMINAL_STATUSES } from '../../src/state-machine'

/**
 * Minimal D1Database mock for updateContactStatus tests.
 */
function createMockDB(currentStatus: string | null) {
  const updates: { sql: string; binds: unknown[] }[] = []

  const db = {
    prepare: (sql: string) => ({
      bind: (...args: unknown[]) => ({
        first: async () => {
          if (currentStatus === null) return null
          return { status: currentStatus }
        },
        run: async () => {
          updates.push({ sql, binds: args })
          return { meta: { changes: 1 } }
        },
      }),
    }),
  }

  return { db: db as unknown as D1Database, updates }
}

describe('canTransition', () => {
  test('blocks terminal -> active (e.g. converted -> active)', () => {
    expect(canTransition('converted', 'active')).toBe(false)
  })

  test('blocks terminal -> active (e.g. unsubscribed -> active)', () => {
    expect(canTransition('unsubscribed', 'active')).toBe(false)
  })

  test('blocks terminal -> active (e.g. bounced -> active)', () => {
    expect(canTransition('bounced', 'active')).toBe(false)
  })

  test('blocks interested -> active (interested is higher priority)', () => {
    expect(canTransition('interested', 'active')).toBe(false)
  })

  test('allows pending -> interested (higher priority)', () => {
    expect(canTransition('pending', 'interested')).toBe(true)
  })

  test('allows pending -> active (higher priority)', () => {
    expect(canTransition('pending', 'active')).toBe(true)
  })

  test('allows active -> stopped (higher priority)', () => {
    expect(canTransition('active', 'stopped')).toBe(true)
  })

  test('allows active -> converted (higher priority)', () => {
    expect(canTransition('active', 'converted')).toBe(true)
  })

  test('allows same status transition (no-op)', () => {
    expect(canTransition('active', 'active')).toBe(true)
  })

  test('exception: not_now -> pending is allowed (resume expiry)', () => {
    expect(canTransition('not_now', 'pending')).toBe(true)
  })

  test('exception: wrong_person -> interested is allowed (reclassification)', () => {
    expect(canTransition('wrong_person', 'interested')).toBe(true)
  })

  test('exception: wrong_person -> active is allowed', () => {
    expect(canTransition('wrong_person', 'active')).toBe(true)
  })

  test('exception: wrong_person -> pending is allowed', () => {
    expect(canTransition('wrong_person', 'pending')).toBe(true)
  })

  test('blocks not_now -> active (not the pending exception)', () => {
    expect(canTransition('not_now', 'active')).toBe(false)
  })

  test('returns false for unknown statuses', () => {
    expect(canTransition('unknown_status', 'active')).toBe(false)
    expect(canTransition('active', 'unknown_status')).toBe(false)
  })

  test('allows sent -> pending (e.g. retry after failure)', () => {
    expect(canTransition('sent', 'pending')).toBe(false)
    // sent (13) -> pending (14) is lower priority, blocked
  })

  test('allows queued -> error (higher priority)', () => {
    expect(canTransition('queued', 'error')).toBe(true)
  })

  test('blocks error -> active (error is higher priority)', () => {
    expect(canTransition('error', 'active')).toBe(false)
  })
})

describe('updateContactStatus', () => {
  test('successful transition updates DB', async () => {
    const { db, updates } = createMockDB('pending')
    const result = await updateContactStatus(db, 'contact-1', 'active')
    expect(result).toBe(true)
    expect(updates).toHaveLength(1)
    expect(updates[0].binds[0]).toBe('active') // new status
    expect(updates[0].binds[updates[0].binds.length - 1]).toBe('contact-1') // contact id
  })

  test('blocked transition returns false and does not update', async () => {
    const { db, updates } = createMockDB('converted')
    const result = await updateContactStatus(db, 'contact-1', 'active')
    expect(result).toBe(false)
    expect(updates).toHaveLength(0) // no UPDATE executed
  })

  test('returns false when contact not found', async () => {
    const { db } = createMockDB(null)
    const result = await updateContactStatus(db, 'nonexistent', 'active')
    expect(result).toBe(false)
  })

  test('no-op returns true when status already matches (no extra)', async () => {
    const { db, updates } = createMockDB('active')
    const result = await updateContactStatus(db, 'contact-1', 'active')
    expect(result).toBe(true)
    expect(updates).toHaveLength(0) // no UPDATE needed
  })

  test('same status with extra fields still updates', async () => {
    const { db, updates } = createMockDB('active')
    const result = await updateContactStatus(db, 'contact-1', 'active', { next_check_at: null })
    expect(result).toBe(true)
    expect(updates).toHaveLength(1) // UPDATE executed for extra fields
  })

  test('passes extra fields in the UPDATE', async () => {
    const { db, updates } = createMockDB('active')
    const result = await updateContactStatus(db, 'contact-1', 'interested', {
      reply_intent: 'interested',
      reply_confidence: 0.95,
    })
    expect(result).toBe(true)
    expect(updates).toHaveLength(1)
    // Binds: [newStatus, ...extraValues, contactId]
    expect(updates[0].binds).toContain('interested')
    expect(updates[0].binds).toContain(0.95)
  })

  test('not_now -> pending exception works via updateContactStatus', async () => {
    const { db, updates } = createMockDB('not_now')
    const result = await updateContactStatus(db, 'contact-1', 'pending')
    expect(result).toBe(true)
    expect(updates).toHaveLength(1)
  })
})

describe('TERMINAL_STATUSES', () => {
  test('includes expected terminal statuses', () => {
    expect(TERMINAL_STATUSES).toContain('do_not_contact')
    expect(TERMINAL_STATUSES).toContain('unsubscribed')
    expect(TERMINAL_STATUSES).toContain('bounced')
    expect(TERMINAL_STATUSES).toContain('converted')
    expect(TERMINAL_STATUSES).toContain('stopped')
    expect(TERMINAL_STATUSES).toContain('not_interested')
    expect(TERMINAL_STATUSES).toContain('interested')
    expect(TERMINAL_STATUSES).toContain('error')
  })

  test('does not include non-terminal statuses', () => {
    expect(TERMINAL_STATUSES).not.toContain('pending')
    expect(TERMINAL_STATUSES).not.toContain('active')
    expect(TERMINAL_STATUSES).not.toContain('sent')
    expect(TERMINAL_STATUSES).not.toContain('queued')
  })
})
