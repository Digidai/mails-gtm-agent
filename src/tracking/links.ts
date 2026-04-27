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
 * Validate that a URL is safe to track and redirect to.
 * Only allow http: and https: schemes.
 */
function isSafeUrl(url: string): boolean {
  try {
    const parsed = new URL(url)
    return parsed.protocol === 'http:' || parsed.protocol === 'https:'
  } catch {
    return false
  }
}

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

    // Skip non-http(s) URLs to prevent open redirect via tracked links
    if (!isSafeUrl(url)) continue

    // Skip duplicates within the same email
    if (seenUrls.has(url)) continue
    seenUrls.add(url)

    const linkId = generateLinkId()
    linkIds.push(linkId)

    stmts.push(
      env.DB.prepare(
        'INSERT INTO tracked_links (id, campaign_id, contact_id, original_url, created_at) VALUES (?, ?, ?, ?, ?)',
      ).bind(linkId, campaignId, contactId, url, now),
    )

    replacements.push({
      original: url,
      tracked: `${baseUrl}/r/${linkId}`,
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
 * Build an HTML email body from plain text, with tracked links as <a> tags.
 * The display text shows the original URL (or domain for long URLs),
 * while the href points to the tracking redirect.
 */
export function buildHtmlBody(
  textBody: string,
  trackedReplacements: Array<{ original: string; tracked: string }>,
): string {
  const trackedByOriginal = new Map(trackedReplacements.map((r) => [r.original, r.tracked]))
  let html = ''
  let lastIndex = 0

  for (const match of textBody.matchAll(URL_REGEX)) {
    const url = match[0]
    const index = match.index ?? 0
    html += escapeHtml(textBody.slice(lastIndex, index))

    const href = trackedByOriginal.get(url) ?? url
    const displayText = trackedByOriginal.has(url) ? displayUrl(url) : url
    html += `<a href="${escapeAttribute(href)}">${escapeHtml(displayText)}</a>`

    lastIndex = index + url.length
  }

  html += escapeHtml(textBody.slice(lastIndex))
  return html.replace(/\n/g, '<br>\n')
}

function displayUrl(url: string): string {
  try {
    const parsed = new URL(url)
    return parsed.hostname + (parsed.pathname !== '/' ? parsed.pathname : '')
  } catch {
    return url
  }
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
}

function escapeAttribute(value: string): string {
  return escapeHtml(value).replace(/"/g, '&quot;')
}

/**
 * Replace URLs with tracking links and return both plain text and HTML versions.
 * Plain text keeps original URLs (human-readable).
 * HTML uses anchor tags with tracking hrefs (clickable, clean display).
 */
export async function replaceLinksWithTrackingDual(
  body: string,
  contactId: string,
  campaignId: string,
  baseUrl: string,
  env: Env,
): Promise<{ text: string; html: string; linkIds: string[] }> {
  const linkIds: string[] = []
  const stmts: D1PreparedStatement[] = []
  const replacements: Array<{ original: string; tracked: string }> = []
  const now = new Date().toISOString()

  const matches = body.matchAll(URL_REGEX)
  const seenUrls = new Set<string>()

  for (const match of matches) {
    const url = match[0]
    if (EXCLUDE_PATTERNS.some(p => p.test(url))) continue
    if (!isSafeUrl(url)) continue
    if (seenUrls.has(url)) continue
    seenUrls.add(url)

    const linkId = generateLinkId()
    linkIds.push(linkId)

    stmts.push(
      env.DB.prepare(
        'INSERT INTO tracked_links (id, campaign_id, contact_id, original_url, created_at) VALUES (?, ?, ?, ?, ?)',
      ).bind(linkId, campaignId, contactId, url, now),
    )

    replacements.push({
      original: url,
      tracked: `${baseUrl}/r/${linkId}`,
    })
  }

  if (stmts.length > 0) {
    await env.DB.batch(stmts)
  }

  // Plain text keeps original URLs
  const text = body

  // HTML uses anchor tags with tracking hrefs
  const html = buildHtmlBody(body, replacements)

  return { text, html, linkIds }
}

/**
 * Check if a URL should be excluded from tracking
 */
export function isExcludedUrl(url: string): boolean {
  return EXCLUDE_PATTERNS.some(p => p.test(url))
}

function generateLinkId(): string {
  return crypto.randomUUID().replace(/-/g, '')
}
