import { describe, expect, it, vi, type Mock } from 'vitest';
import { PGlite } from '@electric-sql/pglite';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  handleInjectAttentionReply,
  type AttentionEventLike,
  type AttentionReplyDependencies,
  type InjectAttentionReplyRequest,
} from '../AttentionReplyInjectionService';
import type {
  HostControlReceiptMutationAuthority,
  HostControlReceiptRow,
} from '../HostControlReceiptsStore';
import { createHostControlReceiptsStore } from '../HostControlReceiptsStore';

const questionText = 'Which deployment ring?';
const validRequest: InjectAttentionReplyRequest = {
  watchId: 'watch-1',
  sessionId: 'session-1',
  promptId: 'prompt-1',
  attentionGeneration: 'generation-1',
  promptType: 'ask_user_question_request',
  answer: 'Canary',
};

const validEvent: AttentionEventLike = {
  id: 'event-1',
  sessionId: 'session-1',
  promptId: 'prompt-1',
  attentionGeneration: 'generation-1',
  kind: 'interactive_prompt',
  promptType: 'AskUserQuestion',
  context: { questions: [{ question: questionText }] },
  status: 'pending',
};

function row(overrides: Partial<HostControlReceiptRow> = {}): HostControlReceiptRow {
  return {
    id: 'receipt-1',
    reservationKey: 'attention-reply:watch-1',
    requestDigest: 'digest',
    operation: 'inject_attention_reply',
    sessionId: 'session-1',
    eventIdentity: 'prompt-1',
    attentionGeneration: 'generation-1',
    state: 'reserved',
    reservationOwner: 'owner-1',
    leaseExpiresAt: Date.parse('2026-07-20T10:00:30.000Z'),
    mutationId: 'mutation-1',
    mutationFence: 1,
    mutationState: 'not_started',
    createdAt: 1,
    updatedAt: 1,
    ...overrides,
  };
}

function testMutationAuthority(
  begin: HostControlReceiptMutationAuthority['begin'],
  recordApplied: HostControlReceiptMutationAuthority['recordApplied'],
  verify = true,
  verifyCleanup = true,
): HostControlReceiptMutationAuthority {
  return {
    begin,
    recordApplied,
    verify: vi.fn(async () => verify),
    verifyCleanup: vi.fn(async () => verifyCleanup),
    enterNative: async <T>(_generation: string, action: () => Promise<T>) => ({
      owned: true as const,
      value: await action(),
    }),
    claimCleanupStep: vi.fn(async () => ({ status: 'claimed' as const })),
    metadataCleanupAuthority: vi.fn((step, attentionGeneration) => ({
      receiptId: 'receipt-1',
      reservationOwner: 'owner-1',
      mutationId: 'mutation-1',
      mutationFence: 1,
      attentionGeneration,
      step,
    })),
  };
}

type TestAttentionReplyDependencies = Omit<
  AttentionReplyDependencies,
  'getPendingInteractiveEvent' | 'respondToInteractivePrompt' | 'reserveReceipt' | 'finalizeReceipt'
> & {
  getPendingInteractiveEvent: Mock<AttentionReplyDependencies['getPendingInteractiveEvent']>;
  respondToInteractivePrompt: Mock<AttentionReplyDependencies['respondToInteractivePrompt']>;
  reserveReceipt: Mock<AttentionReplyDependencies['reserveReceipt']>;
  finalizeReceipt: Mock<AttentionReplyDependencies['finalizeReceipt']>;
  beginMutation: Mock<HostControlReceiptMutationAuthority['begin']>;
  recordMutation: Mock<HostControlReceiptMutationAuthority['recordApplied']>;
};

function makeDeps(event: AttentionEventLike | null = validEvent): TestAttentionReplyDependencies {
  const beginMutation = vi.fn<HostControlReceiptMutationAuthority['begin']>(async (_now, generation) => ({
    started: true,
    row: row({ mutationState: 'unknown', attentionGeneration: generation }),
  }));
  const recordMutation = vi.fn<HostControlReceiptMutationAuthority['recordApplied']>(async (
    certainty,
    receipt,
  ) => row({
    mutationState: certainty,
    mutationReceipt: receipt,
  }));
  return {
    getPendingInteractiveEvent: vi.fn<AttentionReplyDependencies['getPendingInteractiveEvent']>(async () => event),
    respondToInteractivePrompt: vi.fn<AttentionReplyDependencies['respondToInteractivePrompt']>(async () => ({
      success: true,
      attentionCancelledCount: 1,
      eventCleared: true,
      nativeCertainty: 'applied' as const,
      nativeEntered: true,
      cleanupVerified: true,
    })),
    reserveReceipt: vi.fn<AttentionReplyDependencies['reserveReceipt']>(async (input) => ({
      row: row({
        reservationKey: input.reservationKey,
        requestDigest: input.requestDigest,
      }),
      isNewReservation: true,
      status: 'new' as const,
      mutationAuthority: testMutationAuthority(beginMutation, recordMutation),
    })),
    finalizeReceipt: vi.fn<AttentionReplyDependencies['finalizeReceipt']>(async (input) => row({
      state: input.state,
      receipt: input.receipt,
    })),
    now: vi.fn(() => Date.parse('2026-07-20T10:00:00.000Z')),
    createReservationOwner: vi.fn(() => 'owner-1'),
    beginMutation,
    recordMutation,
  };
}

describe('handleInjectAttentionReply', () => {
  it.each([
    ['missing watch', { ...validRequest, watchId: '' }],
    ['missing identity', { ...validRequest, promptId: undefined }],
    ['mismatched dual identity', { ...validRequest, toolUseId: 'other' }],
    ['oversized generation', { ...validRequest, attentionGeneration: 'x'.repeat(301) }],
    ['missing answer', { ...validRequest, answer: undefined }],
  ])('rejects %s before reservation or lookup', async (_name, request) => {
    const deps = makeDeps();
    const result = await handleInjectAttentionReply(deps, request as InjectAttentionReplyRequest);

    expect(result).toEqual({
      status: 400,
      receipt: { outcome: 'failed', verified: false, errorClass: 'invalid_request' },
    });
    expect(deps.reserveReceipt).not.toHaveBeenCalled();
    expect(deps.getPendingInteractiveEvent).not.toHaveBeenCalled();
    expect(deps.respondToInteractivePrompt).not.toHaveBeenCalled();
  });

  it('reserves before lookup and native mutation', async () => {
    const deps = makeDeps();

    await handleInjectAttentionReply(deps, validRequest);

    expect(deps.reserveReceipt.mock.invocationCallOrder[0])
      .toBeLessThan(deps.getPendingInteractiveEvent.mock.invocationCallOrder[0]);
    expect(deps.getPendingInteractiveEvent.mock.invocationCallOrder[0])
      .toBeLessThan(deps.respondToInteractivePrompt.mock.invocationCallOrder[0]);
  });

  it('terminalizes a generationless legacy request without event lookup or native mutation', async () => {
    const deps = makeDeps();
    const result = await handleInjectAttentionReply(deps, {
      ...validRequest,
      attentionGeneration: undefined,
    });

    expect(result).toMatchObject({ status: 200, receipt: { outcome: 'already_resolved' } });
    expect(deps.reserveReceipt).toHaveBeenCalledOnce();
    expect(deps.getPendingInteractiveEvent).not.toHaveBeenCalled();
    expect(deps.respondToInteractivePrompt).not.toHaveBeenCalled();
  });

  it('returns a bounded conflict for a different digest under the same watch key', async () => {
    const seen = new Map<string, string>();
    const deps = makeDeps();
    deps.reserveReceipt.mockImplementation(async (input) => {
      const prior = seen.get(input.reservationKey);
      if (prior && prior !== input.requestDigest) throw new Error('idempotency_conflict');
      seen.set(input.reservationKey, input.requestDigest);
      return {
        row: row({ requestDigest: input.requestDigest }),
        isNewReservation: !prior,
        status: prior ? 'busy' as const : 'new' as const,
        mutationAuthority: testMutationAuthority(deps.beginMutation, deps.recordMutation),
      };
    });

    await handleInjectAttentionReply(deps, validRequest);
    const result = await handleInjectAttentionReply(deps, {
      ...validRequest,
      answer: 'Production',
    });

    expect(result).toEqual({
      status: 409,
      receipt: { outcome: 'failed', verified: false, errorClass: 'idempotency_conflict' },
    });
    expect(JSON.stringify(result)).not.toContain('Production');
  });

  it.each([
    ['missing event', null],
    ['session mismatch', { ...validEvent, sessionId: 'session-2' }],
    ['identity mismatch', { ...validEvent, promptId: 'prompt-2' }],
    ['generation mismatch', { ...validEvent, attentionGeneration: 'generation-2' }],
  ])('fails closed as already_resolved for %s', async (_name, event) => {
    const deps = makeDeps(event as AttentionEventLike | null);
    const result = await handleInjectAttentionReply(deps, validRequest);

    expect(result).toEqual({
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
    expect(deps.respondToInteractivePrompt).not.toHaveBeenCalled();
  });

  it('fails closed for free text against persisted multi-question context', async () => {
    const deps = makeDeps({
      ...validEvent,
      context: {
        questions: [
          { question: 'First secret question?' },
          { question: 'Second secret question?' },
        ],
      },
    });
    const result = await handleInjectAttentionReply(deps, validRequest);

    expect(result).toEqual({
      status: 422,
      receipt: {
        outcome: 'failed',
        verified: false,
        errorClass: 'ambiguous_or_incomplete_answer',
      },
    });
    expect(deps.respondToInteractivePrompt).not.toHaveBeenCalled();
    expect(JSON.stringify(result)).not.toContain('secret question');
  });

  it('accepts only a complete structured answer for persisted multi-question context', async () => {
    const deps = makeDeps({
      ...validEvent,
      context: { questions: [{ question: 'First?' }, { question: 'Second?' }] },
    });
    const result = await handleInjectAttentionReply(deps, {
      ...validRequest,
      answer: { answers: { 'First?': 'One', 'Second?': 'Two' } },
    });

    expect(result.status).toBe(200);
    expect(deps.respondToInteractivePrompt).toHaveBeenCalledWith(
      expect.objectContaining({
        response: {
          answers: { 'First?': 'One', 'Second?': 'Two' },
          cancelled: false,
        },
      }),
    );
  });

  it.each(['yes', 'allow', true, { decision: 'allow' }])(
    'never grants a non-allowlisted permission token (%j)',
    async (answer) => {
      const deps = makeDeps({
        ...validEvent,
        toolUseId: 'permission-1',
        promptId: undefined,
        promptType: 'ToolPermission',
      });
      const result = await handleInjectAttentionReply(deps, {
        watchId: 'watch-permission',
        sessionId: 'session-1',
        toolUseId: 'permission-1',
        promptType: 'permission_request',
        answer,
      });

      expect(result.status).toBe(400);
      expect(deps.respondToInteractivePrompt).not.toHaveBeenCalled();
    },
  );

  it.each([
    [
      'permission approve',
      'permission_request' as const,
      'ToolPermission',
      'approve',
      { decision: 'allow', scope: 'once', cancelled: false },
    ],
    [
      'permission deny',
      'permission_request' as const,
      'ToolPermission',
      'deny',
      { decision: 'deny', scope: 'once', cancelled: false },
    ],
    [
      'plan approve',
      'exit_plan_mode_request' as const,
      'ExitPlanMode',
      'approve',
      { approved: true, clearContext: true },
    ],
    [
      'plan deny',
      'exit_plan_mode_request' as const,
      'ExitPlanMode',
      'deny',
      { approved: false, clearContext: false },
    ],
  ])('maps the exact allowlist token for %s', async (
    _name,
    promptType,
    eventPromptType,
    answer,
    expectedResponse,
  ) => {
    const deps = makeDeps({
      ...validEvent,
      promptType: eventPromptType,
    });
    const result = await handleInjectAttentionReply(deps, {
      ...validRequest,
      promptType,
      answer,
    });

    expect(result.status).toBe(200);
    expect(deps.respondToInteractivePrompt).toHaveBeenCalledWith(
      expect.objectContaining({ promptType, response: expectedResponse, respondedBy: 'telegram' }),
    );
  });

  it('produces the exact success contract and a telegram native response', async () => {
    const deps = makeDeps();
    const result = await handleInjectAttentionReply(deps, validRequest);

    expect(result).toEqual({
      status: 200,
      receipt: {
        outcome: 'injected',
        verified: true,
        receipt: { route: 'host-attention-answer', event_cleared: true },
      },
    });
    expect(deps.respondToInteractivePrompt).toHaveBeenCalledWith(expect.objectContaining({
      sessionId: 'session-1',
      promptId: 'prompt-1',
      promptType: 'ask_user_question_request',
      response: { answers: { [questionText]: 'Canary' }, cancelled: false },
      respondedBy: 'telegram',
      expectedAttentionGeneration: 'generation-1',
      expectedPromptIdentity: 'prompt-1',
      onNativeMutationApplied: expect.any(Function),
    }));
  });

  it('returns only the exact durable row won by finalization', async () => {
    const deps = makeDeps();
    const persistedWinner = {
      outcome: 'already_resolved',
      verified: true,
      receipt: {
        route: 'host-attention-answer',
        event_cleared: false,
        event_not_current: true,
      },
    };
    deps.finalizeReceipt.mockResolvedValueOnce(row({
      state: 'already_resolved',
      receipt: persistedWinner,
    }));

    await expect(handleInjectAttentionReply(deps, validRequest)).resolves.toEqual({
      status: 200,
      receipt: persistedWinner,
    });
  });

  it('maps an atomically stale native response to verified already_resolved', async () => {
    const deps = makeDeps();
    deps.respondToInteractivePrompt.mockResolvedValue({
      success: false,
      staleAction: true,
      nativeCertainty: 'not_applied',
      nativeEntered: false,
      cleanupVerified: false,
    });

    const result = await handleInjectAttentionReply(deps, validRequest);

    expect(result.receipt).toEqual({
      outcome: 'already_resolved',
      verified: true,
      receipt: {
        route: 'host-attention-answer',
        event_cleared: false,
        event_not_current: true,
      },
    });
  });

  it('reconciles an expired unknown-outcome row without a second native mutation', async () => {
    const deps = makeDeps();
    deps.reserveReceipt.mockResolvedValueOnce({
      row: row({
        reservationOwner: 'owner-1',
        mutationState: 'unknown',
        mutationStartedAt: Date.parse('2026-07-20T09:59:00.000Z'),
      }),
      isNewReservation: false,
      status: 'taken_over',
      mutationAuthority: testMutationAuthority(deps.beginMutation, deps.recordMutation),
    });

    const result = await handleInjectAttentionReply(deps, validRequest);

    expect(result).toEqual({
      status: 500,
      receipt: {
        outcome: 'failed',
        verified: false,
        errorClass: 'mutation_outcome_unconfirmed',
      },
    });
    expect(deps.getPendingInteractiveEvent).not.toHaveBeenCalled();
    expect(deps.respondToInteractivePrompt).not.toHaveBeenCalled();
    expect(deps.finalizeReceipt).toHaveBeenCalledOnce();
  });

  it('reconstructs an applied mutation receipt after owner loss without answering again', async () => {
    const deps = makeDeps();
    const injectedReceipt = {
      outcome: 'injected',
      verified: true,
      receipt: { route: 'host-attention-answer', event_cleared: true },
    };
    deps.reserveReceipt.mockResolvedValueOnce({
      row: row({
        reservationOwner: 'owner-1',
        mutationState: 'applied',
        mutationReceipt: { state: 'injected', status: 200, receipt: injectedReceipt },
      }),
      isNewReservation: false,
      status: 'taken_over',
      mutationAuthority: testMutationAuthority(deps.beginMutation, deps.recordMutation),
    });

    const result = await handleInjectAttentionReply(deps, validRequest);

    expect(result).toEqual({ status: 200, receipt: injectedReceipt });
    expect(deps.respondToInteractivePrompt).not.toHaveBeenCalled();
    expect(deps.finalizeReceipt).toHaveBeenCalledWith(expect.objectContaining({
      state: 'injected',
      reservationOwner: 'owner-1',
    }));
  });

  it('replays an applied fact through cleanup-only reconciliation without a second native answer', async () => {
    const deps = makeDeps();
    deps.reserveReceipt.mockResolvedValueOnce({
      row: row({
        mutationState: 'applied',
        mutationReceipt: {
          nativeCertainty: 'applied',
          nativeEntered: true,
          cleanupVerified: false,
          success: true,
        },
      }),
      isNewReservation: false,
      status: 'reconcile',
      mutationAuthority: testMutationAuthority(
        deps.beginMutation,
        deps.recordMutation,
        false,
        true,
      ),
    });

    const result = await handleInjectAttentionReply(deps, validRequest);

    expect(result).toEqual({
      status: 200,
      receipt: {
        outcome: 'injected',
        verified: true,
        receipt: { route: 'host-attention-answer', event_cleared: true },
      },
    });
    expect(deps.beginMutation).not.toHaveBeenCalled();
    expect(deps.respondToInteractivePrompt).toHaveBeenCalledOnce();
    expect(deps.respondToInteractivePrompt).toHaveBeenCalledWith(expect.objectContaining({
      reconcileAppliedOnly: true,
      assertMutationFence: undefined,
      assertCleanupFence: expect.any(Function),
      onNativeMutationApplied: undefined,
    }));
  });

  it('does not misclassify lost applied-cleanup authority as already_resolved', async () => {
    const deps = makeDeps();
    deps.reserveReceipt.mockResolvedValueOnce({
      row: row({
        mutationState: 'applied',
        mutationReceipt: {
          nativeCertainty: 'applied',
          nativeEntered: true,
          cleanupVerified: false,
        },
      }),
      isNewReservation: false,
      status: 'reconcile',
      mutationAuthority: testMutationAuthority(
        deps.beginMutation,
        deps.recordMutation,
        false,
        false,
      ),
    });
    deps.respondToInteractivePrompt.mockResolvedValueOnce({
      success: false,
      staleAction: true,
      nativeCertainty: 'applied',
      nativeEntered: true,
      cleanupVerified: false,
    });

    const result = await handleInjectAttentionReply(deps, validRequest);

    expect(result).toEqual({
      status: 500,
      receipt: {
        outcome: 'failed',
        verified: false,
        errorClass: 'mutation_cleanup_incomplete',
      },
    });
    expect(result.receipt).not.toMatchObject({ outcome: 'already_resolved' });
  });

  it('routes event-absent applied recovery through cleanup-only AIService instead of terminalizing early', async () => {
    const deps = makeDeps(null);
    deps.respondToInteractivePrompt.mockResolvedValueOnce({
      success: true,
      attentionCancelledCount: 0,
      eventCleared: false,
      nativeCertainty: 'applied',
      nativeEntered: true,
      cleanupVerified: true,
    });
    deps.reserveReceipt.mockResolvedValueOnce({
      row: row({
        mutationState: 'applied',
        mutationReceipt: {
          nativeCertainty: 'applied',
          nativeEntered: true,
          cleanupVerified: false,
        },
      }),
      isNewReservation: false,
      status: 'reconcile',
      mutationAuthority: testMutationAuthority(deps.beginMutation, deps.recordMutation),
    });

    const result = await handleInjectAttentionReply(deps, validRequest);

    expect(deps.respondToInteractivePrompt).toHaveBeenCalledOnce();
    expect(deps.respondToInteractivePrompt).toHaveBeenCalledWith(expect.objectContaining({
      promptId: 'prompt-1',
      expectedAttentionGeneration: 'generation-1',
      expectedPromptIdentity: 'prompt-1',
      reconcileAppliedOnly: true,
      onNativeMutationApplied: undefined,
    }));
    expect(result).toEqual({
      status: 200,
      receipt: {
        outcome: 'injected',
        verified: true,
        receipt: {
          route: 'host-attention-answer', event_cleared: false, event_not_current: true,
        },
      },
    });
  });

  it('takes over a real durable reserved row after process loss and terminalizes replacement B once', async () => {
    const db = new PGlite();
    const authorityDir = fs.mkdtempSync(path.join(os.tmpdir(), 'jean-real-ledger-authority-'));
    await (db as unknown as { waitReady: Promise<void> }).waitReady;
    try {
      await db.exec(`
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
      `);
      await db.query(
        `INSERT INTO host_control_store_identity (singleton, store_id, authority_root)
         VALUES (1, $1, $2)`,
        ['jean-real-ledger', authorityDir],
      );
      const store = createHostControlReceiptsStore(db);
      let now = Date.now() + 60_000;
      const owner1Deps = makeDeps();
      owner1Deps.reserveReceipt.mockImplementation(async (input) => {
        const reserved = await store.reserveReceipt(input);
        await reserved.mutationAuthority!.begin(new Date(now), 'generation-1');
        throw new Error('simulated_process_loss');
      });
      owner1Deps.finalizeReceipt.mockImplementation((input) => store.finalizeReceipt(input));
      owner1Deps.createReservationOwner = () => 'owner-1';
      owner1Deps.now = () => now;
      await expect(handleInjectAttentionReply(owner1Deps, validRequest))
        .resolves.toMatchObject({ status: 500 });

      const stranded = await store.getByReservationKey('attention-reply:watch-1');
      expect(stranded).toMatchObject({
        state: 'reserved',
        reservationOwner: 'owner-1',
        mutationState: 'unknown',
        mutationFence: 1,
      });

      await db.query(
        `UPDATE host_control_receipts SET lease_expires_at = NOW()
         WHERE reservation_key = 'attention-reply:watch-1'`,
      );
      now += 120_000;
      const owner2Deps = makeDeps({ ...validEvent, attentionGeneration: 'generation-b' });
      owner2Deps.reserveReceipt.mockImplementation((input) => store.reserveReceipt(input));
      owner2Deps.finalizeReceipt.mockImplementation((input) => store.finalizeReceipt(input));
      owner2Deps.createReservationOwner = () => 'owner-2';
      owner2Deps.now = () => now;
      const reconciled = await handleInjectAttentionReply(owner2Deps, validRequest);
      const replay = await handleInjectAttentionReply(owner2Deps, validRequest);

      expect(reconciled).toEqual(replay);
      expect(reconciled).toMatchObject({
        status: 500,
        receipt: { outcome: 'failed', errorClass: 'mutation_outcome_unconfirmed' },
      });
      expect(owner2Deps.respondToInteractivePrompt).not.toHaveBeenCalled();
      expect(await store.getByReservationKey('attention-reply:watch-1')).toMatchObject({
        state: 'failed',
        reservationOwner: undefined,
        leaseExpiresAt: undefined,
        mutationFence: 2,
      });
    } finally {
      await db.close();
      fs.rmSync(authorityDir, { recursive: true, force: true });
    }
  });

  it('does not expose answer or question text in failed receipts or errors', async () => {
    const secretAnswer = 'ANSWER-TEXT-DO-NOT-STORE';
    const secretQuestion = 'QUESTION-TEXT-DO-NOT-STORE';
    const deps = makeDeps({
      ...validEvent,
      context: { questions: [{ question: secretQuestion }, { question: 'second' }] },
    });

    const result = await handleInjectAttentionReply(deps, {
      ...validRequest,
      answer: secretAnswer,
    });

    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain(secretAnswer);
    expect(serialized).not.toContain(secretQuestion);
  });
});
