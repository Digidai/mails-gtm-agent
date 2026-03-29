import { loadConfig, saveConfig, getConfigPath } from '../config'
import { c } from '../format'

export async function configSet(args: string[]): Promise<void> {
  const key = args[0]
  const value = args[1]

  if (!key || value === undefined) {
    console.error(c.red('Usage: mails-gtm config set <key> <value>'))
    console.error(c.dim('  Keys: api_url, api_token'))
    process.exit(1)
  }

  const validKeys = ['api_url', 'api_token']
  if (!validKeys.includes(key)) {
    console.error(c.red(`Unknown config key: ${key}. Valid keys: ${validKeys.join(', ')}`))
    process.exit(1)
  }

  const config = loadConfig()
  ;(config as any)[key] = value
  saveConfig(config)

  const displayValue = key === 'api_token' ? maskToken(value) : value
  console.log(c.green(`Set ${key} = ${displayValue}`))
}

export async function configShow(): Promise<void> {
  const config = loadConfig()
  const configPath = getConfigPath()

  console.log(c.bold(`Config file: ${configPath}`))
  console.log(`  api_url:   ${config.api_url || c.dim('(not set)')}`)
  console.log(`  api_token: ${config.api_token ? maskToken(config.api_token) : c.dim('(not set)')}`)
}

function maskToken(token: string): string {
  if (token.length <= 8) return '****'
  return token.slice(0, 4) + '****' + token.slice(-4)
}
