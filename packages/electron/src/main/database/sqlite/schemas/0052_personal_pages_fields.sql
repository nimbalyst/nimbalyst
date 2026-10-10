-- ----------------------------------------------------------------------------
-- 0052_personal_pages_fields
--
-- A plain page's own fields (owner, status, summary, tags), as JSON text.
-- NULL means none set. TEXT rather than JSON so PGLite and SQLite read the
-- same string; the service parses and validates it (`normalizePageFields`).
--
-- Column only: no row is rewritten or removed.
--
-- PGLite mirror: worker.js, "Mirror of SQLite migration 0052". It runs on every
-- launch, which is safe because the statement is ADD COLUMN IF NOT EXISTS.
-- ----------------------------------------------------------------------------

ALTER TABLE personal_page_documents ADD COLUMN fields TEXT;
