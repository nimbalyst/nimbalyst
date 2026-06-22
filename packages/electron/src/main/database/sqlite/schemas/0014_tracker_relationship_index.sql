-- Derived relationship index (Epic C Phase 2).
--
-- Relationship FIELDS are the canonical write model: a relationship value lives
-- inside the owning tracker item's JSON `data` and syncs on the metadata socket
-- exactly like `labels` (see tracker-relationships-design.md). This table is a
-- LOCAL-ONLY projection of those field values so reverse lookup ("what blocks
-- NIM-123?") and backlinks do not require scanning every item on every paint.
--
-- It is rebuildable from item JSON + schema at any time and is NEVER put on the
-- wire (no sync columns). Deleting an item's payload makes its outgoing rows go
-- away; incoming rows that point at it become danglers (rendered as tombstone
-- pills) -- there is nothing to cascade-clean server-side.
--
-- Backend divergence: this is the SQLite schema. The PGLite equivalent lives in
-- worker.js createSchemas() (uses TIMESTAMPTZ + JSONB); here timestamps are
-- ISO-8601 TEXT and metadata is JSON TEXT (DATABASE.md parity: always JSON.parse
-- a string).

CREATE TABLE IF NOT EXISTS tracker_relationship_index (
  id                    TEXT PRIMARY KEY,     -- ${workspace}|${source}|${field}|${target}
  workspace             TEXT NOT NULL,
  source_item_id        TEXT NOT NULL,
  source_field_id       TEXT NOT NULL,
  relationship_type_key TEXT,
  target_item_id        TEXT NOT NULL,
  target_tracker_type   TEXT,
  source_updated_at     TEXT,                 -- ISO-8601
  metadata              TEXT NOT NULL DEFAULT '{}'  -- JSON TEXT
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_tracker_rel_index_unique
  ON tracker_relationship_index (workspace, source_item_id, source_field_id, target_item_id);
CREATE INDEX IF NOT EXISTS idx_tracker_rel_index_source
  ON tracker_relationship_index (workspace, source_item_id);
CREATE INDEX IF NOT EXISTS idx_tracker_rel_index_target
  ON tracker_relationship_index (workspace, target_item_id);
CREATE INDEX IF NOT EXISTS idx_tracker_rel_index_type
  ON tracker_relationship_index (workspace, relationship_type_key);
