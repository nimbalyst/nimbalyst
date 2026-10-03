import { beforeEach, describe, expect, it, vi } from 'vitest';
import { checkWorktreeArchiveConsistency, createWorktreeStore } from '../WorktreeStore';
import * as fs from 'fs';

vi.mock('fs', () => ({
  existsSync: vi.fn(),
}));

describe('checkWorktreeArchiveConsistency', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('archives lingering visible sessions for an already-archived worktree', async () => {
    const db = {
      query: vi.fn(async (sql: string, params?: any[]) => {
        if (sql.includes('HAVING COUNT(s.id) > 0 AND COUNT(s.id) = COUNT(CASE WHEN s.is_archived = true THEN 1 END)')) {
          return { rows: [] };
        }

        if (sql.includes('WHERE w.is_archived = true')) {
          return {
            rows: [{
              worktree_id: 'wt-1',
              worktree_path: '/tmp/wt-1',
              session_count: 2,
              visible_session_count: 1,
            }],
          };
        }

        if (sql.includes('UPDATE ai_sessions') && params?.[0] === 'wt-1') {
          return { rows: [] };
        }

        throw new Error(`Unexpected query: ${sql}`);
      }),
    } as any;

    const results = await checkWorktreeArchiveConsistency(db);

    expect(db.query).toHaveBeenCalledWith(
      expect.stringContaining('SET is_archived = true'),
      ['wt-1']
    );
    expect(results).toEqual([
      {
        worktreeId: 'wt-1',
        action: 'completed',
        details: 'Worktree already archived; marked 1 lingering session(s) as archived',
      },
    ]);
    expect(fs.existsSync).not.toHaveBeenCalled();
  });

  it('leaves queued archives to the queue replay, with or without their checkout on disk', async () => {
    vi.mocked(fs.existsSync).mockImplementation((p) => !String(p).endsWith('gone'));
    const db = {
      query: vi.fn(async (sql: string, _params?: any[]): Promise<{ rows: any[] }> => {
        if (sql.includes('HAVING COUNT(s.id) > 0 AND COUNT(s.id) = COUNT(CASE WHEN s.is_archived = true THEN 1 END)')) {
          return {
            rows: ['queued', 'queued-gone', 'stale', 'gone'].map((id) => ({
              worktree_id: id,
              worktree_path: `/tmp/${id}`,
              session_count: 1,
              archived_session_count: 1,
            })),
          };
        }
        return { rows: [] };
      }),
    };

    const results = await checkWorktreeArchiveConsistency(db, { pendingArchiveIds: ['queued', 'queued-gone'] });

    // The replay that runs next deletes the queued checkout; reverting here
    // would leave its sessions visible on a deleted worktree. Completing an
    // already-deleted one here would make the replay skip it, leaving its
    // super loop unarchived and its registration in the source repo.
    const updated = db.query.mock.calls
      .filter(([sql]) => sql.includes('UPDATE'))
      .map(([sql, params]) => [sql.includes('UPDATE worktrees') ? 'worktree archived' : 'sessions reverted', params?.[0]]);
    expect(updated).toEqual([['sessions reverted', 'stale'], ['worktree archived', 'gone']]);
    expect(results.map((r) => [r.worktreeId, r.action])).toEqual([['stale', 'reverted'], ['gone', 'completed']]);
  });
});

/**
 * `source_folder_path` records which root of a multi-root workspace a worktree
 * was branched from. `workspace_id` stays the primary root, so without this
 * column a worktree cut from an attached repo is indistinguishable from one cut
 * from the project itself.
 */
describe('worktree source folder', () => {
  const makeDb = () => {
    const calls: Array<{ sql: string; params?: any[] }> = [];
    const db = {
      query: vi.fn(async (sql: string, params?: any[]) => {
        calls.push({ sql, params });
        return { rows: [] };
      }),
    };
    return { db, calls };
  };

  const worktree = {
    id: 'wt-1',
    name: 'feature',
    path: '/proj_worktrees/feature',
    branch: 'worktree/feature',
    baseBranch: 'main',
    projectPath: '/proj',
    createdAt: 1_700_000_000_000,
  };

  it('defaults to the primary root when the caller names no source folder', async () => {
    const { db, calls } = makeDb();

    await createWorktreeStore(db).create(worktree);

    const insert = calls.find((c) => c.sql.includes('INSERT INTO worktrees'));
    expect(insert?.sql).toContain('source_folder_path');
    expect(insert?.params?.[6]).toBe('/proj');
  });

  it('records the attached root a worktree was branched from', async () => {
    const { db, calls } = makeDb();

    await createWorktreeStore(db).create({ ...worktree, sourceFolderPath: '/other/collab' });

    const insert = calls.find((c) => c.sql.includes('INSERT INTO worktrees'));
    expect(insert?.params?.[1]).toBe('/proj');
    expect(insert?.params?.[6]).toBe('/other/collab');
  });

  it('reads a pre-multi-root row as having come from the primary root', async () => {
    const db = {
      query: vi.fn(async (): Promise<{ rows: any[] }> => ({
        rows: [{
          id: 'wt-1',
          workspace_id: '/proj',
          name: 'feature',
          path: '/proj_worktrees/feature',
          branch: 'worktree/feature',
          base_branch: 'main',
          source_folder_path: null,
          created_at: 1_700_000_000_000,
          updated_at: 1_700_000_000_000,
        }],
      })),
    };

    const found = await createWorktreeStore(db).get('wt-1');

    expect(found?.sourceFolderPath).toBe('/proj');
  });
});
