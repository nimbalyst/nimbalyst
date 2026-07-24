-- ----------------------------------------------------------------------------
-- 0004_fts_on_searchable_text
--
-- Phase 2 of the canonical-transcript-deprecation plan. Switches
-- `ai_agent_messages_fts` from indexing the raw `content` column to indexing
-- the extracted `searchable_text` column added in migration 0003. Triggers
-- skip rows whose `searchable_text` is NULL, so tool noise and metadata
-- chunks no longer pollute the FTS index.
--
-- Existing rows are seeded into the new FTS table from current
-- `searchable_text` values. Rows whose backfill is still pending
-- (`searchable_text IS NULL`) are picked up by the AFTER UPDATE trigger
-- below as the backfill pass runs at startup.
--
-- See plan: nimbalyst-local/plans/canonical-transcript-deprecation.md
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

-- INSERT trigger: only index rows that have actual searchable text. Rows
-- without (metadata, tool noise, transient chunks) stay out of the index
-- entirely, keeping it small and tightly aligned with what search expects
-- to return.
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

-- UPDATE trigger fires for every UPDATE, including the backfill pass that
-- moves rows from `searchable_text IS NULL` -> populated. If the old value
-- was NULL there is nothing to remove from the index, but the WHEN clause
-- can't gate that branch separately, so we issue the 'delete' command
-- unconditionally -- FTS5 ignores deletes for rowids it doesn't have.
CREATE TRIGGER ai_agent_messages_au AFTER UPDATE ON ai_agent_messages
BEGIN
  INSERT INTO ai_agent_messages_fts(ai_agent_messages_fts, rowid, searchable_text)
    VALUES('delete', old.id, old.searchable_text);
  INSERT INTO ai_agent_messages_fts(rowid, searchable_text)
    SELECT new.id, new.searchable_text WHERE new.searchable_text IS NOT NULL;
END;

-- Seed the new FTS table from already-populated rows. Anything left with
-- a NULL searchable_text after migration 0003 will be backfilled by the
-- AgentMessagesBackfill service on next startup, which will fire the
-- AFTER UPDATE trigger above and land each row in the index.
INSERT INTO ai_agent_messages_fts(rowid, searchable_text)
  SELECT id, searchable_text FROM ai_agent_messages
  WHERE searchable_text IS NOT NULL;
