-- mails-gtm-agent D1 Schema (v2 — PLG Conversion Agent)

CREATE TABLE IF NOT EXISTS campaigns (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  name TEXT NOT NULL,
  product_name TEXT NOT NULL,
  product_description TEXT NOT NULL,
  from_email TEXT NOT NULL,
  physical_address TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'active', 'paused', 'completed')),
  ai_generate INTEGER NOT NULL DEFAULT 1,
  warmup_enabled INTEGER NOT NULL DEFAULT 1,
  warmup_start_volume INTEGER NOT NULL DEFAULT 10,
  warmup_increment INTEGER NOT NULL DEFAULT 5,
  warmup_started_at TEXT,
  steps TEXT NOT NULL DEFAULT '[]', -- JSON array of { delay_days, subject_template, body_template }
  last_inbox_check_at TEXT,

  -- v2 fields
  engine TEXT NOT NULL DEFAULT 'agent' CHECK (engine IN ('sequence', 'agent')),
  product_url TEXT,
  conversion_url TEXT,
  knowledge_base TEXT DEFAULT '{}',
  knowledge_base_status TEXT DEFAULT 'pending' CHECK (knowledge_base_status IN ('pending', 'manual', 'generating', 'ready', 'failed')),
  max_emails INTEGER NOT NULL DEFAULT 6,
  min_interval_days INTEGER NOT NULL DEFAULT 2,
  webhook_secret TEXT,
  dry_run INTEGER NOT NULL DEFAULT 0,
  daily_llm_calls INTEGER NOT NULL DEFAULT 0,
  daily_llm_limit INTEGER NOT NULL DEFAULT 100,
  daily_llm_reset_at TEXT,
  max_auto_replies INTEGER NOT NULL DEFAULT 5,

  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS campaign_contacts (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  campaign_id TEXT NOT NULL REFERENCES campaigns(id),
  email TEXT NOT NULL,
  name TEXT,
  company TEXT,
  role TEXT,
  custom_fields TEXT DEFAULT '{}', -- JSON
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN (
    'pending', 'active', 'interested', 'converted', 'stopped',
    'unsubscribed', 'bounced', 'error',
    -- v1 compat statuses
    'queued', 'sent', 'replied',
    'not_now', 'not_interested',
    'wrong_person', 'do_not_contact'
  )),
  current_step INTEGER NOT NULL DEFAULT 0,
  next_send_at TEXT,
  last_sent_at TEXT,
  sent_message_id TEXT,
  resume_at TEXT, -- for not_now contacts
  reply_intent TEXT,
  reply_confidence REAL,

  -- v2 fields
  emails_sent INTEGER NOT NULL DEFAULT 0,
  last_click_at TEXT,
  converted_at TEXT,
  conversion_type TEXT, -- signup / payment / null
  next_check_at TEXT,
  last_enqueued_at TEXT, -- dedup guard
  auto_reply_count INTEGER NOT NULL DEFAULT 0,

  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(campaign_id, email)
);

CREATE INDEX IF NOT EXISTS idx_contacts_campaign_status ON campaign_contacts(campaign_id, status);
CREATE INDEX IF NOT EXISTS idx_contacts_next_send ON campaign_contacts(status, next_send_at);
CREATE INDEX IF NOT EXISTS idx_contacts_email ON campaign_contacts(email);
CREATE INDEX IF NOT EXISTS idx_contacts_next_check ON campaign_contacts(campaign_id, next_check_at);

CREATE TABLE IF NOT EXISTS unsubscribes (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  email TEXT NOT NULL,
  campaign_id TEXT,
  reason TEXT,
  unsubscribed_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(email, campaign_id)
);

CREATE INDEX IF NOT EXISTS idx_unsubscribes_email ON unsubscribes(email);
CREATE UNIQUE INDEX IF NOT EXISTS idx_unsubscribes_global ON unsubscribes(email) WHERE campaign_id = '__global__';

CREATE TABLE IF NOT EXISTS send_log (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  campaign_id TEXT NOT NULL,
  contact_id TEXT NOT NULL,
  step_number INTEGER NOT NULL DEFAULT 0,
  subject TEXT,
  body TEXT,
  message_id TEXT,
  decision_id TEXT,
  status TEXT NOT NULL DEFAULT 'sent' CHECK (status IN ('sent', 'failed', 'bounced', 'dry_run')),
  error TEXT,
  sent_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_send_log_campaign ON send_log(campaign_id, sent_at);
CREATE INDEX IF NOT EXISTS idx_send_log_message_id ON send_log(message_id);
CREATE INDEX IF NOT EXISTS idx_send_log_contact_id ON send_log(contact_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_send_log_decision ON send_log(decision_id) WHERE decision_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS daily_stats (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  campaign_id TEXT NOT NULL,
  date TEXT NOT NULL,
  sent_count INTEGER NOT NULL DEFAULT 0,
  reply_count INTEGER NOT NULL DEFAULT 0,
  bounce_count INTEGER NOT NULL DEFAULT 0,
  unsubscribe_count INTEGER NOT NULL DEFAULT 0,
  UNIQUE(campaign_id, date)
);

-- v2 tables

CREATE TABLE IF NOT EXISTS tracked_links (
  id TEXT PRIMARY KEY,
  campaign_id TEXT NOT NULL,
  contact_id TEXT NOT NULL,
  original_url TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_tracked_links_campaign ON tracked_links(campaign_id);
CREATE INDEX IF NOT EXISTS idx_tracked_links_contact ON tracked_links(contact_id);

CREATE TABLE IF NOT EXISTS events (
  id TEXT PRIMARY KEY,
  campaign_id TEXT NOT NULL,
  contact_id TEXT NOT NULL,
  event_type TEXT NOT NULL, -- email_sent / link_click / reply / signup / payment
  event_data TEXT DEFAULT '{}', -- JSON
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_events_contact ON events(contact_id, created_at);
CREATE INDEX IF NOT EXISTS idx_events_campaign ON events(campaign_id, event_type);

CREATE TABLE IF NOT EXISTS decision_log (
  id TEXT PRIMARY KEY,
  campaign_id TEXT NOT NULL,
  contact_id TEXT NOT NULL,
  action TEXT NOT NULL, -- send / wait / stop
  reasoning TEXT,
  email_angle TEXT,
  email_subject TEXT,
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_decision_log_contact ON decision_log(contact_id, created_at);
CREATE INDEX IF NOT EXISTS idx_decision_log_campaign ON decision_log(campaign_id, created_at);

-- v2.1: Conversational AI SDR

CREATE TABLE IF NOT EXISTS conversations (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  campaign_id TEXT NOT NULL,
  contact_id TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('agent', 'contact')),
  content TEXT NOT NULL,
  message_id TEXT,
  subject TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_conv_contact ON conversations(contact_id, created_at);
CREATE INDEX IF NOT EXISTS idx_conv_campaign ON conversations(campaign_id, contact_id);
