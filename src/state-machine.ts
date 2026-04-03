/**
 * Contact status state machine.
 *
 * Enforces transition rules so that high-priority terminal states
 * (do_not_contact, unsubscribed) are never overridden by lower-priority ones.
 */

/** Status priority — higher number = higher priority (cannot be overridden) */
const STATUS_PRIORITY: Record<string, number> = {
  pending: 0,
  active: 1,
  interested: 2,
  converted: 3,
  stopped: 4,
  bounced: 5,
  error: 5,
  not_now: 3,
  not_interested: 4,
  wrong_person: 4,
  unsubscribed: 8,
  do_not_contact: 9,
  // v1 compat
  queued: 0,
  sent: 1,
  replied: 2,
}

/**
 * Update a contact's status, respecting priority rules.
 * Returns true if the transition was applied, false if blocked.
 */
export async function updateContactStatus(
  db: D1Database,
  contactId: string,
  newStatus: string,
  extra?: Record<string, unknown>,
): Promise<boolean> {
  // Look up current status
  const contact = await db.prepare(
    'SELECT status FROM campaign_contacts WHERE id = ?',
  ).bind(contactId).first<{ status: string }>()

  if (!contact) return false

  const currentPriority = STATUS_PRIORITY[contact.status] ?? 0
  const newPriority = STATUS_PRIORITY[newStatus] ?? 0

  // Block if current status has higher priority
  if (currentPriority > newPriority) {
    return false
  }

  // Also block same-status no-ops
  if (contact.status === newStatus) {
    return false
  }

  // Build UPDATE
  let sql = "UPDATE campaign_contacts SET status = ?, updated_at = datetime('now')"
  const params: unknown[] = [newStatus]

  if (extra) {
    for (const [key, value] of Object.entries(extra)) {
      sql += `, ${key} = ?`
      params.push(value)
    }
  }

  sql += ' WHERE id = ?'
  params.push(contactId)

  const result = await db.prepare(sql).bind(...params).run()
  return (result.meta?.changes ?? 0) > 0
}
