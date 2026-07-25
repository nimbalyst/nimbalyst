-- Historical tool-usage backfill state. The cutoff is captured when this
-- schema first lands so backfill never overlaps tool calls recorded live by
-- the new write path. Per-session markers make retries idempotent and allow a
-- partially completed backfill to resume safely.

CREATE TABLE IF NOT EXISTS tool_usage_backfill_meta (
  singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
  cutoff_at TIMESTAMPTZ NOT NULL
);

INSERT INTO tool_usage_backfill_meta (singleton, cutoff_at)
VALUES (1, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
ON CONFLICT (singleton) DO NOTHING;

CREATE TABLE IF NOT EXISTS tool_usage_backfill_sessions (
  session_id TEXT PRIMARY KEY,
  backfilled_at TIMESTAMPTZ NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
