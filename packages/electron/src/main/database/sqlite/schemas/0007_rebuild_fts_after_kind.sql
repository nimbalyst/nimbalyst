-- ----------------------------------------------------------------------------
-- 0007_rebuild_fts_after_kind
--
-- Forcibly rebuilds `ai_agent_messages_fts` because the existing index is out
-- of sync with the base table on at least some installs:
--
--   ai_agent_messages_fts row count : 1,365,521
--   base rows with searchable_text  :         671
--   base table row count            : 1,364,770   (FTS has 751 MORE rowids than the base table!)
--
-- Symptom: every UPDATE on `ai_agent_messages` fires the AFTER UPDATE trigger,
-- whose first statement is the FTS5 'delete' command. With the index in this
-- inconsistent state SQLite raises "database disk image is malformed", which
-- caused the entire AgentMessagesBackfill pass to abort on its very first row
-- and silently leave 1.3M historical messages without `message_kind`.
--
-- Origin of the corruption: the install predates migration 0004's swap from
-- a `content`-indexed FTS to a `searchable_text`-indexed FTS. The DROP TABLE
-- in 0004 should have cleared the shadow tables, but for these databases the
-- old rowids persisted in the FTS5 internal tables.
--
-- Repair: drop and recreate the FTS table and its triggers (identical schema
-- to migration 0004), then reseed strictly from the current base-table state.
--
-- This is forward-only; no rollback. On a clean install where 0004 left the
-- FTS table consistent, this migration is a no-op equivalent (drops the
-- correct table and seeds the same rows back).
-- ----------------------------------------------------------------------------

DROP TRIGGER IF EXISTS ai_agent_messages_ai;
DROP TRIGGER IF EXISTS ai_agent_messages_ad;
DROP TRIGGER IF EXISTS ai_agent_messages_au;
DROP TABLE IF EXISTS ai_agent_messages_fts;

CREATE VIRTUAL TABLE ai_agent_messages_fts USING fts5(
  searchable_text,
  content='ai_agent_messages',
  content_rowid='id',
  tokenize='porter unicode61'
);

CREATE TRIGGER ai_agent_messages_ai AFTER INSERT ON ai_agent_messages
WHEN new.searchable_text IS NOT NULL
BEGIN
  INSERT INTO ai_agent_messages_fts(rowid, searchable_text)
    VALUES (new.id, new.searchable_text);
END;

CREATE TRIGGER ai_agent_messages_ad AFTER DELETE ON ai_agent_messages
WHEN old.searchable_text IS NOT NULL
BEGIN
  INSERT INTO ai_agent_messages_fts(ai_agent_messages_fts, rowid, searchable_text)
    VALUES('delete', old.id, old.searchable_text);
END;

CREATE TRIGGER ai_agent_messages_au AFTER UPDATE ON ai_agent_messages
BEGIN
  INSERT INTO ai_agent_messages_fts(ai_agent_messages_fts, rowid, searchable_text)
    VALUES('delete', old.id, old.searchable_text);
  INSERT INTO ai_agent_messages_fts(rowid, searchable_text)
    SELECT new.id, new.searchable_text WHERE new.searchable_text IS NOT NULL;
END;

INSERT INTO ai_agent_messages_fts(rowid, searchable_text)
  SELECT id, searchable_text FROM ai_agent_messages
  WHERE searchable_text IS NOT NULL;
