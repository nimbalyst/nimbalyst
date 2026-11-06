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
import { execFileSync } from 'child_process';

// ProjectMigrationService -> WindowManager calls app.on() at module load; the
// shared setup mock only stubs app.getPath. Extend it here.
vi.mock('electron', async () => ({
  app: {
    getPath: (await import('../../../../test-stubs/privateUserData')).testApp.getPath,
    getName: vi.fn(() => 'test-app'),
    getVersion: vi.fn(() => '1.0.0'),
    on: vi.fn(),
  },
}));

const claudeConfigDir = vi.hoisted(() => ({ value: '' }));
// Paths whose rename fails with EXDEV, simulating a move to another volume.
const crossVolume = vi.hoisted(() => ({ sources: new Set<string>() }));
vi.mock('fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('fs/promises')>();
  return {
    ...actual,
    rename: async (from: string, to: string) => {
      if (crossVolume.sources.has(from)) {
        throw Object.assign(new Error('EXDEV: cross-device link not permitted'), { code: 'EXDEV' });
      }
      return actual.rename(from, to);
    },
  };
});
vi.mock('@nimbalyst/runtime/ai/server/providers/claudeCode/claudeConfigDir', () => ({
  resolveClaudeConfigDir: () => claudeConfigDir.value,
}));
vi.mock('../credentials/providerCredentials', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  getProviderCredentials: () => ({ moveWorkspace: vi.fn() }),
}));
vi.mock('../../utils/store', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  getRecentItems: () => [],
  invalidateWorkspaceStoreCache: vi.fn(),
  store: { set: vi.fn() },
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

describe('ProjectMigrationService.moveProject with worktrees (SQLite backend)', () => {
  let tmp: string;
  let sqlite: SQLiteDatabase;
  let db: any;

  const git = (cwd: string, ...args: string[]) =>
    execFileSync('git', args, {
      cwd,
      encoding: 'utf8',
      env: { ...process.env, GIT_DIR: undefined, GIT_WORK_TREE: undefined, GIT_INDEX_FILE: undefined },
    }).trim();

  beforeEach(async () => {
    tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'nim-projmove-')));
    claudeConfigDir.value = path.join(tmp, 'claude');
    sqlite = new SQLiteDatabase({
      dbDir: path.join(tmp, 'sqlite-db'),
      schemaDir: SCHEMA_DIR,
      slowQueryThresholdMs: 1000,
      sampleRate: 0,
    });
    await sqlite.initialize();
    db = { query: sqlite.query.bind(sqlite), createBackup: async () => ({ success: true }) };
  });

  afterEach(async () => {
    crossVolume.sources.clear();
    await sqlite.close();
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  async function makeProjectWithWorktree() {
    const projectPath = path.join(tmp, 'src', 'proj');
    fs.mkdirSync(projectPath, { recursive: true });
    git(projectPath, 'init', '-q', '-b', 'main');
    // Sandbox guard: the repo must be the temp project, never this checkout.
    expect(git(projectPath, 'rev-parse', '--show-toplevel')).toBe(projectPath);
    fs.writeFileSync(path.join(projectPath, 'a.txt'), 'a');
    git(projectPath, 'add', 'a.txt');
    git(projectPath, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '-m', 'init');

    const worktreePath = path.join(tmp, 'src', 'proj_worktrees', 'wt1');
    git(projectPath, 'worktree', 'add', '-q', '-b', 'worktree/wt1', worktreePath);
    await sqlite.query(
      `INSERT INTO worktrees (id, workspace_id, name, path, branch, is_archived) VALUES ($1, $2, $3, $4, $5, $6)`,
      ['w1', projectPath, 'wt1', worktreePath, 'worktree/wt1', true],
    );
    await sqlite.query(
      `INSERT INTO session_files (id, session_id, workspace_id, file_path, link_type) VALUES ($1, $2, $3, $4, $5)`,
      ['f1', 's1', worktreePath, `${worktreePath}/a.txt`, 'edited'],
    );
    return { projectPath, worktreePath };
  }

  it('moves a project with an archived worktree and keeps the worktree linked to git', async () => {
    const { projectPath } = await makeProjectWithWorktree();
    const service = new ProjectMigrationService(db);

    expect(await service.canMoveProject(projectPath)).toEqual({ canMove: true });

    fs.mkdirSync(path.join(tmp, 'dest'));
    const newPath = path.join(tmp, 'dest', 'proj');
    const newWorktreePath = path.join(tmp, 'dest', 'proj_worktrees', 'wt1');
    const result = await service.moveProject(projectPath, newPath);
    expect(result).toMatchObject({ success: true, newPath });

    expect(fs.existsSync(path.join(newWorktreePath, 'a.txt'))).toBe(true);
    // git sees the worktree from the new main repo, and the worktree resolves its repo.
    expect(git(newPath, 'worktree', 'list', '--porcelain')).toContain(`worktree ${newWorktreePath}`);
    expect(git(newWorktreePath, 'rev-parse', '--abbrev-ref', 'HEAD')).toBe('worktree/wt1');
    expect(git(newWorktreePath, 'rev-parse', '--git-common-dir')).toBe(path.join(newPath, '.git'));

    const wt = await sqlite.query<{ workspace_id: string; path: string }>(
      `SELECT workspace_id, path FROM worktrees WHERE id = $1`,
      ['w1'],
    );
    expect(wt.rows[0]).toEqual({ workspace_id: newPath, path: newWorktreePath });

    const file = await sqlite.query<{ workspace_id: string; file_path: string }>(
      `SELECT workspace_id, file_path FROM session_files WHERE id = $1`,
      ['f1'],
    );
    expect(file.rows[0]).toEqual({ workspace_id: newWorktreePath, file_path: `${newWorktreePath}/a.txt` });
  });

  it('copies across volumes, keeps the originals, and links the copied worktree to the copied repo', async () => {
    const { projectPath, worktreePath } = await makeProjectWithWorktree();
    crossVolume.sources.add(projectPath);
    crossVolume.sources.add(path.dirname(worktreePath));
    const service = new ProjectMigrationService(db);

    fs.mkdirSync(path.join(tmp, 'dest'));
    const newPath = path.join(tmp, 'dest', 'proj');
    const newWorktreePath = path.join(tmp, 'dest', 'proj_worktrees', 'wt1');
    const result = await service.moveProject(projectPath, newPath);
    expect(result).toMatchObject({ success: true, newPath });

    expect(fs.existsSync(path.join(projectPath, 'a.txt'))).toBe(true);
    expect(fs.existsSync(path.join(worktreePath, 'a.txt'))).toBe(true);
    expect(git(newWorktreePath, 'rev-parse', '--git-common-dir')).toBe(path.join(newPath, '.git'));
    expect(git(newPath, 'worktree', 'list', '--porcelain')).toContain(`worktree ${newWorktreePath}`);
  });
});
