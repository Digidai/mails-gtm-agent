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
