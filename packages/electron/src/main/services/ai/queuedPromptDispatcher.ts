import type { DocumentContext } from '@nimbalyst/runtime/ai/server/types';
import { mergeClaimedRun, selectCoalescibleRun } from './coalesceQueuedPrompts';

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

  /** Take the guard for `sessionId`; the returned token is required to release it. */
  acquire(sessionId: string): symbol {
    const token = Symbol(sessionId);
    this.owners.set(sessionId, token);
    this.add(sessionId);
    return token;
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
  attachments?: unknown[] | null;
  documentContext?: DocumentContext | null;
}

export interface QueuedPromptStoreLike {
  listPending(sessionId: string): Promise<ClaimedQueuedPrompt[]>;
  claim(promptId: string): Promise<ClaimedQueuedPrompt | null>;
  complete(promptId: string): Promise<void>;
  fail(promptId: string, errorMessage: string): Promise<void>;
}

interface DispatchClaimedQueuedPromptOptions {
  claimed: ClaimedQueuedPrompt;
  /**
   * Every row this turn delivers. Defaults to `[claimed.id]`; a coalesced run
   * passes all of its ids so complete/fail settle the whole batch rather than
   * leaving the merged-away rows stuck in `executing`.
   */
  claimedIds?: string[];
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
  logInfo?: (message: string) => void;
}

export async function dispatchClaimedQueuedPrompt(
  options: DispatchClaimedQueuedPromptOptions,
): Promise<void> {
  const {
    claimed,
    claimedIds,
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
    logInfo,
  } = options;

  const settleIds = claimedIds && claimedIds.length > 0 ? claimedIds : [claimed.id];

  // #1018: hold the guard as a lease. An interrupt can drop it and hand the
  // session to a priority prompt while this dispatch is still in flight, so the
  // release below must check it is still the owner.
  const guardToken = processingSet.acquire(sessionId);

  try {
    await startSession({ sessionId, workspacePath });
  } catch (error) {
    processingSet.releaseIfOwner(sessionId, guardToken);
    throw error;
  }

  // Announce every merged row, not just the head, so the renderer clears the
  // whole run from the queue list instead of leaving stale entries on screen.
  for (const promptId of settleIds) {
    onPromptClaimed({ sessionId, promptId });
  }

  const docContext = {
    ...(claimed.documentContext || {}),
    queuedPromptId: claimed.id,
    attachments: claimed.attachments,
  } as DocumentContext;

  setImmediate(async () => {
    try {
      const mockEvent = {
        sender: targetWindow.webContents,
        senderFrame: targetWindow.webContents.mainFrame,
      } as Electron.IpcMainInvokeEvent;

      await sendMessageHandler(mockEvent, claimed.prompt, docContext, sessionId, workspacePath);
      for (const promptId of settleIds) {
        await queueStore.complete(promptId);
      }
    } catch (queueError) {
      logError(`[AIService] Failed to process queued prompt ${claimed.id}:`, queueError);
      for (const promptId of settleIds) {
        await queueStore.fail(
          promptId,
          queueError instanceof Error ? queueError.message : 'Unknown error',
        );
      }
    } finally {
      // Only release if this dispatch still owns the guard: if an interrupt
      // displaced it, the priority prompt that replaced it is still running and
      // releasing here would let the FIFO continuation start a second turn
      // underneath it (#1018).
      processingSet.releaseIfOwner(sessionId, guardToken);
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
  });
}

interface TryClaimAndDispatchNextQueuedPromptOptions {
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
  } = options;

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

  const pendingPrompts = await queueStore.listPending(sessionId);
  if (pendingPrompts.length === 0) {
    // logInfo(`[AIService] ${source}: no pending prompts for session ${sessionId}`);
    return false;
  }

  // Agent-authored rows deliver as one turn; a human row keeps its own turn and
  // bounds the run on both sides. See coalesceQueuedPrompts.ts.
  const run = selectCoalescibleRun(pendingPrompts);
  const nextPrompt = run[0];
  logInfo(`[AIService] ${source}: processing prompt ${nextPrompt.id} for session ${sessionId}`);

  const claimedHead = await queueStore.claim(nextPrompt.id);
  if (!claimedHead) {
    logInfo(`[AIService] ${source}: prompt ${nextPrompt.id} already claimed`);
    return false;
  }

  // Claim the tail one row at a time. A row that fails to claim was taken by
  // another drainer, so stop extending rather than skipping over it -- pulling
  // the row behind it forward would deliver the run out of order.
  const claimedRun = [claimedHead];
  for (const queued of run.slice(1)) {
    const claimedNext = await queueStore.claim(queued.id);
    if (!claimedNext) break;
    claimedRun.push(claimedNext);
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

  await dispatchClaimedQueuedPrompt({
    claimed,
    claimedIds,
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
    logInfo,
  });

  return true;
}
