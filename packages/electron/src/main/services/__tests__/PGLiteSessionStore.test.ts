import { describe, expect, it, vi } from 'vitest';
import { PGlite } from '@electric-sql/pglite';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { SQLiteDatabase } from '../../database/sqlite/SQLiteDatabase';
import {
  createSQLiteStoreAdapter,
  type StoreDbAdapter,
} from '../../database/sqlite/SQLiteStoreAdapter';
import {
  compareUpdateSessionMetadataWithHostControlAuthority,
  createPGLiteSessionStore,
} from '../PGLiteSessionStore';

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
