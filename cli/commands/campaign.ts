import { ApiClient } from '../api'
import { c, table, progressBar } from '../format'

export async function campaignCreate(args: string[]): Promise<void> {
  const opts = parseFlags(args)
  const name = opts['name']
  const product = opts['product']
  const description = opts['description']
  const address = opts['address'] || ''

  if (!name || !product || !description) {
    console.error(c.red('Usage: mails-gtm campaign create --name <name> --product <product> --description <desc> [--address <addr>]'))
    process.exit(1)
  }

  const api = new ApiClient()
  const result = await api.post('/api/campaign/create', {
    name,
    product_name: product,
    product_description: description,
    physical_address: address,
  })

  console.log(c.green(`Campaign created: ${result.id}`))
}

export async function campaignList(): Promise<void> {
  const api = new ApiClient()
  const result = await api.get('/api/campaign/list')
  const campaigns = result.campaigns || []

  if (campaigns.length === 0) {
    console.log(c.dim('No campaigns found.'))
    return
  }

  const headers = ['ID', 'NAME', 'STATUS', 'CONTACTS', 'SENT', 'REPLIED']
  const rows = campaigns.map((cam: any) => [
    cam.id.slice(0, 8),
    cam.name,
    colorStatus(cam.status),
    String(cam.total_contacts || 0),
    String(cam.sent_count || 0),
    String(cam.reply_count || 0),
  ])

  console.log(table(headers, rows))
}

export async function campaignStats(args: string[]): Promise<void> {
  const id = args[0]
  if (!id) {
    console.error(c.red('Usage: mails-gtm campaign stats <campaign-id>'))
    process.exit(1)
  }

  const api = new ApiClient()
  const stats = await api.get(`/api/campaign/${id}/stats`)

  console.log(`${c.bold('Campaign:')} ${stats.name} (${colorStatus(stats.status)})`)
  console.log(`${c.bold('Total:')} ${stats.total_contacts} contacts | ${c.bold('Today:')} ${stats.today_sent}/${stats.daily_limit} sent`)
  console.log()

  // Status breakdown
  console.log(c.bold('Status breakdown:'))
  const total = stats.total_contacts || 1
  const statuses = [
    'pending', 'queued', 'sent', 'replied', 'interested',
    'not_now', 'not_interested', 'bounced', 'unsubscribed',
    'wrong_person', 'do_not_contact',
  ]

  for (const status of statuses) {
    const count = stats.by_status?.[status] || 0
    if (count === 0) continue
    const pct = Math.round((count / total) * 100)
    const bar = progressBar(count, total)
    const label = status.padEnd(18)
    const countStr = String(count).padStart(4)
    console.log(`  ${label} ${countStr}  ${bar}  ${pct}%`)
  }

  // Step stats
  if (stats.steps?.length > 0) {
    console.log()
    console.log(c.bold('Steps:'))
    for (const step of stats.steps) {
      console.log(`  Step ${step.step_number}: ${c.green(`${step.sent} sent`)} | ${c.yellow(`${step.pending} pending`)}`)
    }
  }
}

export async function campaignStart(args: string[]): Promise<void> {
  const id = args[0]
  if (!id) {
    console.error(c.red('Usage: mails-gtm campaign start <campaign-id>'))
    process.exit(1)
  }

  const api = new ApiClient()
  const result = await api.post(`/api/campaign/${id}/start`)
  console.log(c.green(`Campaign ${result.id} is now ${result.status}`))
}

export async function campaignPause(args: string[]): Promise<void> {
  const id = args[0]
  if (!id) {
    console.error(c.red('Usage: mails-gtm campaign pause <campaign-id>'))
    process.exit(1)
  }

  const api = new ApiClient()
  const result = await api.post(`/api/campaign/${id}/pause`)
  console.log(c.green(`Campaign ${result.id} is now ${result.status}`))
}

function colorStatus(status: string): string {
  switch (status) {
    case 'active': return c.green(status)
    case 'paused': return c.yellow(status)
    case 'draft': return c.dim(status)
    case 'completed': return c.cyan(status)
    default: return status
  }
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
