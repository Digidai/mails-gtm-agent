import { Env, Campaign, CampaignContact } from '../types'
import { sendAutoReply } from './reply-cron'
import { recordAgentMessage } from '../conversations/context'

interface ScheduledReplyRow {
  id: string
  campaign_id: string
  contact_id: string
  reply_body: string
  reply_subject: string
  original_msg_id: string | null
  original_subject: string | null
  send_at: string
  sent: number
  created_at: string
}

/**
 * Reply send cron: runs every minute.
 * Sends scheduled auto-replies that have reached their send_at time.
 * This introduces a human-like delay (2-8 hours) between receiving
 * a reply and sending the auto-response.
 */
export async function replySendCron(env: Env): Promise<void> {
  const now = new Date().toISOString()

  const pending = await env.DB.prepare(
    `SELECT sr.*
     FROM scheduled_replies sr
     WHERE sr.sent = 0 AND sr.send_at <= ?
     ORDER BY sr.send_at ASC
     LIMIT 5`
  ).bind(now).all<ScheduledReplyRow>()

  if (!pending.results?.length) return

  console.log(`[reply-send-cron] Processing ${pending.results.length} scheduled replies`)

  for (const reply of pending.results) {
    try {
      // Fetch campaign and contact data
      const campaign = await env.DB.prepare(
        'SELECT * FROM campaigns WHERE id = ?'
      ).bind(reply.campaign_id).first<Campaign>()

      if (!campaign || campaign.status !== 'active') {
        // Campaign no longer active — mark as sent to skip
        await env.DB.prepare(
          'UPDATE scheduled_replies SET sent = 1 WHERE id = ?'
        ).bind(reply.id).run()
        console.log(`[reply-send-cron] Skipped reply ${reply.id}: campaign ${reply.campaign_id} not active`)
        continue
      }

      const contact = await env.DB.prepare(
        'SELECT * FROM campaign_contacts WHERE id = ?'
      ).bind(reply.contact_id).first<CampaignContact>()

      if (!contact) {
        await env.DB.prepare(
          'UPDATE scheduled_replies SET sent = 1 WHERE id = ?'
        ).bind(reply.id).run()
        console.log(`[reply-send-cron] Skipped reply ${reply.id}: contact ${reply.contact_id} not found`)
        continue
      }

      const originalMsg = {
        id: reply.original_msg_id,
        subject: reply.original_subject || 'Follow up',
      }

      // Determine whether to include compliance footer (only on first reply)
      const skipFooter = (contact.auto_reply_count ?? 0) > 1

      await sendAutoReply(env, campaign, contact, reply.reply_body, originalMsg, { skipComplianceFooter: skipFooter })

      // Record in conversations
      await recordAgentMessage(
        env, reply.campaign_id, reply.contact_id,
        reply.reply_body, reply.reply_subject, null
      )

      // Mark as sent
      await env.DB.prepare(
        'UPDATE scheduled_replies SET sent = 1 WHERE id = ?'
      ).bind(reply.id).run()

      console.log(`[reply-send-cron] Sent scheduled reply for contact ${reply.contact_id}`)
    } catch (err) {
      console.error(`[reply-send-cron] Failed to send reply ${reply.id}:`, err)
    }
  }
}
