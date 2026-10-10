// @vitest-environment node
import { expect, it, vi } from 'vitest';
import { PGlite } from '@electric-sql/pglite';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { SQLiteDatabase } from '../../database/sqlite/SQLiteDatabase';
import { createPGLiteSessionStore } from '../PGLiteSessionStore';
import { readSessionSubtree, findSessionTreeRoot, type HierarchyDatabase } from '../sessionHierarchy';
import { migrateSessionTrees } from '../sessionTreeMigration';
import { healArchivedWorkstreamChildren } from '../healArchivedWorkstreamChildren';
import { assertChildSpawnCapacity, reserveChildSpawnCapacity, getSpawnedSessionRows } from '../metaAgentSessionQueries';
import { QueueDriveService } from '../ai/QueueDriveService';
import { LEGACY_SESSION_TYPES_SQL } from '../../database/legacySessionTypes';

vi.mock('../../database/PGLiteDatabaseWorker', () => ({ database: { query: vi.fn() } }));

// Isolated in-memory PostgreSQL fixture; never opens the user's live database.
const PG_SCHEMA = `CREATE TABLE worktrees (id TEXT PRIMARY KEY, name TEXT, branch TEXT, path TEXT, workspace_id TEXT, is_archived BOOLEAN DEFAULT FALSE);
  CREATE TABLE ai_sessions (
    id TEXT PRIMARY KEY, workspace_id TEXT, file_path TEXT, provider TEXT, model TEXT, title TEXT,
    session_type TEXT DEFAULT 'session', mode TEXT, agent_role TEXT,
    worktree_id TEXT REFERENCES worktrees(id), parent_session_id TEXT REFERENCES ai_sessions(id) ON DELETE SET NULL,
    created_by_session_id TEXT REFERENCES ai_sessions(id) ON DELETE SET NULL,
    document_context JSONB, provider_config JSONB, provider_session_id TEXT, draft_input TEXT,
    metadata JSONB DEFAULT '{}', has_been_named BOOLEAN, created_at TIMESTAMPTZ DEFAULT NOW(), updated_at TIMESTAMPTZ DEFAULT NOW(),
    branched_from_session_id TEXT, branch_point_message_id INTEGER, branched_at TIMESTAMPTZ,
    is_archived BOOLEAN DEFAULT FALSE, is_pinned BOOLEAN DEFAULT FALSE, status TEXT DEFAULT 'idle', last_activity TIMESTAMPTZ,
    last_read_timestamp TIMESTAMPTZ, last_document_state JSONB
  );
  CREATE TABLE ai_agent_messages (id INTEGER, session_id TEXT, direction TEXT, hidden BOOLEAN);
  CREATE TABLE queued_prompts (id TEXT PRIMARY KEY, session_id TEXT, prompt TEXT, status TEXT);`;

it.each(['pglite', 'sqlite'] as const)('%s executes recursive fetch/count/archive/heal, safe migration and hierarchy guards', async backend => {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'nim-session-tree-'));
  const raw = backend === 'pglite' ? new PGlite() : new SQLiteDatabase({ dbDir: temporary,
    schemaDir: path.resolve(__dirname, '../../database/sqlite/schemas'), sampleRate: 0 });
  try {
    if (raw instanceof PGlite) { await raw.waitReady; await raw.exec(PG_SCHEMA); }
    else await raw.initialize();
    const db: HierarchyDatabase = raw instanceof PGlite ? {
      query: (sql, params) => raw.query(sql, params),
      runTransaction: async statements => { await raw.transaction(async tx => {
        for (const statement of statements) {
          const result = await tx.query(statement.sql, statement.params);
          if (statement.expectedRows !== undefined && result.rows.length !== statement.expectedRows) throw new Error('Transaction conflict');
        }
      }); },
    } : raw;
    const store = createPGLiteSessionStore(db);
    await store.create({ id: 'wrapper', provider: 'claude-code', workspaceId: '/p', sessionType: 'workstream' });
    await store.create({ id: 'root', provider: 'claude-code', workspaceId: '/p', parentSessionId: 'wrapper' });
    await store.create({ id: 'child', provider: 'claude-code', workspaceId: '/p', parentSessionId: 'wrapper', createdBySessionId: 'root' });
    await store.create({ id: 'leaf', provider: 'claude-code', workspaceId: '/p', parentSessionId: 'wrapper', createdBySessionId: 'child' });
    expect((await migrateSessionTrees(db)).moved).toBe(2);
    expect((await migrateSessionTrees(db)).moved).toBe(0);
    expect((await store.get('leaf'))?.metadata).toMatchObject({ preTreeParentSessionId: 'wrapper' });
    expect((await readSessionSubtree(db, 'wrapper', '/p')).map(row => [row.id, Number(row.depth)])).toEqual([
      ['wrapper', 0], ['root', 1], ['child', 2], ['leaf', 3],
    ]);
    expect((await readSessionSubtree(db, 'wrapper', '/p')).map(row => [row.id, Number(row.descendant_count)])).toEqual([
      ['wrapper', 3], ['root', 2], ['child', 1], ['leaf', 0],
    ]);
    expect(await findSessionTreeRoot(db, 'leaf', '/p')).toBe('wrapper');
    expect((await store.list('/p')).find(row => row.id === 'root')).toMatchObject({ childCount: 1, descendantCount: 2 });
    await expect(store.updateMetadata('root', { parentSessionId: 'leaf' })).rejects.toThrow(/cycle/i);
    await expect(store.updateMetadata('wrapper', { parentSessionId: 'root' })).rejects.toThrow(/roots/i);
    await db.query("INSERT INTO worktrees (id, workspace_id, name, branch, path) VALUES ('wt', '/p', 'wt', 'wt', '/p-wt')");
    await store.create({ id: 'foreign', provider: 'claude-code', workspaceId: '/p', worktreeId: 'wt' });
    await expect(store.updateMetadata('child', { parentSessionId: 'foreign' })).rejects.toThrow(/worktree/i);
    await store.create({ id: 'blitz', provider: 'claude-code', workspaceId: '/p', sessionType: 'blitz' });
    await store.create({ id: 'blitz-worker', provider: 'claude-code', workspaceId: '/p', parentSessionId: 'blitz', worktreeId: 'wt' });
    await store.updateMetadata('root', { isArchived: true });
    expect(Boolean((await store.get('leaf'))?.isArchived)).toBe(true);
    await store.updateMetadata('root', { isArchived: false });
    expect(Boolean((await store.get('leaf'))?.isArchived)).toBe(false);
    await db.query("UPDATE ai_sessions SET is_archived = TRUE WHERE id = 'root'");
    expect((await healArchivedWorkstreamChildren(db)).healed).toBe(2);
    expect((await healArchivedWorkstreamChildren(db)).healed).toBe(0);
    await store.updateMetadata('root', { isArchived: false });
    await store.delete('child');
    expect((await store.get('leaf'))?.parentSessionId).toBe('root');
    await store.updateMetadata('leaf', { parentSessionId: null });
    const [intent] = (await store.listPendingHierarchyIntents!()).filter(row => row.sessionId === 'leaf');
    expect(intent).toMatchObject({ parentSessionId: null, createdBySessionId: null });
    expect(await store.acknowledgeHierarchyIntent!('leaf', intent.revision, null, null)).toBe(true);
    const remote = await store.applyRemoteHierarchySnapshot!([{ sessionId: 'leaf', parentSessionId: 'root' }], () => true);
    expect(remote[0]).toMatchObject({ accepted: true, parentSessionId: 'root', createdBySessionId: 'root' });
    expect((await store.listPendingHierarchyIntents!()).some(row => row.sessionId === 'leaf')).toBe(false);
  } finally { await raw.close(); fs.rmSync(temporary, { recursive: true, force: true }); }
});

it('legacy startup conversion preserves real tree parents as sessions', async () => {
  const raw = new PGlite();
  try {
    await raw.waitReady; await raw.exec(PG_SCHEMA);
    await raw.query("INSERT INTO ai_sessions (id, session_type) VALUES ('root', 'session'), ('wrapper', 'workstream')");
    await raw.query("INSERT INTO ai_sessions (id, parent_session_id) VALUES ('leaf', 'root')");
    await raw.exec(LEGACY_SESSION_TYPES_SQL);
    expect((await raw.query("SELECT session_type FROM ai_sessions WHERE id = 'root'")).rows).toEqual([{ session_type: 'session' }]);
  } finally { await raw.close(); }
});

it.each(['pglite', 'sqlite'] as const)('%s excludes drag-acquired history from lifetime limits, but counts running sessions', async backend => {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'nim-session-limit-'));
  const raw = backend === 'pglite' ? new PGlite() : new SQLiteDatabase({ dbDir: temporary,
    schemaDir: path.resolve(__dirname, '../../database/sqlite/schemas'), sampleRate: 0 });
  try {
    if (raw instanceof PGlite) { await raw.waitReady; await raw.exec(PG_SCHEMA); }
    else await raw.initialize();
    await raw.query("INSERT INTO ai_sessions (id, workspace_id, provider) VALUES ('old', '/p', 'claude-code'), ('new', '/p', 'claude-code')");
    for (let i = 0; i < 50; i++) await raw.query(`INSERT INTO ai_sessions (id, workspace_id, provider, created_by_session_id, metadata)
      VALUES ($1, '/p', 'claude-code', 'new', $2)`, [`s${i}`, JSON.stringify({ originalSpawnerSessionId: 'old', managerReassignedByUser: true })]);
    await expect(assertChildSpawnCapacity('/p', 'new', raw)).resolves.toBeUndefined();
    expect(await getSpawnedSessionRows('old', '/p', raw)).toHaveLength(0);
    expect(await getSpawnedSessionRows('new', '/p', raw)).toHaveLength(50);
    const pending = await Promise.all([0, 1, 2, 3].map(index => reserveChildSpawnCapacity('/p', 'new', `reserved${index}`, raw)));
    try {
      await expect(reserveChildSpawnCapacity('/p', 'new', 'fifth', raw)).rejects.toThrow(/running at once/i);
      await raw.query("INSERT INTO ai_sessions (id, provider, workspace_id, created_by_session_id, status) VALUES ('reserved0', 'claude-code', '/p', 'new', 'running')");
      await expect(reserveChildSpawnCapacity('/p', 'new', 'fifth', raw)).rejects.toThrow(/running at once/i);
    } finally { pending.forEach(release => release()); }
    await raw.query("DELETE FROM ai_sessions WHERE id = 'reserved0'");
    await raw.query("INSERT INTO ai_sessions (id, provider, workspace_id) VALUES ('limit', 'claude-code', '/p')");
    for (let index = 0; index < 49; index++) await raw.query("INSERT INTO ai_sessions (id, provider, workspace_id, created_by_session_id) VALUES ($1, 'claude-code', '/p', 'limit')", [`limit${index}`]);
    const reservations = await Promise.allSettled([reserveChildSpawnCapacity('/p', 'limit', 'last-slot', raw), reserveChildSpawnCapacity('/p', 'limit', 'over-limit', raw)]);
    expect(reservations.filter(result => result.status === 'fulfilled')).toHaveLength(1);
    for (const result of reservations) if (result.status === 'fulfilled') result.value();
    await raw.query("UPDATE ai_sessions SET status = 'running' WHERE id IN ('s0','s1','s2','s3')");
    await expect(assertChildSpawnCapacity('/p', 'new', raw)).rejects.toThrow(/running at once/i);
  } finally { await raw.close(); fs.rmSync(temporary, { recursive: true, force: true }); }
});

it.each(['pglite', 'sqlite'] as const)('%s resumes migration and preserves null provenance across interrupted batches', async backend => {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'nim-tree-resume-'));
  const raw = backend === 'pglite' ? new PGlite() : new SQLiteDatabase({ dbDir: temporary, schemaDir: path.resolve(__dirname, '../../database/sqlite/schemas'), sampleRate: 0 });
  try {
    if (raw instanceof PGlite) { await raw.waitReady; await raw.exec(PG_SCHEMA); } else await raw.initialize();
    const db: HierarchyDatabase = raw instanceof PGlite ? { query: (sql, params) => raw.query(sql, params), runTransaction: async statements => { await raw.transaction(async tx => { for (const statement of statements) await tx.query(statement.sql, statement.params); }); } } : raw;
    const store = createPGLiteSessionStore(db);
    await store.create({ id: 'wrapper', provider: 'claude-code', workspaceId: '/p', sessionType: 'workstream' });
    await store.create({ id: 'root', provider: 'claude-code', workspaceId: '/p', parentSessionId: 'wrapper' });
    await store.create({ id: 'escaped', provider: 'claude-code', workspaceId: '/p', createdBySessionId: 'root' });
    for (let index = 0; index < 100; index++) await store.create({ id: `m${index}`, provider: 'claude-code', workspaceId: '/p', parentSessionId: 'wrapper', createdBySessionId: 'root' });
    await store.create({ id: 'leaf', provider: 'claude-code', workspaceId: '/p', parentSessionId: 'wrapper', createdBySessionId: 'm0' });
    let transactions = 0;
    const interrupted = { query: db.query.bind(db), runTransaction: async (statements: any[]) => { if (++transactions === 2) throw new Error('interrupted'); await db.runTransaction!(statements); } };
    await expect(migrateSessionTrees(interrupted)).rejects.toThrow('interrupted');
    expect((await store.get('escaped'))?.metadata).toHaveProperty('preTreeParentSessionId', null);
    expect((await migrateSessionTrees(db)).moved).toBeGreaterThan(0);
    expect((await store.get('leaf'))?.parentSessionId).toBe('m0');
    expect(await migrateSessionTrees(db)).toEqual({ moved: 0 });
    for (const id of ['A', 'B', 'unspawned']) await store.create({ id, provider: 'claude-code', workspaceId: '/p' });
    for (const parentSessionId of ['A', 'B', 'A']) await store.updateMetadata('unspawned', { parentSessionId });
    expect((await store.get('unspawned'))?.metadata).toHaveProperty('originalSpawnerSessionId', null);
  } finally { await raw.close(); fs.rmSync(temporary, { recursive: true, force: true }); }
});


it.each(['pglite', 'sqlite'] as const)('%s keeps deferred launches charged through actual queue-drive window recovery', async backend => {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'nim-tree-deferred-'));
  const raw = backend === 'pglite' ? new PGlite() : new SQLiteDatabase({ dbDir: temporary, schemaDir: path.resolve(__dirname, '../../database/sqlite/schemas'), sampleRate: 0 });
  let available = false;
  const listeners = new Set<() => void>();
  const driver = new QueueDriveService({
    attempt: async ({ sessionId }) => {
      if (!available) return { kind: 'deferred', reason: 'no-window' };
      await raw.query("UPDATE queued_prompts SET status='executing' WHERE session_id=$1", [sessionId]);
      await raw.query("UPDATE ai_sessions SET status='running' WHERE id=$1", [sessionId]);
      return { kind: 'dispatched' };
    },
    onWindowAvailable: (_workspace, callback) => { listeners.add(callback); return () => { listeners.delete(callback); }; },
    onSessionIdle: () => () => {}, logInfo: () => {}, logWarn: () => {}, logError: () => {},
  });
  try {
    if (raw instanceof PGlite) { await raw.waitReady; await raw.exec(PG_SCHEMA); } else await raw.initialize();
    await raw.query("INSERT INTO ai_sessions (id, workspace_id, provider) VALUES ('manager', '/p', 'claude-code')");
    for (let index = 0; index < 4; index++) {
      const id = `queued${index}`;
      const release = await reserveChildSpawnCapacity('/p', 'manager', id, raw);
      try {
        await raw.query("INSERT INTO ai_sessions (id, workspace_id, provider, created_by_session_id) VALUES ($1, '/p', 'claude-code', 'manager')", [id]);
        await raw.query("INSERT INTO queued_prompts (id, session_id, prompt, status) VALUES ($1, $1, 'launch', 'pending')", [id]);
        expect(await driver.drive(id, '/p', 'meta-agent')).toEqual({ kind: 'deferred', reason: 'no-window' });
      } finally { release(); }
    }
    await expect(reserveChildSpawnCapacity('/p', 'manager', 'fifth', raw)).rejects.toThrow(/running at once/i);
    available = true;
    for (const callback of [...listeners]) callback();
    await vi.waitFor(async () => expect((await raw.query("SELECT id FROM ai_sessions WHERE status='running'")).rows).toHaveLength(4));
    await expect(assertChildSpawnCapacity('/p', 'manager', raw)).rejects.toThrow(/running at once/i);
    await raw.query("UPDATE ai_sessions SET status='idle' WHERE id='queued0'");
    await expect(assertChildSpawnCapacity('/p', 'manager', raw)).rejects.toThrow(/running at once/i);
    await raw.query("UPDATE queued_prompts SET status='completed' WHERE session_id='queued0'");
    await expect(assertChildSpawnCapacity('/p', 'manager', raw)).resolves.toBeUndefined();
  } finally { driver.dispose(); await raw.close(); fs.rmSync(temporary, { recursive: true, force: true }); }
});
