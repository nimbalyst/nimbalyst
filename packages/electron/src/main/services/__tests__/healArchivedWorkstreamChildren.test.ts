import { describe, expect, it, vi } from 'vitest';
import { healArchivedWorkstreamChildren } from '../healArchivedWorkstreamChildren';

// GitHub #925 item 3 / NIM-1831: pre-existing orphans (active children under an
// already-archived workstream parent) must be healed once at startup.
describe('healArchivedWorkstreamChildren', () => {
  it('archives active children whose parent is archived, and reports the count', async () => {
    const calls: Array<{ sql: string; params: any[] }> = [];
    const db = {
      query: vi.fn(async (sql: string, params: any[] = []) => {
        calls.push({ sql, params });
        if (/count/i.test(sql)) return { rows: [{ count: 3 }] };
        return { rows: [] };
      }),
    };

    const result = await healArchivedWorkstreamChildren(db as any);

    expect(result.healed).toBe(3);
    const update = calls.find((c) => /UPDATE ai_sessions\s+SET is_archived/i.test(c.sql));
    expect(update, 'expected an UPDATE that archives orphaned children').toBeTruthy();
    // Only children of an archived parent are targeted.
    expect(update!.sql).toMatch(/parent_session_id/i);
    expect(update!.sql).toMatch(/is_archived = TRUE/i);
  });

  it('issues no UPDATE when there are no orphans', async () => {
    const calls: string[] = [];
    const db = {
      query: vi.fn(async (sql: string) => {
        calls.push(sql);
        if (/count/i.test(sql)) return { rows: [{ count: 0 }] };
        return { rows: [] };
      }),
    };

    const result = await healArchivedWorkstreamChildren(db as any);

    expect(result.healed).toBe(0);
    expect(calls.some((s) => /UPDATE/i.test(s))).toBe(false);
  });
});
