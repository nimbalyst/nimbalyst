import type { DocumentContext } from '@nimbalyst/runtime/ai/server/types';
import { mergeClaimedRun, selectCoalescibleRun } from './coalesceQueuedPrompts';
import { beginSessionTurn, isTurnAdmissionBlocked } from './sessionTurnControl';
import { TurnSetupCancelledError } from './turnSetupStages';

/**
 * The per-session "a queued-prompt chain is running" guard, as an ownership lease.
 *
 * #1018: this used to be a bare `Set<string>`, and every dispatch released it in
 * its `finally` with an unconditional `delete(sessionId)`. When an interrupt
 * displaced an in-flight dispatch with a priority prompt, the displaced dispatch
 * eventually settled and deleted a guard the priority prompt now held — so an
 * ordinary FIFO prompt could be claimed and sent while the priority prompt was
 * still executing. Releasing now requires still being the owner.
 *
 * Extends `Set<string>` so every existing `.has(sessionId)` reader keeps working
 * unchanged, including the seven reads in MessageStreamingHandler.
 */
export class SessionProcessingGuard extends Set<string> {
  private owners = new Map<string, symbol>();
  private claims = new Map<string, symbol>();

  override has(sessionId: string): boolean {
    return this.claims.has(sessionId) || super.has(sessionId);
  }

  /** Reserve before storage awaits, including when a live drain bypasses the turn guard. */
  beginClaim(sessionId: string): symbol | undefined {
    if (this.claims.has(sessionId)) return undefined;
    const token = Symbol(sessionId);
    this.claims.set(sessionId, token);
    return token;
  }

  endClaim(sessionId: string, token: symbol): void {
    if (this.claims.get(sessionId) === token) this.claims.delete(sessionId);
  }

  /** Take the guard for `sessionId`; the returned token is required to release it. */
  acquire(sessionId: string): symbol {
    const token = Symbol(sessionId);
    this.owners.set(sessionId, token);
    this.add(sessionId);
    return token;
  }

  isOwner(sessionId: string, token: symbol): boolean {
    return this.owners.get(sessionId) === token;
  }

  /** Release only if `token` is still the owner. Returns whether it released. */
  releaseIfOwner(sessionId: string, token: symbol): boolean {
    if (this.owners.get(sessionId) !== token) return false;
    return this.delete(sessionId);
  }

  /**
   * Unconditional release, used by the authoritative cancel/interrupt paths.
   * Clearing the owner is what makes the displaced dispatch's later
   * `releaseIfOwner` a no-op rather than a release of whoever came next.
   */
  override delete(sessionId: string): boolean {
    this.owners.delete(sessionId);
    return super.delete(sessionId);
  }
}

export interface ClaimedQueuedPrompt {
  id: string;
  prompt: string;
  claimToken?: string;
  attachments?: unknown[] | null;
  documentContext?: DocumentContext | null;
}

export interface QueuedPromptStoreLike {
  listPending(sessionId: string): Promise<ClaimedQueuedPrompt[]>;
  claim(promptId: string): Promise<ClaimedQueuedPrompt | null>;
  /** Return an undelivered row claimed by this attempt, never the whole session. */
  releaseClaims(claims: readonly { id: string; claimToken?: string }[]): Promise<void>;
  complete(promptId: string): Promise<void>;
  fail(promptId: string, errorMessage: string): Promise<void>;
}

/** A failed atomic release can be retried safely with the same claim identities. */
async function releaseUndeliveredClaims(
  queueStore: QueuedPromptStoreLike,
  claims: readonly ClaimedQueuedPrompt[],
  logError: (message: string, error: unknown) => void,
): Promise<void> {
  try {
    await queueStore.releaseClaims(claims);
  } catch (error) {
    logError(`[AIService] Retrying return of undelivered queued prompts ${claims.map((row) => row.id).join(', ')}:`, error);
    try { await queueStore.releaseClaims(claims); }
    catch (finalError) {
      logError(`[AIService] Final return of undelivered queued prompts ${claims.map((row) => row.id).join(', ')} failed:`, finalError);
      throw finalError;
    }
  }
}

interface DispatchClaimedQueuedPromptOptions {
  signal?: AbortSignal;
  claimed: ClaimedQueuedPrompt;
  /**
   * Every row this turn delivers. Defaults to `[claimed.id]`; a coalesced run
   * passes all of its ids so complete/fail settle the whole batch rather than
   * leaving the merged-away rows stuck in `executing`.
   */
  claimedIds?: string[];
  /** Preserve each coalesced row's claim identity for an undelivered rollback. */
  claimedRows?: ClaimedQueuedPrompt[];
  continueQueuedPromptChain: (
    sessionId: string,
    workspacePath: string,
    targetWindow: Electron.BrowserWindow,
    source: string,
  ) => Promise<void>;
  logError: (message: string, error: unknown) => void;
  onAfterSettled?: () => Promise<void>;
  onChainSettled?: (payload: { sessionId: string; workspacePath: string; source: string }) => Promise<void>;
  onPromptClaimed: (payload: { sessionId: string; promptId: string }) => void;
  processingSet: SessionProcessingGuard;
  queueStore: QueuedPromptStoreLike;
  sendMessageHandler: (
    event: Electron.IpcMainInvokeEvent,
    message: string,
    documentContext?: DocumentContext,
    sessionId?: string,
    workspacePath?: string,
  ) => Promise<{ content: string }>;
  sessionId: string;
  source: string;
  startSession: (options: { sessionId: string; workspacePath: string }) => Promise<void>;
  targetWindow: Electron.BrowserWindow;
  workspacePath: string;
  /** The provider started (or is about to start) a turn of its own, e.g. a background-task wake. */
  isLeadTurnPending?: () => boolean;
  /** Re-arm the queue driver if a hold wins after the caller saw dispatch scheduled. */
  onDispatchDeferred?: () => void;
  logInfo?: (message: string) => void;
}

export async function dispatchClaimedQueuedPrompt(
  options: DispatchClaimedQueuedPromptOptions,
): Promise<boolean> {
  const {
    claimed,
    claimedIds,
    claimedRows,
    continueQueuedPromptChain,
    logError,
    onAfterSettled,
    onChainSettled,
    onPromptClaimed,
    processingSet,
    queueStore,
    sendMessageHandler,
    sessionId,
    source,
    startSession,
    targetWindow,
    workspacePath,
    isLeadTurnPending,
    onDispatchDeferred,
    logInfo,
  } = options;

  const settleIds = claimedIds && claimedIds.length > 0 ? claimedIds : [claimed.id];
  const returnToPending = () => releaseUndeliveredClaims(queueStore, claimedRows ?? [claimed], logError);
  const isHeld = () => !!options.signal?.aborted || isTurnAdmissionBlocked(sessionId);

  if (isHeld()) {
    await returnToPending();
    return false;
  }

  // #1018: hold the guard as a lease. An interrupt can drop it and hand the
  // session to a priority prompt while this dispatch is still in flight, so the
  // release below must check it is still the owner.
  const dispatchTurn = beginSessionTurn(sessionId);
  const guardToken = processingSet.acquire(sessionId);

  try {
    await startSession({ sessionId, workspacePath });
  } catch (error) {
    try {
      // No message handler has run, so every failed start is undelivered.
      await returnToPending();
    } catch (releaseError) {
      logError(`[AIService] Failed to return queued prompts ${settleIds.join(', ')} after session start failed:`, releaseError);
    } finally {
      processingSet.releaseIfOwner(sessionId, guardToken);
      dispatchTurn.finish();
    }
    throw error;
  }
  if (isHeld()) {
    try {
      await returnToPending();
    } finally {
      processingSet.releaseIfOwner(sessionId, guardToken);
      dispatchTurn.finish();
    }
    return false;
  }

  const docContext = {
    ...(claimed.documentContext || {}),
    queuedPromptId: claimed.id,
    attachments: claimed.attachments,
  } as DocumentContext;

  setImmediate(async () => {
    try {
      // A hold or a cancellation/replacement can win at the scheduled handoff.
      // Neither an undelivered nor a displaced turn owns settlement hooks.
      if (!processingSet.isOwner(sessionId, guardToken) || isHeld() || dispatchTurn.cancelled) {
        let returned = false;
        let released = false;
        try {
          await returnToPending();
          returned = true;
        } catch (error) {
          logError(`[AIService] Failed to return held queued prompts ${settleIds.join(', ')}:`, error);
        } finally {
          released = processingSet.releaseIfOwner(sessionId, guardToken);
        }
        // A cancelling/replacement actor owns its next action. Do not wake it,
        // or advertise a healthy pending retry if storage is still unavailable.
        if (returned && released) onDispatchDeferred?.();
        return;
      }
      let cancelledSetup = false;
      let returnedCancelledClaims = false;
      const completed = new Set<string>();
      try {
        // Announce only when the row is actually handed to the message handler.
        for (const promptId of settleIds) onPromptClaimed({ sessionId, promptId });
        const mockEvent = {
          sender: targetWindow.webContents,
          senderFrame: targetWindow.webContents.mainFrame,
        } as Electron.IpcMainInvokeEvent;

        await sendMessageHandler(mockEvent, claimed.prompt, docContext, sessionId, workspacePath);
        for (const promptId of settleIds) {
          await queueStore.complete(promptId);
          completed.add(promptId);
        }
      } catch (queueError) {
        if (queueError instanceof TurnSetupCancelledError && !queueError.providerEntered) {
          cancelledSetup = true;
          try {
            await returnToPending();
            returnedCancelledClaims = true;
          } catch (releaseError) {
            logError(`[AIService] Failed to return cancelled queued prompts ${settleIds.join(', ')}:`, releaseError);
          }
        } else {
          logError(`[AIService] Failed to process queued prompt ${claimed.id}:`, queueError);
          for (const promptId of settleIds) {
            if (completed.has(promptId)) continue;
            await queueStore.fail(
              promptId,
              queueError instanceof Error ? queueError.message : 'Unknown error',
            );
          }
        }
      } finally {
        // Only release if this dispatch still owns the guard: if an interrupt
        // displaced it, the priority prompt that replaced it is still running and
        // releasing here would let the FIFO continuation start a second turn
        // underneath it (#1018).
        const released = processingSet.releaseIfOwner(sessionId, guardToken);
        if (cancelledSetup) {
          if (released && returnedCancelledClaims) onDispatchDeferred?.();
          return;
        }
        // A replacement dispatch owns continuation and settlement as well as
        // the guard. A displaced turn must not report the child finished.
        if (!released) return;
        // NIM-7428: the turn ended by waking the session with background-task
        // results. That wake turn's own completion continues the queue, ends the
        // session and reports to the parent; doing it here would end a running
        // session, or send a prompt that aborts the wake and drops its results.
        if (isLeadTurnPending?.()) {
          logInfo?.(`[AIService] ${source} finally: session ${sessionId} woke for background results; its wake turn owns the queue`);
          return;
        }
        try {
          await continueQueuedPromptChain(
            sessionId,
            workspacePath,
            targetWindow,
            `${source} finally`,
          );
        } catch (chainErr) {
          logError(`[AIService] ${source} finally: error checking for pending prompts:`, chainErr);
        }
        // If no follow-on prompt was dispatched, the chain has fully settled.
        // The inner sendMessage's completion handler deferred endSession because
        // processingSet still contained this session (we hadn't reached this
        // delete yet), so nobody has marked the session idle. Do it now.
        if (!processingSet.has(sessionId) && onChainSettled) {
          try {
            await onChainSettled({ sessionId, workspacePath, source });
          } catch (settledErr) {
            logError(`[AIService] ${source} finally: chain-settled hook failed:`, settledErr);
          }
        }
        if (onAfterSettled) {
          try {
            await onAfterSettled();
          } catch (afterErr) {
            logError(`[AIService] ${source} finally: post-settle hook failed:`, afterErr);
          }
        }
      }
    } finally { dispatchTurn.finish(); }
  });
  return true;
}

interface TryClaimAndDispatchNextQueuedPromptOptions {
  signal?: AbortSignal;
  continueQueuedPromptChain: DispatchClaimedQueuedPromptOptions['continueQueuedPromptChain'];
  logError: DispatchClaimedQueuedPromptOptions['logError'];
  logInfo: (message: string) => void;
  onAfterSettled?: DispatchClaimedQueuedPromptOptions['onAfterSettled'];
  onChainSettled?: DispatchClaimedQueuedPromptOptions['onChainSettled'];
  onPromptClaimed: DispatchClaimedQueuedPromptOptions['onPromptClaimed'];
  processingSet: SessionProcessingGuard;
  queueStore: QueuedPromptStoreLike;
  sendMessageHandler: DispatchClaimedQueuedPromptOptions['sendMessageHandler'] | null;
  sessionId: string;
  source: string;
  startSession: DispatchClaimedQueuedPromptOptions['startSession'];
  resolveLiveWindow?: (workspacePath: string) => Electron.BrowserWindow | null;
  targetWindow: Electron.BrowserWindow | null;
  workspacePath: string;
  /** True when a draining turn holds the guard but its live query can take this prompt. */
  canBypassChainGuard?: () => boolean;
  isLeadTurnPending?: DispatchClaimedQueuedPromptOptions['isLeadTurnPending'];
  onDispatchDeferred?: DispatchClaimedQueuedPromptOptions['onDispatchDeferred'];
}

export async function tryClaimAndDispatchNextQueuedPrompt(
  options: TryClaimAndDispatchNextQueuedPromptOptions,
): Promise<boolean> {
  const {
    continueQueuedPromptChain,
    logError,
    logInfo,
    onAfterSettled,
    onChainSettled,
    onPromptClaimed,
    processingSet,
    queueStore,
    sendMessageHandler,
    sessionId,
    source,
    startSession,
    resolveLiveWindow,
    targetWindow,
    workspacePath,
    canBypassChainGuard,
    isLeadTurnPending,
    onDispatchDeferred,
  } = options;

  const isHeld = () => !!options.signal?.aborted || isTurnAdmissionBlocked(sessionId);
  if (isHeld()) return false;

  const liveWindow =
    targetWindow && !targetWindow.isDestroyed()
      ? targetWindow
      : resolveLiveWindow?.(workspacePath) ?? null;

  if (!liveWindow || liveWindow.isDestroyed()) {
    logInfo(`[AIService] ${source}: no live window available to continue queued prompts for session ${sessionId}`);
    return false;
  }

  if (processingSet.has(sessionId) && !canBypassChainGuard?.()) {
    logInfo(`[AIService] ${source}: session ${sessionId} already processing a queued prompt, skipping`);
    return false;
  }

  const claimToken = processingSet.beginClaim(sessionId);
  if (!claimToken) return false;
  const claimTurn = beginSessionTurn(sessionId);
  let preClaim = true;
  const retireRead = () => {
    if (!preClaim) return;
    processingSet.endClaim(sessionId, claimToken);
    claimTurn.finish();
  };
  options.signal?.addEventListener('abort', retireRead, { once: true });
  try {
    const pendingPrompts = await queueStore.listPending(sessionId);
    if (isHeld()) return false;
    if (pendingPrompts.length === 0) {
      // logInfo(`[AIService] ${source}: no pending prompts for session ${sessionId}`);
      return false;
    }

    // Agent-authored rows deliver as one turn; a human row keeps its own turn and
    // bounds the run on both sides. See coalesceQueuedPrompts.ts.
    const run = selectCoalescibleRun(pendingPrompts);
    const nextPrompt = run[0];
    logInfo(`[AIService] ${source}: processing prompt ${nextPrompt.id} for session ${sessionId}`);

    // From this point a write may be in flight. Abort cannot discard the
    // lease: await the exact outcome and return only this attempt's claims.
    preClaim = false;
    const claimedHead = await queueStore.claim(nextPrompt.id);
    if (!claimedHead) {
      logInfo(`[AIService] ${source}: prompt ${nextPrompt.id} already claimed`);
      return false;
    }

    // Claim the tail one row at a time. A row that fails to claim was taken by
    // another drainer, so stop extending rather than skipping over it -- pulling
    // the row behind it forward would deliver the run out of order.
    const claimedRun = [claimedHead];
    let returnAttempted = false;
    let dispatchOwnsClaims = false;
    const returnToPending = () => {
      returnAttempted = true;
      return releaseUndeliveredClaims(queueStore, claimedRun, logError);
    };
    try {
      if (isHeld()) {
        await returnToPending();
        return false;
      }
      for (const queued of run.slice(1)) {
        const claimedNext = await queueStore.claim(queued.id);
        if (claimedNext) claimedRun.push(claimedNext);
        if (isHeld()) {
          await returnToPending();
          return false;
        }
        if (!claimedNext) break;
      }

      const claimed = mergeClaimedRun(claimedRun);
      const claimedIds = claimedRun.map((row) => row.id);

      if (claimedRun.length > 1) {
        logInfo(`[AIService] ${source}: coalesced ${claimedRun.length} agent-authored prompts into one turn for session ${sessionId}`);
      }

      if (!sendMessageHandler) {
        for (const promptId of claimedIds) {
          await queueStore.fail(promptId, 'sendMessageHandler not initialized');
        }
        logError('[AIService] Failed to process queued prompt because sendMessageHandler is not initialized', new Error('sendMessageHandler not initialized'));
        return false;
      }

      dispatchOwnsClaims = true;
      return await dispatchClaimedQueuedPrompt({
        signal: options.signal,
        claimed,
        claimedIds,
        claimedRows: claimedRun,
        continueQueuedPromptChain,
        logError,
        onAfterSettled,
        onChainSettled,
        onPromptClaimed,
        processingSet,
        queueStore,
        sendMessageHandler,
        sessionId,
        source,
        startSession,
        targetWindow: liveWindow,
        workspacePath,
        isLeadTurnPending,
        onDispatchDeferred,
        logInfo,
      });
    } catch (error) {
      // Until dispatch takes ownership, every successful claim is undelivered.
      // A failed hold return or dispatch start already owns its own cleanup.
      if (!returnAttempted && !dispatchOwnsClaims) {
        try {
          await returnToPending();
        } catch (releaseError) {
          logError(`[AIService] Failed to return queued prompts after claim preparation failed:`, releaseError);
        }
      }
      throw error;
    }
  } finally {
    options.signal?.removeEventListener('abort', retireRead);
    processingSet.endClaim(sessionId, claimToken);
    claimTurn.finish();
  }
}
