ALTER TABLE collab_document_replicas ADD COLUMN staged_encrypted_snapshot BLOB;
ALTER TABLE collab_document_replicas ADD COLUMN staged_snapshot_generation INTEGER;
ALTER TABLE collab_document_replicas ADD COLUMN staged_snapshot_checksum TEXT;
ALTER TABLE collab_document_replicas ADD COLUMN staged_encoding_version INTEGER;
ALTER TABLE collab_document_replicas ADD COLUMN staged_snapshot_token TEXT;
ALTER TABLE collab_document_replicas ADD COLUMN snapshot_commit_token TEXT;
