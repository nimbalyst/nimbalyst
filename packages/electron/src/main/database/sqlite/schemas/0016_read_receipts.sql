-- Unread indicators for trackers and collaborative docs.
--
-- A read receipt records that a user has viewed a given entity (a tracker item
-- or a shared doc) up to a certain version at a certain time. The "unread"
-- decision compares an entity's current version / last-change author against
-- the user's receipt (see packages/runtime/src/readReceipts/readReceipts.ts).
--
-- Personal, not team: receipts are personal per-user state ABOUT team objects.
-- They are NOT stored on any tracker/document row (keeps the synced tracker
-- payload clean) and they sync on the PERSONAL channel, never the team rooms.
--
-- Backend divergence: this is the SQLite schema. The PGLite equivalent lives in
-- worker.js createSchemas() (BIGINT instead of INTEGER for the epoch/version
-- columns).
--
--   user_email        current identity; '' for single-user / no-identity
--   entity_kind       'tracker' | 'doc' (extensible)
--   entity_id         tracker item id | documentId
--   scope             workspace path (trackers) | org_id (docs)
--   last_viewed_at    epoch ms
--   last_seen_version tracker sync_id | doc sequence (nullable)
--   updated_at        epoch ms; receipt row's own last-write time

CREATE TABLE IF NOT EXISTS read_receipts (
  user_email        TEXT NOT NULL,
  entity_kind       TEXT NOT NULL,
  entity_id         TEXT NOT NULL,
  scope             TEXT NOT NULL,
  last_viewed_at    INTEGER NOT NULL,
  last_seen_version INTEGER,
  updated_at        INTEGER NOT NULL,
  PRIMARY KEY (user_email, entity_kind, entity_id, scope)
);

CREATE INDEX IF NOT EXISTS idx_read_receipts_lookup
  ON read_receipts (user_email, entity_kind, scope);
