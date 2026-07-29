/**
 * OrgAccessResolver — the single client-side access check (Epic H1).
 *
 * `canAccess(db, viewer, { orgId, projectId, action })` is the one permission
 * model that every collaborative surface (trackers, documents, extensions,
 * sessions) consults locally. It reads the local projection tables created by
 * migration 0013 (`orgs` / `org_members` / `projects` / `project_access`) — the
 * mirror of the server-authoritative per-org TeamRoom DO.
 *
 * This is a UX gate: it decides what the client shows/enables. The server gate
 * (collabv3 `can-access-content`) remains authoritative. The two implement the
 * SAME boolean policy so the client doesn't offer an action the server will 403:
 *   - not in the org roster                  -> deny
 *   - org owner/admin                        -> allow everything (implicit project-admin)
 *   - org viewer/unknown role                 -> read-only ceiling
 *   - member/guest + no project context       -> allow view/edit on org-level content, deny admin
 *   - member/guest + a project                -> their project_access grant (deny if none)
 *
 * Backend parity (DATABASE.md): every query here is a plain column SELECT with
 * `$n` placeholders — no `data->'k'` JSON sub-extraction — so PGLite and
 * better-sqlite3 return identical shapes. No defensive JSON parsing is needed.
 */

import { getDatabase } from '../database/initialize';

export type OrgRole = 'owner' | 'admin' | 'member' | 'viewer' | 'guest' | 'unknown';
export type ProjectRole = 'project-admin' | 'project-editor' | 'project-viewer';

/** What the viewer wants to do with the content. */
export type AccessAction = 'view' | 'edit' | 'admin';

export interface CanAccessInput {
  /** Org being accessed. Optional if `projectId` is given (org is derived from it). */
  orgId?: string | null;
  /**
   * Project being accessed. Omit for org-level content (e.g. a document not
   * scoped to a single project) — matches the server treating no-project as
   * "org membership is the gate."
   */
  projectId?: string | null;
  action: AccessAction;
}

export interface CanAccessResult {
  allowed: boolean;
  /** The viewer's org role, or null if they are not in the roster. */
  orgRole: OrgRole | null;
  /**
   * The effective project role for this access: the explicit grant for a
   * member/guest, or 'project-admin' implied for an org owner/admin. Null when
   * there is no project context or no grant.
   */
  projectRole: ProjectRole | null;
  /** Short machine-ish reason, useful for logging/telemetry. */
  reason: string;
}

/** Minimal DB surface the resolver needs (PGLite or better-sqlite3). */
export interface AccessDatabase {
  query<T = unknown>(sql: string, params?: unknown[]): Promise<{ rows: T[] }>;
}

/** Rank a project role for action comparison. Higher = more capable. */
function projectRoleRank(role: ProjectRole | null): number {
  switch (role) {
    case 'project-admin': return 3;
    case 'project-editor': return 2;
    case 'project-viewer': return 1;
    default: return 0;
  }
}

/** Minimum project-role rank an action requires. */
function actionRank(action: AccessAction): number {
  switch (action) {
    case 'admin': return 3;
    case 'edit': return 2;
    case 'view': return 1;
  }
}

function normalizeOrgRole(role: string): OrgRole {
  switch (role) {
    case 'owner':
    case 'admin':
    case 'member':
    case 'viewer':
    case 'guest':
      return role;
    default:
      return 'unknown';
  }
}

/** Maximum project grant rank an organization role may exercise. */
function orgRoleProjectCeilingRank(role: OrgRole): number {
  return role === 'viewer' || role === 'unknown' ? 1 : 3;
}

function projectRoleForRank(rank: number): ProjectRole | null {
  switch (rank) {
    case 3: return 'project-admin';
    case 2: return 'project-editor';
    case 1: return 'project-viewer';
    default: return null;
  }
}

function deny(orgRole: OrgRole | null, reason: string): CanAccessResult {
  return { allowed: false, orgRole, projectRole: null, reason };
}

/**
 * Resolve whether `viewerUserId` may perform `action` on the given org/project,
 * reading the local projection. Pure over `db` so it can be unit-tested against
 * either backend.
 */
export async function canAccess(
  db: AccessDatabase,
  viewerUserId: string,
  input: CanAccessInput,
): Promise<CanAccessResult> {
  if (!viewerUserId) return deny(null, 'no-viewer');

  // Resolve the org. Prefer an explicit orgId; otherwise derive it from the
  // project. Without either we cannot answer.
  let orgId = input.orgId ?? null;
  const projectId = input.projectId ?? null;
  if (!orgId && projectId) {
    const projRows = await db.query<{ org_id: string }>(
      `SELECT org_id FROM projects WHERE id = $1`,
      [projectId],
    );
    orgId = projRows.rows[0]?.org_id ?? null;
    if (!orgId) return deny(null, 'unknown-project');
  }
  if (!orgId) return deny(null, 'no-org');

  // Roster check: not a member -> hard deny (mirrors the server).
  const memberRows = await db.query<{ role: string }>(
    `SELECT role FROM org_members WHERE org_id = $1 AND user_id = $2`,
    [orgId, viewerUserId],
  );
  const rawOrgRole = memberRows.rows[0]?.role ?? null;
  if (!rawOrgRole) return deny(null, 'not-a-member');
  const orgRole = normalizeOrgRole(rawOrgRole);

  // Org owner/admin: implicit project-admin on every project; all actions allow.
  if (orgRole === 'owner' || orgRole === 'admin') {
    return { allowed: true, orgRole, projectRole: 'project-admin', reason: 'org-admin' };
  }

  // Non-admin without a project context: viewer/unknown roles are read-only;
  // member/guest roles may view/edit. Admin requires an org admin/owner.
  if (!projectId) {
    if (input.action === 'admin') return deny(orgRole, 'org-level-admin-requires-admin');
    if (input.action === 'edit' && orgRoleProjectCeilingRank(orgRole) < 2) {
      return deny(orgRole, 'org-level-read-only-role');
    }
    return { allowed: true, orgRole, projectRole: null, reason: 'org-member' };
  }

  // A project grant cannot exceed the enclosing organization role's ceiling.
  const grantRows = await db.query<{ project_role: string }>(
    `SELECT project_role FROM project_access WHERE project_id = $1 AND user_id = $2`,
    [projectId, viewerUserId],
  );
  const rawGrant = grantRows.rows[0]?.project_role ?? null;
  if (!rawGrant) return deny(orgRole, 'no-project-grant');

  const grantRank = projectRoleRank(rawGrant as ProjectRole);
  const effectiveRank = Math.min(grantRank, orgRoleProjectCeilingRank(orgRole));
  const projectRole = projectRoleForRank(effectiveRank);
  const allowed = effectiveRank >= actionRank(input.action);
  return {
    allowed,
    orgRole,
    projectRole,
    reason: allowed
      ? 'project-grant'
      : grantRank >= actionRank(input.action) && effectiveRank < grantRank
        ? 'org-role-ceiling'
        : 'insufficient-project-role',
  };
}

/**
 * Convenience wrapper over the live app database. Returns a deny result if the
 * database is not yet initialized (fail-closed for the UX gate).
 */
export async function canAccessLive(
  viewerUserId: string,
  input: CanAccessInput,
): Promise<CanAccessResult> {
  const db = getDatabase() as AccessDatabase | null;
  if (!db) return deny(null, 'db-unavailable');
  return canAccess(db, viewerUserId, input);
}
