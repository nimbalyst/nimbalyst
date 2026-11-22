/**
 * Unit tests for the Epic H1 client-side access resolver (`canAccess`).
 *
 * Runs against a real SQLiteDatabase + migration 0013 schema (the newer, more
 * divergent backend), proving the plain-column SQL works end to end. The
 * resolver uses no `data->'k'` JSON sub-extraction, so PGLite returns identical
 * shapes (DATABASE.md parity) — covered by the schema mirror in worker.js.
 */

import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { asTeamMemberId } from '@nimbalyst/runtime/auth/jwtScopes';

vi.mock('electron', async () => ({
  app: {
    getPath: (await import('../../../../test-stubs/privateUserData')).testApp.getPath,
    getName: vi.fn(() => 'test-app'),
    getVersion: vi.fn(() => '1.0.0'),
    on: vi.fn(),
  },
}));

import { SQLiteDatabase } from '../../database/sqlite/SQLiteDatabase';
import { canAccess } from '../OrgAccessResolver';

const teamViewer = (memberId: string) => ({ teamMemberId: asTeamMemberId(memberId) });

const SCHEMA_DIR = path.resolve(__dirname, '..', '..', 'database', 'sqlite', 'schemas');

describe('canAccess resolver (SQLite backend, migration 0013)', () => {
  let tmp: string;
  let db: SQLiteDatabase;

  beforeEach(async () => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'nim-access-'));
    db = new SQLiteDatabase({
      dbDir: path.join(tmp, 'sqlite-db'),
      schemaDir: SCHEMA_DIR,
      slowQueryThresholdMs: 1000,
      sampleRate: 0,
    });
    await db.initialize();

    // Seed: org "o" with administrators, a member, a viewer, and an unknown role.
    await db.query(`INSERT INTO orgs (id, stytch_org_id, slug, flavor) VALUES ('o','s-o','acme','team')`);
    await db.query(`INSERT INTO projects (id, org_id, slug, git_origin_hash) VALUES ('p1','o','web','gh1')`);
    await db.query(`INSERT INTO org_members (org_id, user_id, role) VALUES ('o','owner1','owner')`);
    await db.query(`INSERT INTO org_members (org_id, user_id, role) VALUES ('o','admin1','admin')`);
    await db.query(`INSERT INTO org_members (org_id, user_id, role) VALUES ('o','member1','member')`);
    await db.query(`INSERT INTO org_members (org_id, user_id, role) VALUES ('o','viewer1','viewer')`);
    await db.query(`INSERT INTO org_members (org_id, user_id, role) VALUES ('o','future1','future-role')`);
  });

  afterEach(async () => {
    await db.close();
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it('denies a user not in the org roster', async () => {
    const r = await canAccess(db, teamViewer('stranger'), { orgId: 'o', projectId: 'p1', action: 'view' });
    expect(r.allowed).toBe(false);
    expect(r.orgRole).toBeNull();
    expect(r.reason).toBe('not-a-member');
  });

  it('grants an org owner admin on any project (implicit project-admin)', async () => {
    const r = await canAccess(db, teamViewer('owner1'), { orgId: 'o', projectId: 'p1', action: 'admin' });
    expect(r.allowed).toBe(true);
    expect(r.orgRole).toBe('owner');
    expect(r.projectRole).toBe('project-admin');
  });

  it('grants an org admin admin on any project', async () => {
    const r = await canAccess(db, teamViewer('admin1'), { orgId: 'o', projectId: 'p1', action: 'admin' });
    expect(r.allowed).toBe(true);
  });

  it('lets a member view/edit org-level content but not administer it', async () => {
    expect((await canAccess(db, teamViewer('member1'), { orgId: 'o', action: 'view' })).allowed).toBe(true);
    expect((await canAccess(db, teamViewer('member1'), { orgId: 'o', action: 'edit' })).allowed).toBe(true);
    expect((await canAccess(db, teamViewer('member1'), { orgId: 'o', action: 'admin' })).allowed).toBe(false);
  });

  it('keeps an organization viewer read-only for org-level content', async () => {
    expect((await canAccess(db, teamViewer('viewer1'), { orgId: 'o', action: 'view' })).allowed).toBe(true);
    const edit = await canAccess(db, teamViewer('viewer1'), { orgId: 'o', action: 'edit' });
    expect(edit.allowed).toBe(false);
    expect(edit.orgRole).toBe('viewer');
    expect(edit.reason).toBe('org-level-read-only-role');
  });

  it('denies a member on a project with no grant', async () => {
    const r = await canAccess(db, teamViewer('member1'), { orgId: 'o', projectId: 'p1', action: 'view' });
    expect(r.allowed).toBe(false);
    expect(r.orgRole).toBe('member');
    expect(r.reason).toBe('no-project-grant');
  });

  it('honors a project-editor grant for view/edit but not admin', async () => {
    await db.query(`INSERT INTO project_access (project_id, user_id, project_role) VALUES ('p1','member1','project-editor')`);
    expect((await canAccess(db, teamViewer('member1'), { orgId: 'o', projectId: 'p1', action: 'view' })).allowed).toBe(true);
    expect((await canAccess(db, teamViewer('member1'), { orgId: 'o', projectId: 'p1', action: 'edit' })).allowed).toBe(true);
    const adminR = await canAccess(db, teamViewer('member1'), { orgId: 'o', projectId: 'p1', action: 'admin' });
    expect(adminR.allowed).toBe(false);
    expect(adminR.reason).toBe('insufficient-project-role');
  });

  it('lets a project-commenter grant view and comment but never edit', async () => {
    await db.query(`INSERT INTO project_access (project_id, user_id, project_role) VALUES ('p1','member1','project-commenter')`);
    const view = await canAccess(db, teamViewer('member1'), { orgId: 'o', projectId: 'p1', action: 'view' });
    expect(view.allowed).toBe(true);
    expect(view.projectRole).toBe('project-commenter');
    expect((await canAccess(db, teamViewer('member1'), { orgId: 'o', projectId: 'p1', action: 'comment' })).allowed).toBe(true);
    const edit = await canAccess(db, teamViewer('member1'), { orgId: 'o', projectId: 'p1', action: 'edit' });
    expect(edit.allowed).toBe(false);
    expect(edit.projectRole).toBe('project-commenter');
    expect(edit.reason).toBe('insufficient-project-role');
  });

  it('ranks comment above view and below edit for the other project roles', async () => {
    await db.query(`INSERT INTO project_access (project_id, user_id, project_role) VALUES ('p1','member1','project-editor')`);
    expect((await canAccess(db, teamViewer('member1'), { orgId: 'o', projectId: 'p1', action: 'comment' })).allowed).toBe(true);
    await db.query(`INSERT INTO org_members (org_id, user_id, role) VALUES ('o','member2','member')`);
    await db.query(`INSERT INTO project_access (project_id, user_id, project_role) VALUES ('p1','member2','project-viewer')`);
    const viewerComment = await canAccess(db, teamViewer('member2'), { orgId: 'o', projectId: 'p1', action: 'comment' });
    expect(viewerComment.allowed).toBe(false);
    expect(viewerComment.reason).toBe('insufficient-project-role');
  });

  it('caps a commenter grant at the organization viewer ceiling', async () => {
    await db.query(`INSERT INTO project_access (project_id, user_id, project_role) VALUES ('p1','viewer1','project-commenter')`);
    const comment = await canAccess(db, teamViewer('viewer1'), { orgId: 'o', projectId: 'p1', action: 'comment' });
    expect(comment.allowed).toBe(false);
    expect(comment.projectRole).toBe('project-viewer');
    expect(comment.reason).toBe('org-role-ceiling');
  });

  it('allows org-level comments for a member but not an organization viewer', async () => {
    expect((await canAccess(db, teamViewer('member1'), { orgId: 'o', action: 'comment' })).allowed).toBe(true);
    const viewer = await canAccess(db, teamViewer('viewer1'), { orgId: 'o', action: 'comment' });
    expect(viewer.allowed).toBe(false);
    expect(viewer.reason).toBe('org-level-read-only-role');
  });

  it('gives a guest no org-level access and never edit rights on a project', async () => {
    await db.query(`INSERT INTO org_members (org_id, user_id, role) VALUES ('o','guest1','guest')`);
    const orgLevel = await canAccess(db, teamViewer('guest1'), { orgId: 'o', action: 'view' });
    expect(orgLevel.allowed).toBe(false);
    expect(orgLevel.reason).toBe('org-level-guest');
    // No grant: nothing.
    expect((await canAccess(db, teamViewer('guest1'), { orgId: 'o', projectId: 'p1', action: 'view' })).allowed).toBe(false);

    // A commenter grant: read and comment, never edit.
    await db.query(`INSERT INTO project_access (project_id, user_id, project_role) VALUES ('p1','guest1','project-commenter')`);
    expect((await canAccess(db, teamViewer('guest1'), { orgId: 'o', projectId: 'p1', action: 'comment' })).allowed).toBe(true);
    expect((await canAccess(db, teamViewer('guest1'), { orgId: 'o', projectId: 'p1', action: 'edit' })).allowed).toBe(false);

    // An editor grant on a guest only reads.
    await db.query(`UPDATE project_access SET project_role = 'project-editor' WHERE user_id = 'guest1'`);
    const view = await canAccess(db, teamViewer('guest1'), { orgId: 'o', projectId: 'p1', action: 'view' });
    expect(view.allowed).toBe(true);
    expect(view.projectRole).toBe('project-viewer');
    const comment = await canAccess(db, teamViewer('guest1'), { orgId: 'o', projectId: 'p1', action: 'comment' });
    expect(comment.allowed).toBe(false);
    expect(comment.reason).toBe('org-role-ceiling');
  });

  it('caps a project-viewer grant at view only', async () => {
    await db.query(`INSERT INTO project_access (project_id, user_id, project_role) VALUES ('p1','viewer1','project-viewer')`);
    expect((await canAccess(db, teamViewer('viewer1'), { orgId: 'o', projectId: 'p1', action: 'view' })).allowed).toBe(true);
    expect((await canAccess(db, teamViewer('viewer1'), { orgId: 'o', projectId: 'p1', action: 'edit' })).allowed).toBe(false);
  });

  it('caps a viewer project grant at the organization read-only ceiling', async () => {
    await db.query(`INSERT INTO project_access (project_id, user_id, project_role) VALUES ('p1','viewer1','project-admin')`);
    const view = await canAccess(db, teamViewer('viewer1'), { orgId: 'o', projectId: 'p1', action: 'view' });
    expect(view.allowed).toBe(true);
    expect(view.projectRole).toBe('project-viewer');
    const edit = await canAccess(db, teamViewer('viewer1'), { orgId: 'o', projectId: 'p1', action: 'edit' });
    expect(edit.allowed).toBe(false);
    expect(edit.projectRole).toBe('project-viewer');
    expect(edit.reason).toBe('org-role-ceiling');
  });

  it('treats an unrecognized organization role as least-privileged', async () => {
    await db.query(`INSERT INTO project_access (project_id, user_id, project_role) VALUES ('p1','future1','project-admin')`);
    expect((await canAccess(db, teamViewer('future1'), { orgId: 'o', action: 'view' })).allowed).toBe(true);
    expect((await canAccess(db, teamViewer('future1'), { orgId: 'o', action: 'edit' })).allowed).toBe(false);
    const project = await canAccess(db, teamViewer('future1'), { orgId: 'o', projectId: 'p1', action: 'edit' });
    expect(project.allowed).toBe(false);
    expect(project.orgRole).toBe('unknown');
    expect(project.projectRole).toBe('project-viewer');
  });

  it('derives the org from the project when orgId is omitted', async () => {
    await db.query(`INSERT INTO project_access (project_id, user_id, project_role) VALUES ('p1','member1','project-admin')`);
    const r = await canAccess(db, teamViewer('member1'), { projectId: 'p1', action: 'admin' });
    expect(r.allowed).toBe(true);
    expect(r.orgRole).toBe('member');
    expect(r.projectRole).toBe('project-admin');
  });

  it('denies when the project does not exist', async () => {
    const r = await canAccess(db, teamViewer('owner1'), { projectId: 'ghost', action: 'view' });
    expect(r.allowed).toBe(false);
    expect(r.reason).toBe('unknown-project');
  });
});
