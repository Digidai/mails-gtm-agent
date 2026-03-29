import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs'
import { join } from 'path'
import { homedir } from 'os'

const CONFIG_DIR = join(homedir(), '.mails-gtm')
const CONFIG_FILE = join(CONFIG_DIR, 'config.json')

export interface Config {
  api_url: string
  api_token: string
}

const DEFAULT_CONFIG: Config = {
  api_url: '',
  api_token: '',
}

export function loadConfig(): Config {
  try {
    if (existsSync(CONFIG_FILE)) {
      const raw = readFileSync(CONFIG_FILE, 'utf-8')
      return { ...DEFAULT_CONFIG, ...JSON.parse(raw) }
    }
  } catch {
    // ignore parse errors, return default
  }
  return { ...DEFAULT_CONFIG }
}

export function saveConfig(config: Config): void {
  if (!existsSync(CONFIG_DIR)) {
    mkdirSync(CONFIG_DIR, { recursive: true })
  }
  writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2) + '\n', 'utf-8')
}

export function getConfigPath(): string {
  return CONFIG_FILE
}
