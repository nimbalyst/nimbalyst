// @vitest-environment node
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

const sessions = new Map<string, any>();
vi.mock('@nimbalyst/runtime/storage/repositories/AISessionsRepository', () => ({
  AISessionsRepository: {
    get: vi.fn(async (id: string) => sessions.get(id) ?? null),
    create: vi.fn(async () => {}),
    updateMetadata: vi.fn(async () => {}),
  },
}));
const dbQuery = vi.fn();
vi.mock('../../../database/PGLiteDatabaseWorker', () => ({ database: { query: (...a: unknown[]) => dbQuery(...a) } }));
const dispatchMetaAgentTool = vi.fn();
vi.mock('../../../mcp/metaAgentServer', () => ({ dispatchMetaAgentTool: (...a: unknown[]) => dispatchMetaAgentTool(...a) }));
vi.mock('../../session/broadcastSessionCreated', () => ({ broadcastSessionCreated: vi.fn() }));
let stateListener: ((event: { type: string; sessionId: string }) => void) | null = null;
vi.mock('@nimbalyst/runtime/ai/server/SessionStateManager', () => ({
  getSessionStateManager: () => ({
    subscribe: (fn: typeof stateListener) => {
      stateListener = fn;
      return () => {
        stateListener = null;
      };
    },
  }),
}));

import { AISessionsRepository } from '@nimbalyst/runtime/storage/repositories/AISessionsRepository';
import {
  OWNED_SESSIONS_SQL,
  dispatchExtensionSessionsOp,
  setOwnedSessionEventSink,
  startExtensionSessionService,
  summarizeOwnedUsage,
} from '../extensionSessionsService';
import { OWNER_METADATA_MERGE_SQL, isParentNotificationSuppressed, stripOwnerControlledMetadata } from '../sessionOwnership';
import { translateAndBind } from '../../../database/sqlite/dialectTranslator';

const WS = '/ws/project';
const ME = 'com.example.owner';
const scope = { extensionId: ME, workspacePath: WS };
const owner = (extensionId: string, key = 'ada', extra: Record<string, unknown> = {}) => ({
  sessionOwner: { extensionId, key, ...extra },
});

const queue = {
  queuePromptForSession: vi.fn(async () => ({ id: 'q-1', prompt: 'p', createdAt: 1 })),
  triggerQueuedPromptProcessingForSession: vi.fn(async () => true),
};

beforeEach(() => {
  vi.clearAllMocks();
  sessions.clear();
  sessions.set('mine', { id: 'mine', workspacePath: WS, sessionType: 'session', metadata: owner(ME) });
  sessions.set('mine-ws', { id: 'mine-ws', workspacePath: WS, sessionType: 'workstream', metadata: owner(ME) });
  sessions.set('theirs', { id: 'theirs', workspacePath: WS, sessionType: 'session', metadata: owner('com.other') });
  sessions.set('theirs-ws', { id: 'theirs-ws', workspacePath: WS, sessionType: 'workstream', metadata: owner('com.other') });
  sessions.set('plain', { id: 'plain', workspacePath: WS, sessionType: 'session', metadata: {} });
  sessions.set('mine-elsewhere', { id: 'mine-elsewhere', workspacePath: '/ws/other', metadata: owner(ME) });
  startExtensionSessionService(queue);
});

describe('extension session broker scoping', () => {
  it('refuses every per-session op on sessions this extension does not own in this workspace', async () => {
    for (const sessionId of ['theirs', 'plain', 'mine-elsewhere', 'missing']) {
      for (const [op, args] of [
        ['sendPrompt', { sessionId, prompt: 'go' }],
        ['getStatus', { sessionId }],
        ['getResult', { sessionId }],
        ['updateOwnerMetadata', { sessionId, patch: { chapter: 2 } }],
        ['notifyUser', { sessionId, title: 't', body: 'b' }],
      ] as const) {
        await expect(dispatchExtensionSessionsOp(scope, op, args), `${op} on ${sessionId}`).rejects.toThrow(
          /not owned by this extension/
        );
      }
    }
    expect(queue.queuePromptForSession).not.toHaveBeenCalled();
    expect(AISessionsRepository.updateMetadata).not.toHaveBeenCalled();
    expect(dispatchMetaAgentTool).not.toHaveBeenCalled();
    expect(dbQuery).not.toHaveBeenCalled();

    const sent = await dispatchExtensionSessionsOp(scope, 'sendPrompt', { sessionId: 'mine', prompt: 'go' });
    expect(sent).toEqual({ queuedPromptId: 'q-1' });
    expect(queue.triggerQueuedPromptProcessingForSession).toHaveBeenCalledWith('mine', WS, 'meta-agent');
  });

  it('creates an owned session in one write, stamping the extension id from the host scope', async () => {
    const result = (await dispatchExtensionSessionsOp(scope, 'create', {
      ownerKey: 'ada',
      name: 'Ada, Monday shift',
      provider: 'claude-code',
      model: 'opus',
      directive: 'You are Ada.',
      effortLevel: 'high',
      workstreamId: 'mine-ws',
      ownerMetadata: { chapter: 1 },
      routeChildUpdatesToOwner: true,
      prompt: 'Start the shift',
      // Forged fields a module might try to smuggle in; the host ignores them.
      extensionId: 'com.other',
      sessionOwner: { extensionId: 'com.other', key: 'x' },
    })) as { sessionId: string; queuedPromptId: string | null };

    expect(AISessionsRepository.create).toHaveBeenCalledTimes(1);
    const row = vi.mocked(AISessionsRepository.create).mock.calls[0][0] as any;
    expect(row).toMatchObject({
      id: result.sessionId,
      provider: 'claude-code',
      model: 'claude-code:opus',
      title: 'Ada, Monday shift',
      workspaceId: WS,
      parentSessionId: 'mine-ws',
      hasBeenNamed: true,
    });
    expect(row.metadata).toEqual({
      sessionOwner: { extensionId: ME, key: 'ada', routeChildUpdatesToOwner: true },
      ownerMetadata: { chapter: 1 },
      sessionDirective: 'You are Ada.',
      effortLevel: 'high',
    });
    expect(AISessionsRepository.updateMetadata).not.toHaveBeenCalled();
    // The prompt is queued only after the row (and its owner) exists.
    expect(vi.mocked(AISessionsRepository.create).mock.invocationCallOrder[0]).toBeLessThan(
      queue.queuePromptForSession.mock.invocationCallOrder[0]
    );
    expect(result.queuedPromptId).toBe('q-1');

    // A container or spawner owned by another extension cannot be borrowed.
    for (const args of [{ workstreamId: 'theirs-ws' }, { createdBySessionId: 'theirs' }]) {
      await expect(
        dispatchExtensionSessionsOp(scope, 'create', { ownerKey: 'ada', name: 'n', provider: 'claude-code', model: 'opus', ...args })
      ).rejects.toThrow(/not owned by this extension/);
    }
  });

  it('rejects a directive on providers that never read it, and leaves directive-less creates alone', async () => {
    const base = { ownerKey: 'ada', name: 'n', prompt: 'hi' };
    for (const [provider, model] of [['claude', 'claude-sonnet-4-5'], ['openai', 'gpt-5'], ['claude-code-cli', 'opus']]) {
      await expect(
        dispatchExtensionSessionsOp(scope, 'create', { ...base, provider, model, directive: 'You are Ada.' }),
        provider
      ).rejects.toThrow(/does not apply session directives/);
    }
    expect(AISessionsRepository.create).not.toHaveBeenCalled();
    expect(queue.queuePromptForSession).not.toHaveBeenCalled();

    await dispatchExtensionSessionsOp(scope, 'create', { ...base, provider: 'openai-codex', model: 'gpt-5.5', directive: 'You are Ada.' });
    await dispatchExtensionSessionsOp(scope, 'create', { ...base, provider: 'claude', model: 'claude-sonnet-4-5' });
    const rows = vi.mocked(AISessionsRepository.create).mock.calls.map((c) => c[0] as any);
    expect(rows.map((r) => [r.provider, r.metadata.sessionDirective])).toEqual([
      ['openai-codex', 'You are Ada.'],
      ['claude', undefined],
    ]);
  });

  it('merges owner metadata into the bag without touching the rest of the row metadata', async () => {
    sessions.set('mine', { ...sessions.get('mine'), metadata: { ...owner(ME), ownerMetadata: { chapter: 1, stale: true }, phase: 'x' } });
    const res = await dispatchExtensionSessionsOp(scope, 'updateOwnerMetadata', {
      sessionId: 'mine',
      patch: { chapter: 2, stale: null },
    });
    expect(res).toEqual({ ownerMetadata: { chapter: 2 } });
    // Ordinary updateMetadata strips the bag, so the owner writes it with its own merge.
    expect(dbQuery).toHaveBeenCalledWith(OWNER_METADATA_MERGE_SQL, [JSON.stringify({ ownerMetadata: { chapter: 2 } }), 'mine']);
    expect(AISessionsRepository.updateMetadata).not.toHaveBeenCalled();
  });

  it('lists owned sessions across workspace spellings, drops archived from the roster, keeps them in usage', async () => {
    const usage = (n: number) => ({ tokenUsage: { inputTokens: n, outputTokens: 0, totalTokens: n } });
    const now = new Date().toISOString();
    const row = (id: string, workspace_id: string, is_archived: number | boolean, md: object) => ({
      id, workspace_id, is_archived, title: id, session_type: 'session', status: 'idle',
      created_at: now, updated_at: now, last_activity: now, metadata: JSON.stringify({ ...owner(ME), ...md }),
    });
    const ownedRows = [
      row('alt-spelling', `${WS}/`, 0, usage(1)),
      row('archived', WS, 1, usage(10)),
      row('other-project', '/ws/other', false, usage(100)),
    ];
    dbQuery.mockImplementation(async (sql: string) =>
      sql === OWNED_SESSIONS_SQL ? { rows: ownedRows } : { rows: [{ session_id: 'alt-spelling', count: '2' }] }
    );

    const roster = (await dispatchExtensionSessionsOp(scope, 'listOwned', {})) as Array<{ sessionId: string; queuedPromptCount: number }>;
    expect(roster.map((r) => [r.sessionId, r.queuedPromptCount])).toEqual([['alt-spelling', 2]]);

    const report = (await dispatchExtensionSessionsOp(scope, 'getUsage', { since: 0 })) as { totals: { totalTokens: number } };
    expect(report.totals.totalTokens).toBe(11);
    dbQuery.mockReset();
  });
});

describe('owned session settle delivery', () => {
  it('delivers settles to the owning extension only, and completed only once the queue is empty', async () => {
    const emit = vi.fn();
    setOwnedSessionEventSink({ hasListeners: () => true, emit });
    sessions.set('mine', {
      ...sessions.get('mine'),
      createdBySessionId: 'mine-parent',
      parentSessionId: 'mine-ws',
      metadata: {
        ...owner(ME),
        tokenUsage: { inputTokens: 10, outputTokens: 5, totalTokens: 15, costUSD: 0.01, cacheReadInputTokens: 200, cacheCreationInputTokens: 30 },
      },
    });
    const settle = async (type: string, sessionId: string, pending = '0') => {
      dbQuery.mockResolvedValueOnce({ rows: [{ count: pending }] });
      stateListener!({ type, sessionId });
      await new Promise((r) => setTimeout(r, 0));
    };

    await settle('session:completed', 'mine', '2');
    await settle('session:completed', 'plain');
    await settle('session:streaming', 'mine');
    expect(emit).not.toHaveBeenCalled();

    await settle('session:completed', 'mine');
    await settle('session:waiting', 'mine');
    // A failed queued turn emits error, then the chain cleanup's endSession
    // emits completed. The owner hears only the error until the session runs again.
    await settle('session:error', 'mine');
    await settle('session:completed', 'mine');
    await settle('session:started', 'mine');
    await settle('session:completed', 'mine');
    expect(emit.mock.calls.map((c) => [c[0], c[1], c[2].outcome])).toEqual([
      [ME, WS, 'completed'],
      [ME, WS, 'waiting'],
      [ME, WS, 'error'],
      [ME, WS, 'completed'],
    ]);
    expect(emit.mock.calls[0][2]).toMatchObject({
      sessionId: 'mine',
      ownerKey: 'ada',
      createdBySessionId: 'mine-parent',
      workstreamId: 'mine-ws',
      tokenUsage: {
        inputTokens: 10,
        outputTokens: 5,
        totalTokens: 15,
        costUSD: 0.01,
        cacheReadInputTokens: 200,
        cacheCreationInputTokens: 30,
        allTokens: 245,
      },
    });
    setOwnedSessionEventSink(null);
  });
});

describe('ownership helpers', () => {
  it('suppresses the parent re-drive for opted-out or owner-routed children only', () => {
    expect(isParentNotificationSuppressed({ notifyParent: false })).toBe(true);
    expect(isParentNotificationSuppressed(owner(ME, 'k', { routeChildUpdatesToOwner: true }))).toBe(true);
    expect(isParentNotificationSuppressed(JSON.stringify(owner(ME, 'k', { routeChildUpdatesToOwner: true })))).toBe(true);
    expect(isParentNotificationSuppressed(owner(ME))).toBe(false);
    expect(isParentNotificationSuppressed({})).toBe(false);
  });

  it('strips owner-controlled keys from renderer metadata writes', () => {
    expect(stripOwnerControlledMetadata({ ...owner(ME), ownerMetadata: {}, sessionDirective: 'd', phase: 'p' })).toEqual({
      sessionDirective: 'd',
      phase: 'p',
    });
  });
});

describe('owned usage', () => {
  it('counts lifetime usage of sessions active in the window, per key', () => {
    const since = 1_000;
    const report = summarizeOwnedUsage(
      [
        {
          sessionId: 'a',
          key: 'ada',
          lastActivity: 1_500,
          metadata: { tokenUsage: { inputTokens: 100, outputTokens: 20, totalTokens: 120, costUSD: 0.5, cacheReadInputTokens: 4_000, cacheCreationInputTokens: 500 } },
        },
        { sessionId: 'b', key: 'ada', lastActivity: 999, metadata: { tokenUsage: { inputTokens: 999, outputTokens: 999, totalTokens: 1998 } } },
        { sessionId: 'c', key: 'bob', lastActivity: 2_000, metadata: JSON.stringify({ tokenUsage: { inputTokens: 7, outputTokens: 3, totalTokens: 10 } }) },
        { sessionId: 'd', key: 'ada', lastActivity: 3_000, metadata: {} },
      ],
      { since }
    );
    // Rows written before the cache fields existed read them as 0.
    expect(report.totals).toEqual({
      inputTokens: 107,
      outputTokens: 23,
      totalTokens: 130,
      costUSD: 0.5,
      cacheReadInputTokens: 4_000,
      cacheCreationInputTokens: 500,
      allTokens: 4_630,
    });
    expect(report.sessions.map((s) => s.sessionId)).toEqual(['a', 'c', 'd']);
    expect(summarizeOwnedUsage([
      { sessionId: 'a', key: 'ada', lastActivity: 1_500, metadata: { tokenUsage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 } } },
      { sessionId: 'c', key: 'bob', lastActivity: 2_000, metadata: { tokenUsage: { inputTokens: 7, outputTokens: 3, totalTokens: 10 } } },
    ], { since, key: 'bob' }).totals.totalTokens).toBe(10);
  });
});

describe('owned-session query on both live backends', () => {
  const rows: Array<[string, string, string, string]> = [
    ['owned', WS, 'session', JSON.stringify(owner(ME))],
    ['foreign', WS, 'session', JSON.stringify(owner('com.other'))],
    ['elsewhere', '/ws/other', 'session', JSON.stringify(owner(ME))],
    ['unowned', WS, 'session', JSON.stringify({ phase: 'x' })],
    ['nullmeta', WS, 'session', 'null'],
  ];
  const ddl = (json: string, bool: string, ts: string) => `CREATE TABLE ai_sessions (
    id TEXT PRIMARY KEY, workspace_id TEXT, session_type TEXT, title TEXT, status TEXT,
    parent_session_id TEXT, created_by_session_id TEXT, is_archived ${bool},
    created_at ${ts}, updated_at ${ts}, last_activity ${ts}, metadata ${json})`;
  let dir: string;
  let pglite: any;

  beforeAll(async () => {
    const { PGlite } = await import('@electric-sql/pglite');
    dir = mkdtempSync(join(tmpdir(), 'owned-sessions-'));
    pglite = new PGlite({ dataDir: dir });
    await pglite.query(ddl('JSONB', 'BOOLEAN', 'TIMESTAMPTZ'));
    for (const [id, ws, type, md] of rows) {
      await pglite.query(
        `INSERT INTO ai_sessions (id, workspace_id, session_type, is_archived, created_at, updated_at, metadata)
         VALUES ($1, $2, $3, FALSE, NOW(), NOW(), $4::jsonb)`,
        [id, ws, type, md]
      );
    }
  }, 30_000);

  afterAll(async () => {
    await pglite?.close();
    rmSync(dir, { recursive: true, force: true });
  });

  // Workspace and archive filtering happen in JS (identity-aware spelling
  // match; archived rows still count toward usage), so SQL selects by owner.
  it('selects only this extension\'s sessions on PGLite', async () => {
    const { rows: out } = await pglite.query(OWNED_SESSIONS_SQL, [ME]);
    expect(out.map((r: any) => r.id).sort()).toEqual(['elsewhere', 'owned']);
  });

  it('selects only this extension\'s sessions on SQLite', async () => {
    const Database = (await import('better-sqlite3')).default;
    const db = new Database(':memory:');
    try {
      db.exec(ddl('TEXT', 'INTEGER', 'TEXT'));
      const insert = db.prepare(
        `INSERT INTO ai_sessions (id, workspace_id, session_type, is_archived, created_at, updated_at, metadata) VALUES (?, ?, ?, 0, '2026-09-28T00:00:00Z', '2026-09-28T00:00:00Z', ?)`
      );
      for (const r of rows) insert.run(...r);
      const { sql, binds } = translateAndBind(OWNED_SESSIONS_SQL, [ME]);
      const out = db.prepare(sql).all(binds) as Array<{ id: string }>;
      expect(out.map((r) => r.id).sort()).toEqual(['elsewhere', 'owned']);
    } finally {
      db.close();
    }
  });
});
