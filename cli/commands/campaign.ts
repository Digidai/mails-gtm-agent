import { ApiClient } from '../api'
import { c, table, progressBar } from '../format'

export async function campaignCreate(args: string[]): Promise<void> {
  const opts = parseFlags(args)
  const name = opts['name']
  const product = opts['product']
  const description = opts['description']
  const address = opts['address'] || ''
  const productUrl = opts['product-url'] || ''
  const conversionUrl = opts['conversion-url'] || ''
  const engine = opts['engine'] || 'agent'
  const dryRun = opts['dry-run'] === 'true' || opts['dry-run'] === '1'

  if (!name) {
    console.error(c.red('Usage: mails-gtm campaign create --name <name> [options]'))
    console.error(c.dim('  Options:'))
    console.error(c.dim('    --product <name>          Product name'))
    console.error(c.dim('    --description <desc>      Product description'))
    console.error(c.dim('    --product-url <url>       Product URL (auto-generates knowledge base)'))
    console.error(c.dim('    --conversion-url <url>    Conversion target URL'))
    console.error(c.dim('    --address <addr>          Physical address (CAN-SPAM)'))
    console.error(c.dim('    --engine <agent|sequence>  Engine type (default: agent)'))
    console.error(c.dim('    --dry-run <true|false>    Dry-run mode'))
    process.exit(1)
  }

  if (engine === 'sequence' && (!product || !description)) {
    console.error(c.red('Sequence campaigns require --product and --description'))
    process.exit(1)
  }

  const body: Record<string, unknown> = {
    name,
    engine,
    physical_address: address,
  }

  if (product) body.product_name = product
  if (description) body.product_description = description
  if (productUrl) body.product_url = productUrl
  if (conversionUrl) body.conversion_url = conversionUrl
  if (dryRun) body.dry_run = true

  const api = new ApiClient()
  const result = await api.post('/api/campaign/create', body)

  console.log(c.green(`Campaign created: ${result.id}`))
  console.log(`  Engine: ${result.engine}`)
  if (result.webhook_secret) {
    console.log(`  Webhook secret: ${result.webhook_secret}`)
  }
}

export async function campaignList(): Promise<void> {
  const api = new ApiClient()
  const result = await api.get('/api/campaign/list')
  const campaigns = result.campaigns || []

  if (campaigns.length === 0) {
    console.log(c.dim('No campaigns found.'))
    return
  }

  const headers = ['ID', 'NAME', 'ENGINE', 'STATUS', 'CONTACTS', 'SENT', 'REPLIED', 'CONVERTED']
  const rows = campaigns.map((cam: any) => [
    cam.id.slice(0, 8),
    cam.name,
    cam.engine === 'agent' ? c.cyan('agent') : c.dim('sequence'),
    colorStatus(cam.status),
    String(cam.total_contacts || 0),
    String(cam.sent_count || 0),
    String(cam.reply_count || 0),
    String(cam.converted_count || 0),
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
    'pending', 'active', 'queued', 'sent', 'replied', 'interested',
    'converted', 'stopped', 'not_now', 'not_interested',
    'bounced', 'unsubscribed', 'wrong_person', 'do_not_contact',
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

  // Step stats (v1 sequence only)
  if (stats.steps?.length > 0) {
    console.log()
    console.log(c.bold('Steps:'))
    for (const step of stats.steps) {
      console.log(`  Step ${step.step_number}: ${c.green(`${step.sent} sent`)} | ${c.yellow(`${step.pending} pending`)}`)
    }
  }
}

export async function campaignEvents(args: string[]): Promise<void> {
  const id = args[0]
  if (!id) {
    console.error(c.red('Usage: mails-gtm campaign events <campaign-id> [--contact <contact-id>]'))
    process.exit(1)
  }

  const flags = parseFlags(args.slice(1))
  const contactId = flags['contact'] || ''
  let path = `/api/campaign/${id}/events?limit=30`
  if (contactId) path += `&contact_id=${encodeURIComponent(contactId)}`

  const api = new ApiClient()
  const result = await api.get(path)
  const events = result.events || []

  if (events.length === 0) {
    console.log(c.dim('No events found.'))
    return
  }

  const headers = ['TIME', 'TYPE', 'CONTACT', 'DATA']
  const rows = events.map((e: any) => [
    e.created_at?.slice(0, 19) || '',
    colorEventType(e.event_type),
    e.contact_id?.slice(0, 8) || '',
    truncate(e.event_data || '{}', 50),
  ])

  console.log(table(headers, rows))
}

export async function campaignDecisions(args: string[]): Promise<void> {
  const id = args[0]
  if (!id) {
    console.error(c.red('Usage: mails-gtm campaign decisions <campaign-id> [--contact <contact-id>]'))
    process.exit(1)
  }

  const flags = parseFlags(args.slice(1))
  const contactId = flags['contact'] || ''
  let path = `/api/campaign/${id}/decisions?limit=30`
  if (contactId) path += `&contact_id=${encodeURIComponent(contactId)}`

  const api = new ApiClient()
  const result = await api.get(path)
  const decisions = result.decisions || []

  if (decisions.length === 0) {
    console.log(c.dim('No decisions found.'))
    return
  }

  const headers = ['TIME', 'ACTION', 'CONTACT', 'ANGLE', 'SUBJECT', 'REASONING']
  const rows = decisions.map((d: any) => [
    d.created_at?.slice(0, 19) || '',
    colorAction(d.action),
    d.contact_id?.slice(0, 8) || '',
    d.email_angle || c.dim('-'),
    d.email_subject ? truncate(d.email_subject, 30) : c.dim('-'),
    truncate(d.reasoning || '', 40),
  ])

  console.log(table(headers, rows))
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

function colorEventType(type: string): string {
  switch (type) {
    case 'email_sent': return c.green(type)
    case 'link_click': return c.cyan(type)
    case 'reply': return c.yellow(type)
    case 'signup': return c.green(type)
    case 'payment': return c.green(type)
    default: return type
  }
}

function colorAction(action: string): string {
  switch (action) {
    case 'send': return c.green(action)
    case 'wait': return c.yellow(action)
    case 'stop': return c.red(action)
    default: return action
  }
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
