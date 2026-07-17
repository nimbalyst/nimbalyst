ALTER TABLE collab_document_assets
  ADD COLUMN next_attempt_at TIMESTAMPTZ;

DROP INDEX IF EXISTS idx_collab_document_assets_drain;
CREATE INDEX idx_collab_document_assets_drain
  ON collab_document_assets(account_id, upload_state, next_attempt_at, updated_at);
