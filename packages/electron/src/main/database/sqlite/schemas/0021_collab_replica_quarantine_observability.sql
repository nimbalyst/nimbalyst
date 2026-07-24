ALTER TABLE collab_document_replicas ADD COLUMN quarantine_reason TEXT;
ALTER TABLE collab_document_replicas ADD COLUMN quarantined_at TIMESTAMPTZ;
