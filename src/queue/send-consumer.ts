import { Env, SendMessage, Campaign, CampaignContact, CampaignStep } from '../types'
import { generateEmail } from '../llm/generate'
import { generateUnsubscribeToken, generateUnsubscribeUrl } from '../compliance/unsubscribe'
import { generateListUnsubscribeHeaders, generateComplianceFooter } from '../compliance/headers'

export async function sendConsumer(batch: MessageBatch, env: Env): Promise<void> {
  for (const msg of batch.messages) {
    try {
      await processMessage(msg.body as SendMessage, env)
      msg.ack()
    } catch (err) {
      console.error('Send consumer error:', err)
      msg.retry()
    }
  }
}

async function processMessage(message: SendMessage, env: Env): Promise<void> {
  const { contact_id, campaign_id, step_number } = message

  // Fetch contact
  const contact = await env.DB.prepare(
    'SELECT * FROM campaign_contacts WHERE id = ?'
  ).bind(contact_id).first<CampaignContact>()

  if (!contact) {
    console.error(`Contact ${contact_id} not found`)
    return
  }

  // Skip contacts in terminal states
  const terminalStatuses = ['unsubscribed', 'bounced', 'do_not_contact', 'not_interested']
  if (terminalStatuses.includes(contact.status)) {
    console.log(`Contact ${contact_id} is in terminal status '${contact.status}', skipping`)
    return
  }

  // Idempotency check: if already sent for this step
  if (contact.status === 'sent' && contact.current_step >= step_number && contact.sent_message_id) {
    console.log(`Contact ${contact_id} already sent for step ${step_number}, skipping`)
    return
  }

  // Fetch campaign
  const campaign = await env.DB.prepare(
    'SELECT * FROM campaigns WHERE id = ?'
  ).bind(campaign_id).first<Campaign>()

  if (!campaign) {
    console.error(`Campaign ${campaign_id} not found`)
    return
  }

  // Check if contact is unsubscribed globally
  const unsub = await env.DB.prepare(
    'SELECT id FROM unsubscribes WHERE email = ?'
  ).bind(contact.email).first()

  if (unsub) {
    await env.DB.prepare(
      "UPDATE campaign_contacts SET status = 'unsubscribed', updated_at = datetime('now') WHERE id = ?"
    ).bind(contact_id).run()
    return
  }

  // Generate email content
  const { subject, body } = await generateEmail(env, campaign, contact, step_number)

  // Generate unsubscribe token and URL
  const unsubToken = await generateUnsubscribeToken(contact.email, campaign_id, env.UNSUBSCRIBE_SECRET)
  const unsubUrl = generateUnsubscribeUrl(env.UNSUBSCRIBE_BASE_URL, unsubToken)

  // Add compliance footer
  const fullBody = body + generateComplianceFooter(campaign.physical_address, unsubUrl)

  // Generate List-Unsubscribe headers
  const unsubHeaders = generateListUnsubscribeHeaders(unsubUrl)

  // Send via mails-agent API
  const sendRes = await fetch(`${env.MAILS_API_URL}/api/send`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${env.MAILS_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      from: campaign.from_email || env.MAILS_MAILBOX,
      to: [contact.email],
      subject,
      text: fullBody,
      headers: unsubHeaders,
    }),
  })

  if (!sendRes.ok) {
    const errText = await sendRes.text()
    // Log the failure
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

    // Non-retryable errors: mark as failed permanently to avoid infinite retry loop
    const nonRetryable = [400, 401, 403, 422].includes(sendRes.status)
    if (nonRetryable) {
      await env.DB.prepare(
        "UPDATE campaign_contacts SET status = 'bounced', updated_at = datetime('now') WHERE id = ?"
      ).bind(contact_id).run()
      console.error(`Non-retryable send error (${sendRes.status}) for contact ${contact_id}, marking as bounced`)
      return // Don't throw -- ack the message since retrying won't help
    }

    // Retryable errors (5xx, timeouts): reset to pending for retry by cron
    await env.DB.prepare(
      "UPDATE campaign_contacts SET status = 'pending', updated_at = datetime('now') WHERE id = ?"
    ).bind(contact_id).run()

    throw new Error(`Send API error: ${sendRes.status} ${errText}`)
  }

  // mails-worker /api/send returns { id, provider_id }
  const sendData = await sendRes.json() as any
  const messageId = sendData.id || sendData.provider_id || sendData.message_id || ''

  // Calculate next_send_at for the next step
  const steps: CampaignStep[] = JSON.parse(campaign.steps || '[]')
  const nextStep = step_number + 1
  let nextSendAt: string | null = null

  if (nextStep < steps.length) {
    const delayDays = steps[nextStep].delay_days || 3
    const nextDate = new Date(Date.now() + delayDays * 24 * 60 * 60 * 1000)
    nextSendAt = nextDate.toISOString()
  }

  // Update contact status
  const newStatus = nextStep < steps.length ? 'pending' : 'sent'
  await env.DB.prepare(`
    UPDATE campaign_contacts
    SET status = ?, current_step = ?, next_send_at = ?, last_sent_at = datetime('now'),
        sent_message_id = ?, updated_at = datetime('now')
    WHERE id = ?
  `).bind(
    newStatus,
    nextStep < steps.length ? nextStep : step_number,
    nextSendAt,
    messageId,
    contact_id,
  ).run()

  // Log the send
  await env.DB.prepare(`
    INSERT INTO send_log (id, campaign_id, contact_id, step_number, subject, body, message_id, status)
    VALUES (?, ?, ?, ?, ?, ?, ?, 'sent')
  `).bind(
    crypto.randomUUID().replace(/-/g, ''),
    campaign_id,
    contact_id,
    step_number,
    subject,
    fullBody,
    messageId,
  ).run()

  // Update daily stats
  const today = new Date().toISOString().slice(0, 10)
  await env.DB.prepare(`
    INSERT INTO daily_stats (id, campaign_id, date, sent_count)
    VALUES (?, ?, ?, 1)
    ON CONFLICT(campaign_id, date) DO UPDATE SET sent_count = sent_count + 1
  `).bind(
    crypto.randomUUID().replace(/-/g, ''),
    campaign_id,
    today,
  ).run()
}
