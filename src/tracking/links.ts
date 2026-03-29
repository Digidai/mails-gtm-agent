import { Env } from '../types'

const EXCLUDE_PATTERNS = [
  /unsubscribe/i,
  /opt-out/i,
  /opt_out/i,
  /manage-preferences/i,
  /privacy-policy/i,
  /privacy/i,
  /list-unsubscribe/i,
]

// Match URLs in plain text (not inside angle brackets or markdown)
const URL_REGEX = /(https?:\/\/[^\s<>"]+)/g

/**
 * Replace URLs in email body with tracking redirect links.
 * Returns the modified body and the list of tracked link IDs.
 */
export async function replaceLinksWithTracking(
  body: string,
  contactId: string,
  campaignId: string,
  baseUrl: string,
  env: Env,
): Promise<{ body: string; linkIds: string[] }> {
  const linkIds: string[] = []
  const stmts: D1PreparedStatement[] = []
  const replacements: Array<{ original: string; tracked: string }> = []
  const now = new Date().toISOString()

  // Find all URLs
  const matches = body.matchAll(URL_REGEX)
  const seenUrls = new Set<string>()

  for (const match of matches) {
    const url = match[0]

    // Skip excluded patterns
    if (EXCLUDE_PATTERNS.some(p => p.test(url))) continue

    // Skip duplicates within the same email
    if (seenUrls.has(url)) continue
    seenUrls.add(url)

    const linkId = crypto.randomUUID().replace(/-/g, '')
    linkIds.push(linkId)

    stmts.push(
      env.DB.prepare(
        'INSERT INTO tracked_links (id, campaign_id, contact_id, original_url, created_at) VALUES (?, ?, ?, ?, ?)',
      ).bind(linkId, campaignId, contactId, url, now),
    )

    replacements.push({
      original: url,
      tracked: `${baseUrl}/t/${linkId}`,
    })
  }

  // Batch insert tracked links
  if (stmts.length > 0) {
    await env.DB.batch(stmts)
  }

  // Replace URLs in body
  let result = body
  for (const { original, tracked } of replacements) {
    result = result.split(original).join(tracked)
  }

  return { body: result, linkIds }
}

/**
 * Check if a URL should be excluded from tracking
 */
export function isExcludedUrl(url: string): boolean {
  return EXCLUDE_PATTERNS.some(p => p.test(url))
}
