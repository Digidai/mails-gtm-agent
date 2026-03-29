#!/usr/bin/env bun

import {
  campaignCreate, campaignList, campaignStats, campaignStart, campaignPause,
  campaignEvents, campaignDecisions,
} from './commands/campaign'
import { stepsSet, stepsList } from './commands/steps'
import { contactsImport, contactsList } from './commands/contacts'
import { previewCommand } from './commands/preview'
import { configSet, configShow } from './commands/config-cmd'
import { c } from './format'

const USAGE = `${c.bold('mails-gtm')} - PLG Conversion Agent CLI (v2)

${c.bold('Campaign:')}
  campaign create --name <n> [--product-url <url>] [--conversion-url <url>] [--engine agent|sequence]
  campaign list
  campaign stats <campaign-id>
  campaign start <campaign-id>
  campaign pause <campaign-id>
  campaign events <campaign-id> [--contact <id>]
  campaign decisions <campaign-id> [--contact <id>]

${c.bold('Steps (sequence engine):')}
  steps set <campaign-id> --file <steps.json>
  steps list <campaign-id>

${c.bold('Contacts:')}
  contacts import <campaign-id> --csv <file.csv>
  contacts list <campaign-id> [--status <status>] [--limit <n>]

${c.bold('Preview:')}
  preview <campaign-id> [--count <n>]

${c.bold('Config:')}
  config set <key> <value>
  config show
`

async function main() {
  const args = process.argv.slice(2)

  if (args.length === 0 || args[0] === '--help' || args[0] === '-h') {
    console.log(USAGE)
    process.exit(0)
  }

  const group = args[0]
  const action = args[1]
  const rest = args.slice(2)

  try {
    switch (group) {
      case 'campaign':
        switch (action) {
          case 'create': return await campaignCreate(rest)
          case 'list': return await campaignList()
          case 'stats': return await campaignStats(rest)
          case 'start': return await campaignStart(rest)
          case 'pause': return await campaignPause(rest)
          case 'events': return await campaignEvents(rest)
          case 'decisions': return await campaignDecisions(rest)
          default:
            console.error(c.red(`Unknown campaign command: ${action}`))
            process.exit(1)
        }
        break

      case 'steps':
        switch (action) {
          case 'set': return await stepsSet(rest)
          case 'list': return await stepsList(rest)
          default:
            console.error(c.red(`Unknown steps command: ${action}`))
            process.exit(1)
        }
        break

      case 'contacts':
        switch (action) {
          case 'import': return await contactsImport(rest)
          case 'list': return await contactsList(rest)
          default:
            console.error(c.red(`Unknown contacts command: ${action}`))
            process.exit(1)
        }
        break

      case 'preview':
        // "preview" is the group AND the action; the action arg is actually the campaign id
        return await previewCommand([action, ...rest])

      case 'config':
        switch (action) {
          case 'set': return await configSet(rest)
          case 'show': return await configShow()
          default:
            console.error(c.red(`Unknown config command: ${action}`))
            process.exit(1)
        }
        break

      default:
        console.error(c.red(`Unknown command: ${group}`))
        console.log(USAGE)
        process.exit(1)
    }
  } catch (err: any) {
    console.error(c.red(`Error: ${err.message}`))
    process.exit(1)
  }
}

main()
