/**
 * Generate RFC 8058 List-Unsubscribe headers
 */
export function generateListUnsubscribeHeaders(unsubscribeUrl: string): Record<string, string> {
  return {
    'List-Unsubscribe': `<${unsubscribeUrl}>`,
    'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click',
  }
}

/**
 * Generate a physical address footer for CAN-SPAM compliance
 */
export function generateComplianceFooter(physicalAddress: string, unsubscribeUrl: string): string {
  const lines = [
    '',
    '---',
    physicalAddress || 'Physical address not provided',
    `To unsubscribe: ${unsubscribeUrl}`,
  ]
  return lines.join('\n')
}
