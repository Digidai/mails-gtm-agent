/** ANSI color helpers */
export const c = {
  green: (s: string) => `\x1b[32m${s}\x1b[0m`,
  red: (s: string) => `\x1b[31m${s}\x1b[0m`,
  yellow: (s: string) => `\x1b[33m${s}\x1b[0m`,
  cyan: (s: string) => `\x1b[36m${s}\x1b[0m`,
  bold: (s: string) => `\x1b[1m${s}\x1b[0m`,
  dim: (s: string) => `\x1b[2m${s}\x1b[0m`,
}

/** Render a table with aligned columns */
export function table(headers: string[], rows: string[][]): string {
  const widths = headers.map((h, i) => {
    const colValues = [h, ...rows.map(r => r[i] || '')]
    return Math.max(...colValues.map(v => stripAnsi(v).length))
  })

  const headerLine = headers.map((h, i) => h.padEnd(widths[i])).join('  ')
  const lines = [c.bold(headerLine)]

  for (const row of rows) {
    const line = row.map((cell, i) => {
      const stripped = stripAnsi(cell)
      const padding = widths[i] - stripped.length
      return cell + ' '.repeat(Math.max(0, padding))
    }).join('  ')
    lines.push(line)
  }

  return lines.join('\n')
}

/** Build a progress bar */
export function progressBar(value: number, total: number, width = 20): string {
  if (total === 0) return '\u2591'.repeat(width)
  const filled = Math.round((value / total) * width)
  return '\u2588'.repeat(filled) + '\u2591'.repeat(width - filled)
}

/** Strip ANSI escape codes for length calculation */
function stripAnsi(s: string): string {
  return s.replace(/\x1b\[[0-9;]*m/g, '')
}
