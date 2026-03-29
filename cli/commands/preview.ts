import { ApiClient } from '../api'
import { c } from '../format'

export async function previewCommand(args: string[]): Promise<void> {
  const id = args[0]
  if (!id) {
    console.error(c.red('Usage: mails-gtm preview <campaign-id> [--count <n>]'))
    process.exit(1)
  }

  const flags = parseFlags(args.slice(1))
  const count = parseInt(flags['count'] || '3', 10)

  const api = new ApiClient()
  const result = await api.post(`/api/campaign/${id}/preview`, { count })
  const previews = result.previews || []

  if (previews.length === 0) {
    console.log(c.dim('No previews generated. Are there pending contacts?'))
    return
  }

  for (let i = 0; i < previews.length; i++) {
    const p = previews[i]
    const contactInfo = [
      p.contact.email,
      p.contact.name ? `${p.contact.name}` : null,
      p.contact.role ? `${p.contact.role}` : null,
      p.contact.company ? `at ${p.contact.company}` : null,
    ].filter(Boolean).join(', ')

    console.log(c.bold(`Preview ${i + 1}/${previews.length}: ${contactInfo}`))
    console.log(`  ${c.cyan('Subject:')} ${p.generated.subject}`)
    console.log(`  ${c.cyan('Body:')} ${p.generated.body}`)
    console.log('  ---')
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
