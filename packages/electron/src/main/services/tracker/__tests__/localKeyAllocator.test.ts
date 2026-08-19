// @vitest-environment node
/**
 * The regressions these pin are the two that already shipped and were rolled
 * back: a counter that could go backwards, and a number that resolved in a
 * project it did not belong to. Neither is visible on screen.
 */

import { describe, expect, it } from 'vitest';
import {
  assignLocalKeysToRows,
  assignMissingLocalKeys,
  ensureLocalKeyPrefix,
  getLocalKeyPrefixConfig,
  reassignLocalKeyPrefix,
  resolveRowByLocalKey,
  type LocalKeyStateStore,
} from '../localKeyAllocator';

interface Row {
  id: string;
  workspace: string;
  local_key: string | null;
  created: string;
  deleted_at: string | null;
}

/**
 * Enough of the two statements the allocator issues to observe ordering and
 * the `local_key IS NULL` guard. Not a SQL engine.
 */
function fakeDb(rows: Row[]) {
  return {
    rows,
    queries: 0,
    async query<T = unknown>(sql: string, params: unknown[] = []): Promise<{ rows: T[] }> {
      this.queries += 1;
      if (sql.includes('SELECT id FROM tracker_items')) {
        const [workspace] = params as [string];
        const matching = rows
          .filter((r) => r.workspace === workspace && r.local_key === null && r.deleted_at === null)
          .sort((a, b) => a.created.localeCompare(b.created) || a.id.localeCompare(b.id));
        return { rows: matching.map((r) => ({ id: r.id })) as T[] };
      }
      if (sql.includes('SELECT id, local_key FROM tracker_items') && sql.includes('local_key IS NOT NULL')) {
        const [workspace] = params as [string];
        return {
          rows: rows
            .filter((r) => r.workspace === workspace && r.local_key !== null)
            .map((r) => ({ id: r.id, local_key: r.local_key })) as T[],
        };
      }
      if (sql.includes('SELECT id, local_key FROM tracker_items')) {
        const [workspace, ids] = params as [string, string[]];
        const matching = rows.filter((r) => r.workspace === workspace && ids.includes(r.id));
        // Deliberately not in `ids` order: the allocator must not depend on the
        // database preserving the order it asked in.
        return { rows: [...matching].reverse().map((r) => ({ id: r.id, local_key: r.local_key })) as T[] };
      }
      if (sql.startsWith('UPDATE tracker_items SET local_key = CASE id')) {
        // `[workspace, id, key, id, key, ...]`, matching the CASE branches.
        const onlyUnnumbered = sql.includes('local_key IS NULL');
        const [workspace, ...pairs] = params as [string, ...string[]];
        for (let i = 0; i < pairs.length; i += 2) {
          const target = rows.find((r) => r.id === pairs[i] && r.workspace === workspace);
          if (!target) continue;
          if (onlyUnnumbered && target.local_key !== null) continue;
          target.local_key = pairs[i + 1];
        }
        return { rows: [] };
      }
      if (sql.includes('WHERE local_key = $1')) {
        const [localKey, workspace] = params as [string, string];
        const found = rows.find((r) => r.local_key === localKey && r.workspace === workspace);
        return { rows: (found ? [found] : []) as T[] };
      }
      throw new Error(`unexpected sql: ${sql}`);
    },
  };
}

function fakeStore(seed: Record<string, { prefix?: string; counter?: number }> = {}): LocalKeyStateStore & {
  state: Record<string, { prefix?: string; counter?: number }>;
  teamPrefixes: Record<string, string>;
  writes: number;
} {
  const state: Record<string, { prefix?: string; counter?: number }> = { ...seed };
  const teamPrefixes: Record<string, string> = {};
  return {
    state,
    teamPrefixes,
    teamPrefix: (workspacePath) => teamPrefixes[workspacePath],
    writes: 0,
    read: (workspacePath) => state[workspacePath] ?? {},
    write(workspacePath, next) {
      this.writes += 1;
      state[workspacePath] = { ...next };
    },
    takenPrefixes: (workspacePath) =>
      Object.entries(state)
        .filter(([key]) => key !== workspacePath)
        .map(([, value]) => value.prefix)
        .filter((prefix): prefix is string => Boolean(prefix)),
  };
}

function row(id: string, workspace: string, created: string): Row {
  return { id, workspace, local_key: null, created, deleted_at: null };
}

describe('ensureLocalKeyPrefix', () => {
  it('pins once and never moves, even as other projects appear', () => {
    const store = fakeStore();
    expect(ensureLocalKeyPrefix(store, '/src/nimbalyst-code')).toBe('NIM');
    expect(ensureLocalKeyPrefix(store, '/src/nimbalyst-collab')).toBe('NIC');
    // Re-resolving the first project must not renegotiate now that NIC exists.
    expect(ensureLocalKeyPrefix(store, '/src/nimbalyst-code')).toBe('NIM');
  });

  /**
   * A folder named after the team is the common case, and pinning its letters
   * makes `NIM.2767` and `NIM-2999` differ by one character -- in the one place
   * the whole scheme relies on the difference being obvious. Auto-pinning is
   * silent, so it has to get this right without being asked.
   */
  it('routes around the team prefix when it pins one on the project behalf', () => {
    const store = fakeStore();
    store.teamPrefixes['/src/nimbalyst-code'] = 'NIM';

    expect(ensureLocalKeyPrefix(store, '/src/nimbalyst-code')).toBe('NIC');
  });

  it('still offers the team prefix to a user who asks for it', async () => {
    const db = fakeDb([]);
    const store = fakeStore();
    store.teamPrefixes['/src/nimbalyst-code'] = 'NIM';

    expect(await reassignLocalKeyPrefix(db, store, '/src/nimbalyst-code', 'NIM', 'NIM')).toMatchObject({
      prefix: 'NIM',
      matchesTeamPrefix: true,
    });
  });
});

describe('local prefix configuration', () => {
  it('offers the collision-free derived prefix until the user chooses one', () => {
    const store = fakeStore({
      '/src/nimbalyst-code': { prefix: 'NIM', counter: 4 },
    });

    expect(getLocalKeyPrefixConfig(store, '/src/nimbalyst-collab', 'TEAM')).toMatchObject({
      prefix: 'NIC',
      hasIssuedNumbers: false,
      matchesTeamPrefix: false,
    });
  });

  it('accepts a user prefix before allocation and warns when it matches the team prefix', async () => {
    const db = fakeDb([]);
    const store = fakeStore();

    expect(await reassignLocalKeyPrefix(db, store, '/src/app', ' app ', 'APP')).toMatchObject({
      prefix: 'APP',
      hasIssuedNumbers: false,
      matchesTeamPrefix: true,
    });
    expect(store.state['/src/app']).toEqual({ prefix: 'APP', counter: 0 });
  });
});

describe('assignMissingLocalKeys', () => {
  it('numbers unnumbered items in creation order', async () => {
    const db = fakeDb([
      row('b', '/src/app', '2026-08-02'),
      row('a', '/src/app', '2026-08-01'),
    ]);
    const store = fakeStore();

    expect(await assignMissingLocalKeys(db, store, '/src/app')).toBe(2);
    expect(db.rows.find((r) => r.id === 'a')?.local_key).toBe('APP.1');
    expect(db.rows.find((r) => r.id === 'b')?.local_key).toBe('APP.2');
  });

  /**
   * The `LC-###` rollback in one test: the counter was recomputed from rows
   * carrying a local key, so removing them released their numbers and the next
   * create reused one. An old note then resolved to a different item.
   */
  it('never reissues a number after its items are gone', async () => {
    const db = fakeDb([row('a', '/src/app', '2026-08-01'), row('b', '/src/app', '2026-08-02')]);
    const store = fakeStore();
    await assignMissingLocalKeys(db, store, '/src/app');

    db.rows.length = 0;
    db.rows.push(row('c', '/src/app', '2026-08-03'));
    await assignMissingLocalKeys(db, store, '/src/app');

    expect(db.rows.find((r) => r.id === 'c')?.local_key).toBe('APP.3');
  });

  it('spends rather than reissues a number when a write is lost', async () => {
    const db = fakeDb([row('a', '/src/app', '2026-08-01')]);
    const store = fakeStore();
    await assignMissingLocalKeys(db, store, '/src/app');

    // Simulate the row write being lost after the counter advanced.
    db.rows[0].local_key = null;
    await assignMissingLocalKeys(db, store, '/src/app');

    expect(db.rows[0].local_key).toBe('APP.2');
  });

  it('is a no-op on a second pass', async () => {
    const db = fakeDb([row('a', '/src/app', '2026-08-01')]);
    const store = fakeStore();

    expect(await assignMissingLocalKeys(db, store, '/src/app')).toBe(1);
    expect(await assignMissingLocalKeys(db, store, '/src/app')).toBe(0);
  });

  it('numbers each project from its own counter', async () => {
    const db = fakeDb([row('a', '/src/app', '2026-08-01'), row('b', '/src/site', '2026-08-01')]);
    const store = fakeStore();

    await assignMissingLocalKeys(db, store, '/src/app');
    await assignMissingLocalKeys(db, store, '/src/site');

    expect(db.rows.find((r) => r.id === 'a')?.local_key).toBe('APP.1');
    expect(db.rows.find((r) => r.id === 'b')?.local_key).toBe('SIT.1');
  });

  /**
   * The first launch after this feature shipped numbered ~2,800 rows one at a
   * time and blocked the tracker list for 224 seconds. Each row cost a settings
   * write, and a settings write clones and re-persists the whole workspace
   * store, so the per-row cost was never going to be small enough. Bound the
   * work per sweep rather than the wall clock, which no test can pin.
   */
  it('costs a bounded number of settings writes and queries however many rows it numbers', async () => {
    const rows = Array.from({ length: 500 }, (_, i) =>
      row(`id-${String(i).padStart(4, '0')}`, '/src/app', `2026-08-${String((i % 28) + 1).padStart(2, '0')}`));
    const db = fakeDb(rows);
    const store = fakeStore({ '/src/app': { prefix: 'APP', counter: 0 } });
    const queriesBefore = db.queries;

    expect(await assignMissingLocalKeys(db, store, '/src/app')).toBe(500);

    // A per-row implementation spends 500 writes and 1500 queries here.
    expect(store.writes).toBeLessThanOrEqual(10);
    expect(db.queries - queriesBefore).toBeLessThanOrEqual(30);
    expect(rows.every((r) => r.local_key !== null)).toBe(true);
    expect(new Set(rows.map((r) => r.local_key)).size).toBe(500);
    expect(store.state['/src/app']?.counter).toBe(500);
  });

  it('serializes overlapping sweeps and reports the keys actually stored', async () => {
    const db = fakeDb([
      row('a', '/src/app', '2026-08-01'),
      row('b', '/src/app', '2026-08-02'),
    ]);
    const store = fakeStore({ '/src/app': { prefix: 'APP', counter: 0 } });

    const [first, second] = await Promise.all([
      assignLocalKeysToRows(db, store, '/src/app', ['a', 'b']),
      assignLocalKeysToRows(db, store, '/src/app', ['a', 'b']),
    ]);

    const committed = { a: 'APP.1', b: 'APP.2' };
    expect(Object.fromEntries(first)).toEqual(committed);
    expect(Object.fromEntries(second)).toEqual(committed);
    expect(store.state['/src/app']?.counter).toBe(2);
  });
});

/**
 * Re-prefixing exists because the automatic pin used to be able to land on the
 * team's own letters, and the counter locked the prefix before anyone saw it.
 * The numbers are what a note or a commit message actually holds onto, so they
 * survive: only the letters move.
 */
describe('reassignLocalKeyPrefix', () => {
  it('rewrites every existing number and keeps the counter', async () => {
    const db = fakeDb([row('a', '/src/app', '2026-08-01'), row('b', '/src/app', '2026-08-02')]);
    const store = fakeStore();
    await assignMissingLocalKeys(db, store, '/src/app');

    expect(await reassignLocalKeyPrefix(db, store, '/src/app', 'NIC')).toMatchObject({
      prefix: 'NIC',
      hasIssuedNumbers: true,
    });
    expect(db.rows.map((r) => r.local_key)).toEqual(['NIC.1', 'NIC.2']);
    expect(store.state['/src/app']?.counter).toBe(2);

    // The old letters must stop resolving, and the new ones must start.
    expect(await resolveRowByLocalKey(db, 'APP.1', '/src/app')).toBeNull();
    expect(await resolveRowByLocalKey(db, 'NIC.1', '/src/app')).toMatchObject({ id: 'a' });
  });

  it('numbers issued after the move continue the same sequence', async () => {
    const db = fakeDb([row('a', '/src/app', '2026-08-01')]);
    const store = fakeStore();
    await assignMissingLocalKeys(db, store, '/src/app');
    await reassignLocalKeyPrefix(db, store, '/src/app', 'NIC');

    db.rows.push(row('b', '/src/app', '2026-08-02'));
    await assignMissingLocalKeys(db, store, '/src/app');

    expect(db.rows.find((r) => r.id === 'b')?.local_key).toBe('NIC.2');
  });

  it('applies the same validation as choosing a prefix before allocation', async () => {
    const db = fakeDb([row('a', '/src/app', '2026-08-01')]);
    const store = fakeStore({ '/src/other': { prefix: 'ONE', counter: 3 } });
    await assignMissingLocalKeys(db, store, '/src/app');

    await expect(reassignLocalKeyPrefix(db, store, '/src/app', '1x')).rejects.toThrow('2-5 uppercase letters');
    await expect(reassignLocalKeyPrefix(db, store, '/src/app', 'ONE')).rejects.toThrow('already used');
    expect(db.rows[0].local_key).toBe('APP.1');
  });
});

describe('resolveRowByLocalKey', () => {
  it('resolves only inside the project that issued the number', async () => {
    const db = fakeDb([row('a', '/src/app', '2026-08-01')]);
    const store = fakeStore();
    await assignMissingLocalKeys(db, store, '/src/app');

    expect(await resolveRowByLocalKey(db, 'APP.1', '/src/app')).toMatchObject({ id: 'a' });
    expect(await resolveRowByLocalKey(db, 'APP.1', '/src/site')).toBeNull();
  });

  it('refuses a team key, so a dash can never reach the local lane', async () => {
    const db = fakeDb([row('a', '/src/app', '2026-08-01')]);
    expect(await resolveRowByLocalKey(db, 'NIM-212', '/src/app')).toBeNull();
  });
});
