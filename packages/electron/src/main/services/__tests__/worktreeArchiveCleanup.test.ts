// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { PGlite } from '@electric-sql/pglite';
import { SQLiteDatabase } from '../../database/sqlite/SQLiteDatabase';
import { ArchiveProgressManager } from '../ArchiveProgressManager';
import { createSuperLoopStore } from '../SuperLoopStore';
import { createWorktreeStore } from '../WorktreeStore';
import { createWorktreeArchiveCleanup, recoverWorktreeArchivesOnStartup } from '../worktreeArchiveCleanup';

const userData = vi.hoisted(() => ({ dir: '' }));
vi.mock('electron', () => ({
  app: { getPath: () => userData.dir },
  BrowserWindow: { getAllWindows: () => [] },
}));

describe('createWorktreeArchiveCleanup', () => {
  const worktree = {
    id: 'wt-1',
    path: '/proj_worktrees/feature',
    projectPath: '/proj',
    sourceFolderPath: '/other/collab',
  };

  const makeDeps = () => ({
    deleteWorktree: vi.fn(async (_worktreePath: string, _repoPath: string) => {}),
    worktreeStore: { updateArchived: vi.fn(async (_id: string, _isArchived: boolean) => {}) },
    superLoopStore: {
      getLoopByWorktreeId: vi.fn(async () => ({ id: 'loop-1', isArchived: false }) as any),
      updateLoop: vi.fn(async () => null),
    },
    archiveQueue: { updateTaskStatus: vi.fn() },
    unarchiveSession: vi.fn(async (_sessionId: string) => {}),
    pathExists: vi.fn((_path: string) => true),
  });

  it('removes an attached-folder worktree through the repo it was branched from, then archives it and its super loop', async () => {
    const deps = makeDeps();

    await createWorktreeArchiveCleanup(deps)(worktree, ['s-1']);

    // `projectPath` is only the primary root; removing there leaves the real
    // registration behind and runs `branch -D` in the wrong repository.
    expect(deps.deleteWorktree).toHaveBeenCalledWith('/proj_worktrees/feature', '/other/collab');
    expect(deps.worktreeStore.updateArchived).toHaveBeenCalledWith('wt-1', true);
    expect(deps.superLoopStore.updateLoop).toHaveBeenCalledWith('loop-1', { isArchived: true });
    expect(deps.unarchiveSession).not.toHaveBeenCalled();
  });

  it('un-archives every session when the removal fails, and leaves the worktree unarchived', async () => {
    const deps = makeDeps();
    deps.deleteWorktree.mockRejectedValueOnce(new Error('worktree remove failed'));
    deps.unarchiveSession.mockRejectedValueOnce(new Error('session store busy'));

    await expect(createWorktreeArchiveCleanup(deps)(worktree, ['s-1', 's-2']))
      .rejects.toThrow('worktree remove failed');

    expect(deps.unarchiveSession.mock.calls).toEqual([['s-1'], ['s-2']]);
    expect(deps.worktreeStore.updateArchived).not.toHaveBeenCalled();
  });

  it('keeps the sessions archived when the cleanup fails after the checkout is gone', async () => {
    const deps = makeDeps();
    // deleteWorktree's final git-list check can throw after the directory was
    // already removed, for example for a locked worktree.
    deps.deleteWorktree.mockRejectedValueOnce(new Error('still in git worktree list'));
    deps.pathExists.mockImplementation((p) => p !== worktree.path);

    await expect(createWorktreeArchiveCleanup(deps)(worktree, ['s-1', 's-2']))
      .rejects.toThrow('still in git worktree list');

    expect(deps.unarchiveSession).not.toHaveBeenCalled();
  });
});

type Db = { query<T = any>(sql: string, params?: any[]): Promise<{ rows: T[] }> };

async function openDatabase(engine: 'pglite' | 'sqlite', dir: string): Promise<{ db: Db; close: () => Promise<void> }> {
  if (engine === 'sqlite') {
    const sqlite = new SQLiteDatabase({
      dbDir: path.join(dir, 'sqlite-db'),
      schemaDir: path.resolve(__dirname, '../../database/sqlite/schemas'),
      log: () => {},
    });
    await sqlite.initialize();
    return { db: sqlite, close: () => sqlite.close() };
  }
  const pglite = new PGlite();
  // The columns the worktree and super-loop stores read. worker.js builds
  // them over a create and several migrations; the SQLite branch runs the
  // real schema.
  await pglite.exec(`
    CREATE TABLE worktrees (
      id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL, name TEXT NOT NULL, display_name TEXT,
      path TEXT NOT NULL, branch TEXT NOT NULL, base_branch TEXT, source_folder_path TEXT,
      is_pinned BOOLEAN DEFAULT FALSE, is_archived BOOLEAN DEFAULT FALSE,
      pr_number INTEGER, pr_remote TEXT, pr_url TEXT,
      created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP, updated_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE ai_sessions (
      id TEXT PRIMARY KEY, provider TEXT NOT NULL, worktree_id TEXT REFERENCES worktrees(id),
      is_archived BOOLEAN DEFAULT FALSE, created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE super_loops (
      id TEXT PRIMARY KEY, worktree_id TEXT NOT NULL REFERENCES worktrees(id), task_description TEXT NOT NULL,
      title TEXT, status TEXT NOT NULL DEFAULT 'pending', current_iteration INTEGER DEFAULT 0,
      max_iterations INTEGER DEFAULT 20, model_id TEXT, completion_reason TEXT,
      is_archived BOOLEAN DEFAULT FALSE, is_pinned BOOLEAN DEFAULT FALSE,
      created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP, updated_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
    );
  `);
  return { db: pglite, close: () => pglite.close() };
}

/** Resolves once the queue has no task left to run. */
function drained(queue: ArchiveProgressManager): Promise<void> {
  const busy = () => queue.getTasks().some((task) => task.status !== 'completed' && task.status !== 'failed');
  if (!busy()) return Promise.resolve();
  return new Promise((resolve) => {
    const onProgress = () => {
      if (busy()) return;
      queue.off('archive-progress', onProgress);
      resolve();
    };
    queue.on('archive-progress', onProgress);
  });
}

/**
 * The startup order is consistency check, then queue replay. Both persist what
 * they decide, so the sequence is run over two simulated launches against one
 * database and one userData directory; only git and the session store are
 * stood in for.
 */
describe.each(['pglite', 'sqlite'] as const)('worktree archive recovery across launches (%s)', (engine) => {
  let tmp: string;
  let db: Db;
  let close: () => Promise<void>;

  beforeEach(async () => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'nim-archive-recovery-'));
    userData.dir = path.join(tmp, 'userData');
    fs.mkdirSync(userData.dir);
    ({ db, close } = await openDatabase(engine, tmp));
  }, 30_000);

  afterEach(async () => {
    await close();
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  async function removeCheckout(worktreePath: string, _repoPath: string) {
    fs.rmSync(worktreePath, { recursive: true, force: true });
  }

  async function launch(deleteImpl = removeCheckout) {
    const archiveQueue = new ArchiveProgressManager();
    const worktreeStore = createWorktreeStore(db);
    const deleteWorktree = vi.fn(deleteImpl);
    const result = await recoverWorktreeArchivesOnStartup({
      db,
      archiveQueue,
      worktreeStore,
      cleanup: createWorktreeArchiveCleanup({
        deleteWorktree,
        worktreeStore,
        superLoopStore: createSuperLoopStore(db),
        archiveQueue,
        unarchiveSession: async (sessionId) => {
          await db.query('UPDATE ai_sessions SET is_archived = $2 WHERE id = $1', [sessionId, false]);
        },
        pathExists: fs.existsSync,
      }),
    });
    await drained(archiveQueue);
    return { result, deleteWorktree };
  }

  /**
   * An archiving run archived the worktree's sessions and queued the disk
   * cleanup, then quit before the cleanup finished -- with the checkout still
   * on disk, or after removing it but before marking the row archived.
   */
  async function seedInterruptedArchive(checkoutOnDisk: boolean) {
    const projectPath = path.join(tmp, 'proj');
    const sourceFolderPath = path.join(tmp, 'collab');
    const worktreePath = path.join(tmp, 'proj_worktrees', 'feature');
    if (checkoutOnDisk) {
      fs.mkdirSync(worktreePath, { recursive: true });
    }
    await createWorktreeStore(db).create({
      id: 'wt-1',
      name: 'feature',
      path: worktreePath,
      branch: 'worktree/feature',
      baseBranch: 'main',
      projectPath,
      sourceFolderPath,
      createdAt: Date.now(),
    });
    for (const sessionId of ['s-1', 's-2']) {
      await db.query(
        `INSERT INTO ai_sessions (id, provider, worktree_id, is_archived) VALUES ($1, 'claude-code', 'wt-1', $2)`,
        [sessionId, true],
      );
    }
    await db.query(`INSERT INTO super_loops (id, worktree_id, task_description) VALUES ('loop-1', 'wt-1', 'task')`);
    new ArchiveProgressManager().addTask('wt-1', 'feature', () => new Promise<void>(() => {}));
    return { worktreePath, sourceFolderPath };
  }

  async function snapshot() {
    const { rows } = await db.query<{ id: string; is_archived: unknown; path: string }>(
      `SELECT s.id, s.is_archived, w.path FROM ai_sessions s JOIN worktrees w ON w.id = s.worktree_id ORDER BY s.id`,
    );
    const worktree = (await db.query<{ is_archived: unknown }>(`SELECT is_archived FROM worktrees WHERE id = 'wt-1'`)).rows[0];
    const loop = (await db.query<{ is_archived: unknown }>(`SELECT is_archived FROM super_loops WHERE id = 'loop-1'`)).rows[0];
    return {
      visibleSessionsOnDeletedCheckouts: rows
        .filter((row) => !row.is_archived && !fs.existsSync(row.path))
        .map((row) => row.id),
      archivedSessions: rows.filter((row) => Boolean(row.is_archived)).map((row) => row.id),
      worktreeArchived: Boolean(worktree.is_archived),
      loopArchived: Boolean(loop.is_archived),
    };
  }

  it.each([
    { checkout: 'still on disk', checkoutOnDisk: true },
    { checkout: 'already removed', checkoutOnDisk: false },
  ])('finishes a queued archive whose checkout is $checkout on the next launch, and leaves nothing for the one after', async ({ checkoutOnDisk }) => {
    const { worktreePath, sourceFolderPath } = await seedInterruptedArchive(checkoutOnDisk);

    const first = await launch();

    expect(await snapshot()).toEqual({
      visibleSessionsOnDeletedCheckouts: [],
      archivedSessions: ['s-1', 's-2'],
      worktreeArchived: true,
      loopArchived: true,
    });
    // Even an already-removed checkout goes through the replay, which
    // unregisters it from the repo it was branched from.
    expect(first.deleteWorktree).toHaveBeenCalledWith(worktreePath, sourceFolderPath);
    expect(fs.existsSync(worktreePath)).toBe(false);

    const second = await launch();

    expect(second.result).toEqual({ consistency: [], recovered: 0, failed: 0 });
    expect(second.deleteWorktree).not.toHaveBeenCalled();
    expect((await snapshot()).archivedSessions).toEqual(['s-1', 's-2']);
  }, 30_000);

  it('shows the sessions again when the replayed removal fails, and leaves them visible on the launch after', async () => {
    const { worktreePath } = await seedInterruptedArchive(true);

    const first = await launch(async () => {
      throw new Error('worktree remove failed');
    });

    expect(first.result).toEqual({ consistency: [], recovered: 1, failed: 0 });
    expect(fs.existsSync(worktreePath)).toBe(true);
    expect(await snapshot()).toEqual({
      visibleSessionsOnDeletedCheckouts: [],
      archivedSessions: [],
      worktreeArchived: false,
      loopArchived: false,
    });

    const second = await launch();

    expect(second.result).toEqual({ consistency: [], recovered: 0, failed: 0 });
    expect(second.deleteWorktree).not.toHaveBeenCalled();
    expect((await snapshot()).archivedSessions).toEqual([]);
  }, 30_000);
});
