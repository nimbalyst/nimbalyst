// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { allocateIssueKeyForNewItem } from '../allocateIssueKey';

/**
 * Minimal db double: records every statement so a test can assert which
 * columns a write touched, which is the whole point here -- a synced create
 * must not write `issue_number`.
 */
function fakeDb(rows: Record<string, unknown[]> = {}) {
  const calls: Array<{ sql: string; params: unknown[] }> = [];
  const db = {
    async query<T = unknown>(sql: string, params: unknown[] = []): Promise<{ rows: T[] }> {
      calls.push({ sql, params });
      if (sql.includes('MAX(issue_number)')) return { rows: (rows.max ?? [{ max_num: null }]) as T[] };
      if (sql.includes('LIKE')) return { rows: (rows.local ?? []) as T[] };
      return { rows: [] };
    },
  };
  const updates = () => calls.filter((c) => c.sql.includes('UPDATE'));
  return { db, updates };
}

describe('allocateIssueKeyForNewItem', () => {
  it('assigns a provisional local key and no issue_number when a room owns the workspace', async () => {
    const { db, updates } = fakeDb();

    await allocateIssueKeyForNewItem(db, 'item-1', '/ws', { syncActive: true, prefix: 'NIM' });

    const update = updates()[0];
    // The room is the only allocator of issue_number; writing one here is what
    // let two workspaces disagree about the same item's key.
    expect(update.sql).not.toContain('issue_number');
    expect(update.params).toEqual(['LC-1', 'item-1']);
  });

  it('continues the local sequence past existing provisional keys', async () => {
    const { db, updates } = fakeDb({ local: [{ key: 'LC-1' }, { key: 'LC-9' }, { key: 'LC-3' }] });

    await allocateIssueKeyForNewItem(db, 'item-2', '/ws', { syncActive: true, prefix: 'NIM' });

    expect(updates()[0].params).toEqual(['LC-10', 'item-2']);
  });

  it('allocates a real numbered key in the workspace prefix when no room is attached', async () => {
    const { db, updates } = fakeDb({ max: [{ max_num: 41 }] });

    await allocateIssueKeyForNewItem(db, 'item-3', '/ws', { syncActive: false, prefix: 'NIM' });

    expect(updates()[0].sql).toContain('issue_number');
    expect(updates()[0].params).toEqual([42, 'NIM-42', 'item-3']);
  });
});
