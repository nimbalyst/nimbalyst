-- ----------------------------------------------------------------------------
-- 0018_history_preedit_session_index
--
-- Transcript diff enrichment (ToolCallMatcher.createSessionEnrichmentContext)
-- loads every pre-edit snapshot for a session on ai:loadSession. That query
-- filters document_history by json_extract(metadata,'$.sessionId') +
-- json_extract(metadata,'$.type')='pre-edit', and with no supporting index it
-- full-scanned the whole table (27k+ rows), taking 1.7-4.7s per load on large
-- sessions.
--
-- This partial expression index narrows scans to pre-edit rows and gives the
-- planner a direct lookup on sessionId. It mirrors idx_history_pending_session_file
-- (migration 2). The query must use json_extract (not metadata->>'x', which the
-- dialect translator parameterizes into ->>? and cannot index).
-- ----------------------------------------------------------------------------

CREATE INDEX IF NOT EXISTS idx_history_preedit_session
  ON document_history(
    json_extract(metadata, '$.sessionId')
  )
  WHERE json_extract(metadata, '$.type') = 'pre-edit';
