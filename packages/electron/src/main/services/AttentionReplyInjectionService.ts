import { createHash, randomUUID } from 'crypto';
import type {
  HostControlReceiptReservation,
  HostControlReceiptMutationAuthority,
  HostControlReceiptRow,
  HostControlReceiptState,
} from './HostControlReceiptsStore';

export type AttentionReplyPromptType =
  | 'permission_request'
  | 'ask_user_question_request'
  | 'exit_plan_mode_request';

export interface InjectAttentionReplyRequest {
  watchId: string;
  sessionId: string;
  promptId?: string;
  toolUseId?: string;
  attentionGeneration?: string;
  promptType: AttentionReplyPromptType;
  answer: unknown;
}

export interface AttentionEventLike {
  id: string;
  sessionId: string;
  promptId?: string;
  toolUseId?: string;
  attentionGeneration?: string;
  kind: 'generic' | 'interactive_prompt';
  promptType?: string;
  context?: unknown;
  status: 'pending' | 'cancelled';
}

export interface AttentionReplyDependencies {
  getPendingInteractiveEvent(
    sessionId: string,
    identity: string,
  ): Promise<AttentionEventLike | null>;
  respondToInteractivePrompt(params: {
    sessionId: string;
    promptId: string;
    promptType: AttentionReplyPromptType;
    response: unknown;
    respondedBy: 'telegram';
    expectedAttentionGeneration: string;
    expectedPromptIdentity: string;
    mutationAuthority: {
      mutationId: string;
      mutationFence: number;
      attentionGeneration: string;
      promptOccurrence: string;
      answerDigest: string;
    };
    durableMutationAuthority: HostControlReceiptMutationAuthority;
    beforeNativeMutation?: () => Promise<void>;
    beforeNativeEntry?: () => Promise<void>;
    afterNativeApplicationRecorded?: () => Promise<void>;
    afterPromptCleanupCompleted?: () => Promise<void>;
    afterAttentionCleanupCommitted?: () => Promise<void>;
    afterAttentionCleanupCompleted?: () => Promise<void>;
    assertMutationFence?: () => Promise<boolean>;
    assertCleanupFence?: () => Promise<boolean>;
    reconcileAppliedOnly?: boolean;
    onNativeMutationApplied?: (result: AppliedNativeAttentionReplyResult) => Promise<void>;
  }): Promise<{
    success: boolean;
    error?: string;
    promptClear?: unknown;
    staleAction?: boolean;
    attentionCancelledCount?: number;
    eventCleared?: boolean;
    terminalUnconfirmed?: boolean;
    nativeCertainty?: 'not_applied' | 'unknown' | 'applied';
    nativeEntered?: boolean;
    cleanupVerified?: boolean;
  }>;
  reserveReceipt(input: {
    reservationKey: string;
    requestDigest: string;
    operation: 'inject_attention_reply';
    sessionId: string;
    eventIdentity: string;
    attentionGeneration?: string;
    reservationOwner: string;
    now: Date;
    leaseExpiresAt: Date;
  }): Promise<HostControlReceiptReservation>;
  finalizeReceipt(input: {
    id: string;
    reservationKey: string;
    reservationOwner: string;
    mutationId: string;
    mutationFence: number;
    state: Exclude<HostControlReceiptState, 'reserved'>;
    receipt: Record<string, unknown>;
    now: Date;
  }): Promise<HostControlReceiptRow>;
  now?: () => number;
  createReservationOwner?: () => string;
  reservationLeaseMs?: number;
  onJeanReconciliationPoint?: (
    point:
      | 'before_jean_native_mutation'
      | 'after_jean_fence_verified'
      | 'after_jean_application_recorded'
      | 'after_jean_prompt_cleanup_completed'
      | 'after_jean_attention_metadata_committed'
      | 'after_jean_attention_cleanup_completed',
  ) => Promise<void> | void;
}

export interface NativeAttentionReplyResult {
  success: boolean;
  error?: string;
  promptClear?: unknown;
  staleAction?: boolean;
  attentionCancelledCount?: number;
  eventCleared?: boolean;
  terminalUnconfirmed?: boolean;
  nativeCertainty?: 'not_applied' | 'unknown' | 'applied';
  nativeEntered?: boolean;
  cleanupVerified?: boolean;
}

export interface AppliedNativeAttentionReplyResult extends NativeAttentionReplyResult {
  nativeCertainty: 'applied';
  nativeEntered: true;
  cleanupVerified: false;
}

export interface AttentionReplyResult {
  status: number;
  receipt: Record<string, unknown>;
}

const IDENTITY_MAX_CHARS = 512;
const SESSION_MAX_CHARS = 200;
const PROMPT_ID_MAX_CHARS = 300;
const ANSWER_MAX_CHARS = 2_000;
const MAX_STRUCTURED_ANSWERS = 32;
const DEFAULT_RESERVATION_LEASE_MS = 30_000;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function boundedString(value: unknown, maxChars: number): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed.length > 0 && value.length <= maxChars ? trimmed : null;
}

function failure(status: number, errorClass: string): AttentionReplyResult {
  return {
    status,
    receipt: { outcome: 'failed', verified: false, errorClass },
  };
}

function success(
  outcome: 'injected' | 'already_resolved',
  eventCleared = outcome === 'injected',
): Record<string, unknown> {
  return {
    outcome,
    verified: true,
    receipt: {
      route: 'host-attention-answer',
      event_cleared: eventCleared,
      ...(!eventCleared ? { event_not_current: true } : {}),
    },
  };
}

function stableValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableValue);
  if (isRecord(value)) {
    return Object.fromEntries(
      Object.keys(value).sort().map((key) => [key, stableValue(value[key])]),
    );
  }
  return value;
}

function sha256(value: unknown): string {
  return createHash('sha256')
    .update(JSON.stringify(stableValue(value)))
    .digest('hex');
}

type PrevalidatedAnswer =
  | { kind: 'free_text'; value: string }
  | { kind: 'structured'; value: Record<string, string> }
  | { kind: 'decision'; value: 'approve' | 'deny' };

function prevalidateAnswer(
  promptType: AttentionReplyPromptType,
  answer: unknown,
): PrevalidatedAnswer | null {
  if (promptType === 'permission_request' || promptType === 'exit_plan_mode_request') {
    return answer === 'approve' || answer === 'deny'
      ? { kind: 'decision', value: answer }
      : null;
  }

  const text = boundedString(answer, ANSWER_MAX_CHARS);
  if (text) return { kind: 'free_text', value: text };
  if (!isRecord(answer)) return null;
  const rawAnswers = isRecord(answer.answers) ? answer.answers : answer;
  const entries = Object.entries(rawAnswers);
  if (entries.length === 0 || entries.length > MAX_STRUCTURED_ANSWERS) return null;
  const normalized: Record<string, string> = {};
  for (const [key, value] of entries) {
    const boundedKey = boundedString(key, ANSWER_MAX_CHARS);
    const boundedValue = boundedString(value, ANSWER_MAX_CHARS);
    if (!boundedKey || !boundedValue) return null;
    normalized[boundedKey] = boundedValue;
  }
  return { kind: 'structured', value: normalized };
}

function persistedQuestions(context: unknown): Array<Record<string, unknown>> | null {
  if (!isRecord(context) || !Array.isArray(context.questions)) return null;
  if (context.questions.length === 0 || context.questions.length > MAX_STRUCTURED_ANSWERS) {
    return null;
  }
  const questions = context.questions.filter(isRecord);
  if (questions.length !== context.questions.length) return null;
  if (!questions.every((question) => boundedString(question.question, ANSWER_MAX_CHARS))) {
    return null;
  }
  return questions;
}

function normalizeForEvent(
  promptType: AttentionReplyPromptType,
  answer: PrevalidatedAnswer,
  event: AttentionEventLike,
): unknown | null {
  if (promptType === 'permission_request') {
    if (answer.kind !== 'decision') return null;
    return {
      decision: answer.value === 'approve' ? 'allow' : 'deny',
      scope: 'once',
      cancelled: false,
    };
  }
  if (promptType === 'exit_plan_mode_request') {
    if (answer.kind !== 'decision') return null;
    return answer.value === 'approve'
      ? { approved: true, clearContext: true }
      : { approved: false, clearContext: false };
  }

  const questions = persistedQuestions(event.context);
  if (!questions) return null;
  if (answer.kind === 'free_text') {
    if (questions.length !== 1) return null;
    const questionKey = boundedString(questions[0].question, ANSWER_MAX_CHARS)!;
    return { answers: { [questionKey]: answer.value }, cancelled: false };
  }
  if (answer.kind !== 'structured') return null;
  const expectedKeys = questions.map((question) =>
    boundedString(question.question, ANSWER_MAX_CHARS)!
  );
  const suppliedKeys = Object.keys(answer.value);
  if (
    suppliedKeys.length !== expectedKeys.length
    || expectedKeys.some((key) => !Object.prototype.hasOwnProperty.call(answer.value, key))
  ) {
    return null;
  }
  return { answers: answer.value, cancelled: false };
}

function expectedEventPromptType(promptType: AttentionReplyPromptType): string {
  if (promptType === 'permission_request') return 'ToolPermission';
  if (promptType === 'exit_plan_mode_request') return 'ExitPlanMode';
  return 'AskUserQuestion';
}

function statusForReplay(row: HostControlReceiptRow): number {
  if (row.state === 'injected' || row.state === 'already_resolved') return 200;
  const errorClass = row.receipt?.errorClass;
  return typeof errorClass === 'string' && (
    errorClass === 'internal_error'
    || errorClass === 'event_lookup_failed'
    || errorClass.startsWith('mutation_')
    || errorClass.startsWith('native_')
  ) ? 500 : 422;
}

interface StoredMutationResolution {
  state: Exclude<HostControlReceiptState, 'reserved'>;
  status: number;
  receipt: Record<string, unknown>;
}

function resolutionForNativeResult(
  result: NativeAttentionReplyResult,
): StoredMutationResolution {
  if (result.nativeCertainty === 'unknown' || result.terminalUnconfirmed === true) {
    return {
      state: 'failed',
      status: 500,
      receipt: failure(500, 'native_outcome_unknown').receipt,
    };
  }
  if (result.staleAction === true) {
    if (result.nativeCertainty === 'applied') {
      return {
        state: 'failed',
        status: 500,
        receipt: failure(500, 'mutation_cleanup_incomplete').receipt,
      };
    }
    return { state: 'already_resolved', status: 200, receipt: success('already_resolved') };
  }
  if (
    result.nativeCertainty === 'applied'
    && result.cleanupVerified === true
    && result.success === true
  ) {
    return {
      state: 'injected',
      status: 200,
      receipt: success('injected', result.eventCleared === true),
    };
  }
  return { state: 'failed', status: 422, receipt: failure(422, 'native_response_failed').receipt };
}

function parseStoredMutationResolution(
  value: Record<string, unknown> | undefined,
): StoredMutationResolution | null {
  if (!value || !isRecord(value.receipt)) return null;
  const state = value.state;
  const status = value.status;
  if (
    (state !== 'injected' && state !== 'already_resolved' && state !== 'failed')
    || typeof status !== 'number'
  ) return null;
  return { state, status, receipt: value.receipt };
}

export async function handleInjectAttentionReply(
  deps: AttentionReplyDependencies,
  request: InjectAttentionReplyRequest,
): Promise<AttentionReplyResult> {
  if (!isRecord(request)) return failure(400, 'invalid_request');
  const watchId = boundedString(request.watchId, IDENTITY_MAX_CHARS);
  const sessionId = boundedString(request.sessionId, SESSION_MAX_CHARS);
  const promptId = request.promptId === undefined
    ? undefined
    : boundedString(request.promptId, PROMPT_ID_MAX_CHARS);
  const toolUseId = request.toolUseId === undefined
    ? undefined
    : boundedString(request.toolUseId, PROMPT_ID_MAX_CHARS);
  const attentionGeneration = request.attentionGeneration === undefined
    ? undefined
    : boundedString(request.attentionGeneration, PROMPT_ID_MAX_CHARS);
  const promptType = request.promptType;
  const promptTypeValid = promptType === 'permission_request'
    || promptType === 'ask_user_question_request'
    || promptType === 'exit_plan_mode_request';
  const answer = promptTypeValid ? prevalidateAnswer(promptType, request.answer) : null;
  if (
    !watchId
    || !sessionId
    || (!promptId && !toolUseId)
    || (request.promptId !== undefined && !promptId)
    || (request.toolUseId !== undefined && !toolUseId)
    || (promptId && toolUseId && promptId !== toolUseId)
    || (request.attentionGeneration !== undefined && !attentionGeneration)
    || !promptTypeValid
    || !answer
  ) {
    return failure(400, 'invalid_request');
  }

  const boundedAttentionGeneration = attentionGeneration ?? undefined;
  const eventIdentity = promptId || toolUseId!;
  const requestDigest = sha256({
    sessionId,
    eventIdentity,
    attentionGeneration: boundedAttentionGeneration ?? null,
    operation: 'inject_attention_reply',
    promptType,
    normalizedAnswer: {
      kind: answer.kind,
      digest: sha256(answer.value),
    },
  });

  const nowMs = deps.now?.() ?? Date.now();
  const reservationKey = `attention-reply:${watchId}`;
  const reservationOwner = deps.createReservationOwner?.() ?? `attention-reply-owner:${randomUUID()}`;
  const leaseMs = Math.max(1, deps.reservationLeaseMs ?? DEFAULT_RESERVATION_LEASE_MS);

  let reservation: Awaited<ReturnType<AttentionReplyDependencies['reserveReceipt']>>;
  try {
    reservation = await deps.reserveReceipt({
      reservationKey,
      requestDigest,
      operation: 'inject_attention_reply',
      sessionId,
      eventIdentity,
      attentionGeneration: boundedAttentionGeneration,
      reservationOwner,
      now: new Date(nowMs),
      leaseExpiresAt: new Date(nowMs + leaseMs),
    });
  } catch (error) {
    const errorClass = error instanceof Error && error.message.includes('idempotency_conflict')
      ? 'idempotency_conflict'
      : 'reservation_failed';
    return failure(errorClass === 'idempotency_conflict' ? 409 : 500, errorClass);
  }

  const reservationStatus = reservation.status ?? (
    reservation.isNewReservation
      ? 'new'
      : reservation.row.state === 'reserved' ? 'busy' : 'replay'
  );
  // Backward-compatible injected test seams may predate the durable authority.
  // Production reservations always supply the store-backed implementation.
  const mutationAuthority: HostControlReceiptMutationAuthority = reservation.mutationAuthority ?? {
    begin: async (_now: Date, generation: string) => ({
      started: true,
      row: { ...reservation.row, mutationState: 'unknown' as const, attentionGeneration: generation },
    }),
    recordApplied: async (
      certainty: 'not_applied' | 'applied',
      receipt: Record<string, unknown>,
    ) => ({
      ...reservation.row,
      mutationState: certainty,
      mutationReceipt: receipt,
    }),
    verify: async () => true,
    verifyCleanup: async () => true,
    enterNative: async <T>(_generation: string, action: () => Promise<T>) => ({
      owned: true as const,
      value: await action(),
    }),
    claimCleanupStep: async () => ({ status: 'claimed' as const }),
    metadataCleanupAuthority: (step: 'prompt' | 'attention', attentionGeneration: string) => ({
      receiptId: reservation.row.id,
      reservationOwner,
      mutationId: reservation.row.mutationId ?? `compat-mutation:${reservation.row.id}`,
      mutationFence: reservation.row.mutationFence ?? 1,
      attentionGeneration,
      step,
    }),
  };

  if (reservationStatus === 'replay') {
    if (!reservation.row.receipt) {
      return failure(500, 'receipt_missing');
    }
    return {
      status: statusForReplay(reservation.row),
      receipt: reservation.row.receipt,
    };
  }
  if (reservationStatus === 'busy') {
    return failure(409, 'attempt_in_progress');
  }

  const mutationId = reservation.row.mutationId
    ?? (!reservation.mutationAuthority ? `compat-mutation:${reservation.row.id}` : undefined);
  const mutationFence = reservation.row.mutationFence
    ?? (!reservation.mutationAuthority ? 1 : undefined);
  if (!mutationId || mutationFence === undefined) {
    return failure(500, 'mutation_identity_missing');
  }
  const finalize = async (
    state: Exclude<HostControlReceiptState, 'reserved'>,
    receipt: Record<string, unknown>,
    _status: number,
  ): Promise<AttentionReplyResult> => {
    try {
      // A lost claimant still calls finalizeReceipt so the store can return the
      // exact persisted terminal winner; a reserved loser cannot mutate because
      // the UPDATE also consumes the claimed terminal step and DB-time lease.
      await mutationAuthority.claimCleanupStep('terminal', boundedAttentionGeneration ?? 'legacy');
      const finalized = await deps.finalizeReceipt({
        id: reservation.row.id,
        reservationKey,
        reservationOwner,
        mutationId,
        mutationFence,
        state,
        receipt,
        now: new Date(deps.now?.() ?? Date.now()),
      });
      if (!finalized.receipt || finalized.state === 'reserved') {
        return failure(500, 'receipt_missing');
      }
      return {
        status: statusForReplay(finalized),
        receipt: finalized.receipt,
      };
    } catch {
      return failure(500, 'receipt_finalize_failed');
    }
  };

  // Legacy 0027 requests/rows may lack a generation. They may replay or
  // converge, but absence is never authority to infer the current turn.
  if (!boundedAttentionGeneration) {
    return finalize('already_resolved', success('already_resolved'), 200);
  }

  let reconcileAppliedOnly = false;
  if (
    reservationStatus === 'taken_over'
    || reservationStatus === 'same_owner'
    || reservationStatus === 'reconcile'
  ) {
    if (reservation.row.mutationState === 'applied') {
      const stored = parseStoredMutationResolution(reservation.row.mutationReceipt);
      if (stored) return finalize(stored.state, stored.receipt, stored.status);
      // A returned native effect is an immutable durable winner. If the owner
      // died before exact-A cleanup/finalization, replay performs cleanup only;
      // it never invokes the provider/waiter a second time.
      reconcileAppliedOnly = true;
    }
    if (reservation.row.mutationState === 'unknown') {
      // The old owner crossed the no-retry fence. A process loss after that
      // point is terminally failed instead of risking a second native answer.
      return finalize('failed', failure(500, 'mutation_outcome_unconfirmed').receipt, 500);
    }
    if (reservation.row.mutationState === 'not_applied') {
      const stored = parseStoredMutationResolution(reservation.row.mutationReceipt);
      if (stored) return finalize(stored.state, stored.receipt, stored.status);
      return finalize('failed', failure(500, 'mutation_receipt_missing').receipt, 500);
    }
    if (reservation.row.mutationState === 'legacy_unknown') {
      return finalize('already_resolved', success('already_resolved'), 200);
    }
  }

  let event: AttentionEventLike | null;
  try {
    event = await deps.getPendingInteractiveEvent(sessionId, eventIdentity);
  } catch {
    return finalize('failed', failure(500, 'event_lookup_failed').receipt, 500);
  }
  const identityMatches = Boolean(event && (
    event.promptId === eventIdentity || event.toolUseId === eventIdentity
  ));
  const exactEventMatches = Boolean(
    event
    && event.status === 'pending'
    && event.kind === 'interactive_prompt'
    && event.sessionId === sessionId
    && identityMatches
    && event.promptType === expectedEventPromptType(promptType)
    && (boundedAttentionGeneration === undefined
      || event.attentionGeneration === boundedAttentionGeneration),
  );
  if (
    !exactEventMatches
    && !reconcileAppliedOnly
  ) {
    return finalize('already_resolved', success('already_resolved'), 200);
  }

  // Applied-only recovery never re-enters a provider/waiter. When A's event is
  // already absent (or replacement B reuses the raw ID), it still routes through
  // AIService so the durable prompt/attention phases are completed in order.
  const response = exactEventMatches
    ? normalizeForEvent(promptType, answer, event!)
    : { cancelled: false };
  if (!response) {
    return finalize('failed', failure(422, 'ambiguous_or_incomplete_answer').receipt, 422);
  }

  const capturedGeneration = boundedString(
    exactEventMatches ? event!.attentionGeneration : boundedAttentionGeneration,
    PROMPT_ID_MAX_CHARS,
  );
  if (!capturedGeneration) {
    return finalize('already_resolved', success('already_resolved'), 200);
  }

  if (!reconcileAppliedOnly) {
    let mutationStart: Awaited<ReturnType<HostControlReceiptMutationAuthority['begin']>>;
    try {
      mutationStart = await mutationAuthority.begin(
        new Date(deps.now?.() ?? Date.now()),
        capturedGeneration,
      );
    } catch {
      return finalize('failed', failure(500, 'mutation_fence_failed').receipt, 500);
    }
    if (!mutationStart.started) {
      if (mutationStart.row.mutationState === 'applied') {
        const stored = parseStoredMutationResolution(mutationStart.row.mutationReceipt);
        if (stored) return finalize(stored.state, stored.receipt, stored.status);
      }
      return finalize('failed', failure(500, 'mutation_fence_unavailable').receipt, 500);
    }
  }

  let result: Awaited<ReturnType<AttentionReplyDependencies['respondToInteractivePrompt']>>;
  let mutationRecorded = reconcileAppliedOnly;
  try {
    result = await deps.respondToInteractivePrompt({
      sessionId,
      promptId: exactEventMatches ? (event!.promptId ?? event!.toolUseId!) : eventIdentity,
      promptType,
      response,
      respondedBy: 'telegram',
      expectedAttentionGeneration: capturedGeneration,
      expectedPromptIdentity: eventIdentity,
      mutationAuthority: {
        mutationId,
        mutationFence,
        attentionGeneration: capturedGeneration,
        promptOccurrence: exactEventMatches ? event!.id : `reconcile:${mutationId}`,
        answerDigest: sha256(response),
      },
      durableMutationAuthority: mutationAuthority,
      reconcileAppliedOnly,
      assertMutationFence: reconcileAppliedOnly
        ? undefined
        : () => mutationAuthority.verify(capturedGeneration),
      assertCleanupFence: () => mutationAuthority.verifyCleanup(capturedGeneration),
      beforeNativeMutation: deps.onJeanReconciliationPoint
        ? () => Promise.resolve(
            deps.onJeanReconciliationPoint!('before_jean_native_mutation'),
          )
        : undefined,
      beforeNativeEntry: deps.onJeanReconciliationPoint
        ? () => Promise.resolve(
            deps.onJeanReconciliationPoint!('after_jean_fence_verified'),
          )
        : undefined,
      afterPromptCleanupCompleted: deps.onJeanReconciliationPoint
        ? () => Promise.resolve(
            deps.onJeanReconciliationPoint!('after_jean_prompt_cleanup_completed'),
          )
        : undefined,
      afterAttentionCleanupCommitted: deps.onJeanReconciliationPoint
        ? () => Promise.resolve(
            deps.onJeanReconciliationPoint!('after_jean_attention_metadata_committed'),
          )
        : undefined,
      afterAttentionCleanupCompleted: deps.onJeanReconciliationPoint
        ? () => Promise.resolve(
            deps.onJeanReconciliationPoint!('after_jean_attention_cleanup_completed'),
          )
        : undefined,
      afterNativeApplicationRecorded: deps.onJeanReconciliationPoint
        ? () => Promise.resolve(
            deps.onJeanReconciliationPoint!('after_jean_application_recorded'),
          )
        : undefined,
      onNativeMutationApplied: reconcileAppliedOnly ? undefined : async (nativeResult) => {
        await mutationAuthority.recordApplied(
          'applied',
          {
            nativeCertainty: 'applied',
            nativeEntered: true,
            cleanupVerified: false,
            success: nativeResult.success,
          },
          new Date(deps.now?.() ?? Date.now()),
        );
        mutationRecorded = true;
      },
    });
  } catch {
    return finalize('failed', failure(500, 'internal_error').receipt, 500);
  }

  const resolution = resolutionForNativeResult(result);
  if (!mutationRecorded && result.nativeCertainty !== 'unknown') {
    try {
      await mutationAuthority.recordApplied(
        result.nativeCertainty === 'applied' ? 'applied' : 'not_applied',
        {
          state: resolution.state,
          status: resolution.status,
          receipt: resolution.receipt,
        },
        new Date(deps.now?.() ?? Date.now()),
      );
    } catch {
      return finalize('failed', failure(500, 'mutation_receipt_failed').receipt, 500);
    }
  }
  return finalize(resolution.state, resolution.receipt, resolution.status);
}
