-- v2.3: Scheduled auto-replies for human-like delay (2-8 hours)
CREATE TABLE IF NOT EXISTS scheduled_replies (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  campaign_id TEXT NOT NULL,
  contact_id TEXT NOT NULL,
  reply_body TEXT NOT NULL,
  reply_subject TEXT NOT NULL,
  original_msg_id TEXT,
  original_subject TEXT,
  send_at TEXT NOT NULL,
  sent INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_scheduled_replies_send ON scheduled_replies(sent, send_at);

-- Add sender_name to campaigns for personal persona signatures
ALTER TABLE campaigns ADD COLUMN sender_name TEXT;
