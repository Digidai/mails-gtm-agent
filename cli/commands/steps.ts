import { readFileSync } from 'fs'
import { ApiClient } from '../api'
import { c, table } from '../format'

export async function stepsSet(args: string[]): Promise<void> {
  const id = args[0]
  if (!id) {
    console.error(c.red('Usage: mails-gtm steps set <campaign-id> --file <steps.json>'))
    process.exit(1)
  }

  const flags = parseFlags(args.slice(1))
  const filePath = flags['file']
  if (!filePath) {
    console.error(c.red('Missing --file flag. Provide a JSON file with steps.'))
    process.exit(1)
  }

  let stepsData: any
  try {
    const raw = readFileSync(filePath, 'utf-8')
    stepsData = JSON.parse(raw)
  } catch (err: any) {
    console.error(c.red(`Failed to read/parse ${filePath}: ${err.message}`))
    process.exit(1)
  }

  // Support both { steps: [...] } and bare [...]
  const steps = Array.isArray(stepsData) ? stepsData : stepsData.steps
  if (!Array.isArray(steps)) {
    console.error(c.red('JSON must be an array of steps or { "steps": [...] }'))
    process.exit(1)
  }

  const api = new ApiClient()
  const result = await api.post(`/api/campaign/${id}/steps`, { steps })

  console.log(c.green(`Set ${result.steps.length} steps for campaign ${id}`))
  for (const step of result.steps) {
    const mode = step.ai_generate ? c.cyan('AI') : c.dim('template')
    console.log(`  Step ${step.step_number}: delay ${step.delay_days}d [${mode}]`)
  }
}

export async function stepsList(args: string[]): Promise<void> {
  const id = args[0]
  if (!id) {
    console.error(c.red('Usage: mails-gtm steps list <campaign-id>'))
    process.exit(1)
  }

  const api = new ApiClient()
  const result = await api.get(`/api/campaign/${id}/steps`)
  const steps = result.steps || []

  if (steps.length === 0) {
    console.log(c.dim('No steps configured.'))
    return
  }

  const headers = ['STEP', 'DELAY', 'MODE', 'SUBJECT']
  const rows = steps.map((s: any) => [
    String(s.step_number ?? '-'),
    `${s.delay_days}d`,
    s.ai_generate ? c.cyan('AI') : c.dim('template'),
    s.subject_template ? truncate(s.subject_template, 40) : c.dim('(AI generated)'),
  ])

  console.log(table(headers, rows))
}

function truncate(s: string, max: number): string {
  return s.length > max ? s.slice(0, max - 3) + '...' : s
}

function parseFlags(args: string[]): Record<string, string> {
  const flags: Record<string, string> = {}
  for (let i = 0; i < args.length; i++) {
    if (args[i].startsWith('--')) {
      const key = args[i].slice(2)
      flags[key] = args[i + 1] || ''
      i++
    }
  }
  return flags
}
