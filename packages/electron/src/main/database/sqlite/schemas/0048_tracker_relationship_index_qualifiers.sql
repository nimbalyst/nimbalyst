-- ----------------------------------------------------------------------------
-- 0048_tracker_relationship_index_qualifiers
--
-- Each relationship edge carries a qualifier bag (level, note, asOf, source,
-- ...). The index stores it so a view reads an edge's qualifiers without
-- loading the source item, and the field's predicate id so a reader can compute
-- the recheck date from the predicate's `recheckAfterDays`.
--
-- Rows written before this migration have NULL in both columns until their
-- item is reindexed; the index is a rebuildable projection, so the first full
-- rebuild fills them.
--
-- PGLite mirror: worker.js, relationship index section (JSONB + ADD COLUMN IF
-- NOT EXISTS). Here qualifiers is JSON TEXT; always JSON.parse a string.
-- ----------------------------------------------------------------------------

ALTER TABLE tracker_relationship_index ADD COLUMN qualifiers TEXT;
ALTER TABLE tracker_relationship_index ADD COLUMN predicate TEXT;
