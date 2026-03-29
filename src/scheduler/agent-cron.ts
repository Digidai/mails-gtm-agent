import { Env, Campaign, CampaignContact, EvaluateMessage } from '../types'

/**
 * Agent cron: runs every 10 minutes.
 * For engine='agent' campaigns, select contacts due for evaluation and enqueue them.
 * No LLM calls here — all decisions are made by the evaluate-consumer.
 */
export async function agentCron(env: Env): Promise<void> {
  const now = new Date().toISOString()
  const today = now.slice(0, 10) // YYYY-MM-DD

  // 1. Get active agent campaigns
  const campaigns = await env.DB.prepare(
    "SELECT * FROM campaigns WHERE status = 'active' AND engine = 'agent'",
  ).all<Campaign>()

  if (!campaigns.results?.length) return

  for (const campaign of campaigns.results) {
    try {
      // 2. Reset daily LLM calls if needed
      if (!campaign.daily_llm_reset_at || campaign.daily_llm_reset_at < today) {
        await env.DB.prepare(
          'UPDATE campaigns SET daily_llm_calls = 0, daily_llm_reset_at = ? WHERE id = ?',
        ).bind(today, campaign.id).run()
        campaign.daily_llm_calls = 0
      }

      // Skip if daily LLM limit reached
      if (campaign.daily_llm_calls >= campaign.daily_llm_limit) {
        console.log(`Campaign ${campaign.id}: daily LLM limit reached (${campaign.daily_llm_calls}/${campaign.daily_llm_limit})`)
        continue
      }

      // 3. Restore not_now contacts whose resume_at has passed
      await env.DB.prepare(`
        UPDATE campaign_contacts
        SET status = 'pending', resume_at = NULL, next_check_at = NULL, updated_at = datetime('now')
        WHERE campaign_id = ? AND status = 'not_now' AND resume_at IS NOT NULL AND resume_at <= ?
      `).bind(campaign.id, now).run()

      // 4. Select contacts due for evaluation
      const contacts = await env.DB.prepare(`
        SELECT id, campaign_id FROM campaign_contacts
        WHERE campaign_id = ?
          AND status IN ('pending', 'active', 'interested')
          AND (next_check_at IS NULL OR next_check_at <= ?)
          AND (last_enqueued_at IS NULL OR last_enqueued_at < datetime(?, '-5 minutes'))
        ORDER BY next_check_at ASC, created_at ASC
        LIMIT 50
      `).bind(campaign.id, now, now).all<{ id: string; campaign_id: string }>()

      if (!contacts.results?.length) continue

      // 5. Enqueue each contact for evaluation
      for (const contact of contacts.results) {
        // Atomic update: mark as enqueued to prevent duplicates
        const updateResult = await env.DB.prepare(
          'UPDATE campaign_contacts SET last_enqueued_at = ? WHERE id = ? AND (last_enqueued_at IS NULL OR last_enqueued_at < datetime(?, \'-5 minutes\'))',
        ).bind(now, contact.id, now).run()

        if (!updateResult.meta?.changes) continue // Already enqueued recently

        const message: EvaluateMessage = {
          type: 'evaluate',
          campaign_id: contact.campaign_id,
          contact_id: contact.id,
          enqueued_at: now,
        }

        await env.EVALUATE_QUEUE.send(message)
      }
    } catch (err) {
      console.error(`Agent cron error for campaign ${campaign.id}:`, err)
    }
  }
}
