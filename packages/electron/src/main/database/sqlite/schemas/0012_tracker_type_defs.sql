-- Tracker type definitions, materialized into the database.
--
-- Custom tracker schemas have historically lived only as YAML files under
-- <workspace>/.nimbalyst/trackers/*.yaml and in the in-memory registry. That
-- makes the files the source of truth, which breaks down in a synced/
-- collaborative world: a peer who never pulled the YAML cannot resolve a custom
-- type's fields. Materializing the loaded models here makes the database the
-- local source of truth and gives offline consumers (the `nim` CLI) the role
-- map needed to write custom-type items correctly. The sync_id / sync_status
-- columns mirror tracker_items so a future change can carry schemas over the
-- collab sync path.
--
-- `model` is stored as JSON TEXT (not JSONB) so it reads identically on both
-- backends: consumers always JSON.parse a string.

CREATE TABLE IF NOT EXISTS tracker_type_defs (
  id          TEXT PRIMARY KEY,          -- `${workspace}::${type}`
  workspace   TEXT NOT NULL,
  type        TEXT NOT NULL,
  model       TEXT NOT NULL,             -- JSON-serialized TrackerDataModel
  source      TEXT,                      -- provenance: 'yaml' | 'cli' | 'sync'
  updated     TEXT NOT NULL,
  deleted_at  TEXT,
  sync_id     INTEGER,
  sync_status TEXT DEFAULT 'local'
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_tracker_type_defs_ws_type
  ON tracker_type_defs (workspace, type);
