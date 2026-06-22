/**
 * Unit tests for the Epic H1 local-projection writer (OrgProjectionService).
 *
 * Runs against a real SQLiteDatabase + migration 0013 (the newer backend) and
 * verifies that the backfill mints the projection and the reconcile apply
 * methods write through, end-to-end with the canAccess resolver. Plain-column
 * SQL only -> PGLite parity via the worker.js schema mirror.
 */

import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

vi.mock('electron', () => ({
  app: {
    getPath: vi.fn(() => '/mock/path'),
    getName: vi.fn(() => 'test-app'),
    getVersion: vi.fn(() => '1.0.0'),
    on: vi.fn(),
  },
}));

import { SQLiteDatabase } from '../../database/sqlite/SQLiteDatabase';
import {
  backfillProjection,
  applyMemberUpserted,
  applyMemberRemoved,
  applyMemberRoleChanged,
  applyProjectGrant,
  applyProjectRevoke,
  upsertProject,
} from '../OrgProjectionService';
import { canAccess } from '../OrgAccessResolver';

const SCHEMA_DIR = path.resolve(__dirname, '..', '..', 'database', 'sqlite', 'schemas');

describe('OrgProjectionService (SQLite backend, migration 0013)', () => {
  let tmp: string;
  let db: SQLiteDatabase;

  beforeEach(async () => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'nim-proj-'));
    db = new SQLiteDatabase({
      dbDir: path.join(tmp, 'sqlite-db'),
      schemaDir: SCHEMA_DIR,
      slowQueryThresholdMs: 1000,
      sampleRate: 0,
    });
    await db.initialize();
  });

  afterEach(async () => {
    await db.close();
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it('backfills orgs/projects/members/grants from the roster', async () => {
    const counts = await backfillProjection(db, [
      {
        org: { orgId: 'org-aaaaaa', name: 'Acme Team', flavor: 'team', teamProjectId: 'proj-1', gitOriginHash: 'gh1' },
        members: [
          { userId: 'owner1', email: 'o@x.io', role: 'owner' },
          { userId: 'member1', email: 'm@x.io', role: 'member' },
          { userId: 'guest1', role: 'guest' },
        ],
      },
    ]);
    expect(counts).toEqual({ orgs: 1, projects: 1, members: 3, grants: 3 });

    // Org + project landed.
    const org = await db.query<{ flavor: string; stytch_org_id: string }>(
      `SELECT flavor, stytch_org_id FROM orgs WHERE id = 'org-aaaaaa'`);
    expect(org.rows[0]).toEqual({ flavor: 'team', stytch_org_id: 'org-aaaaaa' });
    const proj = await db.query<{ org_id: string; git_origin_hash: string }>(
      `SELECT org_id, git_origin_hash FROM projects WHERE id = 'proj-1'`);
    expect(proj.rows[0]).toEqual({ org_id: 'org-aaaaaa', git_origin_hash: 'gh1' });

    // Grants are role-derived (mirror the server backfill).
    const grants = await db.query<{ user_id: string; project_role: string }>(
      `SELECT user_id, project_role FROM project_access WHERE project_id = 'proj-1' ORDER BY user_id`);
    const byUser = new Map(grants.rows.map(g => [g.user_id, g.project_role]));
    expect(byUser.get('owner1')).toBe('project-admin');
    expect(byUser.get('member1')).toBe('project-editor');
    expect(byUser.get('guest1')).toBe('project-viewer');

    // End-to-end through the resolver: the member can edit the project.
    const r = await canAccess(db, 'member1', { projectId: 'proj-1', action: 'edit' });
    expect(r.allowed).toBe(true);
    expect(r.projectRole).toBe('project-editor');
  });

  it('is idempotent and refreshes mutable fields on re-run', async () => {
    const orgs = [{
      org: { orgId: 'org-bbbbbb', name: 'Beta', flavor: 'team' as const, teamProjectId: 'proj-2', gitOriginHash: 'gh-old' },
      members: [{ userId: 'm1', role: 'member' }],
    }];
    await backfillProjection(db, orgs);
    orgs[0].org.gitOriginHash = 'gh-new';
    await backfillProjection(db, orgs);

    const proj = await db.query<{ git_origin_hash: string }>(
      `SELECT git_origin_hash FROM projects WHERE id = 'proj-2'`);
    expect(proj.rows[0].git_origin_hash).toBe('gh-new');
    const orgCount = await db.query<{ c: number }>(`SELECT COUNT(*) AS c FROM orgs`);
    expect(orgCount.rows[0].c).toBe(1);
  });

  it('write-through reconcile: add, role-change, grant, revoke, remove', async () => {
    await backfillProjection(db, [{
      org: { orgId: 'org-cccccc', name: 'Gamma', flavor: 'team', teamProjectId: 'proj-3' },
      members: [{ userId: 'owner1', role: 'owner' }],
    }]);

    // New member added via DO broadcast.
    await applyMemberUpserted(db, 'org-cccccc', { userId: 'newbie', email: 'n@x.io', role: 'member' });
    expect((await canAccess(db, 'newbie', { orgId: 'org-cccccc', action: 'view' })).allowed).toBe(true);
    // No project grant yet -> denied on the project.
    expect((await canAccess(db, 'newbie', { projectId: 'proj-3', action: 'view' })).allowed).toBe(false);

    // Grant broadcast.
    await applyProjectGrant(db, 'proj-3', 'newbie', 'project-viewer');
    expect((await canAccess(db, 'newbie', { projectId: 'proj-3', action: 'view' })).allowed).toBe(true);
    expect((await canAccess(db, 'newbie', { projectId: 'proj-3', action: 'edit' })).allowed).toBe(false);

    // Role bumped to admin -> implicit project-admin.
    await applyMemberRoleChanged(db, 'org-cccccc', 'newbie', 'admin');
    expect((await canAccess(db, 'newbie', { projectId: 'proj-3', action: 'admin' })).allowed).toBe(true);

    // Revoke the explicit grant (admin still allowed via org role).
    await applyProjectRevoke(db, 'proj-3', 'newbie');
    expect((await canAccess(db, 'newbie', { projectId: 'proj-3', action: 'admin' })).allowed).toBe(true);

    // Remove the member entirely -> denied everywhere; grants cleaned up.
    await applyMemberRoleChanged(db, 'org-cccccc', 'newbie', 'member');
    await applyProjectGrant(db, 'proj-3', 'newbie', 'project-editor');
    await applyMemberRemoved(db, 'org-cccccc', 'newbie');
    expect((await canAccess(db, 'newbie', { orgId: 'org-cccccc', action: 'view' })).allowed).toBe(false);
    const leftover = await db.query<{ c: number }>(
      `SELECT COUNT(*) AS c FROM project_access WHERE user_id = 'newbie'`);
    expect(leftover.rows[0].c).toBe(0);
  });

  it('H3 P0: upsertProject adds a SECOND project to an org without slug collision', async () => {
    await backfillProjection(db, [{
      org: { orgId: 'org-dddddd', name: 'Delta', flavor: 'team', teamProjectId: 'proj-primary', gitOriginHash: 'gh-a' },
      members: [{ userId: 'owner1', role: 'owner' }],
    }]);

    // Add a second project under the same org (Epic H3 P0).
    await upsertProject(db, {
      projectId: 'proj-second', orgId: 'org-dddddd', slug: 'Second Project', gitOriginHash: 'gh-b',
    });

    const projects = await db.query<{ id: string; slug: string; git_origin_hash: string }>(
      `SELECT id, slug, git_origin_hash FROM projects WHERE org_id = 'org-dddddd' ORDER BY id`);
    expect(projects.rows.length).toBe(2);
    const byId = new Map(projects.rows.map(r => [r.id, r]));
    expect(byId.get('proj-primary')!.slug).toBe('main');
    expect(byId.get('proj-second')!.slug).toBe('second-project');
    expect(byId.get('proj-second')!.git_origin_hash).toBe('gh-b');

    // A second add without a slug falls back to a project-id-derived unique slug.
    await upsertProject(db, { projectId: 'proj-third', orgId: 'org-dddddd' });
    const third = await db.query<{ slug: string }>(
      `SELECT slug FROM projects WHERE id = 'proj-third'`);
    expect(third.rows[0].slug).toBe('project-' + 'proj-third'.slice(-6));
  });
});
