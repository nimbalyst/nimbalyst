-- Local observer diagnostics survive backend migration and session restarts.
CREATE TABLE IF NOT EXISTS shell_tracking_coverage (
  session_id TEXT PRIMARY KEY REFERENCES ai_sessions(id) ON DELETE CASCADE,
  data TEXT NOT NULL
);
