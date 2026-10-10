-- ----------------------------------------------------------------------------
-- 0051_personal_pages_parents_and_order
--
-- Typed pages (tracker items) become parents, and pages get one sibling order
-- with types and typed pages.
--
-- 1. `parent_kind` beside every parent column: 'page' (the parent id names a
--    page, as before) or 'item' (it names a tracker item). Existing rows are
--    pages, so the default keeps them as they were.
-- 2. `personal_page_documents.sort_order`: a page's order among its siblings.
--    NULL until the group is first reordered; existing pages keep NULL and so
--    display exactly as before.
--
-- Columns only: no row is rewritten or removed.
--
-- PGLite mirror: worker.js, "Mirror of SQLite migration 0051". It runs on every
-- launch, which is safe because every statement is ADD COLUMN IF NOT EXISTS.
-- ----------------------------------------------------------------------------

ALTER TABLE personal_page_documents ADD COLUMN sort_order REAL;
ALTER TABLE personal_page_documents ADD COLUMN parent_kind TEXT NOT NULL DEFAULT 'page';
ALTER TABLE personal_page_type_placements ADD COLUMN parent_kind TEXT NOT NULL DEFAULT 'page';
ALTER TABLE personal_page_item_placements ADD COLUMN parent_kind TEXT NOT NULL DEFAULT 'page';
