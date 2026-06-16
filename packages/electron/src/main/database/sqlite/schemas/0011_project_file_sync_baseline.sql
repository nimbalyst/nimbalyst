-- 0011_project_file_sync_baseline
--
-- Durable last-synced baseline (content hash + mtime) for personal docs sync
-- (System A). Lets the write-time conflict guard detect locally-diverged files
-- across an app restart, so an older server snapshot can never clobber newer
-- local content (NIM-853, Layer 3).

CREATE TABLE IF NOT EXISTS project_file_sync_baseline (
  project_id TEXT NOT NULL,
  sync_id TEXT NOT NULL,
  content_hash TEXT NOT NULL,
  last_synced_mtime INTEGER NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (project_id, sync_id)
);
