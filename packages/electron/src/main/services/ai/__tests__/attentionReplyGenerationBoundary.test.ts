import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PGlite } from '@electric-sql/pglite';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  assertMainProcessImportProofHarnessDrained,
  mainProcessImportProofModules,
  resetMainProcessImportProofHarness,
} from '../../../__tests__/mainProcessImportProofHarness';

const databaseQuery = vi.hoisted(() => vi.fn());
vi.mock('electron', () => mainProcessImportProofModules.electron);
vi.mock('../../../window/WindowManager', () => mainProcessImportProofModules.windowManager);
vi.mock('../../../utils/logger', () => mainProcessImportProofModules.logger);
vi.mock('electron-log/main', () => mainProcessImportProofModules.electronLog);
vi.mock('../../analytics/AnalyticsService', () => mainProcessImportProofModules.analytics);
vi.mock('electron-store', () => mainProcessImportProofModules.electronStore);
vi.mock('../../../database/PGLiteDatabaseWorker', () => ({
  database: { query: databaseQuery },
}));

beforeEach(() => {
  resetMainProcessImportProofHarness();
});

afterEach(() => {
  assertMainProcessImportProofHarnessDrained();
  resetMainProcessImportProofHarness();
});

describe('mainProcessImportProofHarness', () => {
  it('uses only the fixed collection-shell module and export allowlist', () => {
    expect(Object.keys(mainProcessImportProofModules).sort()).toEqual([
      'analytics', 'electron', 'electronLog', 'electronStore', 'logger', 'windowManager',
    ]);
    expect(Object.keys(mainProcessImportProofModules.electron).sort()).toEqual([
      'BrowserWindow', 'app', 'ipcMain',
    ]);
    expect(Object.keys(mainProcessImportProofModules.windowManager).sort()).toEqual([
      'clearRecentlyDeleted', 'createWindow', 'documentServices', 'findWindowByFilePath',
      'findWindowByWorkspace', 'getFocusedOrNewWindow', 'getMostRecentlyFocusedWorkspaceWindow',
      'getWindowId', 'incrementFocusOrderCounter', 'isRecentlyDeleted', 'markRecentlyDeleted',
      'recentlyDeletedFiles', 'savingWindows', 'windowDevToolsState', 'windowFocusOrder',
      'windowStates', 'windows',
    ]);
  });
});

import { ipcMain } from 'electron';
import { AgentMessagesRepository, AISessionsRepository } from '@nimbalyst/runtime';
import { ProviderFactory } from '@nimbalyst/runtime/ai/server';
import { getSessionStateManager } from '@nimbalyst/runtime/ai/server/SessionStateManager';
import { AIService, runJeanGenerationBoundMutation } from '../AIService';
import type { PendingPromptPersistenceResult } from '../pendingPromptPersistence';
import { setSessionPendingPrompt } from '../pendingPromptPersistence';
import { attentionEventService } from '../../AttentionEventService';
import { parseToolPermissionResponseRecord } from '../claudeCliToolPermission';
import { findFreshInteractiveResponse } from '../../../mcp/tools/interactiveResponsePolling';
import {
  handleInjectAttentionReply,
  type AttentionReplyDependencies,
} from '../../AttentionReplyInjectionService';
import {
  createHostControlReceiptsStore,
  type HostControlReceiptRow,
} from '../../HostControlReceiptsStore';
import { createHostControlMutationCoordinator } from '../../HostControlMutationCoordinator';
import { createPGLiteSessionStore } from '../../PGLiteSessionStore';
import type { HostControlReceiptMutationAuthority } from '../../HostControlReceiptsStore';
import type { AppliedJeanCleanupResumerDependencies } from '../JeanAppliedCleanupResumer';
import { SQLiteDatabase } from '../../../database/sqlite/SQLiteDatabase';
import { createSQLiteStoreAdapter } from '../../../database/sqlite/SQLiteStoreAdapter';

interface PersistedCleanupPhases {
  prompt: 'pending' | 'claimed' | 'complete';
  attention: 'pending' | 'claimed' | 'complete';
  terminal: 'pending' | 'claimed' | 'complete';
  attentionResult?: 'settled' | 'already_absent';
}

function createPersistedPhaseAuthority(
  generation: string,
  phases: PersistedCleanupPhases,
  overrides: Partial<HostControlReceiptMutationAuthority> = {},
): HostControlReceiptMutationAuthority {
  return {
    begin: async () => { throw new Error('unused_begin'); },
    recordApplied: async () => { throw new Error('unused_record'); },
    verify: async () => true,
    verifyCleanup: async () => phases.prompt === 'claimed' || phases.prompt === 'complete',
    enterNative: async <T>(_generation: string, action: () => Promise<T>) => ({
      owned: true as const,
      value: await action(),
    }),
    claimCleanupStep: async (step) => {
      if (phases[step] !== 'complete') return { status: 'claimed' as const };
      return {
        status: 'complete' as const,
        ...(step === 'attention' ? { attentionResult: phases.attentionResult } : {}),
      };
    },
    metadataCleanupAuthority: (step) => ({
      receiptId: 'receipt-test',
      reservationOwner: 'owner-test',
      mutationId: 'mutation-test',
      mutationFence: 1,
      attentionGeneration: generation,
      step,
    }),
    ...overrides,
  };
}

function promptClear(): PendingPromptPersistenceResult {
  return {
    sessionId: 'session-1',
    hasPendingPrompt: false,
    promptId: null,
    generation: null,
    applied: true,
    superseded: false,
    local: { attempted: true, succeeded: true, skippedReason: null },
    sync: { attempted: false, succeeded: false, skippedReason: 'test' },
    fullyPropagated: false,
  };
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

function createDeterministicReceiptStore(
  db: Parameters<typeof createHostControlReceiptsStore>[0],
  storeId: string,
  authorityRoot: string,
) {
  const processIdentity = `nim364-proof:${storeId}`;
  return createHostControlReceiptsStore(db, undefined, {
    storeIdentity: { storeId, authorityRoot },
    mutationCoordinator: createHostControlMutationCoordinator({
      acquireTimeoutMs: 30_000,
      pid: 4242,
      processIdentity,
      isProcessAlive: (pid) => pid === 4242,
      getProcessIdentity: async (pid) => (pid === 4242 ? processIdentity : null),
    }),
  });
}

async function waitForBarrierOrOwner<T>(
  barrier: ReturnType<typeof boundedBarrier>,
  owner: Promise<T>,
  name: string,
): Promise<void> {
  await Promise.race([
    barrier.waitUntilReached(),
    owner.then(
      (result) => Promise.reject(new Error(`owner_settled_before_barrier:${name}:${JSON.stringify(result)}`)),
      (error) => Promise.reject(error),
    ),
  ]);
}

describe('runJeanGenerationBoundMutation', () => {
  it('executes reserve p1 -> pause -> install B -> resume without clearing or answering B', async () => {
    const state = {
      promptId: 'p1',
      generation: 'generation-a',
      pending: true,
      promptMarker: 'replacement-not-installed',
    };
    const reachedPause = boundedBarrier('run_jean_before_native_reached');
    const resume = boundedBarrier('run_jean_before_native_resume');
    const clearPrompt = vi.fn(async () => {
      state.pending = false;
      return promptClear();
    });
    const nativeMutation = vi.fn(async () => ({ success: true }));
    const runOwnedAction = vi.fn(async (_sessionId, _promptId, action) => ({
      owned: true,
      ownership: {
        sessionId: 'session-1',
        promptId: state.promptId,
        attentionGeneration: state.generation,
        matchedPendingPrompt: state.pending,
        readSucceeded: true,
      },
      value: await action({
        ownership: {
          sessionId: 'session-1',
          promptId: state.promptId,
          attentionGeneration: state.generation,
          matchedPendingPrompt: state.pending,
          readSucceeded: true,
        },
        clearPrompt,
      }),
    }));

    const pending = runJeanGenerationBoundMutation({
      sessionId: 'session-1',
      promptId: 'p1',
      expectedPromptIdentity: 'p1',
      expectedAttentionGeneration: 'generation-a',
      beforeNativeMutation: async () => {
        reachedPause.release();
        await resume.promise;
      },
      runOwnedAction: runOwnedAction as any,
      action: async ({ clearPrompt: clear }) => {
        await clear();
        return nativeMutation();
      },
    });

    try {
      await reachedPause.waitUntilReached();
      state.generation = 'generation-b';
      state.pending = true;
      state.promptMarker = 'replacement-b';
      resume.release();

      await expect(pending).resolves.toEqual({ claimed: false, promptClear: undefined });
      expect(state).toEqual({
        promptId: 'p1',
        generation: 'generation-b',
        pending: true,
        promptMarker: 'replacement-b',
      });
      expect(clearPrompt).not.toHaveBeenCalled();
      expect(nativeMutation).not.toHaveBeenCalled();
    } finally {
      resume.release();
      reachedPause.dispose();
      resume.dispose();
      await pending.catch(() => undefined);
    }
  });

  it('compare-clears and mutates once when prompt identity and generation still match', async () => {
    const clearPrompt = vi.fn(async () => promptClear());
    const nativeMutation = vi.fn(async () => 'mutated-a');
    const runOwnedAction = vi.fn(async (_sessionId, _promptId, action) => ({
      owned: true,
      ownership: {
        sessionId: 'session-1',
        promptId: 'p1',
        attentionGeneration: 'generation-a',
        matchedPendingPrompt: true,
        readSucceeded: true,
      },
      value: await action({
        ownership: {
          sessionId: 'session-1',
          promptId: 'p1',
          attentionGeneration: 'generation-a',
          matchedPendingPrompt: true,
          readSucceeded: true,
        },
        clearPrompt,
      }),
    }));

    await expect(runJeanGenerationBoundMutation({
      sessionId: 'session-1',
      promptId: 'p1',
      expectedPromptIdentity: 'p1',
      expectedAttentionGeneration: 'generation-a',
      runOwnedAction: runOwnedAction as any,
      action: async ({ clearPrompt: clear }) => {
        await clear();
        return nativeMutation();
      },
    })).resolves.toMatchObject({ claimed: true, value: 'mutated-a' });
    expect(clearPrompt).toHaveBeenCalledOnce();
    expect(nativeMutation).toHaveBeenCalledOnce();
  });

  it('returns one stable already_resolved Jean receipt for the exact A-to-B schedule', async () => {
    const sessionState = {
      promptId: 'p1',
      generation: 'generation-a',
      pending: true,
      promptMarker: 'prompt-a',
    };
    const reachedPause = boundedBarrier('receipt_before_native_reached');
    const resume = boundedBarrier('receipt_before_native_resume');
    const nativeMutation = vi.fn(async () => ({ success: true }));
    const clearPrompt = vi.fn(async () => {
      sessionState.pending = false;
      return promptClear();
    });
    const runOwnedAction = vi.fn(async (_sessionId, _promptId, action) => ({
      owned: true,
      ownership: {
        sessionId: 'session-1',
        promptId: sessionState.promptId,
        attentionGeneration: sessionState.generation,
        matchedPendingPrompt: sessionState.pending,
        readSucceeded: true,
      },
      value: await action({
        ownership: {
          sessionId: 'session-1',
          promptId: sessionState.promptId,
          attentionGeneration: sessionState.generation,
          matchedPendingPrompt: sessionState.pending,
          readSucceeded: true,
        },
        clearPrompt,
      }),
    }));
    const baseRow: HostControlReceiptRow = {
      id: 'receipt-1',
      reservationKey: 'attention-reply:watch-1',
      requestDigest: 'digest',
      operation: 'inject_attention_reply',
      sessionId: 'session-1',
      eventIdentity: 'p1',
      attentionGeneration: 'generation-a',
      state: 'reserved',
      reservationOwner: 'owner-1',
      leaseExpiresAt: Date.parse('2026-07-20T10:00:30.000Z'),
      mutationId: 'mutation-1',
      mutationFence: 1,
      mutationState: 'not_started',
      createdAt: 1,
      updatedAt: 1,
    };
    let durableRow = baseRow;
    const deps: AttentionReplyDependencies = {
      getPendingInteractiveEvent: vi.fn(async () => ({
        id: 'event-1',
        sessionId: 'session-1',
        promptId: 'p1',
        attentionGeneration: 'generation-a',
        kind: 'interactive_prompt' as const,
        promptType: 'AskUserQuestion',
        context: { questions: [{ question: 'Question key?' }] },
        status: 'pending' as const,
      })),
      reserveReceipt: vi.fn(async () => ({
        row: durableRow,
        isNewReservation: true,
        status: 'new' as const,
        mutationAuthority: {
          begin: async (_now: Date, generation: string) => {
            durableRow = { ...durableRow, mutationState: 'unknown', attentionGeneration: generation };
            return { started: true, row: durableRow };
          },
          recordApplied: async (
            certainty: 'not_applied' | 'applied',
            receipt: Record<string, unknown>,
          ) => {
            durableRow = { ...durableRow, mutationState: certainty, mutationReceipt: receipt };
            return durableRow;
          },
          verify: async () => true,
          verifyCleanup: async () => true,
          enterNative: async <T>(_generation: string, action: () => Promise<T>) => ({
            owned: true as const,
            value: await action(),
          }),
          claimCleanupStep: async () => ({ status: 'claimed' as const }),
          metadataCleanupAuthority: (step: 'prompt' | 'attention', attentionGeneration: string) => ({
            receiptId: durableRow.id,
            reservationOwner: durableRow.reservationOwner!,
            mutationId: durableRow.mutationId!,
            mutationFence: durableRow.mutationFence!,
            attentionGeneration,
            step,
          }),
        },
      })),
      finalizeReceipt: vi.fn(async (input) => {
        durableRow = { ...durableRow, state: input.state, receipt: input.receipt };
        return durableRow;
      }),
      respondToInteractivePrompt: vi.fn(async (params) => {
        const boundary = await runJeanGenerationBoundMutation({
          sessionId: params.sessionId,
          promptId: params.promptId,
          expectedPromptIdentity: params.expectedPromptIdentity,
          expectedAttentionGeneration: params.expectedAttentionGeneration,
          beforeNativeMutation: params.beforeNativeMutation,
          runOwnedAction: runOwnedAction as any,
          action: nativeMutation,
        });
        return boundary.claimed
          ? {
              success: true,
              attentionCancelledCount: 1,
              eventCleared: true,
              nativeCertainty: 'applied' as const,
              nativeEntered: true,
              cleanupVerified: true,
            }
          : {
              success: false,
              staleAction: true,
              nativeCertainty: 'not_applied' as const,
              nativeEntered: false,
              cleanupVerified: false,
            };
      }),
      now: () => Date.parse('2026-07-20T10:00:00.000Z'),
      createReservationOwner: () => 'owner-1',
      onJeanReconciliationPoint: async (point) => {
        expect(point).toBe('before_jean_native_mutation');
        reachedPause.release();
        await resume.promise;
      },
    };

    const pending = handleInjectAttentionReply(deps, {
      watchId: 'watch-1',
      sessionId: 'session-1',
      promptId: 'p1',
      attentionGeneration: 'generation-a',
      promptType: 'ask_user_question_request',
      answer: 'bounded answer',
    });
    try {
      await reachedPause.waitUntilReached();
      sessionState.generation = 'generation-b';
      sessionState.pending = true;
      sessionState.promptMarker = 'prompt-b';
      resume.release();

      await expect(pending).resolves.toEqual({
        status: 200,
        receipt: {
          outcome: 'already_resolved',
          verified: true,
          receipt: {
            route: 'host-attention-answer',
            event_cleared: false,
            event_not_current: true,
          },
        },
      });
      expect(sessionState).toEqual({
        promptId: 'p1',
        generation: 'generation-b',
        pending: true,
        promptMarker: 'prompt-b',
      });
      expect(clearPrompt).not.toHaveBeenCalled();
      expect(nativeMutation).not.toHaveBeenCalled();
      expect(durableRow).toMatchObject({
        state: 'already_resolved',
        mutationState: 'not_applied',
        receipt: { outcome: 'already_resolved', verified: true },
      });
    } finally {
      resume.release();
      reachedPause.dispose();
      resume.dispose();
      await pending.catch(() => undefined);
    }
  });

  it.each(['PGLite', 'SQLite'] as const)(
    '%s reconstructs an applied A with A absent and reused-p1 B current as event_cleared false',
    async (backend) => {
      const sqliteDir = backend === 'SQLite'
        ? fs.mkdtempSync(path.join(os.tmpdir(), 'jean-absent-sqlite-'))
        : undefined;
      const authorityDir = fs.mkdtempSync(path.join(os.tmpdir(), `jean-absent-authority-${backend}-`));
      const sqlite = sqliteDir ? new SQLiteDatabase({
        dbDir: sqliteDir,
        schemaDir: path.resolve(__dirname, '../../../database/sqlite/schemas'),
        slowQueryThresholdMs: 1_000,
        sampleRate: 0,
      }) : undefined;
      const pglite = backend === 'PGLite' ? new PGlite() : undefined;
      let ownerAPromise: Promise<Awaited<ReturnType<typeof handleInjectAttentionReply>>> | undefined;
      let ownerBPromise: Promise<Awaited<ReturnType<typeof handleInjectAttentionReply>>> | undefined;
      const ownerAPaused = boundedBarrier(`jean_absent_owner_a_paused:${backend}`);
      const resumeOwnerA = boundedBarrier(`jean_absent_owner_a_resume:${backend}`);
      const ownerBPaused = boundedBarrier(`jean_absent_owner_b_paused:${backend}`);
      const resumeOwnerB = boundedBarrier(`jean_absent_owner_b_resume:${backend}`);
      let repositoryGet: any;
      let repositoryUpdate: any;
      let providerSpy: any;
      let attentionSpy: any;
      try {
        if (pglite) {
          await (pglite as unknown as { waitReady: Promise<void> }).waitReady;
          await pglite.exec(`
            CREATE TABLE host_control_receipts (
              id TEXT PRIMARY KEY, reservation_key TEXT NOT NULL UNIQUE,
              request_digest TEXT NOT NULL, operation TEXT NOT NULL,
              session_id TEXT NOT NULL, event_identity TEXT NOT NULL,
              attention_generation TEXT, state TEXT NOT NULL,
              reservation_owner TEXT, lease_expires_at TIMESTAMPTZ,
              mutation_id TEXT, mutation_fence INTEGER NOT NULL DEFAULT 0,
              mutation_state TEXT NOT NULL DEFAULT 'not_started',
              mutation_started_at TIMESTAMPTZ, mutation_applied_at TIMESTAMPTZ,
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
              singleton INTEGER PRIMARY KEY, store_id TEXT NOT NULL UNIQUE,
              authority_root TEXT NOT NULL
            );
            CREATE TABLE ai_sessions (id TEXT PRIMARY KEY, provider TEXT NOT NULL, metadata JSONB);
          `);
          await pglite.query(
            `INSERT INTO host_control_store_identity (singleton, store_id, authority_root)
             VALUES (1, $1, $2)`,
            [`jean-absent-${backend}`, authorityDir],
          );
        } else await sqlite!.initialize();
        const durableDb = (pglite
          ? createPgliteStatementAdapter(pglite)
          : createSQLiteStoreAdapter(sqlite!)) as {
          query<T = any>(sql: string, params?: any[]): Promise<{ rows: T[] }>;
          transaction<T = any>(statements: Array<{ sql: string; params?: any[]; expectedRowCount?: number }>): Promise<Array<{ rows: T[] }>>;
        };
        const store = createDeterministicReceiptStore(
          durableDb,
          `jean-absent-${backend}`,
          authorityDir,
        );
        const sessionId = `jean-absent-${backend}`;
        const promptId = 'reused-p1';
        const generationA = `${sessionId}:A`;
        const generationB = `${sessionId}:B`;
        const base = Date.now() + 60_000;
        let now = base;
        let owner = 'owner-a';
        let installedB = false;
        let metadata: Record<string, unknown> = {};
        repositoryGet = vi.spyOn(AISessionsRepository, 'get').mockImplementation(async (id) => (
          id === sessionId ? { id: sessionId, provider: 'claude-code', metadata } as any : null
        ));
        repositoryUpdate = vi.spyOn(AISessionsRepository, 'updateMetadata')
          .mockImplementation(async (_id, patch: any) => {
            metadata = { ...metadata, ...(patch?.metadata ?? patch) };
          });
        const stateManager = getSessionStateManager();
        stateManager.setDatabase({ query: vi.fn(async () => ({ rows: [] })) } as any);
        await stateManager.startSession({
          sessionId,
          workspacePath: 'D:\\workspace',
          initialStatus: 'waiting_for_input',
          attentionGeneration: generationA,
        });
        await setSessionPendingPrompt(sessionId, true, { promptId, generation: generationA });
        const event = (generation: string, occurrence: string) => ({
          id: occurrence, sessionId, promptId, attentionGeneration: generation,
          kind: 'interactive_prompt', promptType: 'AskUserQuestion',
          context: { questions: [{ question: 'Question?' }] }, severity: 'normal',
          deadline: null, dedupeKey: `interactive:AskUserQuestion:${promptId}`,
          status: 'pending', armedAt: new Date().toISOString(), doNotDisturb: false,
          immediateReceipt: {
            requested: true, attempted: false, skippedReason: 'pending',
            recordedAt: new Date().toISOString(),
          },
          dedupeCount: 0,
        });
        metadata.attentionEvents = [event(generationA, 'occurrence-a')];
        await durableDb.query(
          'INSERT INTO ai_sessions(id, provider, metadata) VALUES ($1, $2, $3)',
          [sessionId, 'claude-code', JSON.stringify(metadata)],
        );
        createPGLiteSessionStore(durableDb as any);
        const native = {
          resolveAskUserQuestion: vi.fn((...args: any[]) => ({
            outcome: 'acknowledged', authority: args[4],
          })),
        };
        providerSpy = vi.spyOn(ProviderFactory, 'getProvider').mockReturnValue(native as any);
        attentionSpy = vi.spyOn(attentionEventService, 'cancelInteractivePrompt');
        (ipcMain as any).listenerCount = vi.fn(() => 0);
        databaseQuery.mockResolvedValue({ rows: [] });

        const deps: AttentionReplyDependencies = {
          getPendingInteractiveEvent: (id, identity) => (
            attentionEventService.getPendingInteractiveEvent(id, identity)
          ),
          reserveReceipt: (input) => store.reserveReceipt(input),
          finalizeReceipt: (input) => store.finalizeReceipt(input),
          respondToInteractivePrompt: (params) => (
            AIService.prototype.respondToInteractivePrompt.call({} as AIService, params)
          ),
          now: () => now,
          createReservationOwner: () => owner,
          reservationLeaseMs: 30_000,
          onJeanReconciliationPoint: async (point) => {
            if (point === 'after_jean_application_recorded' && owner === 'owner-a' && !installedB) {
              installedB = true;
              await stateManager.startSession({
                sessionId,
                workspacePath: 'D:\\workspace',
                initialStatus: 'waiting_for_input',
                attentionGeneration: generationB,
              });
              await setSessionPendingPrompt(sessionId, true, { promptId, generation: generationB });
              metadata.attentionEvents = [event(generationB, 'occurrence-b')];
              await durableDb.query('UPDATE ai_sessions SET metadata = $2 WHERE id = $1', [
                sessionId,
                JSON.stringify(metadata),
              ]);
              ownerAPaused.release();
              await resumeOwnerA.promise;
            }
            if (point === 'after_jean_attention_cleanup_completed' && owner === 'owner-b') {
              ownerBPaused.release();
              await resumeOwnerB.promise;
            }
          },
        };
        const request = {
          watchId: `watch-absent-${backend}`, sessionId, promptId,
          attentionGeneration: generationA,
          promptType: 'ask_user_question_request' as const,
          answer: 'A answer',
        };

        ownerAPromise = handleInjectAttentionReply(deps, request);
        await ownerAPaused.waitUntilReached();
        expect(native.resolveAskUserQuestion).toHaveBeenCalledOnce();
        await durableDb.query(
          'UPDATE host_control_receipts SET lease_expires_at = NOW() WHERE reservation_key = $1',
          [`attention-reply:watch-absent-${backend}`],
        );
        now += 120_000;
        owner = 'owner-b';
        ownerBPromise = handleInjectAttentionReply(deps, request);
        await waitForBarrierOrOwner(
          ownerBPaused,
          ownerBPromise,
          `jean_absent_owner_b:${backend}`,
        );
        const afterAbsence = await store.getByReservationKey(`attention-reply:watch-absent-${backend}`);
        expect(afterAbsence).toMatchObject({
          state: 'reserved', mutationState: 'applied',
          cleanupAttentionState: 'complete', cleanupAttentionResult: 'already_absent',
        });
        await durableDb.query(
          'UPDATE host_control_receipts SET lease_expires_at = NOW() WHERE reservation_key = $1',
          [`attention-reply:watch-absent-${backend}`],
        );
        now += 120_000;
        owner = 'owner-c';
        const reconciled = await handleInjectAttentionReply(deps, request);
        resumeOwnerB.release();
        resumeOwnerA.release();
        const loser = await ownerBPromise;
        const ownerAResult = await ownerAPromise;

        expect(reconciled).toEqual({
          status: 200,
          receipt: {
            outcome: 'injected', verified: true,
            receipt: {
              route: 'host-attention-answer', event_cleared: false, event_not_current: true,
            },
          },
        });
        expect(loser).toEqual(reconciled);
        expect(ownerAResult).toEqual(reconciled);
        expect(native.resolveAskUserQuestion).toHaveBeenCalledOnce();
        expect(metadata).toMatchObject({
          hasPendingPrompt: true,
          pendingPromptId: promptId,
          pendingPromptGeneration: generationB,
          attentionEvents: [expect.objectContaining({
            id: 'occurrence-b', attentionGeneration: generationB, status: 'pending',
          })],
        });
        expect(attentionSpy).toHaveBeenCalledTimes(1);
        expect(await store.getByReservationKey(`attention-reply:watch-absent-${backend}`))
          .toMatchObject({
            state: 'injected', mutationFence: 3,
            cleanupAttentionResult: 'already_absent',
          });
      } finally {
        resumeOwnerA.release();
        resumeOwnerB.release();
        ownerAPaused.dispose();
        resumeOwnerA.dispose();
        ownerBPaused.dispose();
        resumeOwnerB.dispose();
        if (ownerAPromise) await ownerAPromise.catch(() => undefined);
        if (ownerBPromise) await ownerBPromise.catch(() => undefined);
        repositoryGet?.mockRestore();
        repositoryUpdate?.mockRestore();
        providerSpy?.mockRestore();
        attentionSpy?.mockRestore();
        databaseQuery.mockReset();
        if (pglite) await pglite.close();
        if (sqlite) await sqlite.close();
        if (sqliteDir) fs.rmSync(sqliteDir, { recursive: true, force: true });
        fs.rmSync(authorityDir, { recursive: true, force: true });
      }
    },
  );

  it.each([
    ['permission_request', { decision: 'allow', scope: 'once' }],
    ['ask_user_question_request', { answers: { Question: 'Answer' } }],
    ['exit_plan_mode_request', { approved: true, clearContext: true }],
  ] as const)(
    'runs real prompt persistence and AIService without publishing a B-consumable %s raw-ID response',
    async (promptType, response) => {
      const sessionId = `jean-production-${promptType}`;
      const promptId = 'reused-p1';
      const generationA = `${sessionId}:A`;
      const generationB = `${sessionId}:B`;
      let metadata: Record<string, unknown> = {};
      const session = { id: sessionId, provider: 'claude-code', metadata };
      const repositoryGet = vi.spyOn(AISessionsRepository, 'get').mockImplementation(async (id) => (
        id === sessionId ? { ...session, metadata } as any : null
      ));
      const repositoryUpdate = vi.spyOn(AISessionsRepository, 'updateMetadata')
        .mockImplementation(async (_id, patch: any) => {
          metadata = { ...metadata, ...(patch?.metadata ?? patch) };
        });
      const stateManager = getSessionStateManager();
      stateManager.setDatabase({ query: vi.fn(async () => ({ rows: [] })) } as any);
      await stateManager.startSession({
        sessionId,
        workspacePath: 'D:\\workspace',
        initialStatus: 'waiting_for_input',
        attentionGeneration: generationA,
      });
      await setSessionPendingPrompt(sessionId, true, {
        promptId,
        generation: generationA,
      });

      const native = {
        resolveToolPermission: vi.fn((...args: any[]) => ({
          outcome: 'acknowledged', authority: args[4],
        })),
        resolveAskUserQuestion: vi.fn((...args: any[]) => ({
          outcome: 'acknowledged', authority: args[4],
        })),
        resolveExitPlanModeConfirmation: vi.fn((...args: any[]) => ({
          outcome: 'acknowledged', authority: args[4],
        })),
      };
      const providerSpy = vi.spyOn(ProviderFactory, 'getProvider').mockReturnValue(native as any);
      const durableAttentionService: {
        cancelInteractivePrompt: NonNullable<AppliedJeanCleanupResumerDependencies['cancelInteractivePrompt']>;
      } = attentionEventService;
      const attentionSpy = vi.spyOn(durableAttentionService, 'cancelInteractivePrompt')
        .mockResolvedValue({ attentionCancelledCount: 1, attentionResult: 'settled' } as any);
      (ipcMain as any).listenerCount = vi.fn(() => 0);
      (ipcMain as any).emit = vi.fn();

      const boundaryReached = boundedBarrier(`provider_boundary_reached:${promptType}`);
      const boundaryGate = boundedBarrier(`provider_boundary_resume:${promptType}`);
      databaseQuery.mockResolvedValue({ rows: [] });
      const sessionQuery = vi.fn(async (sql: string, params?: any[]) => {
          if (sql.includes('UPDATE ai_sessions')) {
            metadata = JSON.parse(params![1]);
            return { rows: [{ id: sessionId }] };
          }
          if (sql.includes('UPDATE host_control_receipts')) return { rows: [{ id: 'receipt-test' }] };
          return { rows: [] };
        });
      createPGLiteSessionStore({
        query: sessionQuery,
        transaction: async <T = any>(statements: Array<{
          sql: string; params?: any[]; expectedRowCount?: number;
        }>) => {
          const results: Array<{ rows: T[] }> = [];
          for (const [index, statement] of statements.entries()) {
            const result = await sessionQuery(statement.sql, statement.params);
            if (statement.expectedRowCount !== undefined
              && result.rows.length !== statement.expectedRowCount) {
              throw new Error(`transaction expected row count mismatch at statement ${index}: expected ${statement.expectedRowCount}, got ${result.rows.length}`);
            }
            results.push({ rows: result.rows as T[] });
          }
          return results;
        },
      } as any);

      const pending = AIService.prototype.respondToInteractivePrompt.call({} as AIService, {
        sessionId,
        promptId,
        promptType,
        response,
        respondedBy: 'telegram',
        expectedAttentionGeneration: generationA,
        expectedPromptIdentity: promptId,
        assertMutationFence: async () => true,
        beforeNativeMutation: async () => {
          boundaryReached.release();
          await boundaryGate.promise;
        },
      });
      try {
        await boundaryReached.waitUntilReached();
        await stateManager.startSession({
          sessionId,
          workspacePath: 'D:\\workspace',
          initialStatus: 'waiting_for_input',
          attentionGeneration: generationB,
        });
        const installB = setSessionPendingPrompt(sessionId, true, {
          promptId,
          generation: generationB,
        });
        boundaryGate.release();

        await expect(pending).resolves.toMatchObject({ success: false, staleAction: true });
        await installB;
        expect(metadata).toMatchObject({
          hasPendingPrompt: true,
          pendingPromptId: promptId,
          pendingPromptGeneration: generationB,
        });
        expect(native.resolveToolPermission).not.toHaveBeenCalled();
        expect(native.resolveAskUserQuestion).not.toHaveBeenCalled();
        expect(native.resolveExitPlanModeConfirmation).not.toHaveBeenCalled();
        expect(attentionSpy).not.toHaveBeenCalled();
        const rawResponseInserts = databaseQuery.mock.calls.filter(([sql]) => (
          typeof sql === 'string' && sql.includes('INSERT INTO ai_agent_messages')
        ));
        expect(rawResponseInserts).toEqual([]);

        // These are the exact unchanged production correlation functions used by
        // the permission and Ask DB pollers. A raw p1 row would settle B; Jean's
        // generation-bound route therefore proves isolation by publishing none.
        expect(parseToolPermissionResponseRecord(JSON.stringify({
          type: 'permission_response', requestId: promptId,
          decision: 'allow', scope: 'once',
        }), promptId)).not.toBeNull();
        expect(findFreshInteractiveResponse([{
          createdAt: new Date(),
          content: JSON.stringify({
            type: 'ask_user_question_response', questionId: promptId,
            answers: { Question: 'A answer' },
          }),
        }], {
          expectedType: 'ask_user_question_response',
          idFields: ['questionId', 'rawQuestionId'],
          acceptedIds: new Set([promptId]),
          notBefore: 0,
        })).not.toBeNull();
      } finally {
        boundaryGate.release();
        boundaryReached.dispose();
        boundaryGate.dispose();
        await pending.catch(() => undefined);
        repositoryGet.mockRestore();
        repositoryUpdate.mockRestore();
        providerSpy.mockRestore();
        attentionSpy.mockRestore();
        databaseQuery.mockReset();
      }
    },
  );

  it.each([
    ['permission_request', { decision: 'allow', scope: 'once' }],
    ['ask_user_question_request', { answers: { Question: 'A answer' } }],
    ['exit_plan_mode_request', { approved: true, clearContext: true }],
  ] as const)(
    'keeps a later reused-p1 B isolated after a successful %s Jean mutation',
    async (promptType, response) => {
      const sessionId = `jean-success-${promptType}`;
      const promptId = 'reused-p1';
      const generationA = `${sessionId}:A`;
      const generationB = `${sessionId}:B`;
      let metadata: Record<string, unknown> = {};
      const repositoryGet = vi.spyOn(AISessionsRepository, 'get').mockImplementation(async (id) => (
        id === sessionId ? { id: sessionId, provider: 'claude-code', metadata } as any : null
      ));
      const repositoryUpdate = vi.spyOn(AISessionsRepository, 'updateMetadata')
        .mockImplementation(async (_id, patch: any) => {
          metadata = { ...metadata, ...(patch?.metadata ?? patch) };
        });
      const stateManager = getSessionStateManager();
      stateManager.setDatabase({ query: vi.fn(async () => ({ rows: [] })) } as any);
      await stateManager.startSession({
        sessionId,
        workspacePath: 'D:\\workspace',
        initialStatus: 'waiting_for_input',
        attentionGeneration: generationA,
      });
      await setSessionPendingPrompt(sessionId, true, { promptId, generation: generationA });

      const durableCleanupPhase: PersistedCleanupPhases = {
        prompt: 'claimed',
        attention: 'claimed',
        terminal: 'pending',
      };
      const native = {
        resolveToolPermission: vi.fn((...args: any[]) => ({
          outcome: 'acknowledged', authority: args[4],
        })),
        resolveAskUserQuestion: vi.fn((...args: any[]) => ({
          outcome: 'acknowledged', authority: args[4],
        })),
        resolveExitPlanModeConfirmation: vi.fn((...args: any[]) => ({
          outcome: 'acknowledged', authority: args[4],
        })),
      };
      const providerSpy = vi.spyOn(ProviderFactory, 'getProvider').mockReturnValue(native as any);
      const durableAttentionService: {
        cancelInteractivePrompt: NonNullable<AppliedJeanCleanupResumerDependencies['cancelInteractivePrompt']>;
      } = attentionEventService;
      const attentionSpy = vi.spyOn(durableAttentionService, 'cancelInteractivePrompt')
        .mockImplementation(async (
          _sessionId,
          _promptId,
          _reason,
          options: {
            expectedGeneration: string;
            durableCleanupAuthority: ReturnType<HostControlReceiptMutationAuthority['metadataCleanupAuthority']>;
          },
        ) => {
          const authority = options.durableCleanupAuthority;
          if (!authority || authority.step !== 'attention'
            || authority.attentionGeneration !== generationA) {
            throw new Error('synthetic_attention_authority_mismatch');
          }
          // Model the production atomic effect/result commit: the acknowledgement
          // is not observable until the durable phase and immutable result agree.
          durableCleanupPhase.attention = 'complete';
          durableCleanupPhase.attentionResult = 'settled';
          return { attentionCancelledCount: 1, attentionResult: 'settled' };
        });
      (ipcMain as any).listenerCount = vi.fn(() => 0);
      (ipcMain as any).emit = vi.fn();
      databaseQuery.mockResolvedValue({ rows: [] });
      const sessionQuery = vi.fn(async (sql: string, params?: any[]) => {
          if (sql.includes('UPDATE ai_sessions')) {
            metadata = JSON.parse(params![1]);
            return { rows: [{ id: sessionId }] };
          }
          if (sql.includes('UPDATE host_control_receipts')) {
            if (sql.includes("cleanup_prompt_state = 'complete'")) durableCleanupPhase.prompt = 'complete';
            if (sql.includes("cleanup_attention_state = 'complete'")) durableCleanupPhase.attention = 'complete';
            if (sql.includes("cleanup_terminal_state = 'complete'")) durableCleanupPhase.terminal = 'complete';
            return { rows: [{ id: 'receipt-test' }] };
          }
          return { rows: [] };
      });
      createPGLiteSessionStore({
        query: sessionQuery,
        transaction: async <T = any>(statements: Array<{
          sql: string; params?: any[]; expectedRowCount?: number;
        }>) => {
          const results: Array<{ rows: T[] }> = [];
          for (const [index, statement] of statements.entries()) {
            const result = await sessionQuery(statement.sql, statement.params);
            if (statement.expectedRowCount !== undefined
              && result.rows.length !== statement.expectedRowCount) {
              throw new Error(`transaction expected row count mismatch at statement ${index}: expected ${statement.expectedRowCount}, got ${result.rows.length}`);
            }
            results.push({ rows: result.rows as T[] });
          }
          return results;
        },
      } as any);

      try {
        const mutationAuthority = {
          mutationId: `${sessionId}:mutation`,
          mutationFence: 1,
          attentionGeneration: generationA,
          promptOccurrence: promptId,
          answerDigest: 'c'.repeat(64),
        };
        const result = await AIService.prototype.respondToInteractivePrompt.call({} as AIService, {
          sessionId,
          promptId,
          promptType,
          response,
          respondedBy: 'telegram',
          expectedAttentionGeneration: generationA,
          expectedPromptIdentity: promptId,
          mutationAuthority,
          durableMutationAuthority: createPersistedPhaseAuthority(generationA, durableCleanupPhase),
          assertMutationFence: async () => true,
          onNativeMutationApplied: async () => {},
        });
        expect(result).toMatchObject({
          success: true,
          nativeCertainty: 'applied',
          nativeEntered: true,
          cleanupVerified: true,
        });
        expect(durableCleanupPhase).toMatchObject({
          prompt: 'complete', attention: 'complete', attentionResult: 'settled',
          terminal: 'pending',
        });
        expect(databaseQuery.mock.calls.some(([sql]) => (
          typeof sql === 'string' && sql.includes('INSERT INTO ai_agent_messages')
        ))).toBe(false);
        const permissionPollRows = await AgentMessagesRepository.list(sessionId, { limit: 50 });
        expect(permissionPollRows.some((message: any) => (
          parseToolPermissionResponseRecord(message.content, promptId) !== null
        ))).toBe(false);
        const askPollRows = await AgentMessagesRepository.listTail(sessionId, 50);
        expect(findFreshInteractiveResponse(askPollRows as any, {
          expectedType: 'ask_user_question_response',
          idFields: ['questionId', 'rawQuestionId'],
          acceptedIds: new Set([promptId]),
          notBefore: 0,
        })).toBeNull();

        await stateManager.startSession({
          sessionId,
          workspacePath: 'D:\\workspace',
          initialStatus: 'waiting_for_input',
          attentionGeneration: generationB,
        });
        await setSessionPendingPrompt(sessionId, true, { promptId, generation: generationB });
        expect(metadata).toMatchObject({
          hasPendingPrompt: true,
          pendingPromptId: promptId,
          pendingPromptGeneration: generationB,
        });
        expect(attentionSpy).toHaveBeenCalledWith(
          sessionId,
          promptId,
          'answered',
          expect.objectContaining({
            expectedGeneration: generationA,
            durableCleanupAuthority: expect.objectContaining({ step: 'attention' }),
          }),
        );
      } finally {
        repositoryGet.mockRestore();
        repositoryUpdate.mockRestore();
        providerSpy.mockRestore();
        attentionSpy.mockRestore();
        databaseQuery.mockReset();
      }
    },
  );

  it.each([
    ['PGLite', 'after_jean_prompt_cleanup_completed'],
    ['SQLite', 'after_jean_prompt_cleanup_completed'],
    ['PGLite', 'after_jean_attention_metadata_committed'],
    ['SQLite', 'after_jean_attention_metadata_committed'],
  ] as const)(
    '%s resumes %s under a reconstructed lease owner without re-entering native code',
    async (backend, pausePoint) => {
    const sqliteDir = backend === 'SQLite'
      ? fs.mkdtempSync(path.join(os.tmpdir(), 'jean-cleanup-sqlite-'))
      : undefined;
    const sqlite = sqliteDir ? new SQLiteDatabase({
      dbDir: sqliteDir,
      schemaDir: path.resolve(__dirname, '../../../database/sqlite/schemas'),
      slowQueryThresholdMs: 1_000,
      sampleRate: 0,
    }) : undefined;
    const pglite = backend === 'PGLite' ? new PGlite() : undefined;
    const authorityDir = fs.mkdtempSync(path.join(os.tmpdir(), `jean-cleanup-authority-${backend}-`));
    if (pglite) {
      await (pglite as unknown as { waitReady: Promise<void> }).waitReady;
      await pglite.exec(`
      CREATE TABLE host_control_receipts (
        id TEXT PRIMARY KEY, reservation_key TEXT NOT NULL UNIQUE,
        request_digest TEXT NOT NULL, operation TEXT NOT NULL,
        session_id TEXT NOT NULL, event_identity TEXT NOT NULL,
        attention_generation TEXT, state TEXT NOT NULL,
        reservation_owner TEXT, lease_expires_at TIMESTAMPTZ,
        mutation_id TEXT, mutation_fence INTEGER NOT NULL DEFAULT 0,
        mutation_state TEXT NOT NULL DEFAULT 'not_started',
        mutation_started_at TIMESTAMPTZ, mutation_applied_at TIMESTAMPTZ,
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
      CREATE TABLE ai_sessions (id TEXT PRIMARY KEY, provider TEXT NOT NULL, metadata JSONB);
    `);
      await pglite.query(
        `INSERT INTO host_control_store_identity (singleton, store_id, authority_root)
         VALUES (1, $1, $2)`,
        [`jean-cleanup-${backend}`, authorityDir],
      );
    } else {
      await sqlite!.initialize();
    }
    const durableDb = (pglite
      ? createPgliteStatementAdapter(pglite)
      : createSQLiteStoreAdapter(sqlite!)) as {
      query<T = any>(sql: string, params?: any[]): Promise<{ rows: T[] }>;
      transaction<T = any>(statements: Array<{ sql: string; params?: any[]; expectedRowCount?: number }>): Promise<Array<{ rows: T[] }>>;
    };
    const terminalWriteOwners: string[] = [];
    const attentionObservedOwners: string[] = [];
    const promptCleanupOwners: string[] = [];
    const attentionCleanupOwners: string[] = [];
    const promptPhaseCompletionOwners: string[] = [];
    const attentionPhaseCompletionOwners: string[] = [];
    const ledgerAdapter = {
      query: async <T = any>(sql: string, params?: any[]) => {
        const result = await durableDb.query<T>(sql, params);
        if (
          sql.includes('UPDATE host_control_receipts')
          && sql.includes('SET state = $2')
          && result.rows.length > 0
        ) terminalWriteOwners.push(String(params?.[3]));
        if (
          sql.includes('UPDATE host_control_receipts')
          && sql.includes("SET cleanup_prompt_state = 'complete'")
          && result.rows.length > 0
        ) promptPhaseCompletionOwners.push(String(params?.[1]));
        if (
          sql.includes('UPDATE host_control_receipts')
          && sql.includes("SET cleanup_attention_state = 'complete'")
          && result.rows.length > 0
        ) attentionPhaseCompletionOwners.push(String(params?.[1]));
        if (sql.includes('UPDATE ai_sessions') && result.rows.length > 0) {
          metadata = JSON.parse(String(params?.[1]));
          if (sql.includes('cleanup_prompt_state')) {
            promptCleanupOwners.push(String(params?.[4]));
          }
          if (sql.includes('cleanup_attention_state')) {
            attentionCleanupOwners.push(String(params?.[4]));
          }
        }
        return result;
      },
      transaction: async <T = any>(statements: Array<{ sql: string; params?: any[]; expectedRowCount?: 1 }>) => {
        const results = await durableDb.transaction<T>(statements);
        statements.forEach((statement, index) => {
          if (results[index]?.rows.length === 0) return;
          if (statement.sql.includes("SET cleanup_prompt_state = 'complete'")) {
            promptPhaseCompletionOwners.push(String(statement.params?.[1]));
          }
          if (statement.sql.includes("SET cleanup_attention_state = 'complete'")) {
            attentionPhaseCompletionOwners.push(String(statement.params?.[1]));
          }
          if (statement.sql.includes('UPDATE ai_sessions')) {
            metadata = JSON.parse(String(statement.params?.[1]));
            if (statement.sql.includes('cleanup_prompt_state')) {
              promptCleanupOwners.push(String(statement.params?.[4]));
            }
            if (statement.sql.includes('cleanup_attention_state')) {
              attentionCleanupOwners.push(String(statement.params?.[4]));
            }
          }
        });
        return results;
      },
    };
    const store = createDeterministicReceiptStore(
      ledgerAdapter,
      `jean-cleanup-${backend}`,
      authorityDir,
    );
    const sessionId = 'jean-cleanup-takeover';
    const promptId = 'p1';
    const generation = `${sessionId}:A`;
    const base = Date.now() + 60_000;
    let now = base;
    let owner = 'owner-a';
    let metadata: Record<string, unknown> = {};
    const repositoryGet = vi.spyOn(AISessionsRepository, 'get').mockImplementation(async (id) => (
      id === sessionId ? { id: sessionId, provider: 'claude-code', metadata } as any : null
    ));
    const repositoryUpdate = vi.spyOn(AISessionsRepository, 'updateMetadata')
      .mockImplementation(async (_id, patch: any) => {
        metadata = { ...metadata, ...(patch?.metadata ?? patch) };
      });
    const stateManager = getSessionStateManager();
    stateManager.setDatabase({ query: vi.fn(async () => ({ rows: [] })) } as any);
    await stateManager.startSession({
      sessionId,
      workspacePath: 'D:\\workspace',
      initialStatus: 'waiting_for_input',
      attentionGeneration: generation,
    });
    await setSessionPendingPrompt(sessionId, true, { promptId, generation });
    metadata.attentionEvents = [{
      id: 'event-occurrence-a', sessionId, promptId,
      attentionGeneration: generation, kind: 'interactive_prompt',
      promptType: 'AskUserQuestion', context: { questions: [{ question: 'Question?' }] },
      severity: 'normal', deadline: null, dedupeKey: 'interactive:AskUserQuestion:p1',
      status: 'pending', armedAt: new Date().toISOString(), doNotDisturb: false,
      immediateReceipt: {
        requested: true, attempted: false, skippedReason: 'pending', recordedAt: new Date().toISOString(),
      },
      dedupeCount: 0,
    }];
    await durableDb.query('INSERT INTO ai_sessions(id, provider, metadata) VALUES ($1, $2, $3)', [
      sessionId,
      'claude-code',
      JSON.stringify(metadata),
    ]);
    createPGLiteSessionStore(ledgerAdapter as any);

    const native = {
      resolveAskUserQuestion: vi.fn((...args: any[]) => ({
        outcome: 'acknowledged', authority: args[4],
      })),
    };
    const providerSpy = vi.spyOn(ProviderFactory, 'getProvider').mockReturnValue(native as any);
    const attentionSpy = vi.spyOn(attentionEventService, 'cancelInteractivePrompt');
    (ipcMain as any).listenerCount = vi.fn(() => 0);
    databaseQuery.mockResolvedValue({ rows: [] });

    const atCleanupGap = boundedBarrier(`jean_cleanup_gap:${pausePoint}`);
    const resumeOldOwner = boundedBarrier('jean_old_owner_resume');
    const finalizeReceipt = vi.fn((input: any) => store.finalizeReceipt(input));
    const deps: AttentionReplyDependencies = {
      getPendingInteractiveEvent: (id, identity) => (
        attentionEventService.getPendingInteractiveEvent(id, identity)
      ),
      reserveReceipt: (input) => store.reserveReceipt(input),
      finalizeReceipt,
      respondToInteractivePrompt: (params) => (
        AIService.prototype.respondToInteractivePrompt.call({} as AIService, params)
      ),
      now: () => now,
      createReservationOwner: () => owner,
      reservationLeaseMs: 30_000,
      onJeanReconciliationPoint: async (point) => {
        if (point === 'after_jean_attention_cleanup_completed') attentionObservedOwners.push(owner);
        if (point === pausePoint && owner === 'owner-a') {
          atCleanupGap.release();
          await resumeOldOwner.promise;
        }
      },
    };
    const request = {
      watchId: 'watch-cleanup', sessionId, promptId,
      attentionGeneration: generation,
      promptType: 'ask_user_question_request' as const,
      answer: 'A answer',
    };

    let oldOwner: Promise<Awaited<ReturnType<typeof handleInjectAttentionReply>>> | undefined;
    try {
      oldOwner = handleInjectAttentionReply(deps, request);
      await waitForBarrierOrOwner(
        atCleanupGap,
        oldOwner,
        `jean_cleanup_gap:${backend}:${pausePoint}`,
      );
      expect(native.resolveAskUserQuestion).toHaveBeenCalledOnce();
      if (pausePoint === 'after_jean_prompt_cleanup_completed') {
        expect(attentionSpy).not.toHaveBeenCalled();
      } else {
        expect(attentionSpy).toHaveBeenCalledOnce();
      }
      const updatesBeforeCleanup = repositoryUpdate.mock.calls.length;

      await durableDb.query(
        `UPDATE host_control_receipts SET lease_expires_at = NOW()
         WHERE reservation_key = 'attention-reply:watch-cleanup'`,
      );
      now = base + 120_000;
      owner = 'owner-b';
      const reconciled = await handleInjectAttentionReply(deps, request);
      resumeOldOwner.release();
      const staleOwnerResult = await oldOwner;
      const replay = await handleInjectAttentionReply(deps, request);

      expect(reconciled).toEqual({
        status: 200,
        receipt: {
          outcome: 'injected',
          verified: true,
          receipt: {
            route: 'host-attention-answer',
            event_cleared: true,
          },
        },
      });
      expect(staleOwnerResult).toEqual(reconciled);
      expect(replay).toEqual(reconciled);
      expect(native.resolveAskUserQuestion).toHaveBeenCalledOnce();
      expect(attentionSpy).toHaveBeenCalledOnce();
      expect(repositoryUpdate.mock.calls.length - updatesBeforeCleanup).toBe(0);
      expect(metadata).toMatchObject({ hasPendingPrompt: false });
      expect(await store.getByReservationKey('attention-reply:watch-cleanup')).toMatchObject({
        state: 'injected', mutationState: 'applied', mutationFence: 2,
        cleanupAttentionResult: 'settled',
        reservationOwner: undefined, leaseExpiresAt: undefined,
      });
      expect(finalizeReceipt).toHaveBeenCalledTimes(2);
      expect(terminalWriteOwners).toEqual(['owner-b']);
      expect(promptCleanupOwners).toEqual(['owner-a']);
      expect(promptPhaseCompletionOwners).toEqual(['owner-a']);
      expect(attentionCleanupOwners).toEqual([
        pausePoint === 'after_jean_prompt_cleanup_completed' ? 'owner-b' : 'owner-a',
      ]);
      expect(attentionPhaseCompletionOwners).toEqual([
        pausePoint === 'after_jean_prompt_cleanup_completed' ? 'owner-b' : 'owner-a',
      ]);
      expect(attentionObservedOwners).toEqual(['owner-b']);
      expect(databaseQuery.mock.calls.some(([sql]) => (
        typeof sql === 'string' && sql.includes('native_winner_outbox')
      ))).toBe(false);
    } finally {
      resumeOldOwner.release();
      atCleanupGap.dispose();
      resumeOldOwner.dispose();
      if (oldOwner) await oldOwner.catch(() => undefined);
      repositoryGet.mockRestore();
      repositoryUpdate.mockRestore();
      providerSpy.mockRestore();
      attentionSpy.mockRestore();
      databaseQuery.mockReset();
      if (pglite) await pglite.close();
      if (sqlite) await sqlite.close();
      if (sqliteDir) fs.rmSync(sqliteDir, { recursive: true, force: true });
      fs.rmSync(authorityDir, { recursive: true, force: true });
    }
  });

  it.each([
    ['permission_request', { decision: 'allow', scope: 'once' }],
    ['exit_plan_mode_request', { approved: true, clearContext: true }],
  ] as const)(
    'records an exact provider miss as not_applied for %s and leaves A pending',
    async (promptType, response) => {
      const sessionId = `jean-miss-${promptType}`;
      const promptId = 'p1';
      const generation = `${sessionId}:A`;
      let metadata: Record<string, unknown> = { mode: 'plan' };
      const repositoryGet = vi.spyOn(AISessionsRepository, 'get').mockImplementation(async (id) => (
        id === sessionId ? { id: sessionId, provider: 'claude-code', metadata } as any : null
      ));
      const repositoryUpdate = vi.spyOn(AISessionsRepository, 'updateMetadata')
        .mockImplementation(async (_id, patch: any) => {
          metadata = { ...metadata, ...(patch?.metadata ?? patch) };
        });
      const stateManager = getSessionStateManager();
      stateManager.setDatabase({ query: vi.fn(async () => ({ rows: [] })) } as any);
      await stateManager.startSession({
        sessionId,
        workspacePath: 'D:\\workspace',
        initialStatus: 'waiting_for_input',
        attentionGeneration: generation,
      });
      await setSessionPendingPrompt(sessionId, true, { promptId, generation });
      const native = {
        resolveToolPermission: vi.fn((...args: any[]) => ({
          outcome: 'not_found', authority: args[4],
        })),
        resolveExitPlanModeConfirmation: vi.fn((...args: any[]) => ({
          outcome: 'not_found', authority: args[4],
        })),
      };
      const providerSpy = vi.spyOn(ProviderFactory, 'getProvider').mockReturnValue(native as any);
      const attentionSpy = vi.spyOn(attentionEventService, 'cancelInteractivePrompt')
        .mockResolvedValue({ attentionCancelledCount: 1, attentionResult: 'settled' } as any);
      const mutationAuthority = {
        mutationId: `${sessionId}:mutation`,
        mutationFence: 1,
        attentionGeneration: generation,
        promptOccurrence: promptId,
        answerDigest: 'e'.repeat(64),
      };

      const result = await AIService.prototype.respondToInteractivePrompt.call({} as AIService, {
        sessionId,
        promptId,
        promptType,
        response,
        respondedBy: promptType === 'exit_plan_mode_request' ? 'desktop' : 'telegram',
        expectedAttentionGeneration: generation,
        expectedPromptIdentity: promptId,
        mutationAuthority,
        assertMutationFence: async () => true,
      });
      expect(result).toMatchObject({
        success: false,
        nativeCertainty: 'not_applied',
        nativeEntered: false,
        cleanupVerified: false,
      });
      expect(attentionSpy).not.toHaveBeenCalled();
      expect(metadata).toMatchObject({ hasPendingPrompt: true, pendingPromptGeneration: generation });
      if (promptType === 'exit_plan_mode_request') expect(metadata.mode).toBe('plan');

      repositoryGet.mockRestore();
      repositoryUpdate.mockRestore();
      providerSpy.mockRestore();
      attentionSpy.mockRestore();
      databaseQuery.mockReset();
    },
  );
});
