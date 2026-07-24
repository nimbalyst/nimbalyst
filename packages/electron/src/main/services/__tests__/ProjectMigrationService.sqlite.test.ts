/**
 * Failing-test-first deliverable for NIM-807.
 *
 * Renaming a project must update workspace_id AND rewrite absolute file_path
 * prefixes across ai_sessions, session_files, and document_history. The
 * original implementation issued PostgreSQL-only SQL
 * (`SUBSTRING(file_path FROM LENGTH($2) + 1)` plus text `||` concat), which
 * the PG->SQLite dialect translator mangled into
 * `json_patch($p1, SUBSTRIN)G(...)` — producing `SqliteError: near "G"` and
 * rolling the rename back. This test reproduces that against a real SQLite
 * backend and must flip red->green with the fix.
 */

import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

// ProjectMigrationService -> WindowManager calls app.on() at module load; the
// shared setup mock only stubs app.getPath. Extend it here.
vi.mock('electron', () => ({
  app: {
    getPath: vi.fn(() => '/mock/path'),
    getName: vi.fn(() => 'test-app'),
    getVersion: vi.fn(() => '1.0.0'),
    on: vi.fn(),
  },
}));

import { SQLiteDatabase } from '../../database/sqlite/SQLiteDatabase';
import { ProjectMigrationService } from '../ProjectMigrationService';

const SCHEMA_DIR = path.resolve(__dirname, '..', '..', 'database', 'sqlite', 'schemas');

describe('ProjectMigrationService.migrateDatabase (SQLite backend)', () => {
  let tmp: string;
  let sqlite: SQLiteDatabase;

  const oldPath = '/Users/test/projects/my_project';
  const newPath = '/Users/test/projects/renamed_project';

  beforeEach(async () => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'nim-projmigrate-'));
    sqlite = new SQLiteDatabase({
      dbDir: path.join(tmp, 'sqlite-db'),
      schemaDir: SCHEMA_DIR,
      slowQueryThresholdMs: 1000,
      sampleRate: 0,
    });
    await sqlite.initialize();

    await sqlite.query(
      `INSERT INTO ai_sessions (id, workspace_id, file_path, provider) VALUES ($1, $2, $3, $4)`,
      ['s1', oldPath, `${oldPath}/notes/foo.md`, 'claude'],
    );
    await sqlite.query(
      `INSERT INTO session_files (id, session_id, workspace_id, file_path, link_type) VALUES ($1, $2, $3, $4, $5)`,
      ['f1', 's1', oldPath, `${oldPath}/notes/foo.md`, 'edited'],
    );
    await sqlite.query(
      `INSERT INTO document_history (workspace_id, file_path, content, timestamp) VALUES ($1, $2, $3, $4)`,
      [oldPath, `${oldPath}/notes/foo.md`, Buffer.from('hello'), 1],
    );
  });

  afterEach(async () => {
    await sqlite.close();
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it('rewrites workspace_id and absolute file_path prefixes without a SQL syntax error', async () => {
    const service = new ProjectMigrationService(sqlite as any);

    // Reproduces the failing path: the private migrateDatabase must run all
    // of its UPDATEs against SQLite without throwing.
    await expect(
      (service as any).migrateDatabase(oldPath, newPath),
    ).resolves.toBeUndefined();

    const session = await sqlite.query<{ workspace_id: string; file_path: string }>(
      `SELECT workspace_id, file_path FROM ai_sessions WHERE id = $1`,
      ['s1'],
    );
    expect(session.rows[0].workspace_id).toBe(newPath);
    expect(session.rows[0].file_path).toBe(`${newPath}/notes/foo.md`);

    const file = await sqlite.query<{ workspace_id: string; file_path: string }>(
      `SELECT workspace_id, file_path FROM session_files WHERE id = $1`,
      ['f1'],
    );
    expect(file.rows[0].workspace_id).toBe(newPath);
    expect(file.rows[0].file_path).toBe(`${newPath}/notes/foo.md`);

    const history = await sqlite.query<{ workspace_id: string; file_path: string }>(
      `SELECT workspace_id, file_path FROM document_history`,
    );
    expect(history.rows[0].workspace_id).toBe(newPath);
    expect(history.rows[0].file_path).toBe(`${newPath}/notes/foo.md`);
  });
});
