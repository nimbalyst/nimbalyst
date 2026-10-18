// @vitest-environment node
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
const h = vi.hoisted(() => ({
  handlers: new Map<string, (...args: any[]) => Promise<any>>(),
  engine: 'sqlite' as 'sqlite' | 'pglite',
  query: vi.fn(),
  dirty: new Set<string>(),
}));
vi.mock('../../utils/ipcRegistry', () => ({
  safeHandle: (key: string, handler: (...args: any[]) => Promise<any>) => h.handlers.set(key, handler),
  safeOn: vi.fn(),
}));
vi.mock('../../database/PGLiteDatabaseWorker', () => ({ database: { getEngine: () => h.engine, query: h.query } }));
vi.mock('../../utils/gitUncommittedFiles', () => ({ getCachedUncommittedFiles: async () => h.dirty }));
vi.mock('@nimbalyst/runtime/ai/server/SessionManager', () => ({ SessionManager: class { async initialize() {} } }));
vi.mock('../../services/analytics/AnalyticsService', () => ({ AnalyticsService: { getInstance: () => ({}) } }));
vi.mock('../../services/ai/remoteSessions', () => ({ remoteSessions: {} }));
vi.mock('../sessionPromptResponseHandler', () => ({ registerSessionPromptResponseHandler: vi.fn() }));
vi.mock('../../services/SessionCommitService', () => ({ SessionCommitService: {} }));
import { invalidateSessionFilesCache, registerSessionHandlers } from '../SessionHandlers';

beforeAll(() => registerSessionHandlers());
beforeEach(() => { h.query.mockReset(); h.dirty = new Set(['folder/file.txt']); });
afterEach(() => vi.restoreAllMocks());

describe('uncommitted-file caller wiring', () => {
  it.each(['sqlite', 'pglite'] as const)('passes %s membership parameters through the registered IPC caller', async engine => {
    h.engine = engine;
    const workspace = `D:/fixture-${engine}`;
    invalidateSessionFilesCache(workspace);
    h.query.mockResolvedValueOnce({ rows: [{ session_id: 'editor' }] })
      .mockResolvedValueOnce({ rows: [{ session_id: 'editor', file_path: 'folder/file.txt' }] });
    const result = await h.handlers.get('sessions:get-uncommitted-counts')!({}, workspace);
    expect(result).toEqual({ success: true, counts: { editor: 1 } });
    const [sql, params] = h.query.mock.calls[1];
    expect(params[0]).toBe(workspace);
    if (engine === 'sqlite') {
      expect(sql).toContain('file_path IN (SELECT value FROM json_each($2))');
      expect(params[1]).toBe(JSON.stringify(['folder/file.txt', `${workspace}/folder/file.txt`, `${workspace}\\folder\\file.txt`.replace(/\//g, '\\')]));
    } else {
      expect(sql).toContain('file_path = ANY($2::text[])');
      expect(params[1]).toEqual(['folder/file.txt', `${workspace}/folder/file.txt`, `${workspace}\\folder\\file.txt`.replace(/\//g, '\\')]);
    }
  });

  it('does not issue a membership query for an empty dirty set and resets editor counts', async () => {
    h.dirty.clear();
    h.query.mockResolvedValueOnce({ rows: [{ session_id: 'editor' }] });
    expect(await h.handlers.get('sessions:get-uncommitted-counts')!({}, '/empty-fixture')).toEqual({ success: true, counts: { editor: 0 } });
    expect(h.query).toHaveBeenCalledOnce();
  });

  it('retries after failure, then uses the successful cached result', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    let membershipCalls = 0;
    h.query.mockImplementation(async (sql: string) => {
      if (sql.includes('SELECT DISTINCT')) return { rows: [{ session_id: 'editor' }] };
      if (++membershipCalls === 1) throw new Error('fixture membership failure');
      return { rows: [{ session_id: 'editor', file_path: 'folder/file.txt' }] };
    });
    const handler = h.handlers.get('sessions:get-uncommitted-counts')!;
    expect(await handler({}, '/recovery-fixture')).toMatchObject({ success: false });
    expect(await handler({}, '/recovery-fixture')).toEqual({ success: true, counts: { editor: 1 } });
    expect(await handler({}, '/recovery-fixture')).toEqual({ success: true, counts: { editor: 1 } });
    expect(membershipCalls).toBe(2);
  });

  it('shares one membership query between concurrent identical IPC callers', async () => {
    let release!: (result: { rows: { session_id: string; file_path: string }[] }) => void;
    const pending = new Promise(resolve => { release = resolve; });
    let membershipCalls = 0;
    h.query.mockImplementation(async (sql: string) => {
      if (sql.includes('SELECT DISTINCT')) return { rows: [{ session_id: 'editor' }] };
      membershipCalls++;
      return pending;
    });
    const handler = h.handlers.get('sessions:get-uncommitted-counts')!;
    const first = handler({}, '/concurrent-fixture');
    const second = handler({}, '/concurrent-fixture');
    await vi.waitFor(() => expect(membershipCalls).toBe(1));
    release({ rows: [{ session_id: 'editor', file_path: 'folder/file.txt' }] });
    expect(await Promise.all([first, second])).toEqual([
      { success: true, counts: { editor: 1 } },
      { success: true, counts: { editor: 1 } },
    ]);
    expect(h.query).toHaveBeenCalledTimes(2);
  });
});
