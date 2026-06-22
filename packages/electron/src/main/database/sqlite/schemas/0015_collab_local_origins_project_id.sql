-- Epic H3 P0: project-scope local shared-document bindings.
--
-- The server now tags each shared document with the project it belongs to
-- (collabv3 TeamRoom document_index.project_id), so a project move can answer
-- "which docs travel with this project." This adds the matching local column to
-- collab_local_origins (the local mirror of shared documents). NULL means the
-- org's primary project (legacy rows), matching the server read-time default.
--
-- project_id holds the server's tracker-room routing key (teamProjectId), the
-- same value used to scope tracker rooms and project_access grants.
--
-- Backend divergence: this is the SQLite schema. The PGLite equivalent is added
-- in worker.js (ALTER TABLE ... ADD COLUMN project_id TEXT).

ALTER TABLE collab_local_origins ADD COLUMN project_id TEXT;

CREATE INDEX IF NOT EXISTS idx_collab_local_origins_project_id
  ON collab_local_origins(project_id);
