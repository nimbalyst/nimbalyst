-- 0001_initial.sql
--
-- Consolidated end-state SQLite schema for Nimbalyst's local store. This is
-- the translation of the PGLite schema produced by every cumulative migration
-- in packages/electron/src/main/database/worker.js (`createSchemas`), flattened
-- to a single CREATE-the-final-shape file.
--
-- Type translation choices:
--   PGLite TIMESTAMPTZ    -> TEXT (ISO-8601, written as Date.toISOString())
--   PGLite BIGSERIAL/SERIAL -> INTEGER PRIMARY KEY AUTOINCREMENT (SQLite ROWID is 64-bit)
--   PGLite JSONB          -> TEXT (validated with json() when queried)
--   PGLite BYTEA          -> BLOB
--   PGLite TEXT[]         -> TEXT storing a JSON array
--   GENERATED ... STORED  -> Same shape with json_extract
--   GIN(to_tsvector...)   -> Replaced by FTS5 virtual tables + sync triggers
--   GIN on JSONB columns  -> Dropped; replaced by per-path expression indexes
--
-- This file is loaded as a single `db.exec()` in SQLite migration runner with
-- foreign_keys ON, journal_mode WAL, synchronous NORMAL. CHECK constraints
-- are preserved verbatim.

-- ----------------------------------------------------------------------------
-- ai_sessions
-- ----------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS ai_sessions (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL DEFAULT 'default',
  file_path TEXT,
  provider TEXT NOT NULL,
  model TEXT,
  title TEXT NOT NULL DEFAULT 'New conversation',
  session_type TEXT DEFAULT 'session',
  agent_role TEXT DEFAULT 'standard',
  created_by_session_id TEXT REFERENCES ai_sessions(id) ON DELETE SET NULL,
  document_context TEXT,                          -- JSON
  provider_config TEXT,                           -- JSON
  provider_session_id TEXT,
  draft_input TEXT,
  metadata TEXT NOT NULL DEFAULT '{}',            -- JSON
  last_read_message_id TEXT,
  last_read_timestamp TEXT,
  has_been_named INTEGER NOT NULL DEFAULT 0,
  status TEXT DEFAULT 'idle' CHECK (status IN ('idle', 'running', 'waiting_for_input', 'error')),
  last_activity TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  mode TEXT DEFAULT 'agent' CHECK (mode IN ('planning', 'agent', 'auto')),
  is_archived INTEGER NOT NULL DEFAULT 0,
  last_document_state TEXT,                       -- JSON
  worktree_id TEXT REFERENCES worktrees(id) ON DELETE SET NULL,
  is_pinned INTEGER NOT NULL DEFAULT 0,
  parent_session_id TEXT REFERENCES ai_sessions(id) ON DELETE SET NULL,
  branched_from_session_id TEXT REFERENCES ai_sessions(id) ON DELETE SET NULL,
  branch_point_message_id INTEGER,
  branched_at TEXT,
  canonical_transform_version INTEGER,
  canonical_last_raw_message_id INTEGER,
  canonical_last_transformed_at TEXT,
  canonical_transform_status TEXT
    CHECK (canonical_transform_status IS NULL
        OR canonical_transform_status IN ('pending', 'complete', 'error')),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE INDEX IF NOT EXISTS idx_ai_sessions_workspace ON ai_sessions(workspace_id);
CREATE INDEX IF NOT EXISTS idx_ai_sessions_created ON ai_sessions(created_at);
CREATE INDEX IF NOT EXISTS idx_ai_sessions_type ON ai_sessions(session_type);
CREATE INDEX IF NOT EXISTS idx_ai_sessions_updated ON ai_sessions(updated_at);
CREATE INDEX IF NOT EXISTS idx_ai_sessions_archived ON ai_sessions(is_archived);
CREATE INDEX IF NOT EXISTS idx_ai_sessions_worktree ON ai_sessions(worktree_id);
CREATE INDEX IF NOT EXISTS idx_ai_sessions_parent ON ai_sessions(parent_session_id);
CREATE INDEX IF NOT EXISTS idx_ai_sessions_branched_from ON ai_sessions(branched_from_session_id);
CREATE INDEX IF NOT EXISTS idx_ai_sessions_agent_role ON ai_sessions(agent_role);
CREATE INDEX IF NOT EXISTS idx_ai_sessions_created_by ON ai_sessions(created_by_session_id);
CREATE INDEX IF NOT EXISTS idx_ai_sessions_created_by_workspace
  ON ai_sessions(created_by_session_id, workspace_id)
  WHERE created_by_session_id IS NOT NULL;

-- ----------------------------------------------------------------------------
-- worktrees (referenced by ai_sessions.worktree_id)
-- ----------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS worktrees (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  name TEXT NOT NULL,
  path TEXT NOT NULL,
  branch TEXT NOT NULL,
  base_branch TEXT DEFAULT 'main',
  display_name TEXT,
  is_pinned INTEGER NOT NULL DEFAULT 0,
  is_archived INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE INDEX IF NOT EXISTS idx_worktrees_workspace ON worktrees(workspace_id);
CREATE INDEX IF NOT EXISTS idx_worktrees_path ON worktrees(path);
CREATE INDEX IF NOT EXISTS idx_worktrees_archived ON worktrees(is_archived);

-- ----------------------------------------------------------------------------
-- document_history
-- ----------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS document_history (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  workspace_id TEXT NOT NULL,
  file_path TEXT NOT NULL,
  content BLOB NOT NULL,
  size_bytes INTEGER,
  timestamp INTEGER NOT NULL,
  version INTEGER DEFAULT 1,
  metadata TEXT NOT NULL DEFAULT '{}'             -- JSON
);

CREATE INDEX IF NOT EXISTS idx_history_workspace_file ON document_history(workspace_id, file_path);
CREATE INDEX IF NOT EXISTS idx_history_timestamp ON document_history(timestamp);

-- Expression index replacing the PGLite `(metadata->>'baseMarkdownHash')`
-- partial index. Used for duplicate detection.
CREATE INDEX IF NOT EXISTS idx_history_file_content_hash
  ON document_history(file_path, json_extract(metadata, '$.baseMarkdownHash'))
  WHERE json_extract(metadata, '$.baseMarkdownHash') IS NOT NULL;

-- One pending-review tag per file at a time.
CREATE UNIQUE INDEX IF NOT EXISTS idx_history_one_pending_per_file
  ON document_history(file_path)
  WHERE json_extract(metadata, '$.status') = 'pending-review';

-- ----------------------------------------------------------------------------
-- session_files
-- ----------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS session_files (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  workspace_id TEXT NOT NULL,
  file_path TEXT NOT NULL,
  link_type TEXT NOT NULL CHECK (link_type IN ('edited', 'referenced', 'read')),
  timestamp TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  metadata TEXT NOT NULL DEFAULT '{}'             -- JSON
);

CREATE INDEX IF NOT EXISTS idx_session_files_session ON session_files(session_id);
CREATE INDEX IF NOT EXISTS idx_session_files_file ON session_files(file_path);
CREATE INDEX IF NOT EXISTS idx_session_files_type ON session_files(link_type);
CREATE INDEX IF NOT EXISTS idx_session_files_workspace ON session_files(workspace_id);
CREATE INDEX IF NOT EXISTS idx_session_files_workspace_file ON session_files(workspace_id, file_path);
CREATE INDEX IF NOT EXISTS idx_session_files_unique ON session_files(session_id, file_path, link_type);
CREATE INDEX IF NOT EXISTS idx_session_files_uncommitted_lookup
  ON session_files(workspace_id, link_type, file_path, timestamp DESC);

-- ----------------------------------------------------------------------------
-- ai_agent_messages (raw append-only log; sole source of truth)
-- ----------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS ai_agent_messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  source TEXT NOT NULL,
  direction TEXT NOT NULL CHECK (direction IN ('input', 'output')),
  content TEXT NOT NULL,
  metadata TEXT,                                  -- JSON
  hidden INTEGER NOT NULL DEFAULT 0,
  provider_message_id TEXT,
  -- Vestigial: kept so legacy writers don't break; the FTS5 mirror below
  -- inserts unconditionally regardless of this flag. A follow-up release
  -- will drop the column entirely.
  searchable INTEGER NOT NULL DEFAULT 0,
  CONSTRAINT fk_ai_agent_messages_session
    FOREIGN KEY (session_id) REFERENCES ai_sessions(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_ai_agent_messages_session ON ai_agent_messages(session_id, id);
CREATE INDEX IF NOT EXISTS idx_ai_agent_messages_created ON ai_agent_messages(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_ai_agent_messages_source_direction ON ai_agent_messages(source, direction);
CREATE INDEX IF NOT EXISTS idx_agent_messages_direction_hidden
  ON ai_agent_messages(session_id, direction, hidden, id);

-- FTS5 mirror with porter+unicode61 tokenizer. Replaces the PGLite
-- to_tsvector('english', content) + GIN index pattern. Insert unconditionally
-- so historical search "just works" after migration.
CREATE VIRTUAL TABLE IF NOT EXISTS ai_agent_messages_fts USING fts5(
  content,
  content='ai_agent_messages',
  content_rowid='id',
  tokenize='porter unicode61'
);

CREATE TRIGGER IF NOT EXISTS ai_agent_messages_ai AFTER INSERT ON ai_agent_messages BEGIN
  INSERT INTO ai_agent_messages_fts(rowid, content) VALUES (new.id, new.content);
END;

CREATE TRIGGER IF NOT EXISTS ai_agent_messages_ad AFTER DELETE ON ai_agent_messages BEGIN
  INSERT INTO ai_agent_messages_fts(ai_agent_messages_fts, rowid, content)
    VALUES('delete', old.id, old.content);
END;

CREATE TRIGGER IF NOT EXISTS ai_agent_messages_au AFTER UPDATE ON ai_agent_messages BEGIN
  INSERT INTO ai_agent_messages_fts(ai_agent_messages_fts, rowid, content)
    VALUES('delete', old.id, old.content);
  INSERT INTO ai_agent_messages_fts(rowid, content) VALUES (new.id, new.content);
END;

-- ----------------------------------------------------------------------------
-- ai_tool_call_file_edits
-- ----------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS ai_tool_call_file_edits (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id TEXT NOT NULL,
  session_file_id TEXT NOT NULL,
  message_id INTEGER NOT NULL,
  tool_call_item_id TEXT,
  tool_use_id TEXT,
  match_score INTEGER NOT NULL DEFAULT 0,
  match_reason TEXT,
  file_timestamp TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  CONSTRAINT fk_atcfe_session FOREIGN KEY (session_id) REFERENCES ai_sessions(id) ON DELETE CASCADE,
  CONSTRAINT fk_atcfe_session_file FOREIGN KEY (session_file_id) REFERENCES session_files(id) ON DELETE CASCADE,
  CONSTRAINT fk_atcfe_message FOREIGN KEY (message_id) REFERENCES ai_agent_messages(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_atcfe_session ON ai_tool_call_file_edits(session_id);
CREATE INDEX IF NOT EXISTS idx_atcfe_session_file ON ai_tool_call_file_edits(session_file_id);
CREATE INDEX IF NOT EXISTS idx_atcfe_message ON ai_tool_call_file_edits(message_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_atcfe_unique
  ON ai_tool_call_file_edits(session_file_id, message_id);
CREATE INDEX IF NOT EXISTS idx_atcfe_session_tool_call
  ON ai_tool_call_file_edits(session_id, tool_call_item_id);

-- ----------------------------------------------------------------------------
-- tracker_items (JSON `data` column + generated projections)
-- ----------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS tracker_items (
  id TEXT PRIMARY KEY,
  issue_number INTEGER,
  issue_key TEXT,
  type TEXT NOT NULL,
  data TEXT NOT NULL,                             -- JSON
  workspace TEXT NOT NULL,
  document_path TEXT,
  line_number INTEGER,
  content TEXT,                                   -- JSON
  archived INTEGER NOT NULL DEFAULT 0,
  archived_at TEXT,
  source TEXT DEFAULT 'inline',
  source_ref TEXT,
  type_tags TEXT NOT NULL DEFAULT '[]',           -- JSON array (replaces TEXT[])
  sync_status TEXT DEFAULT 'local',
  sync_id INTEGER,
  body_version INTEGER NOT NULL DEFAULT 0,
  deleted_at TEXT,
  created TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  last_indexed TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  title TEXT GENERATED ALWAYS AS (json_extract(data, '$.title')) STORED,
  status TEXT GENERATED ALWAYS AS (json_extract(data, '$.status')) STORED,
  kanban_sort_order TEXT GENERATED ALWAYS AS (json_extract(data, '$.kanbanSortOrder')) STORED
);

CREATE INDEX IF NOT EXISTS idx_tracker_type ON tracker_items(type);
CREATE INDEX IF NOT EXISTS idx_tracker_workspace ON tracker_items(workspace);
CREATE INDEX IF NOT EXISTS idx_tracker_status ON tracker_items(status);
CREATE INDEX IF NOT EXISTS idx_tracker_created ON tracker_items(created);
CREATE INDEX IF NOT EXISTS idx_tracker_updated ON tracker_items(updated);
CREATE INDEX IF NOT EXISTS idx_tracker_archived ON tracker_items(archived);
CREATE INDEX IF NOT EXISTS idx_tracker_source ON tracker_items(source);
CREATE INDEX IF NOT EXISTS idx_tracker_sync_status ON tracker_items(sync_status);
CREATE INDEX IF NOT EXISTS idx_tracker_workspace_sync_id ON tracker_items(workspace, sync_id);
CREATE INDEX IF NOT EXISTS idx_tracker_deleted_at ON tracker_items(deleted_at) WHERE deleted_at IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_tracker_kanban_sort ON tracker_items(workspace, status, kanban_sort_order);
CREATE UNIQUE INDEX IF NOT EXISTS idx_tracker_workspace_issue_number
  ON tracker_items(workspace, issue_number) WHERE issue_number IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS idx_tracker_workspace_issue_key
  ON tracker_items(workspace, issue_key) WHERE issue_key IS NOT NULL;
-- Note: the PGLite GIN(data) index has no SQLite analog. Specific JSON-path
-- expression indexes get added here as real query patterns emerge.

-- ----------------------------------------------------------------------------
-- tracker_body_cache
-- ----------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS tracker_body_cache (
  item_id TEXT NOT NULL,
  body_version INTEGER NOT NULL,
  content TEXT NOT NULL,
  cached_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  PRIMARY KEY (item_id, body_version)
);

CREATE INDEX IF NOT EXISTS idx_tracker_body_cache_item ON tracker_body_cache(item_id);

-- ----------------------------------------------------------------------------
-- tracker_transactions (offline four-state mutation queue)
-- ----------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS tracker_transactions (
  client_mutation_id TEXT PRIMARY KEY,
  item_id TEXT NOT NULL,
  workspace_path TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('created','queued','executing','persistedEnqueue')),
  kind TEXT NOT NULL CHECK (kind IN ('create','update','delete')),
  payload TEXT,                                   -- JSON
  enqueued_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  started_at TEXT,
  confirmed_sync_id INTEGER,
  last_rejection TEXT                             -- JSON
);

CREATE INDEX IF NOT EXISTS idx_tracker_txn_workspace_state
  ON tracker_transactions(workspace_path, state);
CREATE INDEX IF NOT EXISTS idx_tracker_txn_item ON tracker_transactions(item_id);

-- ----------------------------------------------------------------------------
-- queued_prompts
-- ----------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS queued_prompts (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  prompt TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'executing', 'completed', 'failed')),
  attachments TEXT,                               -- JSON
  document_context TEXT,                          -- JSON
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  claimed_at TEXT,
  completed_at TEXT,
  error_message TEXT,
  CONSTRAINT fk_queued_prompts_session
    FOREIGN KEY (session_id) REFERENCES ai_sessions(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_queued_prompts_session ON queued_prompts(session_id);
CREATE INDEX IF NOT EXISTS idx_queued_prompts_status ON queued_prompts(status);
CREATE INDEX IF NOT EXISTS idx_queued_prompts_session_status
  ON queued_prompts(session_id, status);
CREATE INDEX IF NOT EXISTS idx_queued_prompts_created ON queued_prompts(created_at);

-- ----------------------------------------------------------------------------
-- ai_session_wakeups
-- ----------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS ai_session_wakeups (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  workspace_id TEXT NOT NULL,
  prompt TEXT NOT NULL,
  reason TEXT,
  fire_at TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending','firing','fired','waiting_for_workspace','overdue','cancelled','failed')),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  fired_at TEXT,
  error TEXT,
  CONSTRAINT fk_session_wakeups_session
    FOREIGN KEY (session_id) REFERENCES ai_sessions(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_session_wakeups_pending_fire_at
  ON ai_session_wakeups(fire_at) WHERE status = 'pending';
CREATE INDEX IF NOT EXISTS idx_session_wakeups_session
  ON ai_session_wakeups(session_id);
CREATE INDEX IF NOT EXISTS idx_session_wakeups_workspace
  ON ai_session_wakeups(workspace_id);
CREATE INDEX IF NOT EXISTS idx_session_wakeups_waiting
  ON ai_session_wakeups(workspace_id) WHERE status = 'waiting_for_workspace';

-- ----------------------------------------------------------------------------
-- super_loops + super_iterations
-- ----------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS super_loops (
  id TEXT PRIMARY KEY,
  worktree_id TEXT NOT NULL REFERENCES worktrees(id) ON DELETE CASCADE,
  task_description TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  current_iteration INTEGER DEFAULT 0,
  max_iterations INTEGER DEFAULT 20,
  completion_reason TEXT,
  model_id TEXT,
  title TEXT,
  is_archived INTEGER NOT NULL DEFAULT 0,
  is_pinned INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE INDEX IF NOT EXISTS idx_super_loops_worktree ON super_loops(worktree_id);
CREATE INDEX IF NOT EXISTS idx_super_loops_status ON super_loops(status);

CREATE TABLE IF NOT EXISTS super_iterations (
  id TEXT PRIMARY KEY,
  super_loop_id TEXT NOT NULL REFERENCES super_loops(id) ON DELETE CASCADE,
  session_id TEXT NOT NULL REFERENCES ai_sessions(id) ON DELETE CASCADE,
  iteration_number INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'running',
  exit_reason TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  completed_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_super_iterations_loop ON super_iterations(super_loop_id);
CREATE INDEX IF NOT EXISTS idx_super_iterations_session ON super_iterations(session_id);

-- ----------------------------------------------------------------------------
-- ai_transcript_events (canonical projection of ai_agent_messages)
-- ----------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS ai_transcript_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id TEXT NOT NULL,
  sequence INTEGER NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  event_type TEXT NOT NULL CHECK (event_type IN (
    'user_message',
    'assistant_message',
    'system_message',
    'tool_call',
    'tool_progress',
    'interactive_prompt',
    'subagent',
    'turn_ended'
  )),
  searchable_text TEXT,
  payload TEXT NOT NULL DEFAULT '{}',             -- JSON
  parent_event_id INTEGER,
  searchable INTEGER NOT NULL DEFAULT 0,
  subagent_id TEXT,
  provider TEXT NOT NULL,
  provider_tool_call_id TEXT,
  CONSTRAINT fk_transcript_session
    FOREIGN KEY (session_id) REFERENCES ai_sessions(id) ON DELETE CASCADE,
  CONSTRAINT fk_transcript_parent
    FOREIGN KEY (parent_event_id) REFERENCES ai_transcript_events(id) ON DELETE SET NULL,
  CONSTRAINT uq_transcript_session_sequence UNIQUE (session_id, sequence)
);

CREATE INDEX IF NOT EXISTS idx_transcript_session_seq
  ON ai_transcript_events(session_id, sequence);
CREATE INDEX IF NOT EXISTS idx_transcript_tool_call_id
  ON ai_transcript_events(provider_tool_call_id) WHERE provider_tool_call_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_transcript_parent
  ON ai_transcript_events(parent_event_id) WHERE parent_event_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_transcript_event_type
  ON ai_transcript_events(session_id, event_type);
CREATE INDEX IF NOT EXISTS idx_transcript_subagent_id
  ON ai_transcript_events(subagent_id) WHERE subagent_id IS NOT NULL;

-- FTS5 mirror of transcript searchable_text. Inserts unconditionally; the
-- `searchable` flag stays for ingest-time control but the trigger ignores it
-- so historical search works.
CREATE VIRTUAL TABLE IF NOT EXISTS ai_transcript_events_fts USING fts5(
  searchable_text,
  content='ai_transcript_events',
  content_rowid='id',
  tokenize='porter unicode61'
);

CREATE TRIGGER IF NOT EXISTS ai_transcript_events_ai AFTER INSERT ON ai_transcript_events BEGIN
  INSERT INTO ai_transcript_events_fts(rowid, searchable_text)
    VALUES (new.id, COALESCE(new.searchable_text, ''));
END;

CREATE TRIGGER IF NOT EXISTS ai_transcript_events_ad AFTER DELETE ON ai_transcript_events BEGIN
  INSERT INTO ai_transcript_events_fts(ai_transcript_events_fts, rowid, searchable_text)
    VALUES('delete', old.id, COALESCE(old.searchable_text, ''));
END;

CREATE TRIGGER IF NOT EXISTS ai_transcript_events_au AFTER UPDATE ON ai_transcript_events BEGIN
  INSERT INTO ai_transcript_events_fts(ai_transcript_events_fts, rowid, searchable_text)
    VALUES('delete', old.id, COALESCE(old.searchable_text, ''));
  INSERT INTO ai_transcript_events_fts(rowid, searchable_text)
    VALUES (new.id, COALESCE(new.searchable_text, ''));
END;

-- ----------------------------------------------------------------------------
-- collab_local_origins (local-only re-upload bindings for shared documents)
-- ----------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS collab_local_origins (
  org_id TEXT NOT NULL,
  document_id TEXT NOT NULL,
  git_remote_hash TEXT,
  workspace_path_hash TEXT,
  relative_path TEXT NOT NULL,
  document_type TEXT NOT NULL,
  source_basename TEXT NOT NULL,
  last_local_content_hash TEXT,
  last_collab_content_hash TEXT,
  last_synced_at TEXT,
  last_seen_mtime_ms INTEGER,
  last_seen_size_bytes INTEGER,
  resolution_status TEXT NOT NULL DEFAULT 'resolved'
    CHECK (resolution_status IN ('resolved', 'missing', 'relinked', 'conflict')),
  resolution_error TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (org_id, document_id)
);

CREATE INDEX IF NOT EXISTS idx_collab_local_origins_git_remote_hash
  ON collab_local_origins(git_remote_hash);
CREATE INDEX IF NOT EXISTS idx_collab_local_origins_relative_path
  ON collab_local_origins(org_id, relative_path);
