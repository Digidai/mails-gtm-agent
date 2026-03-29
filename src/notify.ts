import { Env, Campaign } from './types'
import { mailsFetch } from './mails-api'

type NotifyType = 'interested_reply' | 'conversion' | 'campaign_error'

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
}
