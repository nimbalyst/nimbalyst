-- Participant-filtered, workspace-local projection of the org feedback index.
-- Rich asks and responses remain exclusively in feedback_request_cache and the
-- request room; this row stores only FeedbackRequestIndexEntry JSON.

CREATE TABLE IF NOT EXISTS feedback_request_index (
  workspace_path TEXT NOT NULL,
  org_id         TEXT NOT NULL,
  viewer_user_id TEXT NOT NULL,
  request_id     TEXT NOT NULL,
  data           TEXT NOT NULL,
  created_at     TIMESTAMPTZ NOT NULL,
  updated_at     TIMESTAMPTZ NOT NULL,
  closed_at      TIMESTAMPTZ,
  snapshot_id    TEXT,
  PRIMARY KEY (workspace_path, org_id, viewer_user_id, request_id)
);

CREATE INDEX IF NOT EXISTS idx_feedback_request_index_org
  ON feedback_request_index
    (workspace_path, org_id, viewer_user_id, updated_at);

-- One durable cursor per viewing identity. cutoff_at freezes the legacy cache
-- rows belonging to the one-time pass; requests cached later already self-
-- register through the current server path.
CREATE TABLE IF NOT EXISTS feedback_request_index_backfill (
  workspace_path    TEXT NOT NULL,
  org_id            TEXT NOT NULL,
  viewer_user_id    TEXT NOT NULL,
  cutoff_at         TIMESTAMPTZ NOT NULL,
  cursor_request_id TEXT,
  completed_at      TIMESTAMPTZ,
  PRIMARY KEY (workspace_path, org_id, viewer_user_id)
);
