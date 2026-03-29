import { Env, Campaign } from './types'

type NotifyType = 'interested_reply' | 'conversion'

/**
 * Send a notification email to the campaign owner (campaign.from_email / mailbox).
 * MVP: only two notification types.
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
  }

  try {
    const res = await fetch(`${env.MAILS_API_URL}/api/send`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${env.MAILS_API_KEY}`,
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
