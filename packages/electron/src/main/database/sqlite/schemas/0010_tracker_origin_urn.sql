-- ----------------------------------------------------------------------------
-- 0010_tracker_origin_urn
--
-- External-source importers: tracker items imported from GitHub/Linear/etc.
-- carry a structured origin under data.origin. For imported items the URN
-- (data.origin.external.urn) is the stable identity used to dedup re-imports
-- and to resolve a local item from an external URN (tracker_get_by_urn).
--
-- We index the URN as an expression index rather than adding a STORED
-- generated column: SQLite's ALTER TABLE cannot add STORED generated columns,
-- and an expression index on the same JSON path is usable by the equality
-- lookups the importer registry runs. The matching PGLite expression index is
-- created idempotently in worker.js so both backends accelerate the same query.
--
-- `->`/`->>` chaining is supported by the bundled SQLite (>= 3.38). The
-- expression here MUST match the lookup expression used at the callsite for the
-- planner to use the index.
-- ----------------------------------------------------------------------------

CREATE INDEX IF NOT EXISTS idx_tracker_origin_urn
  ON tracker_items (data->'origin'->'external'->>'urn');
