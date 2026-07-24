CREATE TABLE IF NOT EXISTS collab_document_replicas (
  account_id TEXT NOT NULL,
  org_id TEXT NOT NULL,
  document_id TEXT NOT NULL,
  document_type TEXT NOT NULL,
  encoding_version INTEGER NOT NULL DEFAULT 1,
  encrypted_snapshot BLOB,
  snapshot_generation INTEGER NOT NULL DEFAULT 0,
  last_server_seq INTEGER NOT NULL DEFAULT 0,
  completeness TEXT NOT NULL DEFAULT 'complete'
    CHECK (completeness IN ('complete', 'incomplete', 'corrupt')),
  snapshot_checksum TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  last_accessed_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (account_id, org_id, document_id)
);

CREATE TABLE IF NOT EXISTS collab_document_replica_updates (
  update_id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL,
  org_id TEXT NOT NULL,
  document_id TEXT NOT NULL,
  encrypted_update BLOB NOT NULL,
  source TEXT NOT NULL CHECK (source IN ('local', 'remote', 'server-snapshot')),
  server_sequence INTEGER,
  snapshot_generation INTEGER NOT NULL DEFAULT 0,
  encoding_version INTEGER NOT NULL DEFAULT 1,
  update_checksum TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (account_id, org_id, document_id)
    REFERENCES collab_document_replicas(account_id, org_id, document_id)
    ON DELETE CASCADE
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_collab_replica_updates_server_seq
  ON collab_document_replica_updates(account_id, org_id, document_id, server_sequence)
  WHERE server_sequence IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_collab_replica_updates_tail
  ON collab_document_replica_updates(account_id, org_id, document_id, created_at);

CREATE TABLE IF NOT EXISTS collab_document_outbox (
  batch_id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL,
  org_id TEXT NOT NULL,
  document_id TEXT NOT NULL,
  encrypted_update BLOB NOT NULL,
  encoding_version INTEGER NOT NULL DEFAULT 1,
  update_checksum TEXT NOT NULL,
  state TEXT NOT NULL DEFAULT 'queued'
    CHECK (state IN ('queued', 'inflight', 'rejected')),
  attempt_count INTEGER NOT NULL DEFAULT 0,
  last_error_code TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (account_id, org_id, document_id)
    REFERENCES collab_document_replicas(account_id, org_id, document_id)
    ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_collab_document_outbox_drain
  ON collab_document_outbox(account_id, state, updated_at);
CREATE INDEX IF NOT EXISTS idx_collab_document_replicas_retention
  ON collab_document_replicas(account_id, last_accessed_at);
