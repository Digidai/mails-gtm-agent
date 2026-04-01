/**
 * Generate RFC 8058 List-Unsubscribe headers.
 * Includes both HTTPS URL (for one-click) and mailto (for legacy clients / Gmail compatibility).
 * RFC 8058 requires List-Unsubscribe-Post alongside the HTTPS URL for one-click unsubscribe.
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
  const lines = [
    '',
    '---',
    address || '[Physical address not configured - CAN-SPAM violation]',
    `To unsubscribe: ${unsubscribeUrl}`,
  ]
  return lines.join('\n')
}

/**
 * Generate HTML compliance footer. Unsubscribe is a clean link, not a raw URL.
 */
export function generateComplianceFooterHtml(physicalAddress: string, unsubscribeUrl: string): string {
  const address = physicalAddress?.trim() || '[Physical address not configured]'
  return `<br><hr style="border:none;border-top:1px solid #ddd;margin:16px 0">
<p style="color:#999;font-size:12px">${address}<br>
<a href="${unsubscribeUrl}" style="color:#999">Unsubscribe</a></p>`
}
