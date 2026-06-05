-- ----------------------------------------------------------------------------
-- 0008_guard_fts_triggers
--
-- Replaces the AFTER UPDATE trigger on `ai_agent_messages` with two
-- WHEN-guarded triggers so the FTS5 'delete' command only fires when there
-- is actually a row in the index to delete.
--
-- Why: the AgentMessagesBackfill pass UPDATEs ~1.3M historical rows whose
-- `old.searchable_text` is NULL. The previous combined trigger ran the
-- FTS5 'delete' command unconditionally with NULL content. On this DB that
-- raises `SQLITE_CORRUPT_VTAB: database disk image is malformed`, causing
-- every backfill UPDATE to fail (210s pass, 14 successes out of 1.36M).
--
-- After this migration the trigger work is split:
--
--   ai_agent_messages_au_delete  fires WHEN old.searchable_text IS NOT NULL
--   ai_agent_messages_au_insert  fires WHEN new.searchable_text IS NOT NULL
--
-- For a backfill row that goes from (NULL, NULL) -> (NULL, 'tool') neither
-- trigger fires, so the row's UPDATE no longer talks to the FTS5 index at
-- all. The base-table column updates land normally.
--
-- AI and AD triggers are unchanged (they already guard with WHEN clauses).
-- The FTS schema itself is untouched.
-- ----------------------------------------------------------------------------

DROP TRIGGER IF EXISTS ai_agent_messages_au;

CREATE TRIGGER ai_agent_messages_au_delete AFTER UPDATE ON ai_agent_messages
WHEN old.searchable_text IS NOT NULL
BEGIN
  INSERT INTO ai_agent_messages_fts(ai_agent_messages_fts, rowid, searchable_text)
    VALUES('delete', old.id, old.searchable_text);
END;

CREATE TRIGGER ai_agent_messages_au_insert AFTER UPDATE ON ai_agent_messages
WHEN new.searchable_text IS NOT NULL
BEGIN
  INSERT INTO ai_agent_messages_fts(rowid, searchable_text)
    VALUES (new.id, new.searchable_text);
END;
