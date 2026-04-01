import { Env, Campaign } from '../types'
import { mailsFetch } from '../mails-api'

/**
 * Daily summary cron — sends a digest email to each active campaign's owner.
 * Runs once daily (when hour=9 and minute=0, configured in index.ts).
 *
 * Includes: sent count, click count, reply count, new interested contacts,
 * conversion count, and top-performing angles.
 */
export async function summaryCron(env: Env): Promise<void> {
  console.log('[summary-cron] Starting daily summary...')
  try {
    const campaigns = await env.DB.prepare(
      "SELECT * FROM campaigns WHERE status = 'active' AND engine = 'agent'",
    ).all<Campaign>()

    if (!campaigns.results?.length) {
      console.log('[summary-cron] No active agent campaigns, skipping')
      return
    }

    for (const campaign of campaigns.results) {
      try {
        await sendCampaignSummary(env, campaign)
      } catch (err) {
        console.error(`[summary-cron] Failed to send summary for campaign ${campaign.id}:`, err)
      }
    }

    console.log('[summary-cron] Completed')
  } catch (err) {
    console.error('[summary-cron] Fatal error:', err)
  }
}

async function sendCampaignSummary(env: Env, campaign: Campaign): Promise<void> {
  const yesterday = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString().slice(0, 10)
  const today = new Date().toISOString().slice(0, 10)

  // Sent count (yesterday)
  const sentRow = await env.DB.prepare(
    "SELECT COALESCE(sent_count, 0) as count FROM daily_stats WHERE campaign_id = ? AND date = ?",
  ).bind(campaign.id, yesterday).first<{ count: number }>()
  const sentCount = sentRow?.count ?? 0

  // Click count (yesterday)
  const clickRow = await env.DB.prepare(
    "SELECT COUNT(DISTINCT contact_id) as count FROM events WHERE campaign_id = ? AND event_type = 'link_click' AND created_at >= ? AND created_at < ?",
  ).bind(campaign.id, yesterday, today).first<{ count: number }>()
  const clickCount = clickRow?.count ?? 0

  // Reply count (yesterday)
  const replyRow = await env.DB.prepare(
    "SELECT COUNT(*) as count FROM events WHERE campaign_id = ? AND event_type = 'reply' AND created_at >= ? AND created_at < ?",
  ).bind(campaign.id, yesterday, today).first<{ count: number }>()
  const replyCount = replyRow?.count ?? 0

  // New interested contacts (yesterday)
  const interestedRows = await env.DB.prepare(
    "SELECT cc.email, cc.name, cc.company FROM campaign_contacts cc JOIN events e ON e.contact_id = cc.id WHERE e.campaign_id = ? AND e.event_type = 'reply' AND e.created_at >= ? AND e.created_at < ? AND cc.status = 'interested' LIMIT 10",
  ).bind(campaign.id, yesterday, today).all<{ email: string; name: string | null; company: string | null }>()

  // Conversion count (yesterday)
  const convRow = await env.DB.prepare(
    "SELECT COUNT(*) as count FROM campaign_contacts WHERE campaign_id = ? AND converted_at >= ? AND converted_at < ?",
  ).bind(campaign.id, yesterday, today).first<{ count: number }>()
  const convCount = convRow?.count ?? 0

  // Total pipeline stats
  const totalRow = await env.DB.prepare(
    "SELECT COUNT(*) as total, SUM(CASE WHEN status = 'interested' THEN 1 ELSE 0 END) as interested, SUM(CASE WHEN status = 'converted' THEN 1 ELSE 0 END) as converted, SUM(CASE WHEN status IN ('pending', 'active') THEN 1 ELSE 0 END) as active FROM campaign_contacts WHERE campaign_id = ?",
  ).bind(campaign.id).first<{ total: number; interested: number; converted: number; active: number }>()

  // Build summary email
  const to = campaign.from_email || env.MAILS_MAILBOX
  const subject = `[mails-gtm] Daily summary: ${campaign.name} (${yesterday})`

  const interestedList = (interestedRows.results || [])
    .map(c => `  - ${c.name || c.email}${c.company ? ` (${c.company})` : ''}`)
    .join('\n')

  const body = [
    `Daily Summary for "${campaign.name}"`,
    `Date: ${yesterday}`,
    '',
    '--- Yesterday ---',
    `Emails sent: ${sentCount}`,
    `Link clicks: ${clickCount}`,
    `Replies: ${replyCount}`,
    `Conversions: ${convCount}`,
    '',
    interestedList ? `New interested contacts:\n${interestedList}` : 'No new interested contacts',
    '',
    '--- Pipeline ---',
    `Total contacts: ${totalRow?.total ?? 0}`,
    `Active (in sequence): ${totalRow?.active ?? 0}`,
    `Interested: ${totalRow?.interested ?? 0}`,
    `Converted: ${totalRow?.converted ?? 0}`,
    '',
    sentCount === 0 && replyCount === 0
      ? 'Tip: No activity yesterday. Check if the campaign is running and contacts are available.'
      : clickCount > 0 && convCount === 0
        ? 'Tip: People are clicking but not converting. Consider updating your conversion page or offer.'
        : '',
  ].filter(l => l !== undefined).join('\n')

  try {
    const res = await mailsFetch(env, '/v1/send', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        from: env.MAILS_MAILBOX,
        to: [to],
        subject,
        text: body,
      }),
    })
    if (!res.ok) {
      console.error(`[summary-cron] Send failed for campaign ${campaign.id}: ${res.status}`)
    }
  } catch (err) {
    console.error(`[summary-cron] Send error for campaign ${campaign.id}:`, err)
  }
}
