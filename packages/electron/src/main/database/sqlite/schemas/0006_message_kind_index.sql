-- ----------------------------------------------------------------------------
-- 0006_message_kind_index
--
-- Adds a partial index supporting the cross-session "list all user prompts"
-- query that powers the Quick Open dialog (transcript:list-user-prompts):
--
--   SELECT ... FROM ai_agent_messages t JOIN ai_sessions s ...
--   WHERE t.message_kind = 'user'
--     AND t.searchable_text IS NOT NULL
--     AND s.workspace_id = $1
--   ORDER BY t.created_at DESC
--   LIMIT $2
--
-- Without an index on message_kind this scans the whole table. Observed:
-- 1.36M rows, 94 'user' matches, 12-second cold-cache wall time, head-of-
-- line-blocking sessions:list and tracker-items-list behind it.
--
-- Partial WHERE clause: 99.7% of historical rows have message_kind NULL
-- (the backfill is still incomplete on existing databases). The partial
-- predicate `searchable_text IS NOT NULL` keeps the index tiny -- only
-- the rows the query actually returns end up in it.
-- ----------------------------------------------------------------------------

CREATE INDEX IF NOT EXISTS idx_ai_agent_messages_user_prompts
  ON ai_agent_messages(message_kind, created_at DESC)
  WHERE searchable_text IS NOT NULL;
