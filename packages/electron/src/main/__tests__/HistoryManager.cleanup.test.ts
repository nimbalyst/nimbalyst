// @vitest-environment node
/**
 * History retention used to find its deletions with a ROW_NUMBER() window over
 * the WHOLE document_history table. That table stores full file content (472MB
 * across 46,350 rows on one install), so the scan dragged every blob off disk
 * to identify 487 deletable rows across 5 files -- 5,965ms in a single call on
 * the single-lane SQLite worker, at startup, blocking everything behind it.
 *
 * These pin the cheap shape: find the few files over the limit first, then
 * delete only within those. The retention rule itself is unchanged -- newest
 * `maxSnapshots` per file survive -- and that equivalence is what the first
 * two cases assert.
 */
import { describe, expect, it, vi, beforeEach } from 'vitest';

const query = vi.fn();

vi.mock('../database/PGLiteDatabaseWorker', () => ({
  database: {
    isInitialized: () => true,
    initialize: vi.fn(),
    // Picks the JSON accessor form the pending-review predicates compile to.
    getEngine: () => 'pglite',
    query: (...args: unknown[]) => query(...args),
  },
}));
vi.mock('../utils/logger', () => ({
  logger: { main: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() } },
}));
vi.mock('electron', () => ({
  app: { getPath: () => '/mock', isPackaged: false },
  BrowserWindow: { getAllWindows: () => [] },
}));

const normalize = (sql: string) => sql.replace(/\s+/g, ' ').trim().toLowerCase();
const sqlCalls = () => query.mock.calls.map(c => normalize(String(c[0])));

describe('HistoryManager.cleanup', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    query.mockResolvedValue({ rows: [] });
  });

  it('does no per-file work when no file exceeds the snapshot limit', async () => {
    const { HistoryManager } = await import('../HistoryManager');
    // The over-limit lookup returns nothing -- the common case.
    query.mockResolvedValue({ rows: [] });

    await new HistoryManager().cleanup();

    const calls = sqlCalls();
    // Never scans the whole table to build a window.
    expect(calls.some(s => s.includes('row_number()'))).toBe(false);
    // Age delete plus the over-limit lookup, and nothing more.
    expect(calls.filter(s => s.startsWith('delete'))).toHaveLength(1);
  });

  it('deletes only within files that are over the limit, keeping the newest', async () => {
    const { HistoryManager } = await import('../HistoryManager');
    query.mockImplementation(async (sql: string) => {
      if (normalize(sql).includes('group by file_path')) {
        return { rows: [{ file_path: '/a.md' }, { file_path: '/b.md' }] };
      }
      return { rows: [] };
    });

    await new HistoryManager().cleanup();

    const perFileDeletes = query.mock.calls.filter(
      c => normalize(String(c[0])).startsWith('delete') && normalize(String(c[0])).includes('file_path')
    );
    expect(perFileDeletes).toHaveLength(2);

    // Retention rule preserved: keep the newest N for that file, drop the rest.
    const [sql, params] = perFileDeletes[0];
    const s = normalize(String(sql));
    expect(s).toContain('order by timestamp desc');
    expect(s).toContain('limit');
    expect(params).toContain('/a.md');
    expect(params).toContain(250);
  });

  it('still prunes by age', async () => {
    const { HistoryManager } = await import('../HistoryManager');
    await new HistoryManager().cleanup();

    const ageDelete = sqlCalls().find(s => s.startsWith('delete') && s.includes('timestamp <'));
    expect(ageDelete).toBeDefined();
  });

  // A tag could sit in pending-review forever: 3,284 rows on one dev machine,
  // oldest three months. Read-path reconciliation only reaches files someone
  // opens again, so the bound is what drains the rest (#1403).
  describe('pending-review retention', () => {
    it('retires pending tags past the bound instead of deleting them', async () => {
      const { HistoryManager } = await import('../HistoryManager');
      query.mockImplementation(async (sql: string) => {
        if (normalize(sql).startsWith('select distinct file_path')) {
          return { rows: [{ file_path: '/stale.md' }] };
        }
        return { rows: [] };
      });

      await new HistoryManager().cleanup();

      const retire = query.mock.calls.find(
        c => normalize(String(c[0])).startsWith('update') && normalize(String(c[0])).includes('pending-review'),
      );
      expect(retire).toBeDefined();
      expect(normalize(String(retire![0]))).toContain('"reviewed"');
      // Non-destructive: the row and its baseline survive.
      expect(
        sqlCalls().some(s => s.startsWith('delete') && s.includes('pending-review')),
      ).toBe(false);
    });

    it('issues no update when nothing is past the bound', async () => {
      const { HistoryManager } = await import('../HistoryManager');

      await new HistoryManager().cleanup();

      expect(sqlCalls().some(s => s.startsWith('update'))).toBe(false);
    });

    it('does not take snapshot retention down with it when it fails', async () => {
      // cleanup() has one catch around everything; without isolation a throw
      // here skips the age delete and the per-file pruning silently.
      const { HistoryManager } = await import('../HistoryManager');
      query.mockImplementation(async (sql: string) => {
        if (normalize(sql).startsWith('select distinct file_path')) {
          throw new Error('json predicate exploded');
        }
        return { rows: [] };
      });

      await new HistoryManager().cleanup();

      expect(sqlCalls().some(s => s.startsWith('delete') && s.includes('timestamp <'))).toBe(true);
    });
  });

  it('survives a failure without throwing', async () => {
    const { HistoryManager } = await import('../HistoryManager');
    query.mockRejectedValue(new Error('worker busy'));

    await expect(new HistoryManager().cleanup()).resolves.toBeUndefined();
  });
});

describe('HistoryManager startup and snapshot scope', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    query.mockResolvedValue({ rows: [] });
  });

  it('initialize() does not run retention inline; it is scheduled after first-usable', async () => {
    const { HistoryManager } = await import('../HistoryManager');
    await new HistoryManager().initialize();
    expect(sqlCalls().filter(s => s.startsWith('delete'))).toHaveLength(0);
  });

  it('never snapshots binary files, which gzip cannot shrink', async () => {
    const { HistoryManager } = await import('../HistoryManager');
    const manager = new HistoryManager();

    await manager.createSnapshot('/ws/assets/Logo.PNG', '\u0089PNG\r\n', 'auto-save');
    await manager.createSnapshot('/ws/demo.gif', 'GIF89a', 'ai-edit');
    expect(sqlCalls().some(s => s.includes('insert into document_history'))).toBe(false);

    await manager.createSnapshot('/ws/notes.md', '# notes', 'auto-save');
    expect(sqlCalls().filter(s => s.includes('insert into document_history'))).toHaveLength(1);
  });
});
