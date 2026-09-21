-- Nonunique: historical sessions may share a resume handle. Lookup rejects ambiguity.
CREATE INDEX IF NOT EXISTS idx_ai_sessions_provider_session
  ON ai_sessions (provider, provider_session_id, workspace_id);
CREATE INDEX IF NOT EXISTS idx_ai_agent_messages_provider_identity
  ON ai_agent_messages (session_id, source, direction, provider_message_id)
  WHERE provider_message_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS external_session_cursors (
  provider TEXT NOT NULL,
  external_id TEXT NOT NULL,
  file_path TEXT NOT NULL,
  workspace_path TEXT NOT NULL,
  session_id TEXT NOT NULL REFERENCES ai_sessions(id) ON DELETE CASCADE,
  cursor TEXT,
  PRIMARY KEY (provider, external_id, file_path)
);
CREATE INDEX IF NOT EXISTS idx_external_session_cursors_session
  ON external_session_cursors (session_id);
