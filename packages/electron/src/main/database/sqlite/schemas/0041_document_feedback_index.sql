CREATE TABLE IF NOT EXISTS document_feedback_index_cache (
  workspace_path TEXT NOT NULL,
  org_id TEXT NOT NULL,
  viewer_user_id TEXT NOT NULL,
  data TEXT NOT NULL,
  PRIMARY KEY (workspace_path, org_id, viewer_user_id)
);
