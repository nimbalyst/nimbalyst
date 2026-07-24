-- Identity-scoped personal state about tracker items. This data is local-first
-- and mirrors only over the personal sync lane; it never belongs on team rows.
-- False favorites remain as tombstones so a later unstar wins cross-device.

CREATE TABLE IF NOT EXISTS tracker_personal_state (
  user_email          TEXT NOT NULL,
  scope               TEXT NOT NULL,
  item_id             TEXT NOT NULL,
  is_favorite         INTEGER NOT NULL DEFAULT 0,
  favorite_updated_at INTEGER NOT NULL DEFAULT 0,
  last_opened_at      INTEGER,
  updated_at          INTEGER NOT NULL,
  PRIMARY KEY (user_email, scope, item_id)
);

CREATE INDEX IF NOT EXISTS idx_tracker_personal_state_scope
  ON tracker_personal_state (user_email, scope);
