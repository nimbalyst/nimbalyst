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
  onChainSettled?: (payload: { sessionId: string; workspacePath: string; source: string }) => Promise<void>;
  onPromptClaimed: (payload: { sessionId: string; promptId: string }) => void;
  processingLeases: Map<string, symbol>;
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
}

export async function dispatchClaimedQueuedPrompt(
  options: DispatchClaimedQueuedPromptOptions,
): Promise<void> {
  const {
    claimed,
    continueQueuedPromptChain,
    logError,
    onAfterSettled,
    onChainSettled,
    onPromptClaimed,
    processingLeases,
    queueStore,
    sendMessageHandler,
    sessionId,
    source,
    startSession,
    targetWindow,
    workspacePath,
  } = options;

  const dispatchLease = Symbol(`queued-prompt:${sessionId}:${claimed.id}`);
  processingLeases.set(sessionId, dispatchLease);

  try {
    await startSession({ sessionId, workspacePath });
  } catch (error) {
    if (processingLeases.get(sessionId) === dispatchLease) {
      processingLeases.delete(sessionId);
    }
    throw error;
  }

  onPromptClaimed({ sessionId, promptId: claimed.id });

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
      await queueStore.complete(claimed.id);
    } catch (queueError) {
      logError(`[AIService] Failed to process queued prompt ${claimed.id}:`, queueError);
      await queueStore.fail(
        claimed.id,
        queueError instanceof Error ? queueError.message : 'Unknown error',
      );
    } finally {
      // An interrupt revokes this dispatch's lease before a priority prompt
      // acquires a replacement. The interrupted dispatch can settle later, but
      // its stale finally block must not release the replacement lease or
      // continue the ordinary FIFO chain concurrently with priority delivery.
      if (processingLeases.get(sessionId) !== dispatchLease) {
        return;
      }
      processingLeases.delete(sessionId);
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
      // processingLeases still contained this session (we hadn't reached this
      // delete yet), so nobody has marked the session idle. Do it now.
      if (!processingLeases.has(sessionId) && onChainSettled) {
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
  processingLeases: Map<string, symbol>;
  queueStore: QueuedPromptStoreLike;
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
    processingLeases,
    queueStore,
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

  if (processingLeases.has(sessionId)) {
    logInfo(`[AIService] ${source}: session ${sessionId} already processing a queued prompt, skipping`);
    return false;
  }

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

  if (!sendMessageHandler) {
    await queueStore.fail(claimed.id, 'sendMessageHandler not initialized');
    logError('[AIService] Failed to process queued prompt because sendMessageHandler is not initialized', new Error('sendMessageHandler not initialized'));
    return false;
  }

  await dispatchClaimedQueuedPrompt({
    claimed,
    continueQueuedPromptChain,
    logError,
    onAfterSettled,
    onChainSettled,
    onPromptClaimed,
    processingLeases,
    queueStore,
    sendMessageHandler,
    sessionId,
    source,
    startSession,
    targetWindow,
    workspacePath,
  });

  return true;
}
