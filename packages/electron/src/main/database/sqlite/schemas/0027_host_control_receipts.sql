-- Durable non-queue idempotency receipts for host control mutations.
CREATE TABLE IF NOT EXISTS host_control_receipts (
  id TEXT PRIMARY KEY,
  reservation_key TEXT NOT NULL UNIQUE,
  request_digest TEXT NOT NULL,
  operation TEXT NOT NULL CHECK (operation = 'inject_attention_reply'),
  session_id TEXT NOT NULL,
  event_identity TEXT NOT NULL,
  attention_generation TEXT,
  state TEXT NOT NULL CHECK (state IN ('reserved', 'injected', 'already_resolved', 'failed')),
  receipt TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE INDEX IF NOT EXISTS idx_host_control_receipts_session
  ON host_control_receipts(session_id, created_at);

-- Product-side outbox for the configured workspace companion. This is kept
-- separate from the Jean receipt ledger because pending/sent notification
-- delivery is retryable, while an attention answer must never be attempted
-- twice.
CREATE TABLE IF NOT EXISTS native_winner_outbox (
  id TEXT PRIMARY KEY,
  reservation_key TEXT NOT NULL UNIQUE,
  session_id TEXT NOT NULL,
  event_identity TEXT NOT NULL,
  attention_generation TEXT,
  state TEXT NOT NULL DEFAULT 'pending' CHECK (state IN ('pending', 'sent')),
  attempt_count INTEGER NOT NULL DEFAULT 0,
  receipt TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  last_attempt_at TEXT,
  sent_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_native_winner_outbox_pending
  ON native_winner_outbox(created_at, id) WHERE state = 'pending';
