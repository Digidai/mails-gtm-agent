import { Env } from '../types'
import { recordEvent } from '../events/record'
import { notifyOwner } from '../notify'

/**
 * Dead letter queue consumer.
 * Messages land here after exhausting max_retries on the primary queue.
 * Strategy: log the failure, record an event, and notify the campaign owner.
 * We do NOT retry — if a message failed 3 times, automatic retry won't help.
 * The owner gets an email so they can investigate and manually re-trigger if needed.
 */
export async function dlqConsumer(batch: MessageBatch, env: Env): Promise<void> {
  for (const msg of batch.messages) {
    try {
      const body = msg.body as Record<string, unknown>
      const campaignId = (body.campaign_id as string) || 'unknown'
      const contactId = (body.contact_id as string) || 'unknown'
      const messageType = (body.type as string) || 'unknown'

      console.error(`[DLQ] Message permanently failed: type=${messageType} campaign=${campaignId} contact=${contactId}`)

      // Record event for audit trail
      if (campaignId !== 'unknown' && contactId !== 'unknown') {
        await recordEvent(env, campaignId, contactId, 'dlq_failure', {
          message_type: messageType,
          original_body: JSON.stringify(body).slice(0, 1000),
        })
      }

      // Best-effort: notify campaign owner
      if (campaignId !== 'unknown') {
        try {
          const campaign = await env.DB.prepare(
            'SELECT * FROM campaigns WHERE id = ?',
          ).bind(campaignId).first()

          if (campaign) {
            await notifyOwner(env, campaign as any, 'dlq_failure', {
              contactEmail: (body.to as string) || contactId,
              errorMessage: `Message permanently failed after retries: ${messageType}. Check campaign events for details.`,
            })
          }
        } catch (notifyErr) {
          console.error('[DLQ] Failed to notify owner:', notifyErr)
        }
      }

      msg.ack()
    } catch (err) {
      console.error('[DLQ] Failed to process DLQ message:', err)
      msg.ack() // Always ack DLQ messages — no further retry possible
    }
  }
}
