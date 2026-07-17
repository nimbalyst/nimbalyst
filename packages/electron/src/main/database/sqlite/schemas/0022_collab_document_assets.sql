CREATE TABLE IF NOT EXISTS collab_document_assets (
  account_id TEXT NOT NULL,
  org_id TEXT NOT NULL,
  document_id TEXT NOT NULL,
  asset_id TEXT NOT NULL,
  encrypted_asset BLOB NOT NULL,
  encoding_version INTEGER NOT NULL DEFAULT 1,
  asset_checksum TEXT NOT NULL,
  plaintext_size INTEGER NOT NULL,
  upload_state TEXT NOT NULL DEFAULT 'cached'
    CHECK (upload_state IN ('cached', 'queued', 'inflight', 'rejected')),
  attempt_count INTEGER NOT NULL DEFAULT 0,
  last_error_code TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  last_accessed_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (account_id, org_id, document_id, asset_id)
);

CREATE INDEX IF NOT EXISTS idx_collab_document_assets_drain
  ON collab_document_assets(account_id, upload_state, updated_at);
CREATE INDEX IF NOT EXISTS idx_collab_document_assets_retention
  ON collab_document_assets(account_id, last_accessed_at);
