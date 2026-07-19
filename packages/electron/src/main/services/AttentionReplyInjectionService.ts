import { createHash } from 'crypto';
import type {
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
  }): Promise<{
    success: boolean;
    error?: string;
    promptClear?: unknown;
    staleAction?: boolean;
    attentionCancelledCount?: number;
  }>;
  reserveReceipt(input: {
    reservationKey: string;
    requestDigest: string;
    operation: 'inject_attention_reply';
    sessionId: string;
    eventIdentity: string;
    attentionGeneration?: string;
  }): Promise<{ row: HostControlReceiptRow; isNewReservation: boolean }>;
  finalizeReceipt(input: {
    id: string;
    state: Exclude<HostControlReceiptState, 'reserved'>;
    receipt: Record<string, unknown>;
  }): Promise<HostControlReceiptRow>;
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

function success(outcome: 'injected' | 'already_resolved'): Record<string, unknown> {
  return {
    outcome,
    verified: true,
    receipt: {
      route: 'host-attention-answer',
      event_cleared: true,
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
  return errorClass === 'internal_error' ? 500 : 422;
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

  let reservation: Awaited<ReturnType<AttentionReplyDependencies['reserveReceipt']>>;
  try {
    reservation = await deps.reserveReceipt({
      reservationKey: `attention-reply:${watchId}`,
      requestDigest,
      operation: 'inject_attention_reply',
      sessionId,
      eventIdentity,
      attentionGeneration: boundedAttentionGeneration,
    });
  } catch (error) {
    const errorClass = error instanceof Error && error.message.includes('idempotency_conflict')
      ? 'idempotency_conflict'
      : 'reservation_failed';
    return failure(errorClass === 'idempotency_conflict' ? 409 : 500, errorClass);
  }

  if (!reservation.isNewReservation) {
    if (reservation.row.state === 'reserved' || !reservation.row.receipt) {
      return failure(409, 'attempt_in_progress');
    }
    return {
      status: statusForReplay(reservation.row),
      receipt: reservation.row.receipt,
    };
  }

  const finalize = async (
    state: Exclude<HostControlReceiptState, 'reserved'>,
    receipt: Record<string, unknown>,
    status: number,
  ): Promise<AttentionReplyResult> => {
    try {
      await deps.finalizeReceipt({ id: reservation.row.id, state, receipt });
      return { status, receipt };
    } catch {
      return failure(500, 'receipt_finalize_failed');
    }
  };

  let event: AttentionEventLike | null;
  try {
    event = await deps.getPendingInteractiveEvent(sessionId, eventIdentity);
  } catch {
    return finalize('failed', failure(500, 'event_lookup_failed').receipt, 500);
  }
  const identityMatches = Boolean(event && (
    event.promptId === eventIdentity || event.toolUseId === eventIdentity
  ));
  if (
    !event
    || event.status !== 'pending'
    || event.kind !== 'interactive_prompt'
    || event.sessionId !== sessionId
    || !identityMatches
    || event.promptType !== expectedEventPromptType(promptType)
    || (boundedAttentionGeneration !== undefined
      && event.attentionGeneration !== boundedAttentionGeneration)
  ) {
    return finalize('already_resolved', success('already_resolved'), 200);
  }

  const response = normalizeForEvent(promptType, answer, event);
  if (!response) {
    return finalize('failed', failure(422, 'ambiguous_or_incomplete_answer').receipt, 422);
  }

  let result: Awaited<ReturnType<AttentionReplyDependencies['respondToInteractivePrompt']>>;
  try {
    result = await deps.respondToInteractivePrompt({
      sessionId,
      promptId: event.promptId ?? event.toolUseId!,
      promptType,
      response,
      respondedBy: 'telegram',
    });
  } catch {
    return finalize('failed', failure(500, 'internal_error').receipt, 500);
  }

  if (result.staleAction === true) {
    return finalize('already_resolved', success('already_resolved'), 200);
  }
  if (result.success === true && (result.attentionCancelledCount ?? 0) > 0) {
    return finalize('injected', success('injected'), 200);
  }
  if (result.success === true && result.attentionCancelledCount === 0) {
    return finalize('already_resolved', success('already_resolved'), 200);
  }
  return finalize('failed', failure(422, 'native_response_failed').receipt, 422);
}
