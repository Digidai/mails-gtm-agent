-- Fix #2: Atomic dedup for reply processing
-- processed_messages table ensures each inbound email is only processed once

CREATE TABLE IF NOT EXISTS processed_messages (
  msg_id TEXT PRIMARY KEY,
  contact_id TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
