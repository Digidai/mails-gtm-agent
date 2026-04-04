import { Env, SendMessage, AgentSendMessage, Campaign, CampaignContact, CampaignStep } from '../types'
import { generateEmail } from '../llm/generate'
import { createProvider } from '../llm/provider'
import { generateUnsubscribeToken, generateUnsubscribeUrl } from '../compliance/unsubscribe'
import { generateListUnsubscribeHeaders, generateComplianceFooter, generateComplianceFooterHtml } from '../compliance/headers'
import { buildHtmlBody } from '../tracking/links'
import { recordEvent } from '../events/record'
import { notifyOwner } from '../notify'
import { mailsFetch } from '../mails-api'
import { recordAgentMessage } from '../conversations/context'
import { TERMINAL_STATUSES, updateContactStatus, canTransition } from '../state-machine'

/**
 * R2-6: Atomically claim a send slot against the global daily send limit.
 * Uses INSERT ... ON CONFLICT DO UPDATE with a WHERE guard on sent_count < limit.
 * Returns true if a slot was successfully claimed, false if the limit is reached.
 *
 * We use a dedicated '__global__' campaign_id row in daily_stats to track the
 * cross-campaign total atomically. The per-campaign rows are still maintained
 * separately for reporting.
 */
async function claimGlobalSendSlot(env: Env): Promise<boolean> {
  const limit = parseInt(env.DAILY_SEND_LIMIT || '100', 10)
  const today = new Date().toISOString().slice(0, 10)

  // Try to increment existing global row (only if below limit)
  const updateResult = await env.DB.prepare(
    "UPDATE daily_stats SET sent_count = sent_count + 1 WHERE campaign_id = '__global__' AND date = ? AND sent_count < ?",
  ).bind(today, limit).run()

  if (updateResult.meta?.changes) return true

  // Row may not exist yet — try to insert with sent_count=1
  const insertResult = await env.DB.prepare(
    "INSERT INTO daily_stats (id, campaign_id, date, sent_count) VALUES (?, '__global__', ?, 1) ON CONFLICT(campaign_id, date) DO NOTHING",
  ).bind(crypto.randomUUID().replace(/-/g, ''), today).run()

  if (insertResult.meta?.changes) return true

  // Insert did nothing (row exists but limit reached) — one more try in case of race
  const retryResult = await env.DB.prepare(
    "UPDATE daily_stats SET sent_count = sent_count + 1 WHERE campaign_id = '__global__' AND date = ? AND sent_count < ?",
  ).bind(today, limit).run()

  return !!(retryResult.meta?.changes)
}

// Re-export TERMINAL_STATUSES from state-machine for backward compatibility
export { TERMINAL_STATUSES } from '../state-machine'

export async function sendConsumer(batch: MessageBatch, env: Env): Promise<void> {
  for (const msg of batch.messages) {
    try {
      const body = msg.body as any

      if (body.type === 'agent_send') {
        // v2 agent send
        await processAgentSend(body as AgentSendMessage, env, msg)
      } else {
        // v1 sequence send
        await processSequenceSend(body as SendMessage, env, msg)
      }
    } catch (err) {
      console.error('Send consumer error:', err)
      msg.retry()
    }
  }
}

/**
 * v2: Agent-generated email send.
 * The email content is already prepared by evaluate-consumer.
 * We just add compliance headers/footer and send.
 */
async function processAgentSend(message: AgentSendMessage, env: Env, msg: Message): Promise<void> {
  const { campaign_id, contact_id, mailbox, to, subject, body, htmlBody, angle, decision_id } = message

  // P0-1: Idempotent check — skip if this decision was already sent
  if (decision_id) {
    const existing = await env.DB.prepare(
      'SELECT id FROM send_log WHERE decision_id = ?',
    ).bind(decision_id).first()

    if (existing) {
      console.log(`Decision ${decision_id} already sent, skipping (idempotent)`)
      msg.ack()
      return
    }
  }

  // Fetch campaign for compliance fields
  const campaign = await env.DB.prepare(
    'SELECT * FROM campaigns WHERE id = ?',
  ).bind(campaign_id).first<Campaign>()

  if (!campaign) {
    console.error(`Campaign ${campaign_id} not found`)
    msg.ack()
    return
  }

  // R2-5: Skip if campaign is no longer active (e.g. paused/completed while message was queued)
  if (campaign.status !== 'active') {
    console.log(`Campaign ${campaign_id} is '${campaign.status}', skipping queued agent send for contact ${contact_id}`)
    msg.ack()
    return
  }

  // CAN-SPAM: refuse to send without physical address (defense-in-depth, primary check is at campaign start)
  if (!campaign.physical_address?.trim()) {
    console.error(`Campaign ${campaign_id}: refusing to send without physical address (CAN-SPAM)`)
    msg.ack()
    return
  }

  // Check if contact is in terminal state
  const contact = await env.DB.prepare(
    'SELECT * FROM campaign_contacts WHERE id = ?',
  ).bind(contact_id).first<CampaignContact>()

  if (!contact) {
    msg.ack()
    return
  }

  if (TERMINAL_STATUSES.includes(contact.status as typeof TERMINAL_STATUSES[number])) {
    console.log(`Contact ${contact_id} is in terminal status '${contact.status}', skipping send`)
    msg.ack()
    return
  }

  // Check unsubscribe
  const unsub = await env.DB.prepare(
    'SELECT id FROM unsubscribes WHERE email = ?',
  ).bind(to).first()

  if (unsub) {
    await updateContactStatus(env.DB, contact_id, 'unsubscribed')
    msg.ack()
    return
  }

  // R2-6: Atomically claim a global send slot before sending (skip for dry-run)
  if (!campaign.dry_run) {
    const slotClaimed = await claimGlobalSendSlot(env)
    if (!slotClaimed) {
      console.log(`Global daily send limit reached, requeueing agent send for contact ${contact_id}`)
      msg.retry()
      return
    }
  }

  // Generate compliance elements
  const unsubToken = await generateUnsubscribeToken(to, campaign_id, env.UNSUBSCRIBE_SECRET)
  const unsubUrl = generateUnsubscribeUrl(env.UNSUBSCRIBE_BASE_URL, unsubToken)
  const fullBody = body + generateComplianceFooter(campaign.physical_address, unsubUrl)
  const unsubHeaders = generateListUnsubscribeHeaders(unsubUrl)

  // Build HTML version (tracked links in <a> tags + clean footer)
  let fullHtml: string | undefined
  if (htmlBody) {
    fullHtml = htmlBody + generateComplianceFooterHtml(campaign.physical_address, unsubUrl)
  }

  // Dry-run mode: log but don't send
  if (campaign.dry_run) {
    await env.DB.prepare(`
      INSERT INTO send_log (id, campaign_id, contact_id, step_number, subject, body, decision_id, status)
      VALUES (?, ?, ?, 0, ?, ?, ?, 'dry_run')
    `).bind(
      crypto.randomUUID().replace(/-/g, ''),
      campaign_id,
      contact_id,
      subject,
      fullBody,
      decision_id || null,
    ).run()

    // Record event in dry-run (but do NOT increment emails_sent counter,
    // as that feeds into max_emails hard-rule and would corrupt real counts)
    await recordEvent(env, campaign_id, contact_id, 'email_sent', {
      subject, angle, decision_id, dry_run: true,
    })
    msg.ack()
    return
  }

  // Send via mails-agent API (text = clean original URLs, html = tracked <a> tags)
  const sendPayload: Record<string, unknown> = {
    from: mailbox,
    to: [to],
    subject,
    text: fullBody,
    headers: unsubHeaders,
  }
  if (fullHtml) sendPayload.html = fullHtml

  const sendRes = await mailsFetch(env, '/v1/send', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(sendPayload),
  })

  if (!sendRes.ok) {
    const errText = await sendRes.text()

    await env.DB.prepare(`
      INSERT INTO send_log (id, campaign_id, contact_id, step_number, subject, body, decision_id, status, error)
      VALUES (?, ?, ?, 0, ?, ?, ?, 'failed', ?)
    `).bind(
      crypto.randomUUID().replace(/-/g, ''),
      campaign_id,
      contact_id,
      subject,
      fullBody,
      decision_id || null,
      errText,
    ).run()

    // P1-6: Differentiate error types — only real bounces should mark as bounced
    if ([401, 403].includes(sendRes.status)) {
      // System-level auth error: pause campaign, notify owner, do NOT mark contact as bounced
      await env.DB.prepare(
        "UPDATE campaigns SET status = 'paused', updated_at = datetime('now') WHERE id = ?",
      ).bind(campaign_id).run()

      await recordEvent(env, campaign_id, contact_id, 'campaign_error', {
        error: errText.slice(0, 500), status_code: sendRes.status,
        reason: 'API authentication/authorization failure — campaign paused',
      })

      // Best-effort notification to owner
      try {
        const fullCampaign = await env.DB.prepare('SELECT * FROM campaigns WHERE id = ?').bind(campaign_id).first<Campaign>()
        if (fullCampaign) {
          await notifyOwner(env, fullCampaign, 'campaign_error', {
            contactEmail: to,
            errorMessage: `Send API returned ${sendRes.status}: ${errText.slice(0, 200)}. Campaign has been paused.`,
          })
        }
      } catch (_notifyErr) {
        console.error('Failed to notify owner about campaign error:', _notifyErr)
      }
      msg.ack()
      return
    }

    if ([400, 422].includes(sendRes.status)) {
      // Contact-level error (bad address, invalid payload) — mark as error, NOT bounced
      await updateContactStatus(env.DB, contact_id, 'error')

      await recordEvent(env, campaign_id, contact_id, 'contact_error', {
        error: errText.slice(0, 500), status_code: sendRes.status,
      })
      msg.ack()
      return
    }

    // Refund the global send slot since the email was not actually sent
    try {
      const today = new Date().toISOString().slice(0, 10)
      await env.DB.prepare(
        "UPDATE daily_stats SET sent_count = MAX(0, sent_count - 1) WHERE campaign_id = '__global__' AND date = ?"
      ).bind(today).run()
    } catch { /* best-effort refund */ }

    throw new Error(`Send API error: ${sendRes.status} ${errText}`)
  }

  // === Email sent successfully — from here, always ack (no retry). ===
  // If DB writes fail below, we log the error but do NOT retry the message
  // because the email has already been delivered and retrying would duplicate it.

  const sendData = await sendRes.json() as any
  const messageId = sendData.id || sendData.provider_id || sendData.message_id || ''

  try {
    // Batch all post-send DB writes for atomicity and efficiency
    const now = new Date().toISOString()
    const today = now.slice(0, 10)
    const sendLogId = crypto.randomUUID().replace(/-/g, '')
    const eventId = crypto.randomUUID().replace(/-/g, '')
    const statsId = crypto.randomUUID().replace(/-/g, '')

    await env.DB.batch([
      // Update contact
      env.DB.prepare(
        "UPDATE campaign_contacts SET emails_sent = emails_sent + 1, last_sent_at = ?, sent_message_id = ?, updated_at = ? WHERE id = ?",
      ).bind(now, messageId, now, contact_id),
      // Log send (with decision_id for idempotency)
      env.DB.prepare(
        "INSERT INTO send_log (id, campaign_id, contact_id, step_number, subject, body, message_id, decision_id, status) VALUES (?, ?, ?, 0, ?, ?, ?, ?, 'sent')",
      ).bind(sendLogId, campaign_id, contact_id, subject, fullBody, messageId, decision_id || null),
      // Record event
      env.DB.prepare(
        "INSERT INTO events (id, campaign_id, contact_id, event_type, event_data, created_at) VALUES (?, ?, ?, 'email_sent', ?, ?)",
      ).bind(eventId, campaign_id, contact_id, JSON.stringify({ subject, angle, decision_id, message_id: messageId }), now),
      // Update daily stats
      env.DB.prepare(
        "INSERT INTO daily_stats (id, campaign_id, date, sent_count) VALUES (?, ?, ?, 1) ON CONFLICT(campaign_id, date) DO UPDATE SET sent_count = sent_count + 1",
      ).bind(statsId, campaign_id, today),
    ])

    // v2.1: Record agent message to conversations for context tracking
    try {
      await recordAgentMessage(env, campaign_id, contact_id, fullBody, subject, messageId)
    } catch (convErr) {
      console.error(`[send-consumer] Failed to record agent message to conversations:`, convErr)
    }
  } catch (dbErr) {
    // Email was already sent — log the DB failure but do NOT retry
    console.error(`[CRITICAL] Email sent to ${to} (msgId=${messageId}) but post-send DB update failed:`, dbErr)
  }

  msg.ack()
}

/**
 * v1: Fixed-sequence email send.
 * Preserved for engine='sequence' campaigns.
 */
async function processSequenceSend(message: SendMessage, env: Env, msg: Message): Promise<void> {
  const { contact_id, campaign_id, step_number } = message

  const contact = await env.DB.prepare(
    'SELECT * FROM campaign_contacts WHERE id = ?',
  ).bind(contact_id).first<CampaignContact>()

  if (!contact) {
    console.error(`Contact ${contact_id} not found`)
    msg.ack()
    return
  }

  if (TERMINAL_STATUSES.includes(contact.status as typeof TERMINAL_STATUSES[number])) {
    console.log(`Contact ${contact_id} is in terminal status '${contact.status}', skipping`)
    msg.ack()
    return
  }

  // P0-2: Check if this step was already completed.
  // After a non-last step, status goes back to 'pending' with current_step incremented,
  // so we must check current_step > step_number (step already done) OR
  // status='sent' at the final step.
  if (contact.current_step > step_number) {
    console.log(`Contact ${contact_id} already past step ${step_number} (current_step=${contact.current_step}), skipping`)
    msg.ack()
    return
  }
  if (contact.status === 'sent' && contact.current_step === step_number && contact.sent_message_id) {
    console.log(`Contact ${contact_id} already sent for final step ${step_number}, skipping`)
    msg.ack()
    return
  }

  const campaign = await env.DB.prepare(
    'SELECT * FROM campaigns WHERE id = ?',
  ).bind(campaign_id).first<Campaign>()

  if (!campaign) {
    console.error(`Campaign ${campaign_id} not found`)
    msg.ack()
    return
  }

  // R2-5: Skip if campaign is no longer active (e.g. paused/completed while message was queued)
  if (campaign.status !== 'active') {
    console.log(`Campaign ${campaign_id} is '${campaign.status}', skipping queued sequence send for contact ${contact_id}`)
    msg.ack()
    return
  }

  // CAN-SPAM: refuse to send without physical address (parity with v2 agent send)
  if (!campaign.physical_address?.trim()) {
    console.error(`Campaign ${campaign_id}: refusing to send without physical address (CAN-SPAM)`)
    msg.ack()
    return
  }

  // R2-6: Atomically claim a global send slot before sending (skip for dry-run)
  if (!campaign.dry_run) {
    const slotClaimed = await claimGlobalSendSlot(env)
    if (!slotClaimed) {
      console.log(`Global daily send limit reached, requeueing sequence send for contact ${contact_id}`)
      msg.retry()
      return
    }
  }

  const unsub = await env.DB.prepare(
    'SELECT id FROM unsubscribes WHERE email = ?',
  ).bind(contact.email).first()

  if (unsub) {
    await updateContactStatus(env.DB, contact_id, 'unsubscribed')
    msg.ack()
    return
  }

  const { subject, body } = await generateEmail(createProvider(env), campaign, contact, step_number)

  const unsubToken = await generateUnsubscribeToken(contact.email, campaign_id, env.UNSUBSCRIBE_SECRET)
  const unsubUrl = generateUnsubscribeUrl(env.UNSUBSCRIBE_BASE_URL, unsubToken)
  const fullBody = body + generateComplianceFooter(campaign.physical_address, unsubUrl)
  const unsubHeaders = generateListUnsubscribeHeaders(unsubUrl)

  // Build HTML version with clean footer (v1 has no tracked links, just clean unsubscribe)
  const fullHtml = buildHtmlBody(body, []) + generateComplianceFooterHtml(campaign.physical_address, unsubUrl)

  // Dry-run mode: log but don't send (parity with v2 agent send)
  if (campaign.dry_run) {
    await env.DB.prepare(`
      INSERT INTO send_log (id, campaign_id, contact_id, step_number, subject, body, status)
      VALUES (?, ?, ?, ?, ?, ?, 'dry_run')
    `).bind(
      crypto.randomUUID().replace(/-/g, ''),
      campaign_id,
      contact_id,
      step_number,
      subject,
      fullBody,
    ).run()

    await recordEvent(env, campaign_id, contact_id, 'email_sent', {
      subject, step_number, dry_run: true,
    })
    msg.ack()
    return
  }

  const sendRes = await mailsFetch(env, '/v1/send', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      from: campaign.from_email || env.MAILS_MAILBOX,
      to: [contact.email],
      subject,
      text: fullBody,
      html: fullHtml,
      headers: unsubHeaders,
    }),
  })

  if (!sendRes.ok) {
    const errText = await sendRes.text()
    await env.DB.prepare(`
      INSERT INTO send_log (id, campaign_id, contact_id, step_number, subject, body, status, error)
      VALUES (?, ?, ?, ?, ?, ?, 'failed', ?)
    `).bind(
      crypto.randomUUID().replace(/-/g, ''),
      campaign_id,
      contact_id,
      step_number,
      subject,
      fullBody,
      errText,
    ).run()

    // P1-6: Differentiate error types for v1 engine too
    if ([401, 403].includes(sendRes.status)) {
      // System-level auth error: pause campaign, do NOT mark contact as bounced
      await env.DB.prepare(
        "UPDATE campaigns SET status = 'paused', updated_at = datetime('now') WHERE id = ?",
      ).bind(campaign_id).run()

      console.error(`Auth error (${sendRes.status}) for campaign ${campaign_id}, pausing campaign`)

      try {
        if (campaign) {
          await notifyOwner(env, campaign, 'campaign_error', {
            contactEmail: contact.email,
            errorMessage: `Send API returned ${sendRes.status}: ${errText.slice(0, 200)}. Campaign has been paused.`,
          })
        }
      } catch (_notifyErr) {
        console.error('Failed to notify owner about campaign error:', _notifyErr)
      }
      msg.ack()
      return
    }

    if ([400, 422].includes(sendRes.status)) {
      // Contact-level error (bad address, invalid payload) — mark as error, NOT bounced
      await updateContactStatus(env.DB, contact_id, 'error')
      console.error(`Contact-level send error (${sendRes.status}) for contact ${contact_id}, marking as error`)
      msg.ack()
      return
    }

    await updateContactStatus(env.DB, contact_id, 'pending')

    // Refund the global send slot since the email was not actually sent
    try {
      const today = new Date().toISOString().slice(0, 10)
      await env.DB.prepare(
        "UPDATE daily_stats SET sent_count = MAX(0, sent_count - 1) WHERE campaign_id = '__global__' AND date = ?"
      ).bind(today).run()
    } catch { /* best-effort refund */ }

    throw new Error(`Send API error: ${sendRes.status} ${errText}`)
  }

  // === Email sent successfully — from here, always ack (no retry). ===
  const sendData = await sendRes.json() as any
  const messageId = sendData.id || sendData.provider_id || sendData.message_id || ''

  try {
    const steps: CampaignStep[] = JSON.parse(campaign.steps || '[]')
    const nextStep = step_number + 1
    let nextSendAt: string | null = null

    if (nextStep < steps.length) {
      const delayDays = steps[nextStep].delay_days || 3
      const nextDate = new Date(Date.now() + delayDays * 24 * 60 * 60 * 1000)
      nextSendAt = nextDate.toISOString()
    }

    const newStatus = nextStep < steps.length ? 'pending' : 'sent'
    const now = new Date().toISOString()
    const today = now.slice(0, 10)
    const sendLogId = crypto.randomUUID().replace(/-/g, '')
    const statsId = crypto.randomUUID().replace(/-/g, '')

    // State machine guard: verify the transition is allowed before batching
    if (!canTransition(contact.status, newStatus)) {
      console.log(`[send-consumer] Blocked batch transition ${contact.status} -> ${newStatus} for contact ${contact_id}`)
      msg.ack()
      return
    }

    // Batch all post-send DB writes for atomicity (parity with v2 agent send)
    await env.DB.batch([
      env.DB.prepare(`
        UPDATE campaign_contacts
        SET status = ?, current_step = ?, next_send_at = ?, last_sent_at = ?,
            sent_message_id = ?, emails_sent = emails_sent + 1, updated_at = ?
        WHERE id = ?
      `).bind(
        newStatus,
        nextStep < steps.length ? nextStep : step_number,
        nextSendAt,
        now,
        messageId,
        now,
        contact_id,
      ),
      env.DB.prepare(
        "INSERT INTO send_log (id, campaign_id, contact_id, step_number, subject, body, message_id, status) VALUES (?, ?, ?, ?, ?, ?, ?, 'sent')",
      ).bind(sendLogId, campaign_id, contact_id, step_number, subject, fullBody, messageId),
      env.DB.prepare(
        "INSERT INTO daily_stats (id, campaign_id, date, sent_count) VALUES (?, ?, ?, 1) ON CONFLICT(campaign_id, date) DO UPDATE SET sent_count = sent_count + 1",
      ).bind(statsId, campaign_id, today),
    ])

    // v2.1: Record agent message to conversations for context tracking
    try {
      await recordAgentMessage(env, campaign_id, contact_id, fullBody, subject, messageId)
    } catch (convErr) {
      console.error(`[send-consumer] Failed to record agent message to conversations:`, convErr)
    }
  } catch (dbErr) {
    // Email was already sent — log the DB failure but do NOT retry
    console.error(`[CRITICAL] Email sent to ${contact.email} (msgId=${messageId}) but post-send DB update failed:`, dbErr)
  }

  msg.ack()
}
