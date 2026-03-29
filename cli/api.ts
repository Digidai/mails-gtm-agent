import { loadConfig } from './config'

export class ApiClient {
  private baseUrl: string
  private token: string

  constructor() {
    const config = loadConfig()
    this.baseUrl = config.api_url.replace(/\/+$/, '')
    this.token = config.api_token

    if (!this.baseUrl) {
      throw new Error('API URL not configured. Run: mails-gtm config set api_url <url>')
    }
    if (!this.token) {
      throw new Error('API token not configured. Run: mails-gtm config set api_token <token>')
    }
  }

  private async request(method: string, path: string, body?: unknown): Promise<any> {
    const url = `${this.baseUrl}${path}`
    const headers: Record<string, string> = {
      'Authorization': `Bearer ${this.token}`,
      'Content-Type': 'application/json',
    }

    const res = await fetch(url, {
      method,
      headers,
      body: body ? JSON.stringify(body) : undefined,
    })

    const text = await res.text()
    let data: any
    try {
      data = JSON.parse(text)
    } catch {
      data = { raw: text }
    }

    if (!res.ok) {
      const msg = data?.error || data?.raw || `HTTP ${res.status}`
      throw new Error(msg)
    }

    return data
  }

  get(path: string) { return this.request('GET', path) }
  post(path: string, body?: unknown) { return this.request('POST', path, body) }
  put(path: string, body?: unknown) { return this.request('PUT', path, body) }
  delete(path: string) { return this.request('DELETE', path) }

  /** Upload CSV as raw text body */
  async uploadCsv(campaignId: string, csvText: string): Promise<any> {
    return this.post('/api/contacts/import', {
      campaign_id: campaignId,
      csv: csvText,
    })
  }
}
