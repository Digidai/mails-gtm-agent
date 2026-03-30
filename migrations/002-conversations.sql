-- v2.1: Conversational AI SDR
-- Adds conversations table for multi-turn email dialogue tracking

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

-- campaign_contacts: track auto-reply count
ALTER TABLE campaign_contacts ADD COLUMN auto_reply_count INTEGER DEFAULT 0;

-- campaigns: configurable max auto-replies per contact
ALTER TABLE campaigns ADD COLUMN max_auto_replies INTEGER DEFAULT 5;
