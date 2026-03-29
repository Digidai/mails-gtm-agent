import { Env, Campaign, CampaignContact, SendMessage } from '../types'
import { calculateDailyLimit } from '../utils/warmup'

export async function sendCron(env: Env): Promise<void> {
  const globalLimit = parseInt(env.DAILY_SEND_LIMIT || '100', 10)
  const now = new Date().toISOString()
  const today = now.slice(0, 10) // YYYY-MM-DD

  // 1. Get active campaigns
  const campaigns = await env.DB.prepare(
    "SELECT * FROM campaigns WHERE status = 'active'"
  ).all<Campaign>()

  if (!campaigns.results?.length) return

  // 2. Get global sent count for today (across all campaigns)
  const globalSentToday = await env.DB.prepare(`
    SELECT COUNT(*) as count FROM send_log
    WHERE date(sent_at) = ? AND status = 'sent'
  `).bind(today).first<{ count: number }>()

  let globalRemaining = globalLimit - (globalSentToday?.count || 0)
  if (globalRemaining <= 0) return

  for (const campaign of campaigns.results) {
    if (globalRemaining <= 0) break

    // 3. Calculate per-campaign daily limit (warmup)
    const campaignDailyLimit = calculateDailyLimit(campaign, globalLimit)

    // 4. Get today's sent count for this campaign
    const sentToday = await env.DB.prepare(`
      SELECT COUNT(*) as count FROM send_log
      WHERE campaign_id = ? AND date(sent_at) = ? AND status = 'sent'
    `).bind(campaign.id, today).first<{ count: number }>()

    const sentCount = sentToday?.count || 0
    const campaignRemaining = campaignDailyLimit - sentCount
    const remaining = Math.min(campaignRemaining, globalRemaining)

    if (remaining <= 0) continue

    // 5. Check for not_now contacts whose resume_at has passed
    await env.DB.prepare(`
      UPDATE campaign_contacts
      SET status = 'pending', resume_at = NULL, updated_at = datetime('now')
      WHERE campaign_id = ? AND status = 'not_now' AND resume_at IS NOT NULL AND resume_at <= ?
    `).bind(campaign.id, now).run()

    // 6. Select pending contacts ready to send
    const pendingContacts = await env.DB.prepare(`
      SELECT * FROM campaign_contacts
      WHERE campaign_id = ? AND status = 'pending' AND (next_send_at IS NULL OR next_send_at <= ?)
      ORDER BY next_send_at ASC, created_at ASC
      LIMIT ?
    `).bind(campaign.id, now, remaining).all<CampaignContact>()

    if (!pendingContacts.results?.length) continue

    // 7. Atomically update status to 'queued' and enqueue
    for (const contact of pendingContacts.results) {
      if (globalRemaining <= 0) break

      // Atomic update: only succeeds if still pending
      const updateResult = await env.DB.prepare(`
        UPDATE campaign_contacts
        SET status = 'queued', updated_at = datetime('now')
        WHERE id = ? AND status = 'pending'
      `).bind(contact.id).run()

      if (!updateResult.meta?.changes) continue // Already picked up

      const message: SendMessage = {
        contact_id: contact.id,
        campaign_id: campaign.id,
        step_number: contact.current_step,
      }

      await env.SEND_QUEUE.send(message)
      globalRemaining--
    }
  }
}
