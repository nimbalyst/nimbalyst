-- ----------------------------------------------------------------------------
-- 0002_pending_files_index
--
-- HistoryManager.getPendingFilesForSession was the dominant SQLite CPU sink
-- (17s cumulative / 321 calls in a 5s window, p99 ~77ms, max 127ms). The
-- query filters by file_path LIKE + json_extract(metadata, '$.status') +
-- json_extract(metadata, '$.sessionId') and had to scan every history row
-- for the workspace prefix.
--
-- This partial expression index narrows scans to pending-review rows and
-- lets the planner use a covering lookup on (sessionId, file_path). Other
-- statuses are excluded so the index stays tiny on the common case.
-- ----------------------------------------------------------------------------

CREATE INDEX IF NOT EXISTS idx_history_pending_session_file
  ON document_history(
    json_extract(metadata, '$.sessionId'),
    file_path
  )
  WHERE json_extract(metadata, '$.status') = 'pending-review';
