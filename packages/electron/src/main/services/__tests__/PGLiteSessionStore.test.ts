import { describe, expect, it, vi } from 'vitest';
import { PGlite } from '@electric-sql/pglite';
import {
  BUILT_IN_PROVIDER_CATALOG,
  CLAUDEX_SOL_ENTRY_ID,
  DEEPSEEK_V4_FLASH_OPENROUTER_ENTRY_ID,
  REVIEWED_PROVIDER_CREDENTIAL_REFERENCES,
  resolveProviderCatalog,
} from '@nimbalyst/runtime/ai/server';
import { persistProviderRuntimeRouteSnapshot } from '@nimbalyst/runtime/ai/server/providers/claudeCode/providerRuntimeRoutePersistence';
import { resolveClaudeAgentRuntimeRoutes } from '@nimbalyst/runtime/ai/server/providers/claudeCode/runtimeRouteResolver';
import { createPGLiteSessionStore } from '../PGLiteSessionStore';

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

// Regression (GitHub #925 item 3 / NIM-1831): archiving a workstream PARENT
// left its child sessions (linked by parent_session_id) with is_archived=FALSE,
// so they became invisible orphans still counting toward the active total.
// updateMetadata must cascade an is_archived toggle down to direct children.
describe('PGLiteSessionStore archive cascade to workstream children', () => {
  const captureDb = () => {
    const calls: Array<{ sql: string; params: any[] }> = [];
    const db = {
      query: vi.fn(async (sql: string, params: any[] = []) => {
        calls.push({ sql, params });
        return { rows: [] };
      }),
    };
    return { db, calls };
  };

  it('cascades is_archived=true to child sessions by parent_session_id when archiving', async () => {
    const { db, calls } = captureDb();
    const store = createPGLiteSessionStore(db as any);

    await store.updateMetadata('parent-1', { isArchived: true });

    const cascade = calls.find(
      (c) => /UPDATE ai_sessions SET is_archived/i.test(c.sql) && /parent_session_id/i.test(c.sql),
    );
    expect(cascade, 'expected a cascade UPDATE keyed on parent_session_id').toBeTruthy();
    expect(cascade!.params).toContain('parent-1');
    expect(cascade!.params).toContain(true);
  });

  it('cascades is_archived=false to children when unarchiving', async () => {
    const { db, calls } = captureDb();
    const store = createPGLiteSessionStore(db as any);

    await store.updateMetadata('parent-1', { isArchived: false });

    const cascade = calls.find(
      (c) => /UPDATE ai_sessions SET is_archived/i.test(c.sql) && /parent_session_id/i.test(c.sql),
    );
    expect(cascade, 'expected a cascade UPDATE keyed on parent_session_id').toBeTruthy();
    expect(cascade!.params).toContain('parent-1');
    expect(cascade!.params).toContain(false);
  });

  it('does NOT emit a parent_session_id cascade when isArchived is not part of the update', async () => {
    const { db, calls } = captureDb();
    const store = createPGLiteSessionStore(db as any);

    await store.updateMetadata('parent-1', { title: 'Renamed' });

    const cascade = calls.find((c) => /parent_session_id/i.test(c.sql));
    expect(cascade).toBeFalsy();
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

describe('PGLiteSessionStore atomic provider route metadata', () => {
  it('allows one competing route winner, rejects the loser, and preserves unrelated metadata', async () => {
    let metadata = JSON.stringify({ unrelated: { preserved: true } });
    let initialSelects = 0;
    let releaseInitialReads!: () => void;
    const initialReadsReady = new Promise<void>((resolve) => {
      releaseInitialReads = resolve;
    });
    const db = {
      query: vi.fn(async (sql: string, params: unknown[] = []) => {
        if (/^SELECT metadata FROM ai_sessions/i.test(sql.trim())) {
          const snapshot = metadata;
          initialSelects += 1;
          if (initialSelects === 2) releaseInitialReads();
          if (initialSelects <= 2) await initialReadsReady;
          return { rows: [{ metadata: snapshot }] };
        }
        if (/UPDATE ai_sessions\s+SET metadata = \$3/i.test(sql)) {
          const expected = params[1];
          const next = params[2] as string;
          if (metadata !== expected) return { rows: [] };
          metadata = next;
          return { rows: [{ metadata }] };
        }
        throw new Error(`Unexpected atomic-route query: ${sql}`);
      }),
    };
    const store = createPGLiteSessionStore(db as any);
    const resolution = resolveProviderCatalog(
      BUILT_IN_PROVIDER_CATALOG,
      undefined,
    );
    const credentialReferences = Object.fromEntries(
      REVIEWED_PROVIDER_CREDENTIAL_REFERENCES.map((reference) => [
        reference,
        true,
      ]),
    );
    const routesFor = (catalogEntryId: string) => {
      const entry = resolution.entries.find(
        (candidate) => candidate.id === catalogEntryId,
      );
      if (!entry) throw new Error(`Missing test catalog entry ${catalogEntryId}`);
      const routes = resolveClaudeAgentRuntimeRoutes(
        resolution,
        { model: entry.model.persistedId },
        credentialReferences,
      );
      if (!routes) throw new Error(`Missing runtime route ${catalogEntryId}`);
      return routes;
    };
    const adapter = {
      installSessionMetadataValueIfAbsent: (
        sessionId: string,
        key: string,
        value: unknown,
      ) => store.installMetadataValueIfAbsent!(sessionId, key, value),
    };

    const results = await Promise.allSettled([
      persistProviderRuntimeRouteSnapshot(
        'contended-session',
        routesFor(CLAUDEX_SOL_ENTRY_ID),
        adapter,
      ),
      persistProviderRuntimeRouteSnapshot(
        'contended-session',
        routesFor(DEEPSEEK_V4_FLASH_OPENROUTER_ENTRY_ID),
        adapter,
      ),
    ]);

    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    const rejected = results.find((result) => result.status === 'rejected');
    expect(rejected).toMatchObject({
      status: 'rejected',
      reason: {
        name: 'ProviderRuntimeRouteError',
        code: 'immutable-session-route',
      },
    });
    const persisted = JSON.parse(metadata);
    expect(persisted.unrelated).toEqual({ preserved: true });
    expect(persisted.providerRuntimeRouteSnapshotV1).toBeTruthy();
  });

  it('executes the compare-and-set contract against a real JSONB row', async () => {
    const db = new PGlite();
    try {
      await db.exec(`
        CREATE TABLE ai_sessions (
          id TEXT PRIMARY KEY,
          metadata JSONB DEFAULT '{}'
        );
        INSERT INTO ai_sessions (id, metadata)
        VALUES ('real-session', '{"unrelated":{"preserved":true}}'::jsonb);
      `);
      const store = createPGLiteSessionStore(db as any);

      expect(
        await store.installMetadataValueIfAbsent!(
          'real-session',
          'providerRuntimeRouteSnapshotV1',
          { catalogEntryId: CLAUDEX_SOL_ENTRY_ID },
        ),
      ).toEqual({ catalogEntryId: CLAUDEX_SOL_ENTRY_ID });
      expect(
        await store.installMetadataValueIfAbsent!(
          'real-session',
          'providerRuntimeRouteSnapshotV1',
          { catalogEntryId: DEEPSEEK_V4_FLASH_OPENROUTER_ENTRY_ID },
        ),
      ).toEqual({ catalogEntryId: CLAUDEX_SOL_ENTRY_ID });

      const { rows } = await db.query<{ metadata: Record<string, unknown> }>(
        'SELECT metadata FROM ai_sessions WHERE id = $1',
        ['real-session'],
      );
      expect(rows[0]?.metadata).toMatchObject({
        unrelated: { preserved: true },
        providerRuntimeRouteSnapshotV1: {
          catalogEntryId: CLAUDEX_SOL_ENTRY_ID,
        },
      });
    } finally {
      await db.close();
    }
  });
});

describe('PGLiteSessionStore atomic model reconciliation', () => {
  it('keeps the durable marker when the model write fails and clears it only with a successful retry', async () => {
    const db = new PGlite();
    try {
      await db.exec(`
        CREATE TABLE ai_sessions (
          id TEXT PRIMARY KEY,
          model TEXT CHECK (model <> 'model-write-failure'),
          metadata JSONB DEFAULT '{}'
        );
        INSERT INTO ai_sessions (id, model, metadata)
        VALUES (
          'reconciliation-session',
          'B',
          '{"effortLevel":"max","modelChangeReconciliation":{"status":"pending","previousModel":"A"}}'::jsonb
        );
      `);
      const store = createPGLiteSessionStore(db as any);

      await expect(
        store.updateMetadata('reconciliation-session', {
          model: 'model-write-failure',
          metadata: {
            effortLevel: 'low',
            modelChangeReconciliation: null,
          },
        }),
      ).rejects.toThrow();

      const failed = await db.query<{
        model: string;
        metadata: Record<string, unknown>;
      }>(
        'SELECT model, metadata FROM ai_sessions WHERE id = $1',
        ['reconciliation-session'],
      );
      expect(failed.rows[0]).toMatchObject({
        model: 'B',
        metadata: {
          effortLevel: 'max',
          modelChangeReconciliation: {
            status: 'pending',
            previousModel: 'A',
          },
        },
      });

      await store.updateMetadata('reconciliation-session', {
        model: 'A',
        metadata: {
          effortLevel: 'low',
          modelChangeReconciliation: null,
        },
      });

      const recovered = await db.query<{
        model: string;
        metadata: Record<string, unknown>;
      }>(
        'SELECT model, metadata FROM ai_sessions WHERE id = $1',
        ['reconciliation-session'],
      );
      expect(recovered.rows[0]).toMatchObject({
        model: 'A',
        metadata: {
          effortLevel: 'low',
          modelChangeReconciliation: null,
        },
      });
    } finally {
      await db.close();
    }
  });
});
