import { readFileSync } from 'fs'
import { ApiClient } from '../api'
import { c, table } from '../format'

export async function contactsImport(args: string[]): Promise<void> {
  const id = args[0]
  if (!id) {
    console.error(c.red('Usage: mails-gtm contacts import <campaign-id> --csv <file.csv>'))
    process.exit(1)
  }

  const flags = parseFlags(args.slice(1))
  const csvPath = flags['csv']
  if (!csvPath) {
    console.error(c.red('Missing --csv flag'))
    process.exit(1)
  }

  let csvText: string
  try {
    csvText = readFileSync(csvPath, 'utf-8')
  } catch (err: any) {
    console.error(c.red(`Failed to read ${csvPath}: ${err.message}`))
    process.exit(1)
  }

  const api = new ApiClient()
  const result = await api.uploadCsv(id, csvText)

  console.log(c.green(`Imported ${result.imported} contacts`))
  if (result.duplicates > 0) {
    console.log(c.yellow(`  Duplicates skipped: ${result.duplicates}`))
  }
  if (result.skipped_unsubscribed > 0) {
    console.log(c.yellow(`  Unsubscribed skipped: ${result.skipped_unsubscribed}`))
  }
  if (result.errors?.length > 0) {
    for (const err of result.errors) {
      console.log(c.red(`  Error: ${err}`))
    }
  }
}

export async function contactsList(args: string[]): Promise<void> {
  const id = args[0]
  if (!id) {
    console.error(c.red('Usage: mails-gtm contacts list <campaign-id> [--status <status>] [--limit <n>]'))
    process.exit(1)
  }

  const flags = parseFlags(args.slice(1))
  const status = flags['status'] || ''
  const limit = flags['limit'] || '20'

  let path = `/api/contacts/list?campaign_id=${encodeURIComponent(id)}&limit=${encodeURIComponent(limit)}`
  if (status) {
    path += `&status=${encodeURIComponent(status)}`
  }

  const api = new ApiClient()
  const result = await api.get(path)
  const contacts = result.contacts || []

  if (contacts.length === 0) {
    console.log(c.dim('No contacts found.'))
    return
  }

  const headers = ['EMAIL', 'NAME', 'COMPANY', 'STATUS', 'STEP']
  const rows = contacts.map((con: any) => [
    con.email,
    con.name || c.dim('-'),
    con.company || c.dim('-'),
    colorContactStatus(con.status),
    String(con.current_step),
  ])

  console.log(table(headers, rows))
  console.log(c.dim(`\nShowing ${contacts.length} of ${result.total} total`))
}

function colorContactStatus(status: string): string {
  switch (status) {
    case 'pending': return c.dim(status)
    case 'queued': return c.yellow(status)
    case 'sent': return c.green(status)
    case 'replied': return c.cyan(status)
    case 'interested': return c.green(status)
    case 'bounced': return c.red(status)
    case 'unsubscribed': return c.red(status)
    case 'do_not_contact': return c.red(status)
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
