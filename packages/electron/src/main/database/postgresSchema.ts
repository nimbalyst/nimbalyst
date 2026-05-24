export const POSTGRES_SCHEMA_STATEMENTS = [
  `
    CREATE TABLE IF NOT EXISTS workspaces (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      created_at BIGINT NOT NULL,
      updated_at BIGINT NOT NULL
    )
  `,
  `
    CREATE TABLE IF NOT EXISTS documents (
      id TEXT PRIMARY KEY,
      workspace_id TEXT NOT NULL,
      title TEXT NOT NULL,
      content TEXT NOT NULL DEFAULT '',
      created_at BIGINT NOT NULL,
      updated_at BIGINT NOT NULL
    )
  `,
  `CREATE INDEX IF NOT EXISTS idx_documents_workspace ON documents(workspace_id, updated_at DESC)`,
  `
    CREATE TABLE IF NOT EXISTS document_history (
      id SERIAL PRIMARY KEY,
      workspace_id TEXT NOT NULL,
      file_path TEXT NOT NULL,
      content BYTEA NOT NULL,
      size_bytes INTEGER,
      timestamp BIGINT NOT NULL,
      version INTEGER DEFAULT 1,
      metadata JSONB DEFAULT '{}'
    )
  `,
  `CREATE INDEX IF NOT EXISTS idx_history_workspace_file ON document_history(workspace_id, file_path)`,
  `CREATE INDEX IF NOT EXISTS idx_history_timestamp ON document_history(timestamp)`,
  `CREATE INDEX IF NOT EXISTS idx_history_file_content_hash ON document_history(file_path, (metadata->>'baseMarkdownHash')) WHERE metadata->>'baseMarkdownHash' IS NOT NULL`,
  `CREATE UNIQUE INDEX IF NOT EXISTS idx_history_one_pending_per_file ON document_history(file_path) WHERE metadata->>'status' = 'pending-review'`,
  `
    CREATE TABLE IF NOT EXISTS worktrees (
      id TEXT PRIMARY KEY,
      workspace_id TEXT NOT NULL,
      name TEXT NOT NULL,
      display_name TEXT,
      path TEXT NOT NULL,
      branch TEXT NOT NULL,
      base_branch TEXT DEFAULT 'main',
      is_pinned BOOLEAN DEFAULT FALSE,
      is_archived BOOLEAN DEFAULT FALSE,
      created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
    )
  `,
  `CREATE INDEX IF NOT EXISTS idx_worktrees_workspace ON worktrees(workspace_id)`,
  `CREATE INDEX IF NOT EXISTS idx_worktrees_path ON worktrees(path)`,
  `CREATE INDEX IF NOT EXISTS idx_worktrees_archived ON worktrees(is_archived)`,
  `
    CREATE TABLE IF NOT EXISTS ai_sessions (
      id TEXT PRIMARY KEY,
      workspace_id TEXT NOT NULL DEFAULT 'default',
      file_path TEXT,
      worktree_id TEXT REFERENCES worktrees(id) ON DELETE SET NULL,
      parent_session_id TEXT REFERENCES ai_sessions(id) ON DELETE SET NULL,
      provider TEXT NOT NULL,
      model TEXT,
      title TEXT NOT NULL DEFAULT 'New conversation',
      session_type TEXT DEFAULT 'session',
      mode TEXT DEFAULT 'agent' CHECK (mode IN ('planning', 'agent')),
      agent_role TEXT DEFAULT 'standard',
      created_by_session_id TEXT REFERENCES ai_sessions(id) ON DELETE SET NULL,
      document_context JSONB,
      provider_config JSONB,
      provider_session_id TEXT,
      draft_input TEXT,
      metadata JSONB DEFAULT '{}',
      last_read_message_id TEXT,
      last_read_timestamp TIMESTAMPTZ,
      has_been_named BOOLEAN DEFAULT FALSE,
      status TEXT DEFAULT 'idle' CHECK (status IN ('idle', 'running', 'waiting_for_input', 'error')),
      last_activity TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
      is_archived BOOLEAN DEFAULT FALSE,
      is_pinned BOOLEAN DEFAULT FALSE,
      last_document_state JSONB,
      branched_from_session_id TEXT REFERENCES ai_sessions(id) ON DELETE SET NULL,
      branch_point_message_id BIGINT,
      branched_at TIMESTAMPTZ,
      canonical_transform_version INTEGER,
      canonical_last_raw_message_id BIGINT,
      canonical_last_transformed_at TIMESTAMPTZ,
      canonical_transform_status TEXT CHECK (canonical_transform_status IN ('pending', 'complete', 'error')),
      created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
    )
  `,
  `CREATE INDEX IF NOT EXISTS idx_ai_sessions_workspace ON ai_sessions(workspace_id)`,
  `CREATE INDEX IF NOT EXISTS idx_ai_sessions_created ON ai_sessions(created_at)`,
  `CREATE INDEX IF NOT EXISTS idx_ai_sessions_type ON ai_sessions(session_type)`,
  `CREATE INDEX IF NOT EXISTS idx_ai_sessions_updated ON ai_sessions(updated_at)`,
  `CREATE INDEX IF NOT EXISTS idx_ai_sessions_archived ON ai_sessions(is_archived)`,
  `CREATE INDEX IF NOT EXISTS idx_ai_sessions_worktree ON ai_sessions(worktree_id)`,
  `CREATE INDEX IF NOT EXISTS idx_ai_sessions_parent ON ai_sessions(parent_session_id)`,
  `CREATE INDEX IF NOT EXISTS idx_ai_sessions_agent_role ON ai_sessions(agent_role)`,
  `CREATE INDEX IF NOT EXISTS idx_ai_sessions_created_by ON ai_sessions(created_by_session_id)`,
  `CREATE INDEX IF NOT EXISTS idx_ai_sessions_created_by_workspace ON ai_sessions(created_by_session_id, workspace_id) WHERE created_by_session_id IS NOT NULL`,
  `CREATE INDEX IF NOT EXISTS idx_ai_sessions_branched_from ON ai_sessions(branched_from_session_id)`,
  `
    CREATE TABLE IF NOT EXISTS session_files (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      workspace_id TEXT NOT NULL,
      file_path TEXT NOT NULL,
      link_type TEXT NOT NULL CHECK (link_type IN ('edited', 'referenced', 'read')),
      timestamp TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
      metadata JSONB DEFAULT '{}'
    )
  `,
  `CREATE INDEX IF NOT EXISTS idx_session_files_session ON session_files(session_id)`,
  `CREATE INDEX IF NOT EXISTS idx_session_files_file ON session_files(file_path)`,
  `CREATE INDEX IF NOT EXISTS idx_session_files_type ON session_files(link_type)`,
  `CREATE INDEX IF NOT EXISTS idx_session_files_workspace ON session_files(workspace_id)`,
  `CREATE INDEX IF NOT EXISTS idx_session_files_workspace_file ON session_files(workspace_id, file_path)`,
  `CREATE INDEX IF NOT EXISTS idx_session_files_unique ON session_files(session_id, file_path, link_type)`,
  `CREATE INDEX IF NOT EXISTS idx_session_files_uncommitted_lookup ON session_files(workspace_id, link_type, file_path, timestamp DESC)`,
  `
    CREATE TABLE IF NOT EXISTS ai_agent_messages (
      id BIGSERIAL PRIMARY KEY,
      session_id TEXT NOT NULL REFERENCES ai_sessions(id) ON DELETE CASCADE,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      source TEXT NOT NULL,
      direction TEXT NOT NULL CHECK (direction IN ('input', 'output')),
      content TEXT NOT NULL,
      metadata JSONB,
      hidden BOOLEAN NOT NULL DEFAULT FALSE,
      provider_message_id TEXT,
      searchable BOOLEAN NOT NULL DEFAULT FALSE
    )
  `,
  `CREATE INDEX IF NOT EXISTS idx_ai_agent_messages_session ON ai_agent_messages(session_id, id)`,
  `CREATE INDEX IF NOT EXISTS idx_ai_agent_messages_created ON ai_agent_messages(created_at DESC)`,
  `CREATE INDEX IF NOT EXISTS idx_ai_agent_messages_source_direction ON ai_agent_messages(source, direction)`,
  `CREATE INDEX IF NOT EXISTS idx_ai_agent_messages_content_fts ON ai_agent_messages USING GIN(to_tsvector('english', content)) WHERE searchable = true`,
  `
    CREATE TABLE IF NOT EXISTS ai_tool_call_file_edits (
      id BIGSERIAL PRIMARY KEY,
      session_id TEXT NOT NULL REFERENCES ai_sessions(id) ON DELETE CASCADE,
      session_file_id TEXT NOT NULL REFERENCES session_files(id) ON DELETE CASCADE,
      message_id BIGINT NOT NULL REFERENCES ai_agent_messages(id) ON DELETE CASCADE,
      tool_call_item_id TEXT,
      tool_use_id TEXT,
      match_score INTEGER NOT NULL DEFAULT 0,
      match_reason TEXT,
      file_timestamp TIMESTAMPTZ,
      created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
    )
  `,
  `CREATE INDEX IF NOT EXISTS idx_atcfe_session ON ai_tool_call_file_edits(session_id)`,
  `CREATE INDEX IF NOT EXISTS idx_atcfe_session_file ON ai_tool_call_file_edits(session_file_id)`,
  `CREATE INDEX IF NOT EXISTS idx_atcfe_message ON ai_tool_call_file_edits(message_id)`,
  `CREATE UNIQUE INDEX IF NOT EXISTS idx_atcfe_unique ON ai_tool_call_file_edits(session_file_id, message_id)`,
  `CREATE INDEX IF NOT EXISTS idx_atcfe_session_tool_call ON ai_tool_call_file_edits(session_id, tool_call_item_id)`,
  `
    CREATE TABLE IF NOT EXISTS tracker_items (
      id TEXT PRIMARY KEY,
      issue_number INTEGER,
      issue_key TEXT,
      type TEXT NOT NULL,
      type_tags TEXT[] DEFAULT '{}',
      data JSONB NOT NULL,
      content JSONB,
      workspace TEXT NOT NULL,
      document_path TEXT,
      line_number INTEGER,
      sync_status TEXT DEFAULT 'local',
      sync_id BIGINT,
      body_version BIGINT NOT NULL DEFAULT 0,
      deleted_at TIMESTAMPTZ,
      archived BOOLEAN DEFAULT FALSE,
      archived_at TIMESTAMPTZ,
      source TEXT DEFAULT 'inline',
      source_ref TEXT,
      created TIMESTAMPTZ DEFAULT NOW(),
      updated TIMESTAMPTZ DEFAULT NOW(),
      last_indexed TIMESTAMPTZ DEFAULT NOW(),
      title TEXT GENERATED ALWAYS AS (data->>'title') STORED,
      status TEXT GENERATED ALWAYS AS (data->>'status') STORED,
      kanban_sort_order TEXT GENERATED ALWAYS AS (data->>'kanbanSortOrder') STORED
    )
  `,
  `CREATE INDEX IF NOT EXISTS idx_tracker_type ON tracker_items(type)`,
  `CREATE INDEX IF NOT EXISTS idx_tracker_workspace ON tracker_items(workspace)`,
  `CREATE INDEX IF NOT EXISTS idx_tracker_status ON tracker_items(status)`,
  `CREATE INDEX IF NOT EXISTS idx_tracker_created ON tracker_items(created)`,
  `CREATE INDEX IF NOT EXISTS idx_tracker_updated ON tracker_items(updated)`,
  `CREATE INDEX IF NOT EXISTS idx_tracker_data_gin ON tracker_items USING GIN(data)`,
  `CREATE INDEX IF NOT EXISTS idx_tracker_sync_status ON tracker_items(sync_status)`,
  `CREATE UNIQUE INDEX IF NOT EXISTS idx_tracker_workspace_issue_number ON tracker_items(workspace, issue_number) WHERE issue_number IS NOT NULL`,
  `CREATE UNIQUE INDEX IF NOT EXISTS idx_tracker_workspace_issue_key ON tracker_items(workspace, issue_key) WHERE issue_key IS NOT NULL`,
  `CREATE INDEX IF NOT EXISTS idx_tracker_archived ON tracker_items(archived)`,
  `CREATE INDEX IF NOT EXISTS idx_tracker_source ON tracker_items(source)`,
  `CREATE INDEX IF NOT EXISTS idx_tracker_type_tags ON tracker_items USING GIN(type_tags)`,
  `CREATE INDEX IF NOT EXISTS idx_tracker_kanban_sort ON tracker_items(workspace, status, kanban_sort_order)`,
  `CREATE INDEX IF NOT EXISTS idx_tracker_workspace_sync_id ON tracker_items(workspace, sync_id)`,
  `CREATE INDEX IF NOT EXISTS idx_tracker_deleted_at ON tracker_items(deleted_at) WHERE deleted_at IS NOT NULL`,
  `
    CREATE TABLE IF NOT EXISTS tracker_body_cache (
      item_id TEXT NOT NULL,
      body_version BIGINT NOT NULL,
      content TEXT NOT NULL,
      cached_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      PRIMARY KEY (item_id, body_version)
    )
  `,
  `CREATE INDEX IF NOT EXISTS idx_tracker_body_cache_item ON tracker_body_cache(item_id)`,
  `
    CREATE TABLE IF NOT EXISTS tracker_transactions (
      client_mutation_id TEXT PRIMARY KEY,
      item_id TEXT NOT NULL,
      workspace_path TEXT NOT NULL,
      state TEXT NOT NULL CHECK (state IN ('created','queued','executing','persistedEnqueue')),
      kind TEXT NOT NULL CHECK (kind IN ('create','update','delete')),
      payload JSONB,
      enqueued_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      started_at TIMESTAMPTZ,
      confirmed_sync_id BIGINT,
      last_rejection JSONB
    )
  `,
  `CREATE INDEX IF NOT EXISTS idx_tracker_txn_workspace_state ON tracker_transactions(workspace_path, state)`,
  `CREATE INDEX IF NOT EXISTS idx_tracker_txn_item ON tracker_transactions(item_id)`,
  `
    CREATE TABLE IF NOT EXISTS queued_prompts (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL REFERENCES ai_sessions(id) ON DELETE CASCADE,
      prompt TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'executing', 'completed', 'failed')),
      attachments JSONB,
      document_context JSONB,
      created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
      claimed_at TIMESTAMPTZ,
      completed_at TIMESTAMPTZ,
      error_message TEXT
    )
  `,
  `CREATE INDEX IF NOT EXISTS idx_queued_prompts_session ON queued_prompts(session_id)`,
  `CREATE INDEX IF NOT EXISTS idx_queued_prompts_status ON queued_prompts(status)`,
  `CREATE INDEX IF NOT EXISTS idx_queued_prompts_session_status ON queued_prompts(session_id, status)`,
  `CREATE INDEX IF NOT EXISTS idx_queued_prompts_created ON queued_prompts(created_at)`,
  `
    CREATE TABLE IF NOT EXISTS ai_session_wakeups (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL REFERENCES ai_sessions(id) ON DELETE CASCADE,
      workspace_id TEXT NOT NULL,
      prompt TEXT NOT NULL,
      reason TEXT,
      fire_at TIMESTAMPTZ NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending'
        CHECK (status IN ('pending','firing','fired','waiting_for_workspace','overdue','cancelled','failed')),
      created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
      fired_at TIMESTAMPTZ,
      error TEXT
    )
  `,
  `CREATE INDEX IF NOT EXISTS idx_session_wakeups_pending_fire_at ON ai_session_wakeups(fire_at) WHERE status = 'pending'`,
  `CREATE INDEX IF NOT EXISTS idx_session_wakeups_session ON ai_session_wakeups(session_id)`,
  `CREATE INDEX IF NOT EXISTS idx_session_wakeups_workspace ON ai_session_wakeups(workspace_id)`,
  `CREATE INDEX IF NOT EXISTS idx_session_wakeups_waiting ON ai_session_wakeups(workspace_id) WHERE status = 'waiting_for_workspace'`,
  `
    CREATE TABLE IF NOT EXISTS super_loops (
      id TEXT PRIMARY KEY,
      worktree_id TEXT NOT NULL REFERENCES worktrees(id) ON DELETE CASCADE,
      task_description TEXT NOT NULL,
      title TEXT,
      status TEXT NOT NULL DEFAULT 'pending',
      current_iteration INTEGER DEFAULT 0,
      max_iterations INTEGER DEFAULT 20,
      model_id TEXT,
      completion_reason TEXT,
      is_archived BOOLEAN DEFAULT FALSE,
      is_pinned BOOLEAN DEFAULT FALSE,
      created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
    )
  `,
  `CREATE INDEX IF NOT EXISTS idx_super_loops_worktree ON super_loops(worktree_id)`,
  `CREATE INDEX IF NOT EXISTS idx_super_loops_status ON super_loops(status)`,
  `
    CREATE TABLE IF NOT EXISTS super_iterations (
      id TEXT PRIMARY KEY,
      super_loop_id TEXT NOT NULL REFERENCES super_loops(id) ON DELETE CASCADE,
      session_id TEXT NOT NULL REFERENCES ai_sessions(id) ON DELETE CASCADE,
      iteration_number INTEGER NOT NULL,
      status TEXT NOT NULL DEFAULT 'running',
      exit_reason TEXT,
      created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
      completed_at TIMESTAMPTZ
    )
  `,
  `CREATE INDEX IF NOT EXISTS idx_super_iterations_loop ON super_iterations(super_loop_id)`,
  `CREATE INDEX IF NOT EXISTS idx_super_iterations_session ON super_iterations(session_id)`,
  `
    CREATE TABLE IF NOT EXISTS ai_transcript_events (
      id BIGSERIAL PRIMARY KEY,
      session_id TEXT NOT NULL REFERENCES ai_sessions(id) ON DELETE CASCADE,
      sequence INTEGER NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      event_type TEXT NOT NULL CHECK (event_type IN (
        'user_message','assistant_message','system_message','tool_call',
        'tool_progress','interactive_prompt','subagent','turn_ended'
      )),
      searchable_text TEXT,
      payload JSONB NOT NULL DEFAULT '{}',
      parent_event_id BIGINT REFERENCES ai_transcript_events(id) ON DELETE SET NULL,
      searchable BOOLEAN NOT NULL DEFAULT FALSE,
      subagent_id TEXT,
      provider TEXT NOT NULL,
      provider_tool_call_id TEXT,
      CONSTRAINT uq_transcript_session_sequence UNIQUE (session_id, sequence)
    )
  `,
  `CREATE INDEX IF NOT EXISTS idx_transcript_session_seq ON ai_transcript_events(session_id, sequence)`,
  `CREATE INDEX IF NOT EXISTS idx_transcript_tool_call_id ON ai_transcript_events(provider_tool_call_id) WHERE provider_tool_call_id IS NOT NULL`,
  `CREATE INDEX IF NOT EXISTS idx_transcript_parent ON ai_transcript_events(parent_event_id) WHERE parent_event_id IS NOT NULL`,
  `CREATE INDEX IF NOT EXISTS idx_transcript_event_type ON ai_transcript_events(session_id, event_type)`,
  `CREATE INDEX IF NOT EXISTS idx_transcript_subagent_id ON ai_transcript_events(subagent_id) WHERE subagent_id IS NOT NULL`,
  `CREATE INDEX IF NOT EXISTS idx_transcript_fts ON ai_transcript_events USING GIN (to_tsvector('english', COALESCE(searchable_text, ''))) WHERE searchable = TRUE`,
  `
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
      last_synced_at TIMESTAMPTZ,
      last_seen_mtime_ms BIGINT,
      last_seen_size_bytes BIGINT,
      resolution_status TEXT NOT NULL DEFAULT 'resolved'
        CHECK (resolution_status IN ('resolved', 'missing', 'relinked', 'conflict')),
      resolution_error TEXT,
      created_at TIMESTAMPTZ NOT NULL,
      updated_at TIMESTAMPTZ NOT NULL,
      PRIMARY KEY (org_id, document_id)
    )
  `,
  `CREATE INDEX IF NOT EXISTS idx_collab_local_origins_git_remote_hash ON collab_local_origins(git_remote_hash)`,
  `CREATE INDEX IF NOT EXISTS idx_collab_local_origins_relative_path ON collab_local_origins(org_id, relative_path)`,
];
