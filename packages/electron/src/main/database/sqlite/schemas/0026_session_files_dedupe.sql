-- Collapse duplicate session_files rows and make idx_session_files_unique
-- actually unique.
--
-- session_files has been written append-only: addFileLink issues a plain INSERT
-- with a fresh uuid for every attribution, and idx_session_files_unique -- despite
-- its name -- was created in 0001_initial.sql as a plain, non-unique index, so
-- nothing collapsed repeat attributions. A session that edits the same file N
-- times accumulated N rows, and SessionEditQuota only caps the number of
-- *distinct* files (it returns early with `true` for a file it has already seen,
-- letting the write through).
--
-- getFilesBySession does `SELECT * ... WHERE session_id = ?` with no limit, so
-- every session-files:updated refresh hauled the full duplicate set over IPC.
-- On a long-running session this grew without bound: locally a single session
-- held 6741 'edited' rows for 500 distinct paths (13.5x), one file repeated 134
-- times, which stalled the main-process event loop for seconds and ballooned the
-- renderer that kept the results.
--
-- Ordering note: attributions are re-pointed *before* the delete, because
-- ai_tool_call_file_edits.session_file_id is ON DELETE CASCADE and would
-- otherwise silently drop rows that referenced a duplicate.

CREATE TEMP TABLE _session_files_dedupe AS
WITH ranked AS (
  SELECT
    id,
    FIRST_VALUE(id) OVER (
      PARTITION BY session_id, file_path, link_type
      ORDER BY timestamp DESC, id DESC
    ) AS keep_id,
    ROW_NUMBER() OVER (
      PARTITION BY session_id, file_path, link_type
      ORDER BY timestamp DESC, id DESC
    ) AS rn
  FROM session_files
)
SELECT id AS dup_id, keep_id FROM ranked WHERE rn > 1;

-- OR REPLACE resolves collisions on idx_atcfe_unique (session_file_id, message_id)
-- that appear once several duplicates fold into one surviving row.
UPDATE OR REPLACE ai_tool_call_file_edits
SET session_file_id = (
  SELECT keep_id FROM _session_files_dedupe WHERE dup_id = session_file_id
)
WHERE session_file_id IN (SELECT dup_id FROM _session_files_dedupe);

DELETE FROM session_files
WHERE id IN (SELECT dup_id FROM _session_files_dedupe);

DROP TABLE _session_files_dedupe;

DROP INDEX IF EXISTS idx_session_files_unique;
CREATE UNIQUE INDEX IF NOT EXISTS idx_session_files_unique
  ON session_files(session_id, file_path, link_type);
