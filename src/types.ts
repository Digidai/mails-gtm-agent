export interface Env {
  DB: D1Database
  SEND_QUEUE: Queue
  EVALUATE_QUEUE: Queue
  MAILS_WORKER?: Fetcher      // Service binding to mails-worker (avoids error 1042)
  OPENROUTER_API_KEY: string
  LLM_MODEL?: string          // default: 'anthropic/claude-sonnet-4'
  MAILS_API_URL: string       // fallback: https://mails-worker.genedai.workers.dev
  MAILS_API_KEY: string
  MAILS_MAILBOX: string       // sender email
  ADMIN_TOKEN: string         // API auth token
  WEBHOOK_SECRET?: string     // HMAC secret for inbound email webhooks from mails-agent
  UNSUBSCRIBE_SECRET: string  // HMAC secret for unsubscribe tokens (must differ from ADMIN_TOKEN)
  UNSUBSCRIBE_BASE_URL: string // default: https://mails-gtm-agent.YOUR.workers.dev
  DAILY_SEND_LIMIT: string    // default: "100"
  MAX_CSV_SIZE: string        // default: "5242880" (5MB)
  MAX_CONTACTS_PER_IMPORT?: string  // default: "10000"
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

  // v2 fields
  engine: 'sequence' | 'agent'
  product_url: string | null
  conversion_url: string | null
  knowledge_base: string // JSON
  knowledge_base_status: 'pending' | 'manual' | 'generating' | 'ready' | 'failed'
  max_emails: number
  min_interval_days: number
  webhook_secret: string | null
  webhook_callback_url?: string | null
  dry_run: number
  daily_llm_calls: number
  daily_llm_limit: number
  daily_llm_reset_at: string | null

  // v2.1 fields
  max_auto_replies: number

  // v2.3 fields
  sender_name: string | null

  created_at: string
  updated_at: string
}

export interface CampaignStep {
  step_number?: number
  delay_days: number
  subject_template: string
  body_template: string
  ai_generate?: boolean
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

  // v2 fields
  emails_sent: number
  last_click_at: string | null
  converted_at: string | null
  conversion_type: string | null
  next_check_at: string | null
  last_enqueued_at: string | null

  // v2.1 fields
  auto_reply_count: number

  created_at: string
  updated_at: string
}

// v1 send queue message (engine=sequence)
export interface SendMessage {
  contact_id: string
  campaign_id: string
  step_number: number
}

// v2 send queue message (engine=agent)
export interface AgentSendMessage {
  type: 'agent_send'
  campaign_id: string
  contact_id: string
  mailbox: string
  to: string
  subject: string
  body: string
  htmlBody?: string  // HTML version with tracked links as <a> tags
  angle: string
  decision_id: string
}

// v2 evaluate queue message
export interface EvaluateMessage {
  type: 'evaluate'
  campaign_id: string
  contact_id: string
  enqueued_at: string
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

// v2.1 types — Conversational AI SDR

export interface ConversationMessage {
  role: 'agent' | 'contact'
  content: string
  subject?: string
  created_at: string
}

// v2 types

export type ContactStatus =
  | 'pending'
  | 'active'
  | 'interested'
  | 'converted'
  | 'stopped'
  | 'unsubscribed'
  | 'bounced'

export interface KnowledgeBase {
  product_name?: string
  tagline?: string
  description?: string
  features?: string[]
  pricing?: string
  competitors?: string[]
  use_cases?: string[]
  install_command?: string | null
  quick_start?: string
  quick_start_steps?: string[]
  faq?: Array<{ q: string; a: string }>
  testimonials?: string[]
  conversion_url?: string
  docs_url?: string
}

export interface AgentDecision {
  action: 'send' | 'wait' | 'stop'
  reasoning: string
  email?: {
    angle: string
    subject: string
    body: string
  }
  wait_days?: number
}

export interface Event {
  id: string
  campaign_id: string
  contact_id: string
  event_type: string
  event_data: string // JSON
  created_at: string
}

export interface DecisionLogEntry {
  id: string
  campaign_id: string
  contact_id: string
  action: string
  reasoning: string | null
  email_angle: string | null
  email_subject: string | null
  created_at: string
}
