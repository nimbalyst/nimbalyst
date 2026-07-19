import type { DocumentContext } from '@nimbalyst/runtime/ai/server/types';

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

export type QueuedPromptDispatchOutcome = 'completed' | 'failed';

export interface QueuedPromptDispatchTarget {
  routingWorkspacePath: string;
  expectedWorktreeId: string | null;
  expectedWorktreePath: string | null;
}

export interface QueuedPromptDispatchSessionLike {
  id: string;
  workspacePath?: string | null;
  worktreeId?: string | null;
  worktreePath?: string | null;
  isArchived?: boolean | null;
  worktreeIsArchived?: boolean | null;
}

export interface QueuedPromptTurnContext {
  attentionGeneration: string;
  expectedWorktreeId: string | null;
  expectedWorktreePath: string | null;
  registerDeferredDrainReplay?: (replay: () => Promise<void>) => void;
}

function normalizedIdentity(value: string | null | undefined): string | null {
  return value?.trim() ? value : null;
}

/**
 * A queued target is executable only while both the session and any joined
 * worktree row are active. A dangling worktree id is retired evidence, not
 * permission to fall back to the canonical checkout.
 */
export function isQueuedPromptDispatchSessionRetired(
  session: QueuedPromptDispatchSessionLike,
): boolean {
  if (session.isArchived === true) {
    return true;
  }

  const worktreeId = normalizedIdentity(session.worktreeId);
  const worktreePath = normalizedIdentity(session.worktreePath);
  if (Boolean(worktreeId) !== Boolean(worktreePath)) {
    return true;
  }
  return Boolean(worktreeId && session.worktreeIsArchived !== false);
}

/**
 * Revalidate the immutable worktree association after SessionManager's safe
 * reload and before any watcher/provider is constructed. Direct turns have no
 * queued context and retain their existing alias-tolerant behavior.
 */
export function assertQueuedPromptReloadTarget(
  sessionId: string,
  session: QueuedPromptDispatchSessionLike,
  turnContext?: QueuedPromptTurnContext,
): void {
  if (!turnContext) {
    return;
  }
  if (isQueuedPromptDispatchSessionRetired(session)) {
    throw new Error(`Queued target ${sessionId} was archived or its worktree was retired before execution`);
  }

  const actualWorktreeId = normalizedIdentity(session.worktreeId);
  const actualWorktreePath = normalizedIdentity(session.worktreePath);
  if (
    actualWorktreeId !== turnContext.expectedWorktreeId
    || actualWorktreePath !== turnContext.expectedWorktreePath
  ) {
    throw new Error(
      `Queued target ${sessionId} changed worktree identity before execution: ` +
      `expected ${turnContext.expectedWorktreeId ?? 'none'} at ${turnContext.expectedWorktreePath ?? 'none'}, ` +
      `received ${actualWorktreeId ?? 'none'} at ${actualWorktreePath ?? 'none'}`,
    );
  }
}

/**
 * Validate the caller-supplied lookup identity against the exact persisted
 * session, then return the canonical DB workspace used for routing/lifecycle.
 * The exact active worktree remains a supported lookup alias; it never becomes
 * the routing identity or provider-independent permission owner.
 */
export function resolveQueuedPromptDispatchTarget(
  sessionId: string,
  requestedWorkspacePath: string,
  session: QueuedPromptDispatchSessionLike | null,
): QueuedPromptDispatchTarget | null {
  if (
    !session ||
    session.id !== sessionId ||
    !session.workspacePath?.trim() ||
    isQueuedPromptDispatchSessionRetired(session)
  ) {
    return null;
  }

  const addressable = requestedWorkspacePath === session.workspacePath
    || Boolean(session.worktreePath && requestedWorkspacePath === session.worktreePath);
  if (!addressable) {
    return null;
  }

  return {
    routingWorkspacePath: session.workspacePath,
    expectedWorktreeId: normalizedIdentity(session.worktreeId),
    expectedWorktreePath: normalizedIdentity(session.worktreePath),
  };
}

interface DispatchClaimedQueuedPromptOptions {
  claimed: ClaimedQueuedPrompt;
  continueQueuedPromptChain: (
    sessionId: string,
    workspacePath: string,
    targetWindow: Electron.BrowserWindow,
    source: string,
  ) => Promise<void>;
  logError: (message: string, error: unknown) => void;
  onAfterSettled?: () => Promise<void>;
  onChainSettled?: (payload: {
    sessionId: string;
    workspacePath: string;
    source: string;
    attentionGeneration?: string;
    outcome: QueuedPromptDispatchOutcome;
  }) => Promise<void>;
  onPromptClaimed: (payload: { sessionId: string; promptId: string }) => void;
  processingSet: Set<string>;
  queueStore: QueuedPromptStoreLike;
  sendMessageHandler: (
    event: Electron.IpcMainInvokeEvent,
    message: string,
    documentContext?: DocumentContext,
    sessionId?: string,
    workspacePath?: string,
    turnContext?: QueuedPromptTurnContext,
  ) => Promise<{ content: string }>;
  sessionId: string;
  source: string;
  startSession: (options: { sessionId: string; workspacePath: string }) => Promise<string>;
  target: QueuedPromptDispatchTarget;
  targetWindow: Electron.BrowserWindow;
  workspacePath: string;
}

export async function dispatchClaimedQueuedPrompt(
  options: DispatchClaimedQueuedPromptOptions,
): Promise<boolean> {
  const {
    claimed,
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
    target,
    targetWindow,
    workspacePath,
  } = options;

  processingSet.add(sessionId);

  const errorMessage = (error: unknown): string =>
    error instanceof Error ? error.message : 'Unknown error';
  const runChainSettled = async (
    outcome: QueuedPromptDispatchOutcome,
    attentionGeneration?: string,
  ): Promise<void> => {
    if (!onChainSettled) return;
    try {
      await onChainSettled({
        sessionId,
        workspacePath,
        source,
        attentionGeneration,
        outcome,
      });
    } catch (settledErr) {
      logError(`[AIService] ${source}: chain-settled hook failed:`, settledErr);
    }
  };
  const runAfterSettled = async (): Promise<void> => {
    if (!onAfterSettled) return;
    try {
      await onAfterSettled();
    } catch (afterErr) {
      logError(`[AIService] ${source}: post-settle hook failed:`, afterErr);
    }
  };

  let attentionGeneration: string | undefined;
  let replayDeferredDrain: (() => Promise<void>) | undefined;
  const runDeferredDrainReplay = async (): Promise<void> => {
    if (!replayDeferredDrain) return;
    try {
      await replayDeferredDrain();
    } catch (drainError) {
      logError(`[AIService] ${source}: deferred drain replay failed:`, drainError);
    }
  };
  try {
    attentionGeneration = await startSession({ sessionId, workspacePath });
    if (!attentionGeneration?.trim()) {
      throw new Error(`Queued turn ${claimed.id} started without an attention generation`);
    }
  } catch (error) {
    const ownedGeneration = (
      typeof error === 'object'
      && error !== null
      && 'attentionGeneration' in error
      && typeof (error as { attentionGeneration?: unknown }).attentionGeneration === 'string'
    )
      ? (error as { attentionGeneration: string }).attentionGeneration
      : undefined;
    attentionGeneration = attentionGeneration || ownedGeneration;
    const message = errorMessage(error);
    logError(`[AIService] Failed to start queued prompt ${claimed.id}:`, error);
    try {
      await queueStore.fail(claimed.id, message);
    } catch (failError) {
      logError(`[AIService] Failed to mark queued prompt ${claimed.id} failed:`, failError);
    }
    await runChainSettled('failed', attentionGeneration);
    processingSet.delete(sessionId);
    await runAfterSettled();
    return false;
  }

  try {
    onPromptClaimed({ sessionId, promptId: claimed.id });
  } catch (claimEventError) {
    logError(`[AIService] Failed to publish claimed prompt ${claimed.id}:`, claimEventError);
  }

  const docContext = {
    ...(claimed.documentContext || {}),
    queuedPromptId: claimed.id,
    attachments: claimed.attachments,
  } as DocumentContext;

  setImmediate(async () => {
    let outcome: QueuedPromptDispatchOutcome = 'failed';
    try {
      const mockEvent = {
        sender: targetWindow.webContents,
        senderFrame: targetWindow.webContents.mainFrame,
      } as Electron.IpcMainInvokeEvent;

      await sendMessageHandler(
        mockEvent,
        claimed.prompt,
        docContext,
        sessionId,
        workspacePath,
        {
          attentionGeneration,
          expectedWorktreeId: target.expectedWorktreeId,
          expectedWorktreePath: target.expectedWorktreePath,
          registerDeferredDrainReplay: (replay) => {
            replayDeferredDrain = replay;
          },
        },
      );
      await queueStore.complete(claimed.id);
      outcome = 'completed';
    } catch (queueError) {
      logError(`[AIService] Failed to process queued prompt ${claimed.id}:`, queueError);
      try {
        await queueStore.fail(claimed.id, errorMessage(queueError));
      } catch (failError) {
        logError(`[AIService] Failed to mark queued prompt ${claimed.id} failed:`, failError);
      }
    } finally {
      if (outcome === 'completed') {
        processingSet.delete(sessionId);
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
        // A completed early drain is terminal only after the next queued row
        // has had a chance to claim ownership. Replaying before this check can
        // emit session:completed and wake a parent while successor B is about
        // to run. A remaining pending row also suppresses terminal settlement
        // when continuation could not claim it.
        let hasQueuedSuccessor = processingSet.has(sessionId);
        if (!hasQueuedSuccessor) {
          try {
            hasQueuedSuccessor = (await queueStore.listPending(sessionId)).length > 0;
          } catch (pendingError) {
            hasQueuedSuccessor = true;
            logError(
              `[AIService] ${source} finally: failed to prove the queue has no successor:`,
              pendingError,
            );
          }
        }
        if (hasQueuedSuccessor) {
          await runAfterSettled();
          return;
        }
        await runDeferredDrainReplay();
        // If no follow-on prompt was dispatched, the chain has fully settled.
        // The inner sendMessage's completion handler deferred endSession because
        // processingSet still contained this session (we hadn't reached this
        // delete yet), so nobody has marked the session idle. Do it now.
        if (!processingSet.has(sessionId)) {
          await runChainSettled(outcome, attentionGeneration);
        }
      } else {
        // A failed turn owns its processing guard through durable row failure
        // and generation-bound terminal settlement.
        await runChainSettled(outcome, attentionGeneration);
        processingSet.delete(sessionId);
        await runDeferredDrainReplay();
      }
      await runAfterSettled();
    }
  });

  return true;
}

interface TryClaimAndDispatchNextQueuedPromptOptions {
  continueQueuedPromptChain: DispatchClaimedQueuedPromptOptions['continueQueuedPromptChain'];
  logError: DispatchClaimedQueuedPromptOptions['logError'];
  logInfo: (message: string) => void;
  onAfterSettled?: DispatchClaimedQueuedPromptOptions['onAfterSettled'];
  onChainSettled?: DispatchClaimedQueuedPromptOptions['onChainSettled'];
  onPromptClaimed: DispatchClaimedQueuedPromptOptions['onPromptClaimed'];
  processingSet: Set<string>;
  queueStore: QueuedPromptStoreLike;
  resolveTarget: (input: {
    sessionId: string;
    workspacePath: string;
  }) => Promise<QueuedPromptDispatchTarget | null> | QueuedPromptDispatchTarget | null;
  sendMessageHandler: DispatchClaimedQueuedPromptOptions['sendMessageHandler'] | null;
  sessionId: string;
  source: string;
  startSession: DispatchClaimedQueuedPromptOptions['startSession'];
  targetWindow: Electron.BrowserWindow | null;
  workspacePath: string;
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
    resolveTarget,
    sendMessageHandler,
    sessionId,
    source,
    startSession,
    targetWindow,
    workspacePath,
  } = options;

  if (!targetWindow || targetWindow.isDestroyed()) {
    logInfo(`[AIService] ${source}: no live window available to continue queued prompts for session ${sessionId}`);
    return false;
  }

  if (processingSet.has(sessionId)) {
    logInfo(`[AIService] ${source}: session ${sessionId} already processing a queued prompt, skipping`);
    return false;
  }

  if (!sendMessageHandler) {
    logError(
      '[AIService] Cannot process queued prompt because sendMessageHandler is not initialized',
      new Error('sendMessageHandler not initialized'),
    );
    return false;
  }

  let target: QueuedPromptDispatchTarget | null = null;
  try {
    target = await resolveTarget({ sessionId, workspacePath });
  } catch (targetError) {
    logError(`[AIService] ${source}: queued prompt target resolution failed:`, targetError);
    return false;
  }
  if (!target?.routingWorkspacePath?.trim()) {
    logInfo(
      `[AIService] ${source}: session ${sessionId} is not addressable from workspace ${workspacePath}`,
    );
    return false;
  }
  const routingWorkspacePath = target.routingWorkspacePath;

  const pendingPrompts = await queueStore.listPending(sessionId);
  if (pendingPrompts.length === 0) {
    logInfo(`[AIService] ${source}: no pending prompts for session ${sessionId}`);
    return false;
  }

  const nextPrompt = pendingPrompts[0];
  logInfo(`[AIService] ${source}: processing prompt ${nextPrompt.id} for session ${sessionId}`);

  const claimed = await queueStore.claim(nextPrompt.id);
  if (!claimed) {
    logInfo(`[AIService] ${source}: prompt ${nextPrompt.id} already claimed`);
    return false;
  }

  return dispatchClaimedQueuedPrompt({
    claimed,
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
    target,
    targetWindow,
    workspacePath: routingWorkspacePath,
  });
}
