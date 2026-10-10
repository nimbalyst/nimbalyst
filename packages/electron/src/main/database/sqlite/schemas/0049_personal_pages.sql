-- ----------------------------------------------------------------------------
-- 0049_personal_pages
--
-- Personal pages: folders, documents and tracker-type placements that live
-- only on this machine, per workspace, and work with no account. Documents use
-- the shared-docs model (same ids, title, type metadata) so a later promotion
-- to the team can keep the id; `publication_status` stays 'local' until then.
-- The markdown body is stored inline with a monotonically increasing version
-- used for optimistic concurrency.
--
-- PGLite mirror: worker.js, "Mirror of SQLite migration 0049". Timestamps are
-- TEXT here (ISO-8601) and TIMESTAMPTZ there; read them through toMillis().
-- ----------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS personal_page_folders (
  workspace_path   TEXT NOT NULL,
  folder_id        TEXT NOT NULL,
  parent_folder_id TEXT,
  name             TEXT NOT NULL,
  sort_order       REAL NOT NULL DEFAULT 0,
  created_at       TEXT NOT NULL,
  updated_at       TEXT NOT NULL,
  PRIMARY KEY (workspace_path, folder_id)
);

CREATE TABLE IF NOT EXISTS personal_page_documents (
  workspace_path     TEXT NOT NULL,
  document_id        TEXT NOT NULL,
  title              TEXT NOT NULL,
  document_type      TEXT NOT NULL,
  editor_id          TEXT,
  file_extension     TEXT,
  metadata_version   INTEGER,
  parent_folder_id   TEXT,
  body               TEXT NOT NULL DEFAULT '',
  body_version       INTEGER NOT NULL DEFAULT 0,
  publication_status TEXT NOT NULL DEFAULT 'local',
  created_at         TEXT NOT NULL,
  updated_at         TEXT NOT NULL,
  trashed_at         TEXT,
  PRIMARY KEY (workspace_path, document_id)
);

CREATE TABLE IF NOT EXISTS personal_page_type_placements (
  workspace_path   TEXT NOT NULL,
  type_id          TEXT NOT NULL,
  parent_folder_id TEXT,
  sort_order       REAL NOT NULL DEFAULT 0,
  created_at       TEXT NOT NULL,
  updated_at       TEXT NOT NULL,
  PRIMARY KEY (workspace_path, type_id)
);
