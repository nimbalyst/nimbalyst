/**
 * Migration test for Epic H1 schema (0013_orgs_and_projects).
 *
 * Verifies the org / project / membership tables are created on a fresh SQLite
 * backend with the expected keys and uniqueness constraints. The PGLite
 * equivalent lives in worker.js createSchemas(); both must stay in sync. This
 * exercises the real SQLiteDatabase + migrationRunner path (not a hand-rolled
 * schema), so a missing registration in getMigrations() fails here.
 */

import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

// SQLiteDatabase -> (transitively) modules that call into electron at load.
// The shared test setup only stubs app.getPath; extend it here to be safe.
vi.mock('electron', () => ({
  app: {
    getPath: vi.fn(() => '/mock/path'),
    getName: vi.fn(() => 'test-app'),
    getVersion: vi.fn(() => '1.0.0'),
    on: vi.fn(),
  },
}));

import { SQLiteDatabase } from '../SQLiteDatabase';

const SCHEMA_DIR = path.resolve(__dirname, '..', 'schemas');

describe('0013_orgs_and_projects migration (SQLite backend)', () => {
  let tmp: string;
  let sqlite: SQLiteDatabase;

  beforeEach(async () => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'nim-orgs-migrate-'));
    sqlite = new SQLiteDatabase({
      dbDir: path.join(tmp, 'sqlite-db'),
      schemaDir: SCHEMA_DIR,
      slowQueryThresholdMs: 1000,
      sampleRate: 0,
    });
    await sqlite.initialize();
  });

  afterEach(async () => {
    await sqlite.close();
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it('registers and applies migration version 13', async () => {
    const { rows } = await sqlite.query<{ version: number }>(
      `SELECT version FROM _migrations WHERE version = 13`,
    );
    expect(rows).toHaveLength(1);
  });

  it('creates all four H1 tables', async () => {
    const { rows } = await sqlite.query<{ name: string }>(
      `SELECT name FROM sqlite_master WHERE type='table'
         AND name IN ('orgs','org_members','projects','project_access')
       ORDER BY name`,
    );
    expect(rows.map((r) => r.name)).toEqual([
      'org_members',
      'orgs',
      'project_access',
      'projects',
    ]);
  });

  it('round-trips an org -> member -> project -> grant', async () => {
    await sqlite.query(
      `INSERT INTO orgs (id, stytch_org_id, slug, flavor) VALUES ($1,$2,$3,$4)`,
      ['org_1', 'stytch_1', 'acme', 'team'],
    );
    await sqlite.query(
      `INSERT INTO org_members (org_id, user_id, email, role) VALUES ($1,$2,$3,$4)`,
      ['org_1', 'user_1', 'a@b.c', 'owner'],
    );
    await sqlite.query(
      `INSERT INTO projects (id, org_id, slug, git_origin_hash) VALUES ($1,$2,$3,$4)`,
      ['proj_1', 'org_1', 'web', 'deadbeef'],
    );
    await sqlite.query(
      `INSERT INTO project_access (project_id, user_id, project_role) VALUES ($1,$2,$3)`,
      ['proj_1', 'user_1', 'project-admin'],
    );

    const org = await sqlite.query<{ flavor: string; created_at: string }>(
      `SELECT flavor, created_at FROM orgs WHERE id = 'org_1'`,
    );
    expect(org.rows[0].flavor).toBe('team');
    // Timestamp default is ISO-8601 TEXT (DATABASE.md: TIMESTAMPTZ -> TEXT).
    expect(org.rows[0].created_at).toMatch(/^\d{4}-\d{2}-\d{2}T/);

    const grant = await sqlite.query<{ project_role: string }>(
      `SELECT project_role FROM project_access WHERE project_id='proj_1' AND user_id='user_1'`,
    );
    expect(grant.rows[0].project_role).toBe('project-admin');
  });

  it('enforces UNIQUE(org_id, slug) on projects', async () => {
    await sqlite.query(
      `INSERT INTO orgs (id, stytch_org_id, slug, flavor) VALUES ('o','s','acme','team')`,
    );
    await sqlite.query(
      `INSERT INTO projects (id, org_id, slug) VALUES ('p1','o','web')`,
    );
    await expect(
      sqlite.query(`INSERT INTO projects (id, org_id, slug) VALUES ('p2','o','web')`),
    ).rejects.toThrow();
  });

  it('enforces unique stytch_org_id across orgs', async () => {
    await sqlite.query(
      `INSERT INTO orgs (id, stytch_org_id, slug, flavor) VALUES ('o1','dup','a','team')`,
    );
    await expect(
      sqlite.query(`INSERT INTO orgs (id, stytch_org_id, slug, flavor) VALUES ('o2','dup','b','team')`),
    ).rejects.toThrow();
  });

  it('enforces the composite PK on org_members', async () => {
    await sqlite.query(
      `INSERT INTO orgs (id, stytch_org_id, slug, flavor) VALUES ('o','s','a','team')`,
    );
    await sqlite.query(
      `INSERT INTO org_members (org_id, user_id) VALUES ('o','u')`,
    );
    await expect(
      sqlite.query(`INSERT INTO org_members (org_id, user_id) VALUES ('o','u')`),
    ).rejects.toThrow();
  });
});
