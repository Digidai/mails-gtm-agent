/**
 * Contact Status State Machine
 *
 * Centralizes all contact status transitions to prevent concurrent writers
 * (reply-cron, evaluate-consumer, send-consumer, webhook handler) from
 * overriding each other's status changes.
 *
 * Priority order (lower number = higher priority, cannot be overridden by lower-priority):
 *   do_not_contact (0) > unsubscribed (1) > bounced (2) > converted (3) >
 *   interested (4) > stopped (5) > error (6) > not_interested (7) >
 *   wrong_person (8) > not_now (9) > replied (10) > active (11) >
 *   queued (12) > sent (13) > pending (14)
 */

const STATUS_PRIORITY: Record<string, number> = {
  do_not_contact: 0,
  unsubscribed: 1,
  bounced: 2,
  converted: 3,
  interested: 4,
  stopped: 5,
  error: 6,
  not_interested: 7,
  wrong_person: 8,
  not_now: 9,
  replied: 10,
  active: 11,
  queued: 12,
  sent: 13,
  pending: 14,
}

export const TERMINAL_STATUSES = [
  'do_not_contact', 'unsubscribed', 'bounced', 'converted',
  'stopped', 'not_interested', 'interested', 'error',
] as const

/**
 * Check whether a status transition is allowed.
 *
 * General rule: can only move to equal or higher priority (lower number).
 *
 * Exceptions:
 * - not_now -> pending is allowed (resume_at expiry)
 * - wrong_person -> any status is allowed (reclassification on new reply)
 */
export function canTransition(from: string, to: string): boolean {
  const fromPriority = STATUS_PRIORITY[from]
  const toPriority = STATUS_PRIORITY[to]
  if (fromPriority === undefined || toPriority === undefined) return false

  // Exception: not_now -> pending (resume expiry)
  if (from === 'not_now' && to === 'pending') return true
  // Exception: wrong_person can be reclassified
  if (from === 'wrong_person') return true

  // Can only transition to equal or higher priority (lower number)
  return toPriority <= fromPriority
}

/**
 * Safely update a contact's status, respecting the state machine rules.
 *
 * Returns true if the update was applied (or was a no-op because status
 * already matched), false if the transition was blocked.
 *
 * @param extra - Additional columns to SET alongside the status change
 *                (e.g. reply_intent, resume_at, converted_at).
 */
export async function updateContactStatus(
  db: D1Database,
  contactId: string,
  newStatus: string,
  extra?: Record<string, unknown>,
): Promise<boolean> {
  // Read current status
  const current = await db.prepare(
    'SELECT status FROM campaign_contacts WHERE id = ?',
  ).bind(contactId).first<{ status: string }>()

  if (!current) return false
  if (current.status === newStatus && !extra) return true // no-op

  if (current.status !== newStatus && !canTransition(current.status, newStatus)) {
    console.log(`[state-machine] Blocked transition ${current.status} -> ${newStatus} for contact ${contactId}`)
    return false
  }

  // Build CAS UPDATE — only applies if status hasn't changed since our read
  const sets = ["status = ?", "updated_at = datetime('now')"]
  const binds: unknown[] = [newStatus]

  if (extra) {
    for (const [key, value] of Object.entries(extra)) {
      sets.push(`${key} = ?`)
      binds.push(value)
    }
  }

  // CAS: WHERE id = ? AND status = ? (the status we read above)
  binds.push(contactId, current.status)

  const result = await db.prepare(
    `UPDATE campaign_contacts SET ${sets.join(', ')} WHERE id = ? AND status = ?`,
  ).bind(...binds).run()

  if (!result.meta?.changes) {
    console.log(`[state-machine] CAS failed: status changed between read and write for contact ${contactId}`)
    return false
  }

  return true
}
