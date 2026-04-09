import { Env, Campaign } from './types'
import { mailsFetch } from './mails-api'

type NotifyType = 'interested_reply' | 'conversion' | 'campaign_error' | 'knowledge_gap' | 'conversation_stopped' | 'dlq_failure'

/**
 * Fire an outgoing webhook callback if the campaign has a webhook_callback_url configured.
 * Best-effort: failures are logged but never block the main flow.
 */
async function fireCallbackWebhook(
  campaign: Campaign,
  type: string,
  data: Record<string, unknown>,
): Promise<void> {
  const url = (campaign as any).webhook_callback_url
  if (!url) return

  // URL validation: https only
  try {
    const parsed = new URL(url)
    if (parsed.protocol !== 'https:') {
      console.error(`[webhook-callback] Rejected non-HTTPS URL: ${url}`)
      return
    }
    // Block private IPs
    const hostname = parsed.hostname.toLowerCase()
    if (hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '0.0.0.0' ||
        hostname.startsWith('10.') || hostname.startsWith('192.168.') || hostname.startsWith('172.') ||
        hostname === '[::1]' || hostname.endsWith('.internal') || hostname.endsWith('.local')) {
      console.error(`[webhook-callback] Rejected private IP URL: ${url}`)
      return
    }
  } catch {
    console.error(`[webhook-callback] Invalid URL: ${url}`)
    return
  }

  const payload = JSON.stringify({
    event: type,
    campaign_id: campaign.id,
    campaign_name: campaign.name,
    timestamp: new Date().toISOString(),
    data,
  })

  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
  }

  // HMAC signature if webhook_secret is available
  if (campaign.webhook_secret) {
    const encoder = new TextEncoder()
    const key = await crypto.subtle.importKey(
      'raw', encoder.encode(campaign.webhook_secret),
      { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']
    )
    const sig = await crypto.subtle.sign('HMAC', key, encoder.encode(payload))
    const hex = Array.from(new Uint8Array(sig)).map(b => b.toString(16).padStart(2, '0')).join('')
    headers['X-Webhook-Signature'] = `sha256=${hex}`
  }

  // 5s timeout
  const controller = new AbortController()
  const timeoutId = setTimeout(() => controller.abort(), 5000)

  try {
    const res = await fetch(url, {
      method: 'POST',
      headers,
      body: payload,
      signal: controller.signal,
    })
    if (!res.ok) {
      console.error(`[webhook-callback] POST to ${url} failed: ${res.status}`)
    }
  } catch (err) {
    console.error(`[webhook-callback] Error posting to ${url}:`, err)
  } finally {
    clearTimeout(timeoutId)
  }
}

/**
 * Send a notification email to the campaign owner (campaign.from_email / mailbox).
 */
export async function notifyOwner(
  env: Env,
  campaign: Campaign,
  type: NotifyType,
  data: {
    contactEmail: string
    contactName?: string | null
    replyText?: string
    conversionType?: string
    errorMessage?: string
    gap?: string
    reason?: string
  },
): Promise<void> {
  const to = campaign.from_email || env.MAILS_MAILBOX

  let subject: string
  let body: string

  switch (type) {
    case 'interested_reply':
      subject = `[mails-gtm] Interested reply from ${data.contactEmail}`
      body = [
        `Contact ${data.contactName || data.contactEmail} replied with interest.`,
        '',
        `Campaign: ${campaign.name}`,
        `Email: ${data.contactEmail}`,
        '',
        data.replyText ? `Reply:\n${data.replyText.slice(0, 500)}` : '',
        '',
        'Action: Review and follow up if needed.',
      ].filter(Boolean).join('\n')
      break

    case 'conversion':
      subject = `[mails-gtm] Conversion: ${data.contactEmail} (${data.conversionType || 'signup'})`
      body = [
        `${data.contactName || data.contactEmail} has converted!`,
        '',
        `Campaign: ${campaign.name}`,
        `Email: ${data.contactEmail}`,
        `Type: ${data.conversionType || 'signup'}`,
      ].join('\n')
      break

    case 'campaign_error':
      subject = `[mails-gtm] Campaign paused: ${campaign.name}`
      body = [
        `Campaign "${campaign.name}" has been automatically paused due to a send error.`,
        '',
        `Contact: ${data.contactEmail}`,
        `Error: ${data.errorMessage || 'Unknown error'}`,
        '',
        'Action: Check your API credentials and resume the campaign when ready.',
      ].join('\n')
      break

    case 'knowledge_gap':
      subject = `[mails-gtm] Knowledge gap: ${data.contactEmail}`
      body = [
        `${data.contactName || data.contactEmail} asked a question I couldn't answer.`,
        '',
        `Campaign: ${campaign.name}`,
        `Missing info: ${data.gap || 'Unknown'}`,
        '',
        'Consider updating the campaign knowledge base.',
      ].join('\n')
      break

    case 'conversation_stopped':
      subject = `[mails-gtm] Conversation stopped: ${data.contactEmail}`
      body = [
        `Conversation with ${data.contactName || data.contactEmail} has been stopped.`,
        '',
        `Campaign: ${campaign.name}`,
        `Reason: ${data.reason || 'Unknown'}`,
      ].join('\n')
      break

    case 'dlq_failure':
      subject = `[mails-gtm] Message permanently failed: ${data.contactEmail}`
      body = [
        `A message for ${data.contactName || data.contactEmail} failed after all retries and was sent to the dead letter queue.`,
        '',
        `Campaign: ${campaign.name}`,
        `Error: ${data.errorMessage || 'Unknown — check campaign events for details'}`,
        '',
        'Action: Investigate and manually re-trigger if needed.',
      ].join('\n')
      break
  }

  try {
    const res = await mailsFetch(env, '/v1/send', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        from: env.MAILS_MAILBOX,
        to: [to],
        subject,
        text: body,
      }),
    })
    if (!res.ok) {
      console.error(`Notification send failed: ${res.status} ${await res.text().catch(() => '')}`)
    }
  } catch (err) {
    // Notification failure is not critical — log and continue
    console.error('Failed to send notification:', err)
  }

  // Fire outgoing webhook if configured
  try {
    await fireCallbackWebhook(campaign, type, data)
  } catch { /* best-effort */ }
}
