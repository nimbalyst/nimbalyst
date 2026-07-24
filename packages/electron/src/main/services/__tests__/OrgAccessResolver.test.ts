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

vi.mock('electron', () => ({
  app: {
    getPath: vi.fn(() => '/mock/path'),
    getName: vi.fn(() => 'test-app'),
    getVersion: vi.fn(() => '1.0.0'),
    on: vi.fn(),
  },
}));

import { SQLiteDatabase } from '../../database/sqlite/SQLiteDatabase';
import { canAccess } from '../OrgAccessResolver';

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

    // Seed: org "o" with an owner, an admin, a plain member, and a guest.
    await db.query(`INSERT INTO orgs (id, stytch_org_id, slug, flavor) VALUES ('o','s-o','acme','team')`);
    await db.query(`INSERT INTO projects (id, org_id, slug, git_origin_hash) VALUES ('p1','o','web','gh1')`);
    await db.query(`INSERT INTO org_members (org_id, user_id, role) VALUES ('o','owner1','owner')`);
    await db.query(`INSERT INTO org_members (org_id, user_id, role) VALUES ('o','admin1','admin')`);
    await db.query(`INSERT INTO org_members (org_id, user_id, role) VALUES ('o','member1','member')`);
    await db.query(`INSERT INTO org_members (org_id, user_id, role) VALUES ('o','viewer1','member')`);
  });

  afterEach(async () => {
    await db.close();
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it('denies a user not in the org roster', async () => {
    const r = await canAccess(db, 'stranger', { orgId: 'o', projectId: 'p1', action: 'view' });
    expect(r.allowed).toBe(false);
    expect(r.orgRole).toBeNull();
    expect(r.reason).toBe('not-a-member');
  });

  it('grants an org owner admin on any project (implicit project-admin)', async () => {
    const r = await canAccess(db, 'owner1', { orgId: 'o', projectId: 'p1', action: 'admin' });
    expect(r.allowed).toBe(true);
    expect(r.orgRole).toBe('owner');
    expect(r.projectRole).toBe('project-admin');
  });

  it('grants an org admin admin on any project', async () => {
    const r = await canAccess(db, 'admin1', { orgId: 'o', projectId: 'p1', action: 'admin' });
    expect(r.allowed).toBe(true);
  });

  it('lets a member view/edit org-level content but not administer it', async () => {
    expect((await canAccess(db, 'member1', { orgId: 'o', action: 'view' })).allowed).toBe(true);
    expect((await canAccess(db, 'member1', { orgId: 'o', action: 'edit' })).allowed).toBe(true);
    expect((await canAccess(db, 'member1', { orgId: 'o', action: 'admin' })).allowed).toBe(false);
  });

  it('denies a member on a project with no grant', async () => {
    const r = await canAccess(db, 'member1', { orgId: 'o', projectId: 'p1', action: 'view' });
    expect(r.allowed).toBe(false);
    expect(r.orgRole).toBe('member');
    expect(r.reason).toBe('no-project-grant');
  });

  it('honors a project-editor grant for view/edit but not admin', async () => {
    await db.query(`INSERT INTO project_access (project_id, user_id, project_role) VALUES ('p1','member1','project-editor')`);
    expect((await canAccess(db, 'member1', { orgId: 'o', projectId: 'p1', action: 'view' })).allowed).toBe(true);
    expect((await canAccess(db, 'member1', { orgId: 'o', projectId: 'p1', action: 'edit' })).allowed).toBe(true);
    const adminR = await canAccess(db, 'member1', { orgId: 'o', projectId: 'p1', action: 'admin' });
    expect(adminR.allowed).toBe(false);
    expect(adminR.reason).toBe('insufficient-project-role');
  });

  it('caps a project-viewer grant at view only', async () => {
    await db.query(`INSERT INTO project_access (project_id, user_id, project_role) VALUES ('p1','viewer1','project-viewer')`);
    expect((await canAccess(db, 'viewer1', { orgId: 'o', projectId: 'p1', action: 'view' })).allowed).toBe(true);
    expect((await canAccess(db, 'viewer1', { orgId: 'o', projectId: 'p1', action: 'edit' })).allowed).toBe(false);
  });

  it('derives the org from the project when orgId is omitted', async () => {
    await db.query(`INSERT INTO project_access (project_id, user_id, project_role) VALUES ('p1','member1','project-admin')`);
    const r = await canAccess(db, 'member1', { projectId: 'p1', action: 'admin' });
    expect(r.allowed).toBe(true);
    expect(r.orgRole).toBe('member');
    expect(r.projectRole).toBe('project-admin');
  });

  it('denies when the project does not exist', async () => {
    const r = await canAccess(db, 'owner1', { projectId: 'ghost', action: 'view' });
    expect(r.allowed).toBe(false);
    expect(r.reason).toBe('unknown-project');
  });
});
