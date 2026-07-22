import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PGlite } from '@electric-sql/pglite';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { app } from 'electron';
import {
  database,
  PGLiteDatabaseWorker,
  resolveCheckedInPGLiteWorkerPath,
} from '../../database/PGLiteDatabaseWorker';
import { AISessionsRepository } from '@nimbalyst/runtime';
import { createSyncedSessionStore } from '@nimbalyst/runtime/sync';
import { SQLiteDatabase } from '../../database/sqlite/SQLiteDatabase';
import {
  createSQLiteStoreAdapter,
  type StoreDbAdapter,
} from '../../database/sqlite/SQLiteStoreAdapter';
import {
  compareUpdateSessionMetadataWithHostControlAuthority,
  createPGLiteSessionStore,
  getAllSessionsForSync,
} from '../PGLiteSessionStore';
import { SessionVisibilityControlService } from '../SessionVisibilityControlService';
import { bindVisibilityStorageRootAuthority } from '../../ipc/SessionHandlers';

describe('PGLiteSessionStore archive filters', () => {
  it('filters out sessions that belong to archived worktrees in list()', async () => {
    const queries: string[] = [];
    const db = {
      query: vi.fn(async (sql: string) => {
        queries.push(sql);
        return { rows: [] };
      }),
    };

    const store = createPGLiteSessionStore(db as any);
    await store.list('/workspace');

    expect(queries[0]).toContain('LEFT JOIN worktrees w ON s.worktree_id = w.id');
    expect(queries[0]).toContain('(s.worktree_id IS NULL OR w.is_archived = FALSE OR w.is_archived IS NULL)');
  });

  it('filters out sessions that belong to archived worktrees in search()', async () => {
    const queries: string[] = [];
    const db = {
      query: vi.fn(async (sql: string) => {
        queries.push(sql);
        return { rows: [] };
      }),
    };

    const store = createPGLiteSessionStore(db as any);
    await store.search('/workspace', 'worktree');

    expect(queries[0]).toContain('LEFT JOIN worktrees w ON s.worktree_id = w.id');
    expect(queries[0]).toContain('(s.worktree_id IS NULL OR w.is_archived = FALSE OR w.is_archived IS NULL)');
  });
});

// Regression: under SQLite, `metadata` / `document_context` / `provider_config`
// / `last_document_state` come back from the driver as raw JSON strings, not
// parsed objects. Without normalization at this boundary, downstream callers
// like SessionManager.updateSessionTokenUsage spread `{...session.metadata}`
// and iterate the string character by character into numeric-keyed
// properties; the result is re-serialized and written back, growing the row
// ~9x per write cycle until a single metadata column hits hundreds of MB.
// See the comment on parseJsonColumn in PGLiteSessionStore.
describe('PGLiteSessionStore JSON-column read normalization', () => {
  const makeRow = (overrides: Record<string, unknown> = {}) => ({
    id: 's1',
    workspace_id: '/ws',
    provider: 'claude-code',
    model: null,
    title: 'Untitled',
    session_type: 'session',
    mode: 'agent',
    agent_role: 'standard',
    created_by_session_id: null,
    parent_session_id: null,
    worktree_id: null,
    worktree_path: null,
    worktree_project_path: null,
    worktree_is_archived: null,
    is_archived: false,
    is_pinned: false,
    branched_from_session_id: null,
    branch_point_message_id: null,
    branched_at: null,
    branched_from_provider_session_id: null,
    created_at: new Date(0),
    updated_at: new Date(0),
    last_read_ms: null,
    has_been_named: false,
    draft_input: null,
    document_context: null,
    provider_config: null,
    provider_session_id: null,
    last_document_state: null,
    metadata: '{}',
    ...overrides,
  });

  it('get() returns metadata as a parsed object even when the driver returns a JSON string', async () => {
    const db = {
      query: vi.fn(async () => ({
        rows: [makeRow({ metadata: '{"tags":["foo"],"phase":"validating","tokenUsage":{"totalTokens":42}}' })],
      })),
    };
    const store = createPGLiteSessionStore(db as any);
    const session = await store.get('s1');
    expect(session?.metadata).toEqual({
      tags: ['foo'],
      phase: 'validating',
      tokenUsage: { totalTokens: 42 },
    });
    // The crucial guarantee for the corruption bug: spreading metadata
    // must NOT iterate characters of the original string.
    const spread = { ...(session?.metadata as Record<string, unknown>) };
    expect(spread).not.toHaveProperty('0');
    expect(spread).toHaveProperty('tags');
  });

  it.each([
    ['PGLite-shaped metadata', { workspaceId: '/metadata-alias' }],
    ['SQLite-shaped metadata', '{"workspaceId":"/metadata-alias"}'],
  ])('keeps the DB workspace column authoritative with %s', async (_label, metadata) => {
    const db = {
      query: vi.fn(async () => ({
        rows: [makeRow({
          workspace_id: '/repo',
          worktree_id: 'worktree-1',
          worktree_path: '/repo_worktrees/fresh',
          worktree_project_path: '/repo',
          metadata,
        })],
      })),
    };
    const store = createPGLiteSessionStore(db as any);

    const session = await store.get('s1');

    expect(session).toMatchObject({
      workspacePath: '/repo',
      worktreePath: '/repo_worktrees/fresh',
      worktreeProjectPath: '/repo',
    });
    expect(session?.metadata).toMatchObject({ workspaceId: '/metadata-alias' });
  });

  it.each([
    ['PGLite active', false, false],
    ['PGLite archived', true, true],
    ['SQLite active', 0, false],
    ['SQLite archived', 1, true],
  ])('get() normalizes %s session and joined-worktree lifecycle evidence', async (_label, storedValue, expectedValue) => {
    const queries: string[] = [];
    const db = {
      query: vi.fn(async (sql: string) => {
        queries.push(sql);
        return {
          rows: [makeRow({
            worktree_id: 'worktree-1',
            worktree_path: '/repo_worktrees/fresh',
            worktree_project_path: '/repo',
            worktree_is_archived: storedValue,
            is_archived: storedValue,
          })],
        };
      }),
    };
    const store = createPGLiteSessionStore(db as any);

    const session = await store.get('s1');

    expect(queries[0]).toContain('w.is_archived AS worktree_is_archived');
    expect(session?.worktreeIsArchived).toBe(expectedValue);
    expect(session?.isArchived).toBe(expectedValue);
  });

  it('get() leaves joined lifecycle evidence absent when the worktree row was deleted', async () => {
    const db = {
      query: vi.fn(async () => ({
        rows: [makeRow({
          worktree_id: 'worktree-deleted',
          worktree_path: null,
          worktree_is_archived: null,
        })],
      })),
    };
    const store = createPGLiteSessionStore(db as any);

    const session = await store.get('s1');

    expect(session).toMatchObject({ worktreeId: 'worktree-deleted' });
    expect(session?.worktreePath).toBeUndefined();
    expect(session?.worktreeIsArchived).toBeUndefined();
  });

  it('get() falls back to {} when the metadata text is malformed', async () => {
    const db = {
      query: vi.fn(async () => ({
        rows: [makeRow({ metadata: 'not json' })],
      })),
    };
    const store = createPGLiteSessionStore(db as any);
    const session = await store.get('s1');
    expect(session?.metadata).toEqual({});
  });

  it('get() refuses to treat a bare JSON string as a metadata object', async () => {
    // `JSON.parse('"foo"')` succeeds but yields a string; spreading that
    // would again hit the char-by-char trap. The normalizer must reject.
    const db = {
      query: vi.fn(async () => ({
        rows: [makeRow({ metadata: '"foo"' })],
      })),
    };
    const store = createPGLiteSessionStore(db as any);
    const session = await store.get('s1');
    expect(session?.metadata).toEqual({});
  });

  it('get() parses document_context, provider_config, last_document_state from JSON strings', async () => {
    const db = {
      query: vi.fn(async () => ({
        rows: [
          makeRow({
            document_context: '{"path":"/foo.md"}',
            provider_config: '{"endpoint":"https://api"}',
            last_document_state: '{"version":2}',
          }),
        ],
      })),
    };
    const store = createPGLiteSessionStore(db as any);
    const session = await store.get('s1');
    expect(session?.documentContext).toEqual({ path: '/foo.md' });
    expect(session?.providerConfig).toEqual({ endpoint: 'https://api' });
    expect(session?.lastDocumentState).toEqual({ version: 2 });
  });

  // Regression: a session whose AskUserQuestion / GitCommitProposal /
  // ExitPlanMode / ToolPermission / PromptForUserInput prompt was open at
  // the time of a renderer reload could end up with
  // sessionHasPendingInteractivePromptAtom stuck `true`, because the only
  // recovery was a runtime resolve event the new renderer never saw. The
  // fix persists the bit to `metadata.hasPendingPrompt` and surfaces it as
  // `hasPendingInteractivePrompt` so the renderer rehydrates BOTH true and
  // false from the DB on session list refresh.
  it('list() surfaces hasPendingInteractivePrompt from metadata.hasPendingPrompt', async () => {
    const db = {
      query: vi.fn(async () => ({
        rows: [
          {
            ...makeRow({
              id: 'with-pending',
              metadata: '{"hasPendingPrompt":true}',
            }),
            child_count: 0,
            effective_updated_at: new Date(0),
          },
          {
            ...makeRow({
              id: 'without-pending',
              metadata: '{"hasPendingPrompt":false}',
            }),
            child_count: 0,
            effective_updated_at: new Date(0),
          },
          {
            ...makeRow({
              id: 'missing-field',
              metadata: '{}',
            }),
            child_count: 0,
            effective_updated_at: new Date(0),
          },
        ],
      })),
    };
    const store = createPGLiteSessionStore(db as any);
    const list = await store.list('/ws');
    const findById = (id: string) => list.find((s) => s.id === id) as any;
    expect(findById('with-pending').hasPendingInteractivePrompt).toBe(true);
    expect(findById('without-pending').hasPendingInteractivePrompt).toBe(false);
    expect(findById('missing-field').hasPendingInteractivePrompt).toBe(false);
  });

  it('list() returns metadata-derived fields (tags, phase, hasUnread) from JSON-string metadata', async () => {
    const db = {
      query: vi.fn(async () => ({
        rows: [{
          ...makeRow({
            metadata: '{"tags":["bug-fix","sqlite"],"phase":"validating","hasUnread":true}',
          }),
          child_count: 0,
          effective_updated_at: new Date(0),
        }],
      })),
    };
    const store = createPGLiteSessionStore(db as any);
    const list = await store.list('/ws');
    expect(list[0]?.tags).toEqual(['bug-fix', 'sqlite']);
    expect(list[0]?.phase).toBe('validating');
    expect(list[0]?.hasUnread).toBe(true);
  });
});

describe('PGLiteSessionStore.updateMetadata defense-in-depth', () => {
  it('refuses to merge when metadata.metadata is a string and warns', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const db = {
      query: vi.fn(async () => ({ rows: [{ metadata: '{}' }] })),
    };
    const store = createPGLiteSessionStore(db as any);
    await store.updateMetadata('s1', { metadata: '{"poison":true}' as any });
    // No UPDATE should have been issued for the metadata column. The only
    // queries that ran were the ensureReady-style precondition queries.
    const updateCalls = db.query.mock.calls.filter((c: any[]) =>
      typeof c[0] === 'string' && /UPDATE\s+ai_sessions\s+SET\s+metadata\s*=/i.test(c[0])
    );
    expect(updateCalls.length).toBe(0);
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it('refuses an array metadata payload', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const db = { query: vi.fn(async () => ({ rows: [{ metadata: '{}' }] })) };
    const store = createPGLiteSessionStore(db as any);
    await store.updateMetadata('s1', { metadata: ['a', 'b'] as any });
    const updateCalls = db.query.mock.calls.filter((c: any[]) =>
      typeof c[0] === 'string' && /UPDATE\s+ai_sessions\s+SET\s+metadata\s*=/i.test(c[0])
    );
    expect(updateCalls.length).toBe(0);
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });
});

describe('PGLiteSessionStore durable Jean cleanup CAS', () => {
  const metadataA = {
    hasPendingPrompt: true,
    pendingPromptId: 'p1',
    pendingPromptGeneration: 'generation-a',
  };
  const metadataCleared = {
    hasPendingPrompt: false,
    pendingPromptId: null,
    pendingPromptGeneration: null,
  };

  function createPGliteStatementAdapter(native: PGlite): StoreDbAdapter {
    return {
      query: native.query.bind(native),
      transaction: async <T = any>(statements: Array<{
        sql: string; params?: any[]; expectedRowCount?: number;
      }>) => native.transaction(async (tx) => {
        const results: Array<{ rows: T[] }> = [];
        for (const [index, statement] of statements.entries()) {
          const result = await tx.query<T>(statement.sql, statement.params);
          if (statement.expectedRowCount !== undefined
            && result.rows.length !== statement.expectedRowCount) {
            throw new Error(
              `transaction expected row count mismatch at statement ${index}: expected ${statement.expectedRowCount}, got ${result.rows.length}`,
            );
          }
          results.push(result);
        }
        return results;
      }),
    };
  }

  async function exercise(db: StoreDbAdapter, cleanup: () => Promise<void>) {
    createPGLiteSessionStore(db);
    const authority = {
      receiptId: 'receipt-1',
      reservationOwner: 'owner-1',
      mutationId: 'mutation-1',
      mutationFence: 1,
      attentionGeneration: 'generation-a',
      step: 'prompt' as const,
    };
    try {
      await expect(compareUpdateSessionMetadataWithHostControlAuthority({
        sessionId: 'session-1',
        expectedMetadata: metadataA,
        nextMetadata: metadataCleared,
        authority,
        promptResult: 'cleared',
        promptEventIdentity: 'p1',
      })).resolves.toBe(true);
      const initialCommit = await db.query<any>(
        `SELECT metadata, cleanup_prompt_state FROM ai_sessions
         CROSS JOIN host_control_receipts WHERE ai_sessions.id = $1`,
        ['session-1'],
      );
      expect(initialCommit.rows[0]).toMatchObject({ cleanup_prompt_state: 'complete' });
      expect(typeof initialCommit.rows[0].metadata === 'string'
        ? JSON.parse(initialCommit.rows[0].metadata)
        : initialCommit.rows[0].metadata).toEqual(metadataCleared);
      await db.query(
        `UPDATE ai_sessions SET metadata = $2 WHERE id = $1`,
        ['session-1', JSON.stringify(metadataA)],
      );
      await db.query(
        `UPDATE host_control_receipts
         SET reservation_owner = 'owner-2', mutation_fence = 2,
             cleanup_prompt_state = 'claimed', cleanup_prompt_fence = 2
         WHERE id = 'receipt-1'`,
      );
      await expect(compareUpdateSessionMetadataWithHostControlAuthority({
        sessionId: 'session-1',
        expectedMetadata: metadataA,
        nextMetadata: metadataCleared,
        authority,
        promptResult: 'cleared',
        promptEventIdentity: 'p1',
      })).rejects.toThrow('transaction expected row count mismatch at statement 0: expected 1, got 0');
      const persisted = await db.query<any>('SELECT metadata FROM ai_sessions WHERE id = $1', ['session-1']);
      const decoded = typeof persisted.rows[0].metadata === 'string'
        ? JSON.parse(persisted.rows[0].metadata)
        : persisted.rows[0].metadata;
      expect(decoded).toEqual(metadataA);
    } finally {
      await cleanup();
    }
  }

  async function exerciseAtomicAttentionSettlement(db: StoreDbAdapter, cleanup: () => Promise<void>) {
    createPGLiteSessionStore(db);
    const attentionMetadataA = {
      attentionEvents: [
        { kind: 'interactive_prompt', promptId: 'p1', attentionGeneration: 'generation-a', status: 'pending' },
        { kind: 'interactive_prompt', promptId: 'p1', attentionGeneration: 'generation-b', status: 'pending' },
      ],
      attentionSummary: { pending: true },
    };
    const attentionMetadataSettled = {
      attentionEvents: [
        { kind: 'interactive_prompt', promptId: 'p1', attentionGeneration: 'generation-a', status: 'cancelled' },
        { kind: 'interactive_prompt', promptId: 'p1', attentionGeneration: 'generation-b', status: 'pending' },
      ],
      attentionSummary: { pending: true },
    };
    const authority = {
      receiptId: 'receipt-1',
      reservationOwner: 'owner-1',
      mutationId: 'mutation-1',
      mutationFence: 1,
      attentionGeneration: 'generation-a',
      step: 'attention' as const,
    };
    try {
      await expect(compareUpdateSessionMetadataWithHostControlAuthority({
        sessionId: 'session-1',
        expectedMetadata: attentionMetadataA,
        nextMetadata: attentionMetadataSettled,
        authority,
        attentionResult: 'settled',
        attentionOccurrence: { eventIdentity: 'p1', attentionGeneration: 'generation-a' },
      })).resolves.toBe(true);
      const committed = await db.query<any>(
        `SELECT metadata FROM ai_sessions WHERE id = $1`,
        ['session-1'],
      );
      const receipt = await db.query<any>(
        `SELECT cleanup_attention_state, cleanup_attention_result
         FROM host_control_receipts WHERE id = $1`,
        ['receipt-1'],
      );
      expect(typeof committed.rows[0].metadata === 'string'
        ? JSON.parse(committed.rows[0].metadata)
        : committed.rows[0].metadata).toEqual(attentionMetadataSettled);
      expect(receipt.rows[0]).toMatchObject({
        cleanup_attention_state: 'complete', cleanup_attention_result: 'settled',
      });

      // A non-current authority is a proved no-op for both durable facts: the
      // session CAS cannot clear metadata and the paired replay fact cannot
      // be invented by the second statement.
      await db.query(
        `UPDATE ai_sessions SET metadata = $2 WHERE id = $1`,
        ['session-1', JSON.stringify(attentionMetadataA)],
      );
      await db.query(
        `UPDATE host_control_receipts
         SET reservation_owner = 'owner-2', cleanup_attention_state = 'claimed',
             cleanup_attention_result = NULL
         WHERE id = 'receipt-1'`,
      );
      await expect(compareUpdateSessionMetadataWithHostControlAuthority({
        sessionId: 'session-1',
        expectedMetadata: attentionMetadataA,
        nextMetadata: attentionMetadataSettled,
        authority,
        attentionResult: 'settled',
        attentionOccurrence: { eventIdentity: 'p1', attentionGeneration: 'generation-a' },
      })).rejects.toThrow('transaction expected row count mismatch at statement 0: expected 1, got 0');
      const afterMiss = await db.query<any>(
        `SELECT s.metadata, h.cleanup_attention_state, h.cleanup_attention_result
         FROM ai_sessions s CROSS JOIN host_control_receipts h
         WHERE s.id = $1 AND h.id = $2`,
        ['session-1', 'receipt-1'],
      );
      expect(typeof afterMiss.rows[0].metadata === 'string'
        ? JSON.parse(afterMiss.rows[0].metadata)
        : afterMiss.rows[0].metadata).toEqual(attentionMetadataA);
      expect(afterMiss.rows[0]).toMatchObject({
        cleanup_attention_state: 'claimed', cleanup_attention_result: null,
      });
    } finally {
      await cleanup();
    }
  }

  async function exerciseAtomicPromptAbsence(db: StoreDbAdapter, cleanup: () => Promise<void>) {
    createPGLiteSessionStore(db);
    const metadataB = {
      hasPendingPrompt: true,
      pendingPromptId: 'p1',
      pendingPromptGeneration: 'generation-b',
      unrelated: { preserved: true },
    };
    const authority = {
      receiptId: 'receipt-absent',
      reservationOwner: 'owner-1',
      mutationId: 'mutation-absent',
      mutationFence: 1,
      attentionGeneration: 'generation-a',
      step: 'prompt' as const,
    };
    try {
      await expect(compareUpdateSessionMetadataWithHostControlAuthority({
        sessionId: 'session-absent',
        expectedMetadata: metadataB,
        nextMetadata: metadataB,
        authority,
        promptResult: 'already_absent',
        promptEventIdentity: 'p1',
      })).resolves.toBe(true);
      const committed = await db.query<any>(
        `SELECT s.metadata, h.cleanup_prompt_state
         FROM ai_sessions s CROSS JOIN host_control_receipts h
         WHERE s.id = $1 AND h.id = $2`,
        ['session-absent', 'receipt-absent'],
      );
      expect(typeof committed.rows[0].metadata === 'string'
        ? JSON.parse(committed.rows[0].metadata)
        : committed.rows[0].metadata).toEqual(metadataB);
      expect(committed.rows[0].cleanup_prompt_state).toBe('complete');
    } finally {
      await cleanup();
    }
  }

  it('consumes the exact cleanup fence in the same PGLite metadata statement', async () => {
    const db = new PGlite();
    await (db as unknown as { waitReady: Promise<void> }).waitReady;
    await db.exec(`
      CREATE TABLE ai_sessions (id TEXT PRIMARY KEY, metadata JSONB);
      CREATE TABLE host_control_receipts (
        id TEXT PRIMARY KEY, event_identity TEXT, reservation_owner TEXT, mutation_id TEXT,
        mutation_fence INTEGER, attention_generation TEXT, state TEXT,
        mutation_state TEXT, lease_expires_at TIMESTAMPTZ,
        cleanup_prompt_state TEXT, cleanup_prompt_fence INTEGER,
        cleanup_attention_state TEXT, cleanup_attention_fence INTEGER,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
      );
      INSERT INTO ai_sessions VALUES ('session-1',
        '{"hasPendingPrompt":true,"pendingPromptId":"p1","pendingPromptGeneration":"generation-a"}');
      INSERT INTO host_control_receipts VALUES (
        'receipt-1', 'p1', 'owner-1', 'mutation-1', 1, 'generation-a', 'reserved',
        'applied', '2999-01-01T00:00:00.000Z', 'claimed', 1, 'pending', 0);
    `);
    await exercise(createPGliteStatementAdapter(db), () => db.close());
  });

  it('atomically records exact-A PGLite attention settlement with its durable replay fact', async () => {
    const native = new PGlite();
    await (native as unknown as { waitReady: Promise<void> }).waitReady;
    await native.exec(`
      CREATE TABLE ai_sessions (id TEXT PRIMARY KEY, metadata JSONB);
      CREATE TABLE host_control_receipts (
        id TEXT PRIMARY KEY, event_identity TEXT, reservation_owner TEXT, mutation_id TEXT,
        mutation_fence INTEGER, attention_generation TEXT, state TEXT,
        mutation_state TEXT, lease_expires_at TIMESTAMPTZ,
        cleanup_prompt_state TEXT, cleanup_prompt_fence INTEGER,
        cleanup_attention_state TEXT, cleanup_attention_fence INTEGER,
        cleanup_attention_result TEXT,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
      );
      INSERT INTO ai_sessions VALUES ('session-1',
        '{"attentionEvents":[{"kind":"interactive_prompt","promptId":"p1","attentionGeneration":"generation-a","status":"pending"},{"kind":"interactive_prompt","promptId":"p1","attentionGeneration":"generation-b","status":"pending"}],"attentionSummary":{"pending":true}}');
      INSERT INTO host_control_receipts VALUES (
        'receipt-1', 'p1', 'owner-1', 'mutation-1', 1, 'generation-a', 'reserved',
        'applied', '2999-01-01T00:00:00.000Z', 'complete', 1, 'claimed', 1, NULL);
    `);
    const db = createPGliteStatementAdapter(native);
    await exerciseAtomicAttentionSettlement(db, () => native.close());
  });

  it('atomically records PGLite prompt already_absent without changing replacement B metadata', async () => {
    const native = new PGlite();
    await (native as unknown as { waitReady: Promise<void> }).waitReady;
    await native.exec(`
      CREATE TABLE ai_sessions (id TEXT PRIMARY KEY, metadata JSONB);
      CREATE TABLE host_control_receipts (
        id TEXT PRIMARY KEY, event_identity TEXT, reservation_owner TEXT, mutation_id TEXT,
        mutation_fence INTEGER, attention_generation TEXT, state TEXT,
        mutation_state TEXT, lease_expires_at TIMESTAMPTZ,
        cleanup_prompt_state TEXT, cleanup_prompt_fence INTEGER,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
      );
      INSERT INTO ai_sessions VALUES ('session-absent',
        '{"hasPendingPrompt":true,"pendingPromptId":"p1","pendingPromptGeneration":"generation-b","unrelated":{"preserved":true}}');
      INSERT INTO host_control_receipts VALUES (
        'receipt-absent', 'p1', 'owner-1', 'mutation-absent', 1, 'generation-a', 'reserved',
        'applied', '2999-01-01T00:00:00.000Z', 'claimed', 1, CURRENT_TIMESTAMP);
    `);
    await exerciseAtomicPromptAbsence(createPGliteStatementAdapter(native), () => native.close());
  });

  it('consumes the exact cleanup fence in the same SQLite metadata statement', async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nim364-session-cleanup-'));
    const sqlite = new SQLiteDatabase({
      dbDir: tempDir,
      schemaDir: path.resolve(__dirname, '../../database/sqlite/schemas'),
      slowQueryThresholdMs: 1000,
      sampleRate: 0,
    });
    await sqlite.initialize();
    const db = createSQLiteStoreAdapter(sqlite);
    await db.query('INSERT INTO ai_sessions(id, provider, metadata) VALUES ($1, $2, $3)', [
      'session-1', 'claude-code', JSON.stringify(metadataA),
    ]);
    await db.query(`
      INSERT INTO host_control_receipts(
        id, reservation_key, request_digest, operation, session_id, event_identity,
        attention_generation, state, reservation_owner, lease_expires_at,
        mutation_id, mutation_fence, mutation_state,
        cleanup_prompt_state, cleanup_prompt_fence)
      VALUES ($1,$2,$3,'inject_attention_reply',$4,$5,$6,'reserved',$7,$8,$9,1,'applied','claimed',1)
    `, [
      'receipt-1', 'attention-reply:session-cleanup', 'digest', 'session-1', 'p1',
      'generation-a', 'owner-1', new Date('2999-01-01T00:00:00.000Z'), 'mutation-1',
    ]);
    await exercise(db, async () => {
      await sqlite.close();
      fs.rmSync(tempDir, { recursive: true, force: true });
    });
  });

  it('atomically records exact-A SQLite attention settlement with its durable replay fact', async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nim364-session-attention-'));
    const sqlite = new SQLiteDatabase({
      dbDir: tempDir,
      schemaDir: path.resolve(__dirname, '../../database/sqlite/schemas'),
      slowQueryThresholdMs: 1000,
      sampleRate: 0,
    });
    await sqlite.initialize();
    const db = createSQLiteStoreAdapter(sqlite);
    await db.query('INSERT INTO ai_sessions(id, provider, metadata) VALUES ($1, $2, $3)', [
      'session-1', 'claude-code', JSON.stringify({
        attentionEvents: [
          { kind: 'interactive_prompt', promptId: 'p1', attentionGeneration: 'generation-a', status: 'pending' },
          { kind: 'interactive_prompt', promptId: 'p1', attentionGeneration: 'generation-b', status: 'pending' },
        ], attentionSummary: { pending: true },
      }),
    ]);
    await db.query(`
      INSERT INTO host_control_receipts(
        id, reservation_key, request_digest, operation, session_id, event_identity,
        attention_generation, state, reservation_owner, lease_expires_at,
        mutation_id, mutation_fence, mutation_state,
        cleanup_prompt_state, cleanup_prompt_fence,
        cleanup_attention_state, cleanup_attention_fence, cleanup_attention_result)
      VALUES ($1,$2,$3,'inject_attention_reply',$4,$5,$6,'reserved',$7,$8,$9,1,'applied',
              'complete',1,'claimed',1,NULL)
    `, [
      'receipt-1', 'attention-reply:session-attention', 'digest', 'session-1', 'p1',
      'generation-a', 'owner-1', new Date('2999-01-01T00:00:00.000Z'), 'mutation-1',
    ]);
    await exerciseAtomicAttentionSettlement(db, async () => {
      await sqlite.close();
      fs.rmSync(tempDir, { recursive: true, force: true });
    });
  });

  it('rejects a settled transition that mutates same-ID generation B before entering the transaction', async () => {
    const transaction = vi.fn();
    createPGLiteSessionStore({ query: vi.fn(), transaction } as any);
    const expected = {
      attentionEvents: [
        { kind: 'interactive_prompt', promptId: 'p1', attentionGeneration: 'generation-a', status: 'pending' },
        { kind: 'interactive_prompt', promptId: 'p1', attentionGeneration: 'generation-b', status: 'pending' },
      ],
      unrelated: { preserved: true },
    };
    await expect(compareUpdateSessionMetadataWithHostControlAuthority({
      sessionId: 'session-1',
      expectedMetadata: expected,
      nextMetadata: {
        ...expected,
        attentionEvents: [
          { ...expected.attentionEvents[0], status: 'cancelled' },
          { ...expected.attentionEvents[1], status: 'cancelled' },
        ],
      },
      authority: {
        receiptId: 'receipt-1', reservationOwner: 'owner-1', mutationId: 'mutation-1',
        mutationFence: 1, attentionGeneration: 'generation-a', step: 'attention',
      },
      attentionResult: 'settled',
      attentionOccurrence: { eventIdentity: 'p1', attentionGeneration: 'generation-a' },
    })).rejects.toThrow('host_control_attention_nonoccurrence_mutated');
    expect(transaction).not.toHaveBeenCalled();
  });

  it('rejects already_absent while exact A remains pending before entering the transaction', async () => {
    const transaction = vi.fn();
    createPGLiteSessionStore({ query: vi.fn(), transaction } as any);
    const expected = {
      attentionEvents: [
        { kind: 'interactive_prompt', promptId: 'p1', attentionGeneration: 'generation-a', status: 'pending' },
        { kind: 'interactive_prompt', promptId: 'p1', attentionGeneration: 'generation-b', status: 'pending' },
      ],
      unrelated: { preserved: true },
    };
    await expect(compareUpdateSessionMetadataWithHostControlAuthority({
      sessionId: 'session-1', expectedMetadata: expected, nextMetadata: expected,
      authority: {
        receiptId: 'receipt-1', reservationOwner: 'owner-1', mutationId: 'mutation-1',
        mutationFence: 1, attentionGeneration: 'generation-a', step: 'attention',
      },
      attentionResult: 'already_absent',
      attentionOccurrence: { eventIdentity: 'p1', attentionGeneration: 'generation-a' },
    })).rejects.toThrow('host_control_attention_absence_transition_invalid');
    expect(transaction).not.toHaveBeenCalled();
  });
});

type VisibilityRow = {
  id: string;
  workspace_id: string;
  metadata: string;
  is_pinned: boolean;
  parent_session_id: string | null;
  title: string;
  has_been_named: boolean;
  session_type: string;
  worktree_id: string | null;
  is_archived: boolean;
};

function makeVisibilityDatabase(initial: VisibilityRow[]) {
  const rows = new Map(initial.map((row) => [row.id, { ...row }]));
  const fenceOwners = new Map<string, string>();
  let beforeAtomicUpdate: (() => Promise<void>) | undefined;
  const db = {
    getEngine: () => 'sqlite' as const,
    query: vi.fn(async (sql: string, params: unknown[] = []) => {
      if (/SELECT metadata, is_pinned/i.test(sql)) {
        const row = rows.get(params[0] as string);
        return { rows: row ? [{ ...row }] : [] };
      }
      if (/^SELECT metadata FROM ai_sessions/i.test(sql.trim())) {
        const row = rows.get(params[0] as string);
        return { rows: row ? [{ metadata: row.metadata }] : [] };
      }
      if (/SELECT s\.\*/i.test(sql) && /WHERE s\.id=\$1 LIMIT 1/i.test(sql)) {
        const row = rows.get(params[0] as string);
        return { rows: row ? [{
          ...row,
          provider: 'claude-code',
          created_at: new Date(1),
          updated_at: new Date(2),
        }] : [] };
      }
      if (/UPDATE ai_sessions SET/i.test(sql) && /RETURNING 1 AS applied/i.test(sql)) {
        await beforeAtomicUpdate?.();
        beforeAtomicUpdate = undefined;
        const id = params[0] as string;
        const workspacePath = params[1] as string;
        const row = rows.get(id);
        if (!row || row.workspace_id !== workspacePath) return { rows: [] };
        const isPin = /is_pinned =/i.test(sql);
        const isParent = /parent_session_id =/i.test(sql);
        const isRename = /title =/i.test(sql);
        let cursor = 2;
        if (isPin && row.is_pinned !== params[cursor++]) return { rows: [] };
        if (isParent && row.parent_session_id !== params[cursor++]) return { rows: [] };
        if (isRename) {
          if (row.title !== params[cursor++] || row.has_been_named !== params[cursor++]) return { rows: [] };
        }
        const nextPinned = isPin ? params[cursor++] as boolean : row.is_pinned;
        const nextParent = isParent ? params[cursor++] as string | null : row.parent_session_id;
        const nextTitle = isRename ? params[cursor++] as string : row.title;
        const nextNamed = isRename ? params[cursor++] as boolean : row.has_been_named;
        const expectedMetadata = params[cursor++] as string;
        const nextMetadata = params[cursor++] as string;
        if (row.metadata !== expectedMetadata) return { rows: [] };
        if (/FROM ai_sessions destination/i.test(sql)) {
          const destinationId = params[cursor++] as string;
          const destinationWorkspace = params[cursor++] as string;
          const destination = rows.get(destinationId);
          const destinationComparison = destination?.workspace_id
            .replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
          if (
            !destination || destinationComparison !== destinationWorkspace ||
            destination.session_type !== 'workstream' || destination.parent_session_id !== null ||
            destination.worktree_id !== null || destination.is_archived
          ) return { rows: [] };
        }
        if (/FROM session_visibility_storage_fence storage_fence/i.test(sql)) {
          const fenceRoot = params[cursor++] as string;
          const fenceOwner = params[cursor++] as string;
          if (fenceOwners.get(fenceRoot) !== fenceOwner) return { rows: [] };
        }
        rows.set(id, {
          ...row,
          is_pinned: nextPinned,
          parent_session_id: nextParent,
          title: nextTitle,
          has_been_named: nextNamed,
          metadata: nextMetadata,
        });
        return { rows: [{ applied: 1 }] };
      }
      throw new Error(`Unexpected visibility test SQL: ${sql}`);
    }),
  };
  return {
    db,
    rows,
    installFence(rootIdentity: string, ownerId: string) {
      fenceOwners.set(rootIdentity, ownerId);
    },
    beforeNextAtomicUpdate(handler: () => Promise<void>) { beforeAtomicUpdate = handler; },
  };
}

const VISIBILITY_TEST_WORKSPACE = process.platform === 'win32' ? 'C:\\repo' : '/repo';
const VISIBILITY_TEST_COMPARISON = process.platform === 'win32' ? 'c:/repo' : '/repo';

function visibilityRow(id: string, overrides: Partial<VisibilityRow> = {}): VisibilityRow {
  return {
    id,
    workspace_id: VISIBILITY_TEST_WORKSPACE,
    metadata: '{}',
    is_pinned: false,
    parent_session_id: null,
    title: 'Before',
    has_been_named: false,
    session_type: 'session',
    worktree_id: null,
    is_archived: false,
    ...overrides,
  };
}

describe('PGLiteSessionStore durable visibility operation identity', () => {
  it('rejects canonical database nonce takeover before the visibility CAS linearizes', async () => {
    const memory = makeVisibilityDatabase([visibilityRow('target')]);
    const store = createPGLiteSessionStore(memory.db as any);
    const rootIdentity = 'physical-root-dev:inode';
    memory.installFence(rootIdentity, 'owner-a');
    let resume!: () => void;
    const gate = new Promise<void>((resolve) => { resume = resolve; });
    let reached!: () => void;
    const atDatabaseLinearization = new Promise<void>((resolve) => { reached = resolve; });
    memory.beforeNextAtomicUpdate(async () => { reached(); await gate; });
    const mutation: any = {
      mutationId: 'operation-fenced', workspacePath: VISIBILITY_TEST_WORKSPACE,
      workspaceComparisonPath: VISIBILITY_TEST_COMPARISON, operation: 'session_set_pinned',
      expected: { isPinned: false }, after: { isPinned: true },
    };
    Object.defineProperty(mutation, Symbol.for('nimbalyst.visibility-storage-fence'), {
      enumerable: false,
      value: {
        rootIdentity,
        ownerId: 'owner-a',
      },
    });

    const applying = store.applyVisibilityMutation?.('target', mutation);
    await atDatabaseLinearization;
    // Owner B wins the canonical shared database authority before A's UPDATE.
    // The predicate in A's UPDATE must now match zero rows.
    memory.installFence(rootIdentity, 'owner-b');
    resume();

    await expect(applying).resolves.toBe(false);
    expect(memory.rows.get('target')?.is_pinned).toBe(false);
    await expect(store.hasVisibilityMutation?.('target', 'operation-fenced')).resolves.toBe(false);
  });

  it('distinguishes no-write/same-after, committed/restore-before, and third-state writers', async () => {
    const memory = makeVisibilityDatabase([visibilityRow('target')]);
    const store = createPGLiteSessionStore(memory.db as any);

    // Reserved operation A never reaches the atomic write. An unrelated B
    // reaches the same visible after value, but cannot impersonate A.
    await store.applyVisibilityMutation?.('target', {
      mutationId: 'operation-b', workspacePath: VISIBILITY_TEST_WORKSPACE, workspaceComparisonPath: VISIBILITY_TEST_COMPARISON, operation: 'session_set_pinned',
      expected: { isPinned: false }, after: { isPinned: true },
    });
    await expect(store.hasVisibilityMutation?.('target', 'operation-a')).resolves.toBe(false);
    await expect(store.hasVisibilityMutation?.('target', 'operation-b')).resolves.toBe(true);

    // A committed operation remains attributable after another atomic writer
    // restores the original visible state.
    await store.applyVisibilityMutation?.('target', {
      mutationId: 'operation-c', workspacePath: VISIBILITY_TEST_WORKSPACE, workspaceComparisonPath: VISIBILITY_TEST_COMPARISON, operation: 'session_set_pinned',
      expected: { isPinned: true }, after: { isPinned: false },
    });
    await expect(store.hasVisibilityMutation?.('target', 'operation-b')).resolves.toBe(true);
    expect(memory.rows.get('target')?.is_pinned).toBe(false);

    // A third visible state likewise preserves both exact internal identities.
    await store.applyVisibilityMutation?.('target', {
      mutationId: 'operation-d', workspacePath: VISIBILITY_TEST_WORKSPACE, workspaceComparisonPath: VISIBILITY_TEST_COMPARISON, operation: 'session_rename',
      expected: { title: 'Before', hasBeenNamed: false },
      after: { title: 'Third state', hasBeenNamed: true },
    });
    await expect(store.hasVisibilityMutation?.('target', 'operation-d')).resolves.toBe(true);
    const publicSession = await store.get('target');
    expect(publicSession?.metadata).not.toHaveProperty('__nimbalystVisibilityMutationIds');
  });

  it('rejects a destination deleted at the storage barrier without changing the target', async () => {
    const memory = makeVisibilityDatabase([
      visibilityRow('target'),
      visibilityRow('destination', { session_type: 'workstream' }),
    ]);
    const store = createPGLiteSessionStore(memory.db as any);
    let release!: () => void;
    const barrier = new Promise<void>((resolve) => { release = resolve; });
    let reached!: () => void;
    const atAtomicUpdate = new Promise<void>((resolve) => { reached = resolve; });
    memory.beforeNextAtomicUpdate(async () => { reached(); await barrier; });
    const applying = store.applyVisibilityMutation?.('target', {
      mutationId: 'move-1', workspacePath: VISIBILITY_TEST_WORKSPACE, workspaceComparisonPath: VISIBILITY_TEST_COMPARISON, operation: 'session_set_workstream',
      expected: { parentSessionId: null }, after: { parentSessionId: 'destination' },
      destinationSessionId: 'destination',
    });
    await atAtomicUpdate;
    memory.rows.delete('destination');
    release();

    await expect(applying).resolves.toBe(false);
    expect(memory.rows.get('target')?.parent_session_id).toBeNull();
  });

  it('does not roll back or clobber a newer target reparent at the storage barrier', async () => {
    const memory = makeVisibilityDatabase([
      visibilityRow('target'),
      visibilityRow('destination', { session_type: 'workstream' }),
      visibilityRow('newer', { session_type: 'workstream' }),
    ]);
    const store = createPGLiteSessionStore(memory.db as any);
    let release!: () => void;
    const barrier = new Promise<void>((resolve) => { release = resolve; });
    let reached!: () => void;
    const atAtomicUpdate = new Promise<void>((resolve) => { reached = resolve; });
    memory.beforeNextAtomicUpdate(async () => { reached(); await barrier; });
    const applying = store.applyVisibilityMutation?.('target', {
      mutationId: 'stale-move', workspacePath: VISIBILITY_TEST_WORKSPACE, workspaceComparisonPath: VISIBILITY_TEST_COMPARISON, operation: 'session_set_workstream',
      expected: { parentSessionId: null }, after: { parentSessionId: 'destination' },
      destinationSessionId: 'destination',
    });
    await atAtomicUpdate;
    memory.rows.get('target')!.parent_session_id = 'newer';
    release();

    await expect(applying).resolves.toBe(false);
    expect(memory.rows.get('target')?.parent_session_id).toBe('newer');
  });
});

describe('PGLiteSessionStore visibility identity on the real SQLite engine', () => {
  const temporaryDirectories: string[] = [];
  const databases: SQLiteDatabase[] = [];

  afterEach(async () => {
    for (const database of databases.splice(0)) await database.close();
    for (const directory of temporaryDirectories.splice(0)) {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });

  it('makes a database nonce takeover defeat a write paused before real SQLite linearization', async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'nim-366-fenced-sqlite-'));
    temporaryDirectories.push(directory);
    const sqlite = new SQLiteDatabase({
      dbDir: directory,
      schemaDir: path.resolve(__dirname, '..', '..', 'database', 'sqlite', 'schemas'),
      slowQueryThresholdMs: 1_000,
      sampleRate: 0,
    });
    databases.push(sqlite);
    await sqlite.initialize();
    await sqlite.query(
      `INSERT INTO ai_sessions (id, workspace_id, provider, metadata)
       VALUES ($1, $2, $3, $4)`,
      ['target', VISIBILITY_TEST_WORKSPACE, 'claude-code', '{}'],
    );
    await sqlite.query(`CREATE TABLE IF NOT EXISTS session_visibility_storage_fence (
      root_identity TEXT PRIMARY KEY,
      owner_id TEXT NOT NULL
    )`);
    await sqlite.query(
      'INSERT INTO session_visibility_storage_fence (root_identity, owner_id) VALUES ($1, $2)',
      ['physical-dev:inode', 'owner-a'],
    );
    const productionAdapter = createSQLiteStoreAdapter(sqlite);
    let resume!: () => void;
    const gate = new Promise<void>((resolve) => { resume = resolve; });
    let reached!: () => void;
    const atDatabaseLinearization = new Promise<void>((resolve) => { reached = resolve; });
    const db = {
      ...productionAdapter,
      query: async <T>(sql: string, params: unknown[] = []) => {
        if (/UPDATE ai_sessions SET/i.test(sql) && /session_visibility_storage_fence/i.test(sql)) {
          reached();
          await gate;
        }
        return productionAdapter.query<T>(sql, params);
      },
    };
    const store = createPGLiteSessionStore(db);
    const mutation: any = {
      mutationId: 'real-fence-takeover',
      workspacePath: VISIBILITY_TEST_WORKSPACE,
      workspaceComparisonPath: VISIBILITY_TEST_COMPARISON,
      operation: 'session_set_pinned',
      expected: { isPinned: false },
      after: { isPinned: true },
    };
    Object.defineProperty(mutation, Symbol.for('nimbalyst.visibility-storage-fence'), {
      enumerable: false,
      value: { rootIdentity: 'physical-dev:inode', ownerId: 'owner-a' },
    });

    const applying = store.applyVisibilityMutation?.('target', mutation);
    await atDatabaseLinearization;
    await sqlite.query(
      'UPDATE session_visibility_storage_fence SET owner_id = $1 WHERE root_identity = $2',
      ['owner-b', 'physical-dev:inode'],
    );
    resume();

    await expect(applying).resolves.toBe(false);
    const raw = await sqlite.query<{ is_pinned: number; metadata: string }>(
      'SELECT is_pinned, metadata FROM ai_sessions WHERE id = $1',
      ['target'],
    );
    expect(raw.rows[0].is_pinned).toBe(0);
    expect(JSON.parse(raw.rows[0].metadata))
      .not.toHaveProperty('__nimbalystVisibilityMutationIds.real-fence-takeover');
  });

  it('uses the real SQLite statement boundary for destination deletion and newer reparent schedules', async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'nim-366-workstream-sqlite-'));
    temporaryDirectories.push(directory);
    const sqlite = new SQLiteDatabase({
      dbDir: directory,
      schemaDir: path.resolve(__dirname, '..', '..', 'database', 'sqlite', 'schemas'),
      slowQueryThresholdMs: 1_000,
      sampleRate: 0,
    });
    databases.push(sqlite);
    await sqlite.initialize();
    for (const [id, sessionType] of [
      ['target', 'session'],
      ['destination', 'workstream'],
      ['destination-2', 'workstream'],
      ['newer-parent', 'workstream'],
    ]) {
      await sqlite.query(
        `INSERT INTO ai_sessions (id, workspace_id, provider, session_type, title, metadata)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [id, VISIBILITY_TEST_WORKSPACE, 'claude-code', sessionType, id, '{}'],
      );
    }

    const productionAdapter = createSQLiteStoreAdapter(sqlite);
    let beforeAtomicUpdate: (() => Promise<void>) | undefined;
    const db = {
      ...productionAdapter,
      query: async <T>(sql: string, params: unknown[] = []) => {
        if (/UPDATE ai_sessions SET/i.test(sql) && /EXISTS \(/i.test(sql)) {
          const barrier = beforeAtomicUpdate;
          beforeAtomicUpdate = undefined;
          await barrier?.();
        }
        return productionAdapter.query<T>(sql, params);
      },
    };
    const store = createPGLiteSessionStore(db);

    let releaseDelete!: () => void;
    const deleteGate = new Promise<void>((resolve) => { releaseDelete = resolve; });
    let deleteReached!: () => void;
    const atDeleteBoundary = new Promise<void>((resolve) => { deleteReached = resolve; });
    beforeAtomicUpdate = async () => { deleteReached(); await deleteGate; };
    const deletedDestination = store.applyVisibilityMutation?.('target', {
      mutationId: 'real-delete-race',
      workspacePath: VISIBILITY_TEST_WORKSPACE,
      workspaceComparisonPath: VISIBILITY_TEST_COMPARISON,
      operation: 'session_set_workstream',
      expected: { parentSessionId: null },
      after: { parentSessionId: 'destination' },
      destinationSessionId: 'destination',
    });
    await atDeleteBoundary;
    await sqlite.query('DELETE FROM ai_sessions WHERE id = $1', ['destination']);
    releaseDelete();
    await expect(deletedDestination).resolves.toBe(false);

    let releaseReparent!: () => void;
    const reparentGate = new Promise<void>((resolve) => { releaseReparent = resolve; });
    let reparentReached!: () => void;
    const atReparentBoundary = new Promise<void>((resolve) => { reparentReached = resolve; });
    beforeAtomicUpdate = async () => { reparentReached(); await reparentGate; };
    const staleReparent = store.applyVisibilityMutation?.('target', {
      mutationId: 'real-reparent-race',
      workspacePath: VISIBILITY_TEST_WORKSPACE,
      workspaceComparisonPath: VISIBILITY_TEST_COMPARISON,
      operation: 'session_set_workstream',
      expected: { parentSessionId: null },
      after: { parentSessionId: 'destination-2' },
      destinationSessionId: 'destination-2',
    });
    await atReparentBoundary;
    await sqlite.query(
      'UPDATE ai_sessions SET parent_session_id = $1 WHERE id = $2',
      ['newer-parent', 'target'],
    );
    releaseReparent();
    await expect(staleReparent).resolves.toBe(false);
    const target = await sqlite.query<{ parent_session_id: string | null }>(
      'SELECT parent_session_id FROM ai_sessions WHERE id = $1',
      ['target'],
    );
    expect(target.rows[0].parent_session_id).toBe('newer-parent');
  });

  it('preserves exact visibility state and its secret ledger across an existing-ID create upsert', async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'nim-366-create-upsert-sqlite-'));
    temporaryDirectories.push(directory);
    const sqlite = new SQLiteDatabase({
      dbDir: directory,
      schemaDir: path.resolve(__dirname, '..', '..', 'database', 'sqlite', 'schemas'),
      slowQueryThresholdMs: 1_000,
      sampleRate: 0,
    });
    databases.push(sqlite);
    await sqlite.initialize();
    await sqlite.query(
      `INSERT INTO ai_sessions (id, workspace_id, provider, title, has_been_named, metadata)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      ['target', VISIBILITY_TEST_WORKSPACE, 'claude-code', 'Before', false, '{}'],
    );
    const store = createPGLiteSessionStore(createSQLiteStoreAdapter(sqlite));
    const mutation = {
      mutationId: 'rename-before-stale-create',
      workspacePath: VISIBILITY_TEST_WORKSPACE,
      workspaceComparisonPath: VISIBILITY_TEST_COMPARISON,
      operation: 'session_rename' as const,
      expected: { title: 'Before', hasBeenNamed: false },
      after: { title: 'Authoritative rename', hasBeenNamed: true },
    };
    await expect(store.applyVisibilityMutation?.('target', mutation)).resolves.toBe(true);

    await store.create({
      id: 'target',
      provider: 'claude-code',
      workspaceId: VISIBILITY_TEST_WORKSPACE,
      title: 'Stale imported title',
      metadata: {
        importMarker: 'stale-public-payload',
        __nimbalystVisibilityMutationIds: { forged: 'caller-controlled' },
      },
      hasBeenNamed: false,
    } as any);

    const raw = await sqlite.query<{
      title: string;
      has_been_named: number;
      metadata: string;
    }>('SELECT title, has_been_named, metadata FROM ai_sessions WHERE id = $1', ['target']);
    expect(raw.rows[0].title).toBe('Authoritative rename');
    expect(raw.rows[0].has_been_named).toBe(1);
    const internalMetadata = JSON.parse(raw.rows[0].metadata);
    expect(internalMetadata.importMarker).toBe('stale-public-payload');
    expect(internalMetadata.__nimbalystVisibilityMutationIds).toHaveProperty(
      mutation.mutationId,
    );
    expect(internalMetadata.__nimbalystVisibilityMutationIds).not.toHaveProperty('forged');
    await expect(store.hasVisibilityMutation?.(
      'target', mutation.mutationId,
      internalMetadata.__nimbalystVisibilityMutationIds[mutation.mutationId],
    )).resolves.toBe(true);

    const publicSession = await store.get('target');
    expect(publicSession?.metadata).not.toHaveProperty('__nimbalystVisibilityMutationIds');
    const fullSync = await getAllSessionsForSync(false);
    expect(JSON.stringify(fullSync)).not.toContain(mutation.mutationId);
    expect(JSON.stringify(fullSync)).not.toContain('__nimbalystVisibilityMutationIds');
  });

  it('skips malformed legacy SQLite metadata before LIMIT and returns a later obligation', async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'nim-366-sync-obligation-sqlite-'));
    temporaryDirectories.push(directory);
    const sqlite = new SQLiteDatabase({
      dbDir: directory,
      schemaDir: path.resolve(__dirname, '..', '..', 'database', 'sqlite', 'schemas'),
      slowQueryThresholdMs: 1_000,
      sampleRate: 0,
    });
    databases.push(sqlite);
    await sqlite.initialize();
    await sqlite.query(
      `INSERT INTO ai_sessions (id, workspace_id, provider, metadata)
       VALUES ($1, $2, $3, $4), ($5, $6, $7, $8)`,
      [
        '000-malformed', '/repo', 'claude-code', '{ definitely-not-json',
        '100-valid', '/repo', 'claude-code', JSON.stringify({
          __nimbalystSyncPublicationObligation: {
            obligationId: 'valid-after-malformed',
            sessionId: '100-valid',
            workspaceId: '/repo',
            createdAt: 123,
          },
        }),
      ],
    );
    const store = createPGLiteSessionStore(createSQLiteStoreAdapter(sqlite));

    await expect(store.listSyncPublicationObligations?.(1)).resolves.toEqual([{
      obligationId: 'valid-after-malformed',
      sessionId: '100-valid',
      workspaceId: '/repo',
      createdAt: 123,
    }]);
  });

  it('persists a bounded obligation cursor across store reconstruction and wraps fairly', async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'nim-366-sync-cursor-sqlite-'));
    temporaryDirectories.push(directory);
    const sqlite = new SQLiteDatabase({
      dbDir: directory,
      schemaDir: path.resolve(__dirname, '..', '..', 'database', 'sqlite', 'schemas'),
      slowQueryThresholdMs: 1_000,
      sampleRate: 0,
    });
    databases.push(sqlite);
    await sqlite.initialize();
    for (let index = 0; index < 101; index += 1) {
      const id = `session-${index.toString().padStart(3, '0')}`;
      await sqlite.query(
        `INSERT INTO ai_sessions (id, workspace_id, provider, metadata)
         VALUES ($1, $2, $3, $4)`,
        [id, '/repo', 'claude-code', JSON.stringify({
          __nimbalystSyncPublicationObligation: {
            obligationId: `obligation-${index}`,
            sessionId: id,
            workspaceId: '/repo',
            createdAt: index,
          },
        })],
      );
    }

    const firstProcess = createPGLiteSessionStore(createSQLiteStoreAdapter(sqlite));
    const firstPage = await firstProcess.listSyncPublicationObligations?.(100);
    expect(firstPage).toHaveLength(100);
    expect(firstPage?.[0].sessionId).toBe('session-000');
    expect(firstPage?.[99].sessionId).toBe('session-099');

    const afterRestart = createPGLiteSessionStore(createSQLiteStoreAdapter(sqlite));
    const nextPage = await afterRestart.listSyncPublicationObligations?.(100);
    expect(nextPage?.map((fact) => fact.sessionId)).toEqual(['session-100']);

    const wrapped = await afterRestart.listSyncPublicationObligations?.(100);
    expect(wrapped).toHaveLength(100);
    expect(wrapped?.[0].sessionId).toBe('session-000');
  });

  it.skipIf(process.platform !== 'win32')(
    'preserves a committed identity through a stale generic write and strips every full-sync payload',
    async () => {
      const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'nim-366-visibility-sqlite-'));
      temporaryDirectories.push(directory);
      const sqlite = new SQLiteDatabase({
        dbDir: directory,
        schemaDir: path.resolve(__dirname, '..', '..', 'database', 'sqlite', 'schemas'),
        slowQueryThresholdMs: 1_000,
        sampleRate: 0,
      });
      databases.push(sqlite);
      await sqlite.initialize();
      await sqlite.query(
        `INSERT INTO ai_sessions (id, workspace_id, provider, title, metadata)
         VALUES ($1, $2, $3, $4, $5)`,
        ['target', 'C:\\Repo', 'claude-code', 'Target', JSON.stringify({ phase: 'before' })],
      );

      let releaseStaleRead!: () => void;
      const staleReadGate = new Promise<void>((resolve) => { releaseStaleRead = resolve; });
      let staleReadReached!: () => void;
      const atStaleRead = new Promise<void>((resolve) => { staleReadReached = resolve; });
      let interceptNextMetadataRead = true;
      const productionAdapter = createSQLiteStoreAdapter(sqlite);
      const db = {
        ...productionAdapter,
        query: async <T>(sql: string, params: unknown[] = []) => {
          const result = await productionAdapter.query<T>(sql, params);
          if (interceptNextMetadataRead && /^\s*SELECT metadata FROM ai_sessions/i.test(sql)) {
            interceptNextMetadataRead = false;
            staleReadReached();
            await staleReadGate;
          }
          return result;
        },
      };
      const store = createPGLiteSessionStore(db);

      const staleGenericWrite = store.updateMetadata('target', {
        metadata: {
          tags: ['stale-writer'],
          __nimbalystVisibilityMutationIds: { forged: 'caller-controlled' },
        },
      });
      await atStaleRead;

      const mutation = {
        mutationId: 'operation-real-sqlite',
        workspacePath: 'c:/repo/',
        workspaceComparisonPath: 'c:/repo',
        operation: 'session_set_pinned' as const,
        expected: { isPinned: false },
        after: { isPinned: true },
      };
      await expect(store.applyVisibilityMutation?.('target', mutation)).resolves.toBe(true);
      releaseStaleRead();
      await staleGenericWrite;

      await expect(store.hasVisibilityMutation?.('target', mutation.mutationId)).resolves.toBe(true);
      await expect(store.applyVisibilityMutation?.('target', mutation)).resolves.toBe(true);
      await expect(store.applyVisibilityMutation?.('target', {
        ...mutation,
        after: { isPinned: false },
      })).resolves.toBe(false);
      await expect(store.applyVisibilityMutation?.('target', {
        ...mutation,
        mutationId: 'wrong-workspace',
        workspacePath: 'D:\\other',
        workspaceComparisonPath: 'd:/other',
      })).resolves.toBe(false);

      const raw = await sqlite.query<{ metadata: string; is_pinned: number }>(
        'SELECT metadata, is_pinned FROM ai_sessions WHERE id = $1',
        ['target'],
      );
      expect(raw.rows[0].is_pinned).toBe(1);
      const internalMetadata = JSON.parse(raw.rows[0].metadata);
      expect(internalMetadata.__nimbalystVisibilityMutationIds).toHaveProperty(
        mutation.mutationId,
      );
      expect(internalMetadata.__nimbalystVisibilityMutationIds).not.toHaveProperty('forged');
      const exactIdentity = internalMetadata.__nimbalystVisibilityMutationIds[mutation.mutationId];
      await expect(store.hasVisibilityMutation?.(
        'target', mutation.mutationId, exactIdentity,
      )).resolves.toBe(true);
      await expect(store.hasVisibilityMutation?.(
        'target', mutation.mutationId, 'different-payload-fingerprint',
      )).resolves.toBe(false);

      const fullSync = await getAllSessionsForSync(false);
      expect(fullSync).toHaveLength(1);
      expect(fullSync[0].metadata).toEqual(expect.objectContaining({ tags: ['stale-writer'] }));
      expect(fullSync[0].metadata).not.toHaveProperty('__nimbalystVisibilityMutationIds');
      expect(JSON.stringify(fullSync)).not.toContain(mutation.mutationId);
    },
  );
});

describe('PGLiteSessionStore existing-ID ledger on the real PGLite dialect', () => {
  const checkedInWorkerAppPath = path.resolve(process.cwd(), 'packages', 'electron');
  let originalGetAppPathDescriptor: PropertyDescriptor | undefined;

  beforeEach(() => {
    originalGetAppPathDescriptor = Object.getOwnPropertyDescriptor(app, 'getAppPath');
    Object.defineProperty(app, 'getAppPath', {
      configurable: true,
      value: () => checkedInWorkerAppPath,
    });
  });

  afterEach(() => {
    if (originalGetAppPathDescriptor) {
      Object.defineProperty(app, 'getAppPath', originalGetAppPathDescriptor);
    } else {
      delete (app as { getAppPath?: unknown }).getAppPath;
    }
  });

  it('uses the production worker schema while preserving the protected row and secret ledger', async () => {
    const userDataPath = fs.mkdtempSync(path.join(os.tmpdir(), 'nim-366-pglite-production-schema-'));
    const getPath = vi.spyOn(app, 'getPath').mockImplementation((name: string) => (
      name === 'userData' ? userDataPath : os.tmpdir()
    ));
    const checkedInWorkerPath = resolveCheckedInPGLiteWorkerPath();
    expect(checkedInWorkerPath.replace(/\\/g, '/')).toMatch(/src\/main\/database\/worker\.js$/);
    const checkedInWorkerBytes = fs.readFileSync(checkedInWorkerPath, 'utf8');
    expect(checkedInWorkerBytes).toContain('async createSchemas()');
    expect(checkedInWorkerBytes).toContain('CREATE TABLE IF NOT EXISTS ai_sessions');
    const pglite = new PGLiteDatabaseWorker({ workerPathOverride: checkedInWorkerPath });
    try {
      // initialize() executes this checkout's worker.js bytes directly. It
      // cannot fall back to an absent/stale out/worker.bundle.js artifact.
      await pglite.initialize();
      const columns = await pglite.query<{
        column_name: string;
        is_nullable: string;
        column_default: string | null;
      }>(`
        SELECT column_name, is_nullable, column_default
        FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = 'ai_sessions'
      `);
      const byName = new Map(columns.rows.map((column) => [column.column_name, column]));
      for (const required of [
        'workspace_id', 'provider', 'title', 'parent_session_id', 'metadata',
        'has_been_named', 'is_pinned', 'is_archived', 'created_at', 'updated_at',
      ]) {
        expect(byName.has(required)).toBe(true);
      }
      expect(byName.get('provider')?.is_nullable).toBe('NO');
      expect(byName.get('metadata')?.column_default).toContain("'{}'");
      expect(byName.get('is_pinned')?.column_default).toContain('false');

      const store = createPGLiteSessionStore(pglite);
      await store.create({
        id: 'target',
        provider: 'claude-code',
        workspaceId: '/repo',
        title: 'Before',
      });
      const workspaceComparisonPath = path.resolve('/repo').replace(/\\/g, '/').replace(/\/+$/, '');
      const mutation = {
        mutationId: 'pglite-existing-id-operation',
        workspacePath: '/repo',
        workspaceComparisonPath: process.platform === 'win32'
          ? workspaceComparisonPath.toLowerCase()
          : workspaceComparisonPath,
        operation: 'session_rename' as const,
        expected: { title: 'Before', hasBeenNamed: false },
        after: { title: 'Authoritative title', hasBeenNamed: true },
      };
      await expect(store.applyVisibilityMutation?.('target', mutation)).resolves.toBe(true);

      await store.createWithSyncPublicationObligation?.({
        id: 'target',
        provider: 'claude-code',
        workspaceId: '/repo',
        title: 'Stale imported title',
        parentSessionId: 'stale-parent',
        metadata: {
          importMarker: 'public-import',
          __nimbalystVisibilityMutationIds: { forged: 'caller-controlled' },
        },
        hasBeenNamed: false,
      } as any, {
        obligationId: 'publication-obligation-1',
        sessionId: 'target',
        workspaceId: '/repo',
        createdAt: 123,
      });

      const raw = await pglite.query<{
        workspace_id: string;
        title: string;
        parent_session_id: string | null;
        has_been_named: boolean;
        metadata: Record<string, any>;
      }>(
        'SELECT workspace_id, title, parent_session_id, has_been_named, metadata FROM ai_sessions WHERE id = $1',
        ['target'],
      );
      expect(raw.rows[0]).toMatchObject({
        workspace_id: '/repo',
        title: 'Authoritative title',
        parent_session_id: null,
        has_been_named: true,
      });
      expect(raw.rows[0].metadata.importMarker).toBe('public-import');
      expect(raw.rows[0].metadata.__nimbalystVisibilityMutationIds)
        .toHaveProperty(mutation.mutationId);
      expect(raw.rows[0].metadata.__nimbalystVisibilityMutationIds)
        .not.toHaveProperty('forged');
      expect(raw.rows[0].metadata.__nimbalystSyncPublicationObligation).toEqual({
        obligationId: 'publication-obligation-1',
        sessionId: 'target',
        workspaceId: '/repo',
        createdAt: 123,
      });
      await store.create({
        id: '000-malformed-obligation',
        provider: 'claude-code',
        workspaceId: '/repo',
      });
      await pglite.query(
        `UPDATE ai_sessions
         SET metadata = $2::jsonb
         WHERE id = $1`,
        ['000-malformed-obligation', JSON.stringify({
          __nimbalystSyncPublicationObligation: { obligationId: 7 },
        })],
      );
      // Validation happens in the production SQL before LIMIT, so an earlier
      // malformed row cannot starve the first valid durable obligation.
      await expect(store.listSyncPublicationObligations?.(1)).resolves.toEqual([{
        obligationId: 'publication-obligation-1',
        sessionId: 'target',
        workspaceId: '/repo',
        createdAt: 123,
      }]);
      await expect(store.hasVisibilityMutation?.('target', mutation.mutationId))
        .resolves.toBe(true);
      const publicSession = await store.get('target');
      expect(publicSession).toMatchObject({
        title: 'Authoritative title',
        parentSessionId: null,
        hasBeenNamed: true,
      });
      expect(publicSession?.metadata)
        .not.toHaveProperty('__nimbalystVisibilityMutationIds');
      expect(publicSession?.metadata)
        .not.toHaveProperty('__nimbalystSyncPublicationObligation');
      const fullSync = await getAllSessionsForSync(false);
      expect(JSON.stringify(fullSync)).not.toContain('__nimbalystSyncPublicationObligation');
      expect(JSON.stringify(fullSync)).not.toContain('publication-obligation-1');
      const publicList = await store.list('/repo', { includeArchived: true });
      expect(JSON.stringify(publicList)).not.toContain(mutation.mutationId);
      expect(JSON.stringify(publicList)).not.toContain('__nimbalystVisibilityMutationIds');
      await expect(store.clearSyncPublicationObligation?.('target', 'wrong-id')).resolves.toBe(false);
      await expect(store.clearSyncPublicationObligation?.(
        'target', 'publication-obligation-1',
      )).resolves.toBe(true);
    } finally {
      await pglite.close().catch(() => undefined);
      getPath.mockRestore();
      fs.rmSync(userDataPath, { recursive: true, force: true });
    }
  });

  it('uses the active checked-in PGLite facade to reject a replaced canonical fence truthfully', async () => {
    const userDataPath = fs.mkdtempSync(path.join(os.tmpdir(), 'nim-366-pglite-fence-facade-'));
    const getPath = vi.spyOn(app, 'getPath').mockImplementation((name: string) => (
      name === 'userData' ? userDataPath : os.tmpdir()
    ));
    const previousDatabase = database.getActiveDatabase();
    const previousEngine = database.getEngine();
    const pglite = new PGLiteDatabaseWorker({
      workerPathOverride: resolveCheckedInPGLiteWorkerPath(),
    });
    let firstLease: Awaited<ReturnType<typeof bindVisibilityStorageRootAuthority>> | null = null;
    let successorLease: Awaited<ReturnType<typeof bindVisibilityStorageRootAuthority>> | null = null;
    try {
      await pglite.initialize();
      database.useDatabase(pglite, 'pglite');
      firstLease = await bindVisibilityStorageRootAuthority(userDataPath);

      let resume!: () => void;
      const gate = new Promise<void>((resolve) => { resume = resolve; });
      let reached!: () => void;
      const atRealStatement = new Promise<void>((resolve) => { reached = resolve; });
      const activeFacadeAdapter = {
        getEngine: () => database.getEngine(),
        query: async <T>(sql: string, params: unknown[] = []) => {
          if (/UPDATE ai_sessions SET/i.test(sql) && /session_visibility_storage_fence/i.test(sql)) {
            reached();
            await gate;
          }
          return database.query<T>(sql, params);
        },
      };
      const baseStore = createPGLiteSessionStore(activeFacadeAdapter);
      const syncProvider = {
        connect: vi.fn().mockResolvedValue(undefined), disconnect: vi.fn(),
        disconnectAll: vi.fn(), isConnected: vi.fn().mockReturnValue(true),
        getStatus: vi.fn(), onStatusChange: vi.fn(() => () => undefined),
        onRemoteChange: vi.fn(() => () => undefined), pushChange: vi.fn(),
        pushMetadataChangeWithResult: vi.fn().mockResolvedValue({
          outcome: 'index_frame_written', attempted: true,
          indexFrameWritten: true, skippedReason: null,
        }),
      } as any;
      const syncedStore = createSyncedSessionStore(baseStore, syncProvider);
      AISessionsRepository.setStore(syncedStore);
      await AISessionsRepository.create({
        id: 'actor', provider: 'claude-code', workspaceId: '/repo', title: 'Actor',
      });
      await AISessionsRepository.create({
        id: 'target', provider: 'claude-code', workspaceId: '/repo', title: 'Target',
      });
      syncProvider.pushMetadataChangeWithResult.mockClear();

      const reserved: string[] = [];
      const committed: string[] = [];
      const aborted: string[] = [];
      const audits: any[] = [];
      const service = new SessionVisibilityControlService({
        repository: AISessionsRepository,
        audit: (event) => { audits.push(event); },
        broadcast: () => false,
        randomId: () => 'pglite-fence-audit',
        assertStorageRootOwnership: () => firstLease!.assertOwned(),
        withStorageRootWriteFence: (work) => firstLease!.runProtectedWrite(work),
        convergenceOutbox: {
          start: async () => undefined,
          reserveMutation: async (intent) => { reserved.push(intent.auditId); },
          markMutationCommitted: async (auditId) => { committed.push(auditId); },
          markMutationAborted: async (auditId) => { aborted.push(auditId); },
          acknowledgeMutationAudit: async () => undefined,
          acknowledgeMutationDelivery: async () => undefined,
          enqueueAudit: async () => undefined,
          enqueueDelivery: async () => undefined,
          flush: async () => undefined,
          close: async () => undefined,
        },
      });

      const mutating = service.setPinned({
        actorSessionId: 'actor',
        workspacePath: '/repo',
        source: 'mcp-host',
        correlationId: 'pglite-fence-correlation',
      }, 'target', true);
      await atRealStatement;
      // Exercise the production fatal-loss path: A immediately loses the
      // physical-root endpoint while its already-admitted continuation remains
      // paused. B then acquires that same physical root through the exact
      // Electron registration/active-facade claim boundary.
      await firstLease.forfeitAfterFatalOwnershipLoss();
      successorLease = await bindVisibilityStorageRootAuthority(userDataPath);
      expect(successorLease.rootIdentity).toBe(firstLease.rootIdentity);
      expect(successorLease.ownerId).not.toBe(firstLease.ownerId);
      resume();

      await expect(mutating).rejects.toMatchObject({
        code: 'INTERNAL_ERROR', auditStatus: 'pending',
      });
      const raw = await database.query<{ is_pinned: boolean; metadata: Record<string, unknown> }>(
        'SELECT is_pinned, metadata FROM ai_sessions WHERE id = $1',
        ['target'],
      );
      expect(raw.rows[0].is_pinned).toBe(false);
      expect(raw.rows[0].metadata).not.toHaveProperty('__nimbalystVisibilityMutationIds');
      expect(reserved).toEqual(['pglite-fence-audit']);
      // A process that has fatally lost the physical-root lease may not forge
      // an abort/audit acknowledgement after takeover. The durable reservation
      // remains for successor restart reconciliation instead of being falsely
      // reported recorded or committed.
      expect(aborted).toEqual([]);
      expect(committed).toEqual([]);
      expect(audits).toEqual([]);
      expect(syncProvider.pushMetadataChangeWithResult).not.toHaveBeenCalled();
    } finally {
      await successorLease?.release().catch(() => undefined);
      await firstLease?.release().catch(() => undefined);
      AISessionsRepository.configureVisibilityStorageFence(null);
      AISessionsRepository.clearStore();
      database.useDatabase(previousDatabase, previousEngine);
      await pglite.close().catch(() => undefined);
      getPath.mockRestore();
      fs.rmSync(userDataPath, { recursive: true, force: true });
    }
  });

  it('keeps the repository tail around an entered PGLite mutation until the successor can commit last', async () => {
    const userDataPath = fs.mkdtempSync(path.join(os.tmpdir(), 'nim-366-pglite-generation-tail-'));
    const getPath = vi.spyOn(app, 'getPath').mockImplementation((name: string) => (
      name === 'userData' ? userDataPath : os.tmpdir()
    ));
    const previousDatabase = database.getActiveDatabase();
    const previousEngine = database.getEngine();
    const pglite = new PGLiteDatabaseWorker({
      workerPathOverride: resolveCheckedInPGLiteWorkerPath(),
    });
    try {
      await pglite.initialize();
      database.useDatabase(pglite, 'pglite');
      let releaseA!: () => void;
      const gate = new Promise<void>((resolve) => { releaseA = resolve; });
      let enteredA!: () => void;
      const atAStatement = new Promise<void>((resolve) => { enteredA = resolve; });
      const statementOrder: string[] = [];
      const activeFacadeAdapter = {
        getEngine: () => database.getEngine(),
        query: async <T>(sql: string, params: unknown[] = []) => {
          if (/UPDATE ai_sessions SET title\s*=/i.test(sql)) {
            const title = String(params[1]);
            statementOrder.push(`enter:${title}`);
            if (title === 'A') {
              enteredA();
              await gate;
            }
            const result = await database.query<T>(sql, params);
            statementOrder.push(`commit:${title}`);
            return result;
          }
          return database.query<T>(sql, params);
        },
      };
      const baseStore = createPGLiteSessionStore(activeFacadeAdapter);
      await baseStore.create({
        id: 'generation-tail-target', provider: 'claude-code',
        workspaceId: '/repo', title: 'initial',
      });
      const oldProvider = {
        connect: vi.fn().mockResolvedValue(undefined), disconnect: vi.fn(),
        disconnectAll: vi.fn(), isConnected: vi.fn().mockReturnValue(true),
        getStatus: vi.fn(), onStatusChange: vi.fn(() => () => undefined),
        onRemoteChange: vi.fn(() => () => undefined), pushChange: vi.fn(),
        pushMetadataChangeWithResult: vi.fn().mockResolvedValue({
          outcome: 'index_frame_written', attempted: true,
          indexFrameWritten: true, skippedReason: null,
        }),
      } as any;
      const oldStore = createSyncedSessionStore(baseStore, oldProvider);
      AISessionsRepository.setStore(oldStore);
      const writeA = AISessionsRepository.updateMetadata(
        'generation-tail-target', { title: 'A' },
      );
      await atAStatement;
      let disposalSettled = false;
      const disposing = oldStore.dispose!().then(() => { disposalSettled = true; });
      await Promise.resolve();
      expect(disposalSettled).toBe(false);

      const currentProvider = {
        ...oldProvider,
        pushChange: vi.fn(),
        pushMetadataChangeWithResult: vi.fn().mockResolvedValue({
          outcome: 'index_frame_written', attempted: true,
          indexFrameWritten: true, skippedReason: null,
        }),
      } as any;
      const currentStore = createSyncedSessionStore(baseStore, currentProvider);
      AISessionsRepository.setStore(currentStore);
      const writeB = AISessionsRepository.updateMetadata(
        'generation-tail-target', { title: 'B' },
      );
      await Promise.resolve();
      expect(statementOrder).toEqual(['enter:A']);

      releaseA();
      await expect(writeA).resolves.toBeUndefined();
      await disposing;
      await expect(writeB).resolves.toBeUndefined();
      expect(statementOrder).toEqual(['enter:A', 'commit:A', 'enter:B', 'commit:B']);
      await expect(baseStore.get('generation-tail-target')).resolves.toMatchObject({ title: 'B' });
      expect(oldProvider.pushMetadataChangeWithResult).not.toHaveBeenCalled();
      expect(currentProvider.pushMetadataChangeWithResult).toHaveBeenCalledTimes(1);
      await currentStore.dispose?.();
    } finally {
      AISessionsRepository.clearStore();
      database.useDatabase(previousDatabase, previousEngine);
      await pglite.close().catch(() => undefined);
      getPath.mockRestore();
      fs.rmSync(userDataPath, { recursive: true, force: true });
    }
  });
});
