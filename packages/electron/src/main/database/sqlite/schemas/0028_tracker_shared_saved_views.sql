-- Team-shared tracker saved views.
--
-- Mirrors tracker_type_navigation: one collapsed row per view, carrying its own
-- monotonic `sync_id` cursor from the saved-view lane on the tracker room.
-- Local-only views are NOT stored here -- they stay in workspace settings; a row
-- exists only once a view has been shared with the team.
CREATE TABLE IF NOT EXISTS tracker_shared_saved_views (
  workspace   TEXT NOT NULL,
  view_id     TEXT NOT NULL,
  payload     TEXT NOT NULL,
  updated     TEXT NOT NULL,
  deleted_at  TEXT,
  sync_id     INTEGER,
  sync_status TEXT NOT NULL DEFAULT 'local',
  PRIMARY KEY (workspace, view_id)
);

CREATE INDEX IF NOT EXISTS idx_tracker_shared_saved_views_sync
  ON tracker_shared_saved_views (workspace, sync_status);

CREATE INDEX IF NOT EXISTS idx_tracker_shared_saved_views_cursor
  ON tracker_shared_saved_views (workspace, sync_id);
