export interface Env {
  DB: D1Database
  SEND_QUEUE: Queue
  OPENROUTER_API_KEY: string
  MAILS_API_URL: string       // default: https://mails-worker.genedai.workers.dev
  MAILS_API_KEY: string
  MAILS_MAILBOX: string       // sender email
  ADMIN_TOKEN: string         // API auth token
  UNSUBSCRIBE_BASE_URL: string // default: https://mails-gtm-agent.YOUR.workers.dev
  DAILY_SEND_LIMIT: string    // default: "100"
}

export interface Campaign {
  id: string
  name: string
  product_name: string
  product_description: string
  from_email: string
  physical_address: string
  status: 'draft' | 'active' | 'paused' | 'completed'
  ai_generate: number
  warmup_enabled: number
  warmup_start_volume: number
  warmup_increment: number
  warmup_started_at: string | null
  steps: string // JSON
  last_inbox_check_at: string | null
  created_at: string
  updated_at: string
}

export interface CampaignStep {
  delay_days: number
  subject_template: string
  body_template: string
}

export interface CampaignContact {
  id: string
  campaign_id: string
  email: string
  name: string | null
  company: string | null
  role: string | null
  custom_fields: string // JSON
  status: string
  current_step: number
  next_send_at: string | null
  last_sent_at: string | null
  sent_message_id: string | null
  resume_at: string | null
  reply_intent: string | null
  reply_confidence: number | null
  created_at: string
  updated_at: string
}

export interface SendMessage {
  contact_id: string
  campaign_id: string
  step_number: number
}

export type IntentType =
  | 'interested'
  | 'not_now'
  | 'not_interested'
  | 'wrong_person'
  | 'out_of_office'
  | 'unsubscribe'
  | 'auto_reply'
  | 'do_not_contact'
  | 'unclear'

export interface ClassifyResult {
  intent: IntentType
  confidence: number
  resume_date: string | null
}

export interface GenerateResult {
  subject: string
  body: string
}

export interface ContactImportRow {
  email: string
  name?: string
  company?: string
  role?: string
  [key: string]: string | undefined
}
