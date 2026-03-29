import { Env } from '../types'

/**
 * Record an event to the events table.
 */
export async function recordEvent(
  env: Env,
  campaignId: string,
  contactId: string,
  eventType: string,
  eventData: Record<string, unknown> = {},
): Promise<string> {
  const id = crypto.randomUUID().replace(/-/g, '')
  const now = new Date().toISOString()

  await env.DB.prepare(
    'INSERT INTO events (id, campaign_id, contact_id, event_type, event_data, created_at) VALUES (?, ?, ?, ?, ?, ?)',
  ).bind(id, campaignId, contactId, eventType, JSON.stringify(eventData), now).run()

  return id
}
