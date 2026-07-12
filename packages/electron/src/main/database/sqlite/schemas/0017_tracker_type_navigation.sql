CREATE TABLE IF NOT EXISTS tracker_type_navigation (
  workspace   TEXT NOT NULL,
  entry_id    TEXT NOT NULL,
  kind        TEXT NOT NULL,
  payload     TEXT NOT NULL,
  updated     TEXT NOT NULL,
  deleted_at  TEXT,
  sync_id     INTEGER,
  sync_status TEXT NOT NULL DEFAULT 'local',
  PRIMARY KEY (workspace, entry_id)
);

CREATE INDEX IF NOT EXISTS idx_tracker_type_navigation_sync
  ON tracker_type_navigation (workspace, sync_status);

CREATE INDEX IF NOT EXISTS idx_tracker_type_navigation_cursor
  ON tracker_type_navigation (workspace, sync_id);
