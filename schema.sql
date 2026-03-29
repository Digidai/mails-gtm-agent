-- mails-gtm-agent D1 Schema

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
    'pending', 'queued', 'sent', 'replied',
    'interested', 'not_now', 'not_interested',
    'wrong_person', 'unsubscribed', 'bounced', 'do_not_contact'
  )),
  current_step INTEGER NOT NULL DEFAULT 0,
  next_send_at TEXT,
  last_sent_at TEXT,
  sent_message_id TEXT,
  resume_at TEXT, -- for not_now contacts
  reply_intent TEXT,
  reply_confidence REAL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(campaign_id, email)
);

CREATE INDEX IF NOT EXISTS idx_contacts_campaign_status ON campaign_contacts(campaign_id, status);
CREATE INDEX IF NOT EXISTS idx_contacts_next_send ON campaign_contacts(status, next_send_at);
CREATE INDEX IF NOT EXISTS idx_contacts_email ON campaign_contacts(email);

CREATE TABLE IF NOT EXISTS unsubscribes (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  email TEXT NOT NULL,
  campaign_id TEXT,
  reason TEXT,
  unsubscribed_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(email, campaign_id)
);

CREATE INDEX IF NOT EXISTS idx_unsubscribes_email ON unsubscribes(email);

CREATE TABLE IF NOT EXISTS send_log (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  campaign_id TEXT NOT NULL,
  contact_id TEXT NOT NULL,
  step_number INTEGER NOT NULL,
  subject TEXT,
  body TEXT,
  message_id TEXT,
  status TEXT NOT NULL DEFAULT 'sent' CHECK (status IN ('sent', 'failed', 'bounced')),
  error TEXT,
  sent_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_send_log_campaign ON send_log(campaign_id, sent_at);
CREATE INDEX IF NOT EXISTS idx_send_log_message_id ON send_log(message_id);

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
