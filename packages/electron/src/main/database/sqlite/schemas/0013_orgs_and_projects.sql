-- Org / Project / membership model (Epic H1).
--
-- These tables are the LOCAL projection of the server-authoritative per-org
-- TeamRoom Durable Object (member_roles + a new project_access table). The
-- client gates UX from this projection via a single `canAccess` check; the DO
-- remains the source of truth and is reconciled the same way trackers are.
--
-- Hierarchy is 2-level (Org -> Project); "team" is the paid org *flavor*, not an
-- entity. Project-scoped roles ship in v1; the `guest` org role is modeled now
-- but not surfaced in v1 UI (avoids a later migration).
--
-- Backend divergence: this is the SQLite schema. The PGLite equivalent lives in
-- worker.js createSchemas() and uses TIMESTAMPTZ; here timestamps are ISO-8601
-- TEXT (DATABASE.md: "PGLite TIMESTAMPTZ -> TEXT, written as Date.toISOString()").
-- No FK enforcement (matches the rest of this schema; SQLite needs PRAGMA
-- foreign_keys=ON, and these rows arrive out-of-order from DO reconciliation).

-- Orgs (1:1 with a Stytch B2B org). `id` is our internal canonical key so the
-- slug stays rename-safe.
CREATE TABLE IF NOT EXISTS orgs (
  id            TEXT PRIMARY KEY,
  stytch_org_id TEXT NOT NULL UNIQUE,
  slug          TEXT NOT NULL UNIQUE,
  flavor        TEXT NOT NULL,              -- 'personal' | 'team'
  created_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

-- Org membership = the seat + org-level role.
CREATE TABLE IF NOT EXISTS org_members (
  org_id     TEXT NOT NULL,                 -- -> orgs(id)
  user_id    TEXT NOT NULL,                 -- Stytch member id
  email      TEXT,
  role       TEXT NOT NULL DEFAULT 'member',-- owner | admin | member | guest
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  PRIMARY KEY (org_id, user_id)
);

-- Projects (app-DB only; never modeled in Stytch). git_origin_hash is a routing
-- hint, intentionally non-unique.
CREATE TABLE IF NOT EXISTS projects (
  id              TEXT PRIMARY KEY,
  org_id          TEXT NOT NULL,            -- -> orgs(id)
  slug            TEXT NOT NULL,            -- unique within org
  git_origin_hash TEXT,
  created_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  UNIQUE (org_id, slug)
);

-- Member -> Project access grant (the project member set is a subset of the org
-- roster). project_role is NOT NULL: a member/guest's rights in a project are
-- exactly this grant (org owner/admin get project-admin implicitly, in code).
CREATE TABLE IF NOT EXISTS project_access (
  project_id   TEXT NOT NULL,              -- -> projects(id)
  user_id      TEXT NOT NULL,
  project_role TEXT NOT NULL,              -- project-admin | project-editor | project-viewer
  created_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  PRIMARY KEY (project_id, user_id)
);

CREATE INDEX IF NOT EXISTS idx_org_members_user ON org_members (user_id);
CREATE INDEX IF NOT EXISTS idx_projects_org ON projects (org_id);
CREATE INDEX IF NOT EXISTS idx_projects_git_origin ON projects (git_origin_hash);
CREATE INDEX IF NOT EXISTS idx_project_access_user ON project_access (user_id);
