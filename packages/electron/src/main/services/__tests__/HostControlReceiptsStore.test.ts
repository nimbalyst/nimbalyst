import { PGlite } from '@electric-sql/pglite';
import { createHash } from 'crypto';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  assertMainProcessImportProofHarnessDrained,
  mainProcessImportProofModules,
  resetMainProcessImportProofHarness,
} from '../../__tests__/mainProcessImportProofHarness';

vi.mock('electron', () => mainProcessImportProofModules.electron);
vi.mock('../../window/WindowManager', () => mainProcessImportProofModules.windowManager);
vi.mock('../../utils/logger', () => mainProcessImportProofModules.logger);
vi.mock('electron-log/main', () => mainProcessImportProofModules.electronLog);
vi.mock('../../analytics/AnalyticsService', () => mainProcessImportProofModules.analytics);
vi.mock('electron-store', () => mainProcessImportProofModules.electronStore);
vi.mock('../../database/PGLiteDatabaseWorker', () => ({ database: { query: vi.fn() } }));
import { AISessionsRepository } from '@nimbalyst/runtime';
import { SQLiteDatabase } from '../../database/sqlite/SQLiteDatabase';
import { createSQLiteStoreAdapter } from '../../database/sqlite/SQLiteStoreAdapter';
import {
  createHostControlReceiptsStore as createProductionHostControlReceiptsStore,
  type HostControlReceiptsStore,
} from '../HostControlReceiptsStore';
import { createHostControlMutationCoordinator } from '../HostControlMutationCoordinator';
import { handleInjectAttentionReply } from '../AttentionReplyInjectionService';
import { createPGLiteSessionStore } from '../PGLiteSessionStore';
import { AIService } from '../ai/AIService';

beforeEach(() => {
  resetMainProcessImportProofHarness();
});

afterEach(() => {
  assertMainProcessImportProofHarnessDrained();
  resetMainProcessImportProofHarness();
});

const unitAuthorityRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'host-store-unit-authority-'));
afterAll(() => fs.rmSync(unitAuthorityRoot, { recursive: true, force: true }));
const createHostControlReceiptsStore = (
  ...args: Parameters<typeof createProductionHostControlReceiptsStore>
) => createProductionHostControlReceiptsStore(args[0], args[1], {
  storeIdentity: { storeId: 'host-store-unit', authorityRoot: unitAuthorityRoot },
  ...args[2],
});

describe('HostControlReceiptsStore dual-backend contract', () => {
  let pglite: PGlite;
  let sqlite: SQLiteDatabase;
  let tempDir: string;
  let pgliteStore: HostControlReceiptsStore;
  let sqliteStore: HostControlReceiptsStore;

  beforeAll(async () => {
    pglite = new PGlite();
    await (pglite as unknown as { waitReady: Promise<void> }).waitReady;
    await pglite.exec(`
      CREATE TABLE host_control_receipts (
        id TEXT PRIMARY KEY,
        reservation_key TEXT NOT NULL UNIQUE,
        request_digest TEXT NOT NULL,
        operation TEXT NOT NULL CHECK (operation = 'inject_attention_reply'),
        session_id TEXT NOT NULL,
        event_identity TEXT NOT NULL,
        attention_generation TEXT,
        state TEXT NOT NULL CHECK (state IN ('reserved', 'injected', 'already_resolved', 'failed')),
        reservation_owner TEXT,
        lease_expires_at TIMESTAMPTZ,
        mutation_id TEXT,
        mutation_fence INTEGER NOT NULL DEFAULT 0,
        mutation_state TEXT NOT NULL DEFAULT 'not_started',
        mutation_started_at TIMESTAMPTZ,
        mutation_applied_at TIMESTAMPTZ,
        mutation_receipt JSONB,
        cleanup_prompt_state TEXT NOT NULL DEFAULT 'pending',
        cleanup_prompt_fence INTEGER NOT NULL DEFAULT 0,
        cleanup_attention_state TEXT NOT NULL DEFAULT 'pending',
        cleanup_attention_fence INTEGER NOT NULL DEFAULT 0,
        cleanup_attention_result TEXT,
        cleanup_terminal_state TEXT NOT NULL DEFAULT 'pending',
        cleanup_terminal_fence INTEGER NOT NULL DEFAULT 0,
        receipt JSONB,
        created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
      );
      CREATE TABLE host_control_store_identity (
        singleton INTEGER PRIMARY KEY,
        store_id TEXT NOT NULL UNIQUE,
        authority_root TEXT NOT NULL
      );
      CREATE TABLE native_winner_outbox (
        id TEXT PRIMARY KEY,
        reservation_key TEXT NOT NULL UNIQUE,
        session_id TEXT NOT NULL,
        event_identity TEXT NOT NULL,
        attention_generation TEXT,
        state TEXT NOT NULL DEFAULT 'pending',
        attempt_count INTEGER NOT NULL DEFAULT 0,
        receipt JSONB,
        created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
        last_attempt_at TIMESTAMPTZ,
        sent_at TIMESTAMPTZ
      );
      CREATE TABLE ai_sessions (
        id TEXT PRIMARY KEY,
        provider TEXT NOT NULL,
        metadata JSONB NOT NULL
      );
    `);
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'host-control-receipts-'));
    await pglite.query(
      `INSERT INTO host_control_store_identity (singleton, store_id, authority_root)
       VALUES (1, $1, $2)`,
      ['pglite-host-receipts-test', path.join(tempDir, 'pglite-authority')],
    );
    sqlite = new SQLiteDatabase({
      dbDir: tempDir,
      schemaDir: path.resolve(__dirname, '../../database/sqlite/schemas'),
      slowQueryThresholdMs: 1000,
      sampleRate: 0,
    });
    await sqlite.initialize();
    pgliteStore = createProductionHostControlReceiptsStore(pglite);
    sqliteStore = createProductionHostControlReceiptsStore(createSQLiteStoreAdapter(sqlite));
  });

  beforeEach(async () => {
    await pglite.exec('DELETE FROM host_control_receipts; DELETE FROM native_winner_outbox; DELETE FROM ai_sessions;');
    const handle = sqlite.getRawHandle()!;
    handle.exec('DELETE FROM host_control_receipts; DELETE FROM native_winner_outbox; DELETE FROM ai_sessions;');
  });

  afterAll(async () => {
    await sqlite.close();
    await pglite.close();
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  function reserve(
    store: HostControlReceiptsStore,
    digest = 'digest-1',
    owner = 'owner-a',
    nowMs = Date.now() + 60_000,
    leaseMs = 1_000,
  ) {
    return store.reserveReceipt({
      reservationKey: 'attention-reply:watch-1',
      requestDigest: digest,
      operation: 'inject_attention_reply',
      sessionId: 'session-1',
      eventIdentity: 'prompt-1',
      attentionGeneration: 'generation-1',
      reservationOwner: owner,
      now: new Date(nowMs),
      leaseExpiresAt: new Date(nowMs + leaseMs),
    });
  }

  function jeanRequestDigest(): string {
    const answerDigest = createHash('sha256')
      .update(JSON.stringify('bounded answer'))
      .digest('hex');
    return createHash('sha256').update(JSON.stringify({
      attentionGeneration: 'generation-1',
      eventIdentity: 'prompt-1',
      normalizedAnswer: { digest: answerDigest, kind: 'free_text' },
      operation: 'inject_attention_reply',
      promptType: 'ask_user_question_request',
      sessionId: 'session-1',
    })).digest('hex');
  }

  async function expireReservation(name: string, key = 'attention-reply:watch-1'): Promise<void> {
    if (name === 'PGLite') {
      await pglite.query(
        'UPDATE host_control_receipts SET lease_expires_at = NOW() WHERE reservation_key = $1',
        [key],
      );
    } else {
      await createSQLiteStoreAdapter(sqlite).query(
        'UPDATE host_control_receipts SET lease_expires_at = NOW() WHERE reservation_key = $1',
        [key],
      );
    }
  }

  function createPgliteStatementAdapter(native: PGlite) {
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
            throw new Error(`transaction expected row count mismatch at statement ${index}: expected ${statement.expectedRowCount}, got ${result.rows.length}`);
          }
          results.push(result);
        }
        return results;
      }),
    };
  }

  function createDeterministicRecoveryStore(db: any, backend: string) {
    const processIdentity = `nim364-recovery:${backend}`;
    return createProductionHostControlReceiptsStore(db, undefined, {
      storeIdentity: {
        storeId: `host-replay-${backend}`,
        authorityRoot: path.join(tempDir, `host-replay-authority-${backend}`),
      },
      mutationCoordinator: createHostControlMutationCoordinator({
        acquireTimeoutMs: 30_000,
        pid: 4343,
        processIdentity,
        isProcessAlive: (pid) => pid === 4343,
        getProcessIdentity: async (pid) => (pid === 4343 ? processIdentity : null),
      }),
    });
  }

  function boundedBarrier(name: string, timeoutMs = 2_000) {
    let reached = false;
    let reach!: () => void;
    let release!: () => void;
    let settled = false;
    const reachedPromise = new Promise<void>((resolve) => { reach = resolve; });
    const promise = new Promise<void>((resolve) => {
      release = resolve;
    });
    const releaseOnce = () => {
      if (settled) return;
      settled = true;
      if (!reached) { reached = true; reach(); }
      release();
    };
    return {
      promise,
      async waitUntilReached(timeout = timeoutMs) {
        let timer: ReturnType<typeof setTimeout> | undefined;
        try {
          await Promise.race([
            reachedPromise,
            new Promise<void>((_resolve, reject) => { timer = setTimeout(() => reject(new Error(`barrier_timeout:${name}`)), timeout); }),
          ]);
        } finally {
          if (timer) clearTimeout(timer);
        }
      },
      release: releaseOnce,
      dispose: releaseOnce,
    };
  }

  it.each([
    ['PGLite', () => pgliteStore],
    ['SQLite', () => sqliteStore],
  ])('%s reserves once and same-digest replay is a no-op read', async (_name, getStore) => {
    const store = getStore();
    const first = await reserve(store);
    const replay = await reserve(store);

    expect(first.isNewReservation).toBe(true);
    expect(replay.isNewReservation).toBe(false);
    expect(replay.row.id).toBe(first.row.id);
    expect(replay.row.state).toBe('reserved');
    expect(replay.status).toBe('same_owner');
  });

  it.each([
    ['PGLite', () => pgliteStore],
    ['SQLite', () => sqliteStore],
  ])('%s rejects a different digest under the unique reservation key', async (_name, getStore) => {
    const store = getStore();
    await reserve(store);
    await expect(reserve(store, 'digest-2')).rejects.toThrow('idempotency_conflict');
  });

  it.each([
    ['PGLite', () => pgliteStore],
    ['SQLite', () => sqliteStore],
  ])('%s rejects a receipt over the true 4096-byte cap before mutation', async (_name, getStore) => {
    const store = getStore();
    const reserved = await reserve(store);

    await expect(store.finalizeReceipt({
      id: reserved.row.id,
      reservationKey: 'attention-reply:watch-1',
      reservationOwner: 'owner-a',
      mutationId: reserved.row.mutationId!,
      mutationFence: reserved.row.mutationFence!,
      state: 'failed',
      receipt: { error: 'é'.repeat(4096) },
      now: new Date('2026-07-20T10:00:00.500Z'),
    })).rejects.toThrow('exceeds 4096 bytes');
    await expect(store.getByReservationKey('attention-reply:watch-1'))
      .resolves.toMatchObject({ state: 'reserved', receipt: undefined });
  });

  it.each([
    ['PGLite', () => pgliteStore],
    ['SQLite', () => sqliteStore],
  ])('%s grants exactly one owner takeover after lease expiry', async (_name, getStore) => {
    const store = getStore();
    await reserve(store, 'digest-1', 'dead-owner');
    await expireReservation(_name);
    const takeoverAt = Date.now() + 120_000;

    const results = await Promise.all([
      reserve(store, 'digest-1', 'takeover-a', takeoverAt),
      reserve(store, 'digest-1', 'takeover-b', takeoverAt),
    ]);

    expect(results.filter((result) => result.status === 'taken_over')).toHaveLength(1);
    expect(results.filter((result) => result.status === 'busy')).toHaveLength(1);
    expect(new Set(results.map((result) => result.row.reservationOwner)).size).toBe(1);
  });

  it.each([
    ['PGLite', () => pgliteStore],
    ['SQLite', () => sqliteStore],
  ])('%s preserves the no-retry mutation fence across owner takeover', async (_name, getStore) => {
    const store = getStore();
    const first = await reserve(store, jeanRequestDigest(), 'dead-owner');
    expect((await first.mutationAuthority!.begin(
      new Date(),
      'generation-1',
    )).started).toBe(true);
    await expireReservation(_name);

    const takeover = await reserve(
      store,
      jeanRequestDigest(),
      'takeover-owner',
      Date.now() + 120_000,
    );
    expect(takeover).toMatchObject({
      status: 'taken_over',
      row: { mutationState: 'unknown', reservationOwner: 'takeover-owner' },
    });
    expect((await takeover.mutationAuthority!.begin(
      new Date('2026-07-20T10:00:01.100Z'),
      'generation-1',
    )).started).toBe(false);
    await expect(first.mutationAuthority!.recordApplied(
      'applied',
      { outcome: 'late-old-owner' },
      new Date('2026-07-20T10:00:01.100Z'),
    )).rejects.toThrow('host_control_mutation_ownership_lost');
    await expect(store.finalizeReceipt({
      id: first.row.id,
      reservationKey: 'attention-reply:watch-1',
      reservationOwner: 'dead-owner',
      mutationId: first.row.mutationId!,
      mutationFence: first.row.mutationFence!,
      state: 'failed',
      receipt: { outcome: 'failed', errorClass: 'late-owner' },
      now: new Date('2026-07-20T10:00:01.100Z'),
    })).rejects.toThrow('host_control_receipt_finalization_ownership_lost');
  });

  it.each([
    ['PGLite', () => pgliteStore],
    ['SQLite', () => sqliteStore],
  ])('%s rejects a same-state mutation fact with different persisted bytes', async (_name, getStore) => {
    const reserved = await reserve(getStore());
    await reserved.mutationAuthority!.begin(
      new Date('2026-07-20T10:00:00.250Z'),
      'generation-1',
    );
    const results = await Promise.allSettled([
      reserved.mutationAuthority!.recordApplied(
        'applied',
        { nativeCertainty: 'applied', winner: 'left' },
        new Date('2026-07-20T10:00:00.500Z'),
      ),
      reserved.mutationAuthority!.recordApplied(
        'applied',
        { nativeCertainty: 'applied', winner: 'right' },
        new Date('2026-07-20T10:00:00.500Z'),
      ),
    ]);
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter((result) => result.status === 'rejected')).toHaveLength(1);
    const persisted = await getStore().getByReservationKey('attention-reply:watch-1');
    expect(persisted?.mutationReceipt).toEqual(expect.objectContaining({
      nativeCertainty: 'applied',
    }));
  });

  it.each([
    ['PGLite', () => pgliteStore],
    ['SQLite', () => sqliteStore],
  ])('%s resumes after prompt cleanup completed and transfers remaining phases at exact lease equality', async (_name, getStore) => {
    const store = getStore();
    const base = Date.now() + 60_000;
    const first = await reserve(store, jeanRequestDigest(), 'owner-a', base);
    await first.mutationAuthority!.begin(new Date(base), 'generation-1');
    await first.mutationAuthority!.recordApplied(
      'applied',
      { nativeCertainty: 'applied', nativeEntered: true, cleanupVerified: false },
      new Date(base + 500),
    );
    expect(await first.mutationAuthority!.claimCleanupStep('prompt', 'generation-1'))
      .toEqual({ status: 'claimed' });

    await expireReservation(_name);
    expect(await first.mutationAuthority!.verifyCleanup('generation-1')).toBe(false);
    await expect(store.finalizeReceipt({
      id: first.row.id,
      reservationKey: 'attention-reply:watch-1',
      reservationOwner: 'owner-a',
      mutationId: first.row.mutationId!,
      mutationFence: first.row.mutationFence!,
      state: 'injected',
      receipt: { outcome: 'injected' },
      now: new Date(base + 1_000),
    })).rejects.toThrow('host_control_receipt_finalization_ownership_lost');

    const takeover = await reserve(store, jeanRequestDigest(), 'owner-b', base + 1_000);
    expect(takeover).toMatchObject({
      status: 'taken_over',
      row: { mutationState: 'applied', mutationFence: 2, reservationOwner: 'owner-b' },
    });
    expect(await takeover.mutationAuthority!.verifyCleanup('generation-1')).toBe(true);
    expect(await takeover.mutationAuthority!.claimCleanupStep('terminal', 'generation-1')).toBe(false);
    expect(await takeover.mutationAuthority!.claimCleanupStep('prompt', 'generation-1'))
      .toEqual({ status: 'claimed' });
    expect(await takeover.mutationAuthority!.claimCleanupStep('terminal', 'generation-1')).toBe(false);
    expect(await takeover.mutationAuthority!.claimCleanupStep('attention', 'generation-1'))
      .toEqual({ status: 'claimed' });
    expect(await store.getByReservationKey('attention-reply:watch-1')).toMatchObject({
      cleanupAttentionState: 'claimed',
      cleanupAttentionResult: undefined,
    });
    expect(await takeover.mutationAuthority!.claimCleanupStep('terminal', 'generation-1')).toBe(false);
    await expect(store.finalizeReceipt({
      id: takeover.row.id,
      reservationKey: 'attention-reply:watch-1',
      reservationOwner: 'owner-b',
      mutationId: takeover.row.mutationId!,
      mutationFence: takeover.row.mutationFence!,
      state: 'injected',
      receipt: { outcome: 'injected', verified: true },
      now: new Date(base + 1_001),
    })).rejects.toThrow('host_control_receipt_finalization_ownership_lost');
  });

  it.each([
    ['PGLite', () => pgliteStore],
    ['SQLite', () => sqliteStore],
  ])('%s reconstructs an unknown process-loss gap without a second Jean mutation', async (_name, getStore) => {
    const store = getStore();
    const first = await reserve(store, jeanRequestDigest(), 'dead-owner');
    await first.mutationAuthority!.begin(
      new Date('2026-07-20T10:00:00.250Z'),
      'generation-1',
    );
    await expireReservation(_name);
    let now = Date.now() + 120_000;
    const respond = vi.fn();
    const deps = {
      getPendingInteractiveEvent: vi.fn(),
      respondToInteractivePrompt: respond,
      reserveReceipt: (input: any) => store.reserveReceipt(input),
      finalizeReceipt: (input: any) => store.finalizeReceipt(input),
      now: () => now,
      createReservationOwner: () => 'takeover-owner',
      reservationLeaseMs: 1_000,
    };
    const request = {
      watchId: 'watch-1', sessionId: 'session-1', promptId: 'prompt-1',
      attentionGeneration: 'generation-1',
      promptType: 'ask_user_question_request' as const,
      answer: 'bounded answer',
    };

    const reconciled = await handleInjectAttentionReply(deps, request);
    now += 1;
    const replay = await handleInjectAttentionReply(deps, request);

    expect(reconciled).toEqual(replay);
    expect(reconciled).toMatchObject({
      status: 500,
      receipt: { outcome: 'failed', errorClass: 'mutation_outcome_unconfirmed' },
    });
    expect(respond).not.toHaveBeenCalled();
    expect(await store.getByReservationKey('attention-reply:watch-1')).toMatchObject({
      state: 'failed', mutationState: 'unknown', mutationFence: 2,
    });
  });

  it.each([
    ['PGLite', () => pglite as any],
    ['SQLite', () => createSQLiteStoreAdapter(sqlite) as any],
  ])('%s excludes O1 while O2 is paused after host takeover CAS commit and before publication', async (_name, getDb) => {
    const db = getDb();
    const operationLockDirectory = path.join(tempDir, `host-entry-lock-${_name}`);
    const storeIdentity = {
      storeId: `host-entry-store-${_name}`,
      authorityRoot: operationLockDirectory,
    };
    vi.resetModules();
    const ownerOneCoordinatorModule = await import('../HostControlMutationCoordinator');
    vi.resetModules();
    const ownerTwoCoordinatorModule = await import('../HostControlMutationCoordinator');
    expect(ownerOneCoordinatorModule).not.toBe(ownerTwoCoordinatorModule);
    const store = createHostControlReceiptsStore(db, undefined, {
      mutationCoordinator: ownerOneCoordinatorModule.createHostControlMutationCoordinator({
        acquireTimeoutMs: 2_000,
      }),
      storeIdentity,
    });
    const base = Date.now() + 60_000;
    const first = await reserve(store, jeanRequestDigest(), 'owner-a', base);
    expect((await first.mutationAuthority!.begin(
      new Date(base),
      'generation-1',
    )).started).toBe(true);
    await expireReservation(_name);

    const atTakeoverCommit = boundedBarrier('host_takeover_committed');
    const resumeTakeover = boundedBarrier('host_takeover_resume');
    const takeoverStore = createHostControlReceiptsStore(db, undefined, {
      mutationCoordinator: ownerTwoCoordinatorModule.createHostControlMutationCoordinator({
        acquireTimeoutMs: 2_000,
      }),
      storeIdentity,
      afterReceiptReservationCommitted: async ({ takenOver }) => {
        if (!takenOver) return;
        atTakeoverCommit.release();
        await resumeTakeover.promise;
      },
    });
    const takeoverPromise = reserve(
      takeoverStore,
      jeanRequestDigest(),
      'owner-b',
      base + 1_000,
    );
    const nativeMutation = vi.fn();
    let oldOwner: Promise<unknown> | undefined;
    try {
      await atTakeoverCommit.waitUntilReached();
      oldOwner = first.mutationAuthority!.enterNative('generation-1', async () => {
        nativeMutation();
        return true;
      });
      await Promise.resolve();
      expect(nativeMutation).not.toHaveBeenCalled();

      resumeTakeover.release();
      const takeover = await takeoverPromise;
      expect(takeover).toMatchObject({ status: 'taken_over', row: { mutationFence: 2 } });
      await expect(oldOwner).resolves.toEqual({ owned: false });
      expect(nativeMutation).not.toHaveBeenCalled();
    } finally {
      resumeTakeover.release();
      atTakeoverCommit.dispose();
      resumeTakeover.dispose();
      await takeoverPromise.catch(() => undefined);
      if (oldOwner) await oldOwner.catch(() => undefined);
    }
  });

  it.each([
    ['PGLite', () => pgliteStore],
    ['SQLite', () => sqliteStore],
  ])('%s replays an applied fact through exact-A cleanup only', async (_name, getStore) => {
    void getStore;
    const transactionalDb = _name === 'PGLite'
      ? createPgliteStatementAdapter(pglite)
      : createSQLiteStoreAdapter(sqlite);
    const store = createDeterministicRecoveryStore(transactionalDb, _name);
    createPGLiteSessionStore(transactionalDb);
    const sessionMetadata = {
      hasPendingPrompt: true,
      pendingPromptId: 'prompt-1',
      pendingPromptGeneration: 'generation-1',
      attentionEvents: [{
        id: 'event-occurrence-a', sessionId: 'session-1', promptId: 'prompt-1',
        attentionGeneration: 'generation-1', kind: 'interactive_prompt', promptType: 'AskUserQuestion',
        context: { questions: [{ question: 'Bounded question?' }] }, severity: 'normal', deadline: null,
        dedupeKey: 'interactive:AskUserQuestion:prompt-1', status: 'pending', armedAt: new Date().toISOString(),
        doNotDisturb: false, immediateReceipt: { requested: true, attempted: false, skippedReason: 'pending', recordedAt: new Date().toISOString() },
        dedupeCount: 0,
      }],
    };
    await transactionalDb.query(
      `INSERT INTO ai_sessions (id, provider, metadata) VALUES ($1, $2, $3)`,
      ['session-1', 'claude-code', JSON.stringify(sessionMetadata)],
    );
    const repositoryGet = vi.spyOn(AISessionsRepository, 'get').mockImplementation(async (id) => {
      const current = await transactionalDb.query<any>('SELECT metadata FROM ai_sessions WHERE id = $1', [id]);
      if (current.rows.length !== 1) return null as any;
      const metadata = current.rows[0].metadata;
      return { id, metadata: typeof metadata === 'string' ? JSON.parse(metadata) : metadata } as any;
    });
    const first = await reserve(
      store,
      jeanRequestDigest(),
      'dead-owner',
      Date.now() + 60_000,
      30_000,
    );
    await first.mutationAuthority!.begin(
      new Date('2026-07-20T10:00:00.250Z'),
      'generation-1',
    );
    await first.mutationAuthority!.recordApplied(
      'applied',
      { nativeCertainty: 'applied', nativeEntered: true, cleanupVerified: false },
      new Date('2026-07-20T10:00:00.500Z'),
    );
    await expireReservation(_name);
    const respond = vi.fn((params: any) => {
      expect(params).toMatchObject({ reconcileAppliedOnly: true, durableMutationAuthority: expect.any(Object) });
      return AIService.prototype.respondToInteractivePrompt.call({} as AIService, params);
    });
    const deps = {
      getPendingInteractiveEvent: vi.fn(async () => ({
        id: 'event-1', sessionId: 'session-1', promptId: 'prompt-1',
        attentionGeneration: 'generation-1', kind: 'interactive_prompt' as const,
        promptType: 'AskUserQuestion',
        context: { questions: [{ question: 'Bounded question?' }] },
        status: 'pending' as const,
      })),
      respondToInteractivePrompt: respond,
      reserveReceipt: (input: any) => store.reserveReceipt(input),
      finalizeReceipt: (input: any) => store.finalizeReceipt(input),
      now: () => Date.now() + 120_000,
      createReservationOwner: () => 'recovery-owner',
      reservationLeaseMs: 30_000,
    };
    const request = {
      watchId: 'watch-1', sessionId: 'session-1', promptId: 'prompt-1',
      attentionGeneration: 'generation-1',
      promptType: 'ask_user_question_request' as const,
      answer: 'bounded answer',
    };

    try {
      const reconciled = await handleInjectAttentionReply(deps, request);
      const replay = await handleInjectAttentionReply(deps, request);

      expect(reconciled).toEqual(replay);
      const persisted = await store.getByReservationKey('attention-reply:watch-1');
      expect({
        errorClass: (reconciled.receipt as Record<string, unknown>).errorClass,
        prompt: persisted?.cleanupPromptState,
        attention: persisted?.cleanupAttentionState,
        attentionResult: persisted?.cleanupAttentionResult,
        terminal: persisted?.cleanupTerminalState,
      }).toEqual({
        errorClass: undefined,
        prompt: 'complete',
        attention: 'complete',
        attentionResult: 'settled',
        terminal: 'complete',
      });
      expect(reconciled).toMatchObject({ status: 200, receipt: { outcome: 'injected' } });
      expect(respond).toHaveBeenCalledOnce();
    } finally {
      repositoryGet.mockRestore();
    }
  });

  it.each([
    ['PGLite', () => pgliteStore],
    ['SQLite', () => sqliteStore],
  ])('%s returns the exact persisted winner from different-payload finalizers', async (_name, getStore) => {
    const store = getStore();
    const reserved = await reserve(store);
    await reserved.mutationAuthority!.claimCleanupStep('terminal', 'generation-1');
    const base = {
      id: reserved.row.id,
      reservationKey: 'attention-reply:watch-1',
      reservationOwner: 'owner-a',
      mutationId: reserved.row.mutationId!,
      mutationFence: reserved.row.mutationFence!,
      state: 'failed' as const,
      now: new Date('2026-07-20T10:00:00.500Z'),
    };
    const [left, right] = await Promise.all([
      store.finalizeReceipt({ ...base, receipt: { outcome: 'failed', errorClass: 'left' } }),
      store.finalizeReceipt({ ...base, receipt: { outcome: 'failed', errorClass: 'right' } }),
    ]);

    expect(left.receipt).toEqual(right.receipt);
    expect(['left', 'right']).toContain(left.receipt?.errorClass);
    expect((await store.getByReservationKey('attention-reply:watch-1'))?.receipt)
      .toEqual(left.receipt);
  });

  it('decodes PGLite JSONB and SQLite TEXT receipts identically', async () => {
    const receipt = {
      outcome: 'injected',
      verified: true,
      receipt: { route: 'host-attention-answer', event_cleared: true },
    };
    const pgliteReserved = await reserve(pgliteStore);
    const sqliteReserved = await reserve(sqliteStore);
    await Promise.all([
      pgliteReserved.mutationAuthority!.claimCleanupStep('terminal', 'generation-1'),
      sqliteReserved.mutationAuthority!.claimCleanupStep('terminal', 'generation-1'),
    ]);
    const [pgliteFinal, sqliteFinal] = await Promise.all([
      pgliteStore.finalizeReceipt({
        id: pgliteReserved.row.id,
        reservationKey: 'attention-reply:watch-1',
        reservationOwner: 'owner-a',
        mutationId: pgliteReserved.row.mutationId!,
        mutationFence: pgliteReserved.row.mutationFence!,
        state: 'injected',
        receipt,
        now: new Date('2026-07-20T10:00:00.500Z'),
      }),
      sqliteStore.finalizeReceipt({
        id: sqliteReserved.row.id,
        reservationKey: 'attention-reply:watch-1',
        reservationOwner: 'owner-a',
        mutationId: sqliteReserved.row.mutationId!,
        mutationFence: sqliteReserved.row.mutationFence!,
        state: 'injected',
        receipt,
        now: new Date('2026-07-20T10:00:00.500Z'),
      }),
    ]);

    expect({
      reservationKey: pgliteFinal.reservationKey,
      requestDigest: pgliteFinal.requestDigest,
      operation: pgliteFinal.operation,
      sessionId: pgliteFinal.sessionId,
      eventIdentity: pgliteFinal.eventIdentity,
      attentionGeneration: pgliteFinal.attentionGeneration,
      state: pgliteFinal.state,
      receipt: pgliteFinal.receipt,
    }).toEqual({
      reservationKey: sqliteFinal.reservationKey,
      requestDigest: sqliteFinal.requestDigest,
      operation: sqliteFinal.operation,
      sessionId: sqliteFinal.sessionId,
      eventIdentity: sqliteFinal.eventIdentity,
      attentionGeneration: sqliteFinal.attentionGeneration,
      state: sqliteFinal.state,
      receipt: sqliteFinal.receipt,
    });
  });

  it('executes the production PGLite upgrade block over populated 0027 rows', async () => {
    const legacy = new PGlite();
    await (legacy as unknown as { waitReady: Promise<void> }).waitReady;
    try {
      await legacy.exec(`
        CREATE TABLE host_control_receipts (
          id TEXT PRIMARY KEY, reservation_key TEXT NOT NULL UNIQUE,
          request_digest TEXT NOT NULL, operation TEXT NOT NULL,
          session_id TEXT NOT NULL, event_identity TEXT NOT NULL,
          attention_generation TEXT, state TEXT NOT NULL, receipt JSONB,
          created_at TIMESTAMPTZ NOT NULL, updated_at TIMESTAMPTZ NOT NULL
        );
        INSERT INTO host_control_receipts VALUES (
          'legacy-reserved', 'attention-reply:legacy', 'digest',
          'inject_attention_reply', 'session', 'prompt', NULL, 'reserved', NULL,
          TIMESTAMPTZ '2026-07-20 00:00:00+00', TIMESTAMPTZ '2026-07-20 00:00:00+00'
        );
      `);
      const workerSource = fs.readFileSync(
        path.resolve(__dirname, '../../database/worker.js'),
        'utf8',
      );
      const productionUpgrade = workerSource.match(
        /ALTER TABLE host_control_receipts ADD COLUMN IF NOT EXISTS reservation_owner[\s\S]*?UPDATE host_control_receipts[\s\S]*?AND mutation_id IS NULL;/,
      )?.[0];
      expect(productionUpgrade).toBeTruthy();
      await legacy.exec(productionUpgrade!);
      const result = await legacy.query<any>(
        `SELECT reservation_owner, lease_expires_at, mutation_id,
                mutation_fence, mutation_state
         FROM host_control_receipts WHERE id = 'legacy-reserved'`,
      );
      expect(result.rows[0]).toMatchObject({
        reservation_owner: 'legacy-orphan',
        mutation_id: 'legacy-host-mutation:legacy-reserved',
        mutation_fence: 0,
        mutation_state: 'legacy_unknown',
      });
      expect(new Date(result.rows[0].lease_expires_at).getTime()).toBe(0);

      await legacy.exec(`
        INSERT INTO host_control_receipts(
          id, reservation_key, request_digest, operation, session_id,
          event_identity, attention_generation, state, receipt, created_at, updated_at,
          reservation_owner, lease_expires_at, mutation_id, mutation_fence, mutation_state,
          cleanup_prompt_state, cleanup_prompt_fence,
          cleanup_attention_state, cleanup_attention_fence,
          cleanup_attention_result,
          cleanup_terminal_state, cleanup_terminal_fence)
        VALUES
          ('modern-host-not-started', 'attention-reply:modern-1', 'digest-1',
           'inject_attention_reply', 'session', 'prompt', 'generation-modern',
           'reserved', NULL, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP,
           'owner-modern', TIMESTAMPTZ '2026-07-20 10:00:00+00',
           'host-mutation:modern-1', 7, 'not_started', 'claimed', 7, 'pending', 0, NULL,
           'claimed', 7),
          ('modern-host-unknown', 'attention-reply:modern-2', 'digest-2',
           'inject_attention_reply', 'session', 'prompt', 'generation-modern',
           'reserved', NULL, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP,
           'owner-modern', TIMESTAMPTZ '2026-07-20 10:00:00+00',
           'host-mutation:modern-2', 8, 'unknown', 'pending', 0, 'claimed', 8, NULL,
           'pending', 0),
          ('modern-host-applied', 'attention-reply:modern-3', 'digest-3',
           'inject_attention_reply', 'session', 'prompt', 'generation-modern',
           'reserved', NULL, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP,
           'owner-modern', TIMESTAMPTZ '2026-07-20 10:00:00+00',
           'host-mutation:modern-3', 9, 'applied', 'complete', 9, 'complete', 9,
           'settled', 'complete', 9),
          ('modern-host-resultless', 'attention-reply:modern-4', 'digest-4',
           'inject_attention_reply', 'session', 'prompt', 'generation-modern',
           'reserved', NULL, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP,
           'owner-modern', TIMESTAMPTZ '2026-07-20 10:00:00+00',
           'host-mutation:modern-4', 10, 'applied', 'complete', 10, 'complete', 10,
           NULL, 'pending', 0);
      `);
      await legacy.exec(productionUpgrade!);
      const modern = await legacy.query<any>(`
        SELECT id, reservation_owner, mutation_id, mutation_fence, mutation_state,
               cleanup_prompt_state, cleanup_prompt_fence,
               cleanup_attention_state, cleanup_attention_fence,
               cleanup_attention_result,
               cleanup_terminal_state, cleanup_terminal_fence
        FROM host_control_receipts WHERE id LIKE 'modern-host-%' ORDER BY id
      `);
      expect(modern.rows).toEqual([
        expect.objectContaining({ id: 'modern-host-applied', reservation_owner: 'owner-modern', mutation_id: 'host-mutation:modern-3', mutation_fence: 9, mutation_state: 'applied', cleanup_prompt_state: 'complete', cleanup_attention_state: 'complete', cleanup_attention_result: 'settled', cleanup_terminal_state: 'complete', cleanup_terminal_fence: 9 }),
        expect.objectContaining({ id: 'modern-host-not-started', reservation_owner: 'owner-modern', mutation_id: 'host-mutation:modern-1', mutation_fence: 7, mutation_state: 'not_started', cleanup_prompt_state: 'claimed', cleanup_prompt_fence: 7, cleanup_terminal_state: 'claimed', cleanup_terminal_fence: 7 }),
        expect.objectContaining({ id: 'modern-host-resultless', reservation_owner: 'owner-modern', mutation_id: 'host-mutation:modern-4', mutation_fence: 10, mutation_state: 'applied', cleanup_attention_state: 'pending', cleanup_attention_fence: 0, cleanup_attention_result: null }),
        expect.objectContaining({ id: 'modern-host-unknown', reservation_owner: 'owner-modern', mutation_id: 'host-mutation:modern-2', mutation_fence: 8, mutation_state: 'unknown', cleanup_attention_state: 'claimed', cleanup_attention_fence: 8, cleanup_terminal_state: 'pending', cleanup_terminal_fence: 0 }),
      ]);
      await legacy.exec(productionUpgrade!);
      await expect(legacy.query<any>(`
        SELECT mutation_id, mutation_fence, mutation_state,
               cleanup_attention_state, cleanup_attention_fence, cleanup_attention_result
        FROM host_control_receipts WHERE id = 'modern-host-resultless'
      `)).resolves.toMatchObject({
        rows: [expect.objectContaining({
          mutation_id: 'host-mutation:modern-4', mutation_fence: 10,
          mutation_state: 'applied', cleanup_attention_state: 'pending',
          cleanup_attention_fence: 0, cleanup_attention_result: null,
        })],
      });
    } finally {
      await legacy.close();
    }
  });
});
