/**
 * OrgProjectionService — maintains the LOCAL projection of the org/project/
 * membership model (Epic H1) in the app DB tables created by migration 0013.
 *
 * The server-authoritative source is the per-org TeamRoom Durable Object
 * (member_roles + project_access). The client mirrors it into `orgs` /
 * `projects` / `org_members` / `project_access` so the single `canAccess`
 * resolver (OrgAccessResolver) can gate UX locally, the same way trackers keep
 * a local projection of their DO. This module owns the writes:
 *   - `backfillProjection` — one-time/launch reconcile from the team roster.
 *   - `applyMember*` / `applyProject*` — write-through for live DO broadcasts
 *     (memberAdded / memberRoleChanged / memberRemoved / project-access).
 *
 * Pure over a minimal DB interface so it can be unit-tested on either backend.
 * All SQL is plain-column (no `data->'k'` JSON sub-extraction), so PGLite and
 * better-sqlite3 behave identically (DATABASE.md parity). `EXCLUDED` is upper-
 * case (works on both backends; SQLite keywords are case-insensitive).
 */

export type OrgFlavor = 'personal' | 'team';
export type OrgRole = 'owner' | 'admin' | 'member' | 'guest';
export type ProjectRole = 'project-admin' | 'project-editor' | 'project-viewer';

export interface ProjectionDb {
  query<T = unknown>(sql: string, params?: unknown[]): Promise<{ rows: T[] }>;
}

export interface OrgInput {
  /** Stytch org id; used as the local canonical id AND stytch_org_id (1:1 mirror). */
  orgId: string;
  name: string;
  flavor: OrgFlavor;
  /** Server-minted project id (names the team's tracker room). The local project's id. */
  teamProjectId?: string | null;
  gitOriginHash?: string | null;
}

export interface MemberInput {
  userId: string;
  email?: string | null;
  role: string;
}

export interface OrgWithRoster {
  org: OrgInput;
  members: MemberInput[];
}

export interface BackfillCounts {
  orgs: number;
  projects: number;
  members: number;
  grants: number;
}

/** Map an org role to the project role the roster-derived seed uses. Mirrors
 *  the server's backfillProjectAccess so the two projections agree. */
export function defaultProjectRoleForOrgRole(orgRole: string): ProjectRole {
  if (orgRole === 'owner' || orgRole === 'admin') return 'project-admin';
  if (orgRole === 'guest') return 'project-viewer';
  return 'project-editor';
}

function nowIso(): string {
  return new Date().toISOString();
}

/** lowercase, hyphenated, ascii-only; empty falls back to 'org'. */
function slugify(s: string): string {
  const base = (s || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  return base || 'org';
}

/** Upsert an org row and (if a project id is known) its single project row. */
export async function upsertOrg(db: ProjectionDb, org: OrgInput): Promise<void> {
  const ts = nowIso();
  // orgs.slug is globally UNIQUE; suffix with the org id tail to guarantee it.
  const slug = `${slugify(org.name)}-${org.orgId.slice(-6)}`;
  await db.query(
    `INSERT INTO orgs (id, stytch_org_id, slug, flavor, created_at, updated_at)
     VALUES ($1, $2, $3, $4, $5, $5)
     ON CONFLICT (id) DO UPDATE SET
       stytch_org_id = EXCLUDED.stytch_org_id,
       slug = EXCLUDED.slug,
       flavor = EXCLUDED.flavor,
       updated_at = EXCLUDED.updated_at`,
    [org.orgId, org.orgId, slug, org.flavor, ts],
  );

  if (org.teamProjectId) {
    await db.query(
      `INSERT INTO projects (id, org_id, slug, git_origin_hash, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $5)
       ON CONFLICT (id) DO UPDATE SET
         org_id = EXCLUDED.org_id,
         git_origin_hash = EXCLUDED.git_origin_hash,
         updated_at = EXCLUDED.updated_at`,
      [org.teamProjectId, org.orgId, 'main', org.gitOriginHash ?? null, ts],
    );
  }
}

export interface ProjectInput {
  /** Server team_project_id; the local projects.id (names the tracker room). */
  projectId: string;
  orgId: string;
  /** Unique within the org. Defaults to a tail of the project id when omitted. */
  slug?: string | null;
  gitOriginHash?: string | null;
}

/**
 * Upsert one project row (Epic H3 P0: an org can now own many projects). Used
 * when a second/third project is added to an existing org, distinct from the
 * primary project that `upsertOrg` mirrors. Idempotent on projects.id.
 */
export async function upsertProject(db: ProjectionDb, p: ProjectInput): Promise<void> {
  const ts = nowIso();
  // projects has UNIQUE(org_id, slug); fall back to a stable per-project slug so
  // additional projects never collide with the primary's 'main'.
  const slug = p.slug && p.slug.trim() ? slugify(p.slug) : `project-${p.projectId.slice(-6)}`;
  await db.query(
    `INSERT INTO projects (id, org_id, slug, git_origin_hash, created_at, updated_at)
     VALUES ($1, $2, $3, $4, $5, $5)
     ON CONFLICT (id) DO UPDATE SET
       org_id = EXCLUDED.org_id,
       slug = EXCLUDED.slug,
       git_origin_hash = EXCLUDED.git_origin_hash,
       updated_at = EXCLUDED.updated_at`,
    [p.projectId, p.orgId, slug, p.gitOriginHash ?? null, ts],
  );
}

/** Upsert one membership. */
export async function applyMemberUpserted(db: ProjectionDb, orgId: string, m: MemberInput): Promise<void> {
  const ts = nowIso();
  await db.query(
    `INSERT INTO org_members (org_id, user_id, email, role, created_at, updated_at)
     VALUES ($1, $2, $3, $4, $5, $5)
     ON CONFLICT (org_id, user_id) DO UPDATE SET
       email = COALESCE(EXCLUDED.email, org_members.email),
       role = EXCLUDED.role,
       updated_at = EXCLUDED.updated_at`,
    [orgId, m.userId, m.email ?? null, m.role, ts],
  );
}

/** Remove a membership and any project grants the user held in that org. */
export async function applyMemberRemoved(db: ProjectionDb, orgId: string, userId: string): Promise<void> {
  await db.query(`DELETE FROM org_members WHERE org_id = $1 AND user_id = $2`, [orgId, userId]);
  // Drop the user's grants on this org's projects (keeps the projection tidy;
  // the resolver would deny anyway once the membership is gone).
  await db.query(
    `DELETE FROM project_access WHERE user_id = $1
       AND project_id IN (SELECT id FROM projects WHERE org_id = $2)`,
    [userId, orgId],
  );
}

/** Update just the org role of an existing (or new) membership. */
export async function applyMemberRoleChanged(db: ProjectionDb, orgId: string, userId: string, role: string): Promise<void> {
  const ts = nowIso();
  await db.query(
    `INSERT INTO org_members (org_id, user_id, role, created_at, updated_at)
     VALUES ($1, $2, $3, $4, $4)
     ON CONFLICT (org_id, user_id) DO UPDATE SET
       role = EXCLUDED.role,
       updated_at = EXCLUDED.updated_at`,
    [orgId, userId, role, ts],
  );
}

/** Upsert a project_access grant (write-through for a project-access broadcast). */
export async function applyProjectGrant(db: ProjectionDb, projectId: string, userId: string, projectRole: ProjectRole): Promise<void> {
  const ts = nowIso();
  await db.query(
    `INSERT INTO project_access (project_id, user_id, project_role, created_at)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (project_id, user_id) DO UPDATE SET
       project_role = EXCLUDED.project_role`,
    [projectId, userId, projectRole, ts],
  );
}

/** Revoke a project_access grant. */
export async function applyProjectRevoke(db: ProjectionDb, projectId: string, userId: string): Promise<void> {
  await db.query(`DELETE FROM project_access WHERE project_id = $1 AND user_id = $2`, [projectId, userId]);
}

/**
 * Seed project_access for a project from its org roster (role-derived). Mirrors
 * the server-side backfill: owner/admin -> project-admin, member -> editor,
 * guest -> viewer. Idempotent (does not clobber a grant set elsewhere).
 */
export async function seedProjectAccessFromRoster(
  db: ProjectionDb,
  projectId: string,
  members: MemberInput[],
): Promise<number> {
  const ts = nowIso();
  for (const m of members) {
    await db.query(
      `INSERT INTO project_access (project_id, user_id, project_role, created_at)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (project_id, user_id) DO NOTHING`,
      [projectId, m.userId, defaultProjectRoleForOrgRole(m.role), ts],
    );
  }
  return members.length;
}

/**
 * One-time / launch backfill: mint the local projection for a set of orgs and
 * their rosters. Idempotent — safe to run on every launch (upserts + DO NOTHING
 * grant seeding). Returns counts for logging.
 */
export async function backfillProjection(db: ProjectionDb, orgs: OrgWithRoster[]): Promise<BackfillCounts> {
  const counts: BackfillCounts = { orgs: 0, projects: 0, members: 0, grants: 0 };
  for (const { org, members } of orgs) {
    await upsertOrg(db, org);
    counts.orgs++;
    if (org.teamProjectId) counts.projects++;

    for (const m of members) {
      await applyMemberUpserted(db, org.orgId, m);
      counts.members++;
    }

    if (org.teamProjectId) {
      counts.grants += await seedProjectAccessFromRoster(db, org.teamProjectId, members);
    }
  }
  return counts;
}
