-- ----------------------------------------------------------------------------
-- 0053_index_hygiene
--
-- One index added, seven dropped. No row is rewritten or removed.
--
-- Added: idx_ai_agent_messages_latest_assistant_text serves the tray snippet
-- query (tray/sessionSnippets.ts latestAssistantTextSql), which reads MAX(id)
-- per session over assistant rows with text. With only (session_id, id) or the
-- user-prompts index to choose from, SQLite walked every tool row of each
-- session (or every assistant row in the database) through the table; it ran on
-- every session state change while the island was open. The partial predicate
-- repeats the query's three filters, so the index is covering and holds only
-- the rows the query can return.
--
-- Dropped, each a leading prefix of a surviving index on the same table (so
-- every reader can seek the longer one), or with no reader:
--   idx_session_files_session      prefix of idx_session_files_unique
--   idx_session_files_workspace    prefix of idx_session_files_workspace_file
--   idx_session_files_type         no query filters on link_type alone; without
--                                  stats the planner chose it for the
--                                  per-session edited lookup and walked every
--                                  edited row in the database
--   idx_queued_prompts_session     prefix of idx_queued_prompts_session_status
--   idx_tracker_workspace          prefix of idx_tracker_workspace_sync_id and
--                                  idx_tracker_kanban_sort
--   idx_ai_sessions_created_by     the partial idx_ai_sessions_created_by_workspace
--                                  serves every `created_by_session_id = ?`
--                                  (equality implies IS NOT NULL)
--   idx_history_file_content_hash  no query filters on baseMarkdownHash; the
--                                  dedupe compares it in JS after a
--                                  file_path/timestamp lookup
--
-- Plans are pinned in __tests__/indexHygienePlans.test.ts.
--
-- PGLite mirror: worker.js, "Mirror of SQLite migration 0053". It runs on every
-- launch, which is safe because every statement is IF [NOT] EXISTS.
-- ----------------------------------------------------------------------------

CREATE INDEX IF NOT EXISTS idx_ai_agent_messages_latest_assistant_text
  ON ai_agent_messages(session_id, id DESC)
  WHERE message_kind = 'assistant'
    AND searchable_text IS NOT NULL
    AND searchable_text <> '';

DROP INDEX IF EXISTS idx_session_files_session;
DROP INDEX IF EXISTS idx_session_files_workspace;
DROP INDEX IF EXISTS idx_session_files_type;
DROP INDEX IF EXISTS idx_queued_prompts_session;
DROP INDEX IF EXISTS idx_tracker_workspace;
DROP INDEX IF EXISTS idx_ai_sessions_created_by;
DROP INDEX IF EXISTS idx_history_file_content_hash;
