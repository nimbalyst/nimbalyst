import { beforeEach, describe, expect, it, vi } from 'vitest';
import { checkWorktreeArchiveConsistency } from '../WorktreeStore';
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
});
