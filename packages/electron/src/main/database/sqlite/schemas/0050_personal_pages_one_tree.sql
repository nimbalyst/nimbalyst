-- ----------------------------------------------------------------------------
-- 0050_personal_pages_one_tree
--
-- Personal pages become one page tree: any page can hold child pages, and a
-- typed page (a tracker item) can be placed under any page.
--
-- 1. Every personal folder becomes a page: a markdown document with the same
--    id, the folder's name as its title, the same parent and an empty body.
--    Documents and type placements that named the folder as their parent keep
--    the same id, which now names the page.
-- 2. The folder rows are NOT deleted. `converted_at` marks each one once its
--    page exists, so the table stays as a recoverable record of the old tree
--    and a later pass never converts a folder twice (or resurrects a page the
--    user deleted). Only the page is read after this migration.
-- 3. `personal_page_item_placements`: where a typed page sits in the tree. No
--    row means it sits under its type.
--
-- The runner applies this file in one transaction, so the pages and the marks
-- land together or not at all. A document that already holds a folder's id is
-- left untouched (ON CONFLICT DO NOTHING).
--
-- PGLite mirror: worker.js, "Mirror of SQLite migration 0050". It runs on every
-- launch, which is safe because only unmarked folders are converted.
-- ----------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS personal_page_item_placements (
  workspace_path TEXT NOT NULL,
  item_id        TEXT NOT NULL,
  parent_id      TEXT,
  sort_order     REAL NOT NULL DEFAULT 0,
  created_at     TEXT NOT NULL,
  updated_at     TEXT NOT NULL,
  PRIMARY KEY (workspace_path, item_id)
);

ALTER TABLE personal_page_folders ADD COLUMN converted_at TEXT;

INSERT INTO personal_page_documents
  (workspace_path, document_id, title, document_type, editor_id, file_extension,
   metadata_version, parent_folder_id, body, body_version, publication_status,
   created_at, updated_at)
SELECT workspace_path, folder_id, name, 'markdown', NULL, NULL,
       NULL, parent_folder_id, '', 0, 'local',
       created_at, updated_at
FROM personal_page_folders
WHERE converted_at IS NULL
ON CONFLICT (workspace_path, document_id) DO NOTHING;

UPDATE personal_page_folders
SET converted_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
WHERE converted_at IS NULL
  AND EXISTS (
    SELECT 1 FROM personal_page_documents d
    WHERE d.workspace_path = personal_page_folders.workspace_path
      AND d.document_id = personal_page_folders.folder_id
  );
