/**
 * Close every unanswered question a human turn supersedes (NIM-7240).
 *
 * Stopping a turn leaves its open question answerable on purpose (#1116): the
 * user has decided nothing, and answering later resumes the session with the
 * answer. Starting a new turn is a decision. The user chose to move on instead
 * of answering, so every question asked before that turn is closed for good.
 * Without this, nothing ever closed it: the widget stayed answerable, "Jump to
 * question" kept pointing at it, and the session kept reporting a pending
 * prompt.
 *
 * Runs at the start of a turn, before the provider is invoked, and closes every
 * unanswered question it finds (see `snapshotQuestionsToSupersede` for why the
 * last-user-message boundary is not used here). Only human turns supersede:
 * an agent `send_prompt`, a child-session update, a wakeup, an automation or
 * the answer auto-resume leave open questions alone.
 */

import { ipcMain } from 'electron';
import { partitionUnansweredQuestions, type UnansweredQuestion } from '@nimbalyst/runtime/ai/server/interactivePromptTools';
import { getCodexToolLookupAliases } from '@nimbalyst/runtime/ai/server/toolLookupIds';
import type { PromptProvenance } from '@nimbalyst/runtime/ai/server/types';
import { loadViewMessages } from '../../utils/transcriptHelpers';
import { getQueuedPromptsStore } from '../RepositoryManager';
import { getRequestUserInputResponseChannel } from '../../mcp/tools/interactivePromptFallback';
import { hasLiveInteractivePrompt } from '../../mcp/tools/interactivePromptLiveness';
import { reservePromptAnswer } from './PromptAnswerReservation';
import {
  hasTerminalizedAskUserQuestion,
  markInteractivePromptTerminalized,
  persistInteractivePromptTerminalResult,
} from './askUserQuestionFallbackResolution';
import { getSeenToolResultIds } from './claudeCliToolResultSeen';
import { codexQuestionRecoveryId, deliverCodexQuestionAnswer, hasAnswer } from './codexQuestionDelivery';
import { hasOpenPrompts, isPromptOpen, resolvePrompt } from './openPromptRegistry';
import { setSessionPendingPrompt } from './pendingPromptPersistence';
import { logger } from '../../utils/logger';

/** The parts of a send's document context that say who started the turn. */
export interface TurnOriginContext {
  inputType?: unknown;
  queuedPromptId?: unknown;
  promptOrigin?: unknown;
  promptProvenance?: Partial<PromptProvenance> | null;
}

/**
 * True only when a person started this turn. Reads the caller's own context,
 * never the provenance MessageStreamingHandler defaults for the transcript row:
 * that default labels the answer auto-resume, teammate-idle and extension-chat
 * sends as human.
 *
 * Explicit provenance wins over `inputType`, so an agent send that happens to
 * carry `inputType: 'user'` still cannot supersede.
 */
export function isHumanTurn(context: TurnOriginContext | null | undefined): boolean {
  if (!context) return false;
  if (context.promptOrigin === 'interactive-question') return false;
  if (context.promptProvenance) return context.promptProvenance.actor === 'human';
  return context.inputType === 'user' && !context.queuedPromptId;
}

const SUPERSEDED = { answers: {}, cancelled: true, reason: 'superseded', respondedBy: 'desktop' } as const;

export interface SupersedeOutcome {
  superseded: string[];
  /** Left alone: an answer is in flight, or a live turn still owns the question. */
  skipped: string[];
}

/** The unanswered questions that existed before a human turn started. */
export interface SupersedeSnapshot {
  sessionId: string;
  provider: string;
  questions: UnansweredQuestion[];
}

const EMPTY_OUTCOME = (): SupersedeOutcome => ({ superseded: [], skipped: [] });

/**
 * Read the session's unanswered questions. Must run before the new turn
 * reaches the provider: Claude and Codex persist the new user row inside that
 * call, so a scan taken here has no row for the new turn yet and nothing in it
 * can belong to that turn. Every unanswered question in it is closed, whether
 * or not it follows the last persisted user message.
 *
 * Returns null for a non-human turn, or when the read fails. Supersede is
 * cleanup: a failure must never fail the user's send, and the transcript
 * already renders a question before the newest user message as closed.
 */
export async function snapshotQuestionsToSupersede(args: {
  sessionId: string;
  provider: string;
  context: TurnOriginContext | null | undefined;
}): Promise<SupersedeSnapshot | null> {
  const { sessionId, provider } = args;
  if (!isHumanTurn(args.context)) return null;
  try {
    const started = Date.now();
    const view = await loadViewMessages(sessionId, provider);
    const elapsedMs = Date.now() - started;
    const timing = `[supersedeOpenQuestions] view load for ${sessionId} took ${elapsedMs}ms`;
    if (elapsedMs > 100) logger.main.warn(timing);
    else logger.main.info(timing);
    if (!view.success) throw new Error(view.error);
    const { open, superseded } = partitionUnansweredQuestions(view.messages);
    return { sessionId, provider, questions: [...superseded, ...open] };
  } catch (error) {
    // Cleanup only: the send goes ahead, and the UI still shows the question closed.
    logger.main.error(`[supersedeOpenQuestions] snapshot failed for ${sessionId}:`, error);
    return null;
  }
}

/** Close every question in a snapshot taken by `snapshotQuestionsToSupersede`. */
export async function closeSupersededQuestions(snapshot: SupersedeSnapshot | null): Promise<SupersedeOutcome> {
  const outcome = EMPTY_OUTCOME();
  if (!snapshot || snapshot.questions.length === 0) return outcome;
  const { sessionId, provider } = snapshot;
  try {
    const wasTracked = hasOpenPrompts(sessionId);
    for (const question of snapshot.questions) {
      const closed = provider === 'openai-codex' && question.toolName === 'AskUserQuestion'
        ? await supersedeCodexQuestion(sessionId, question.id)
        : question.toolName === 'AskUserQuestion'
          ? await supersedeAskUserQuestion(sessionId, question.id, provider)
          : await supersedeRequestUserInput(sessionId, question.id, provider);
      (closed ? outcome.superseded : outcome.skipped).push(question.id);
      if (closed) resolvePrompt(sessionId, question.id);
    }

    // `resolvePrompt` clears the bit itself when it drained tracked ids. A bit
    // left over from before a restart has no tracked ids, so clear it here.
    if (outcome.superseded.length > 0 && !wasTracked && !hasOpenPrompts(sessionId) && !hasLiveInteractivePrompt(sessionId)) {
      await setSessionPendingPrompt(sessionId, false);
    }
  } catch (error) {
    // Cleanup only: the send goes ahead, and the UI still shows the question closed.
    logger.main.error(`[supersedeOpenQuestions] closing questions failed for ${sessionId}:`, error);
  }
  logger.main.info(
    `[supersedeOpenQuestions] session=${sessionId} superseded=${outcome.superseded.length} skipped=${outcome.skipped.length}`,
  );
  return outcome;
}

/** Snapshot and close in one step, for callers already past persistence but before the provider call. */
export async function supersedeOpenQuestions(args: {
  sessionId: string;
  provider: string;
  context: TurnOriginContext | null | undefined;
}): Promise<SupersedeOutcome> {
  return closeSupersededQuestions(await snapshotQuestionsToSupersede(args));
}

/**
 * Codex questions are owned by `codexQuestionTurns`, and `begin()` for this
 * turn already retired the old waiters, so the cancel goes through the same
 * delivery boundary an answer does. It writes the terminal row itself.
 */
async function supersedeCodexQuestion(sessionId: string, questionId: string): Promise<boolean> {
  // A queued recovery means the user answered and the continuation is waiting
  // to run. Cancelling now would race it.
  const queue = getQueuedPromptsStore();
  const ids = [...new Set([questionId, ...getCodexToolLookupAliases(questionId)])];
  for (const id of ids) {
    if (await queue.get(codexQuestionRecoveryId(sessionId, id))) return false;
  }
  if (await hasAnswer(sessionId, questionId)) return false;
  await deliverCodexQuestionAnswer(sessionId, questionId, { ...SUPERSEDED, answers: {} });
  return true;
}

async function supersedeAskUserQuestion(sessionId: string, questionId: string, provider: string): Promise<boolean> {
  if (hasTerminalizedAskUserQuestion(sessionId, questionId)) return true;
  // An in-process SDK question still pending in its provider is closed by that
  // turn's abort, which writes its own cancelled row. Writing one here as well
  // would give it two results, and the later one would drop the reason.
  if (isPromptOpen(sessionId, questionId)) return false;
  // Reserving the cancel is what refuses a late click on the stale widget
  // across a restart; a failed reservation means an answer is already in flight.
  if (!reservePromptAnswer(sessionId, 'question', questionId, { answers: {}, cancelled: true })) return false;

  // A waiter may be keyed by the raw Codex id behind a synthetic `nimtc|` id.
  for (const waiterId of getCodexToolLookupAliases(questionId)) {
    const channel = `ask-user-question-response:${sessionId}:${waiterId}`;
    if (ipcMain.listenerCount(channel) > 0) {
      ipcMain.emit(channel, null, { ...SUPERSEDED, questionId: waiterId, sessionId });
    }
  }
  // A CLI waiter writes the terminal row during the emit (it marks the id
  // synchronously); writing another would give the question two results.
  if (getSeenToolResultIds(sessionId).has(questionId)) {
    markInteractivePromptTerminalized(sessionId, questionId);
    return true;
  }
  await persistTerminalRow(sessionId, questionId, provider);
  return true;
}

async function supersedeRequestUserInput(sessionId: string, promptId: string, provider: string): Promise<boolean> {
  let settledWaiter = false;
  for (const waiterId of getCodexToolLookupAliases(promptId)) {
    const channel = getRequestUserInputResponseChannel(sessionId, waiterId);
    if (ipcMain.listenerCount(channel) > 0) {
      settledWaiter = true;
      ipcMain.emit(channel, null, SUPERSEDED);
    }
  }
  // The PromptForUserInput waiter always writes its terminal row on settle.
  if (settledWaiter) {
    markInteractivePromptTerminalized(sessionId, promptId);
    return true;
  }
  await persistTerminalRow(sessionId, promptId, provider);
  return true;
}

function persistTerminalRow(sessionId: string, questionId: string, provider: string): Promise<void> {
  return persistInteractivePromptTerminalResult({
    sessionId,
    questionId,
    answers: {},
    cancelled: true,
    reason: 'superseded',
    source: provider === 'openai-codex' ? 'openai-codex' : undefined,
  });
}
