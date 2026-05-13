import { describe, expect, it, vi } from 'vitest';
import { createSuperLoopStore } from '../SuperLoopStore';

describe('SuperLoopStore listLoops', () => {
  it('excludes archived loops and loops whose worktree is archived', async () => {
    const queries: string[] = [];
    const db = {
      query: vi.fn(async (sql: string) => {
        queries.push(sql);
        return { rows: [] };
      }),
    };

    const store = createSuperLoopStore(db);
    await store.listLoops('/workspace');

    expect(queries[0]).toContain('(rl.is_archived = FALSE OR rl.is_archived IS NULL)');
    expect(queries[0]).toContain('(w.is_archived = FALSE OR w.is_archived IS NULL)');
  });
});
