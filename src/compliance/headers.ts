/**
 * Generate List-Unsubscribe and List-Unsubscribe-Post headers.
 * Includes RFC 8058 one-click unsubscribe (List-Unsubscribe-Post) as required
 * by Gmail/Yahoo bulk sender guidelines (2024+) and recommended by RFC 8058.
 */
export function generateListUnsubscribeHeaders(unsubscribeUrl: string, mailtoAddress?: string): Record<string, string> {
  const urls = mailtoAddress
    ? `<${unsubscribeUrl}>, <mailto:${mailtoAddress}?subject=unsubscribe>`
    : `<${unsubscribeUrl}>`

  return {
    'List-Unsubscribe': urls,
    'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click',
  }
}

/**
 * Generate a physical address footer for CAN-SPAM compliance.
 * CAN-SPAM Act requires a valid physical postal address in every commercial email.
 * If missing, a prominent warning is included (caller should prevent this via campaign validation).
 */
export function generateComplianceFooter(physicalAddress: string, unsubscribeUrl: string): string {
  const address = physicalAddress?.trim()
  if (!address) {
    console.warn('[CAN-SPAM] Physical address is missing from email footer. This violates CAN-SPAM requirements.')
  }
  return `\n\n—\n${address || '[Physical address not configured - CAN-SPAM violation]'}\nUnsubscribe: ${unsubscribeUrl}`
}

/**
 * Generate HTML compliance footer. Unsubscribe is a clean link, not a raw URL.
 */
export function generateComplianceFooterHtml(physicalAddress: string, unsubscribeUrl: string): string {
  const rawAddress = physicalAddress?.trim() || '[Physical address not configured]'
  const address = rawAddress.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  return `<br><p style="color:#999;font-size:12px;border-top:1px solid #eee;padding-top:8px;margin-top:16px">${address}<br>
<a href="${unsubscribeUrl}" style="color:#999">Unsubscribe</a></p>`
}
