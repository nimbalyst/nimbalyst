/**
 * Centralized Session Transcript IPC Listeners
 *
 * Subscribes to session-transcript-related IPC events ONCE and updates atoms.
 * Components read from atoms, never subscribe to IPC directly.
 *
 * Events handled:
 * - ai:tokenUsageUpdated → updates sessionStoreAtom tokenUsage
 * - ai:error → sessionErrorAtom, streamCompletionSignalAtom
 * - ai:streamResponse (isComplete) → streamCompletionSignalAtom
 * - ai:promptAdditions → sessionPromptAdditionsAtom (dev mode)
 * - ai:queuedPromptsReceived → triggers queue refresh
 *
 * Note: These events were previously subscribed to directly in SessionTranscript.tsx,
 * causing race conditions when switching sessions and stale closure bugs.
 *
 * Other session events (ai:message-logged, session:title-updated, ai:askUserQuestion,
 * ai:exitPlanModeConfirm, session:started/completed) are already handled in sessionStateListeners.ts.
 *
 * Call initSessionTranscriptListeners() once in AgentMode.tsx on mount.
 */

import { store } from '@nimbalyst/runtime/store';
import { updateSessionStoreAtom, sessionStoreAtom, sessionPromptAdditionsAtom } from '../atoms/sessions';
import {
  sessionErrorAtom,
  sessionQueuedPromptsAtom,
  streamCompletionSignalAtom,
  transcriptEventSignalAtom,
} from '../atoms/sessionTranscript';

/**
 * Initialize session transcript IPC listeners.
 * Should be called once at app startup.
 *
 * @returns Cleanup function to call on unmount
 */
export function initSessionTranscriptListeners(): () => void {
  const cleanups: Array<() => void> = [];

  // =========================================================================
  // Token Usage Updated
  // =========================================================================
  cleanups.push(
    window.electronAPI.on('ai:tokenUsageUpdated', (data: {
      sessionId: string;
      tokenUsage: any;
    }) => {
      const { sessionId, tokenUsage } = data;
      if (!sessionId) return;

      // Update via the unified update atom which syncs both stores
      // Only update if tokenUsage is truthy (not null/undefined)
      if (tokenUsage) {
        store.set(updateSessionStoreAtom, {
          sessionId,
          updates: { tokenUsage },
        });
      }
    })
  );

  // =========================================================================
  // AI Error
  // =========================================================================
  cleanups.push(
    window.electronAPI.on('ai:error', (data: {
      sessionId: string;
      message: string;
      isAuthError?: boolean;
      isBedrockToolError?: boolean;
      isServerError?: boolean;
      isCodexAuthRequired?: boolean;
    }) => {
      const { sessionId, message, isAuthError, isBedrockToolError, isServerError, isCodexAuthRequired } = data;
      if (!sessionId) return;

      // Set the error in the atom - SessionTranscript will read it and display
      store.set(sessionErrorAtom(sessionId), { message, isAuthError, isBedrockToolError, isServerError, isCodexAuthRequired });

      // Signal stream completion so awaiters (e.g. superLoopBlockedFeedback) unblock
      store.set(streamCompletionSignalAtom(sessionId), (prev) => prev + 1);
    })
  );

  // =========================================================================
  // Stream Response Completion Signal
  // =========================================================================
  cleanups.push(
    window.electronAPI.on('ai:streamResponse', (data: {
      sessionId: string;
      isComplete?: boolean;
    }) => {
      const { sessionId, isComplete } = data;
      if (!sessionId || !isComplete) return;

      // Signal stream completion so awaiters (e.g. superLoopBlockedFeedback) unblock
      store.set(streamCompletionSignalAtom(sessionId), (prev) => prev + 1);
    })
  );

  // =========================================================================
  // ExitPlanMode is now DB-backed (handled by sessionStateListeners.ts)
  // No IPC listener needed here - state derived from sessionPendingPromptsAtom
  // =========================================================================

  // =========================================================================
  // Prompt Additions (Dev Mode)
  // =========================================================================
  cleanups.push(
    window.electronAPI.on('ai:promptAdditions', (data: {
      sessionId: string;
      systemPromptAddition: string | null;
      userMessageAddition: string | null;
      attachments?: Array<{ type: string; filename: string; mimeType?: string; filepath?: string }>;
      timestamp: number;
    }) => {
      const { sessionId, systemPromptAddition, userMessageAddition, attachments, timestamp } = data;
      if (!sessionId) return;

      // Get current messages to find last user message index
      // Using the atoms approach avoids stale closure issues
      const sessionData = store.get(sessionStoreAtom(sessionId));
      const messages = sessionData?.messages || [];
      let lastUserIdx = -1;
      for (let i = messages.length - 1; i >= 0; i--) {
        if (messages[i].type === 'user_message') {
          lastUserIdx = i;
          break;
        }
      }

      store.set(sessionPromptAdditionsAtom(sessionId), {
        systemPromptAddition,
        userMessageAddition,
        attachments,
        timestamp,
        messageIndex: lastUserIdx,
      });
    })
  );

  // =========================================================================
  // Transcript Event (per-session activity signal)
  // Bumps a per-session signal atom so components (e.g. the kanban transcript
  // peek) can react to new turns without subscribing to IPC themselves.
  // =========================================================================
  cleanups.push(
    window.electronAPI.on('transcript:event', (event: { sessionId?: string }) => {
      const sessionId = event?.sessionId;
      if (!sessionId) return;
      store.set(transcriptEventSignalAtom(sessionId), (prev) => prev + 1);
    })
  );

  cleanups.push(
    window.electronAPI.on('transcript:session-reparsed', (event: { sessionId?: string }) => {
      const sessionId = event?.sessionId;
      if (!sessionId) return;
      store.set(transcriptEventSignalAtom(sessionId), (prev) => prev + 1);
    })
  );

  // =========================================================================
  // Queued Prompts Received
  // =========================================================================
  cleanups.push(
    window.electronAPI.on('ai:queuedPromptsReceived', async (data: { sessionId: string }) => {
      const { sessionId } = data;
      if (!sessionId) return;

      // Refresh queued prompts from the database
      try {
        const pending = await window.electronAPI.invoke('ai:listPendingPrompts', sessionId);
        store.set(sessionQueuedPromptsAtom(sessionId), pending || []);
      } catch (error) {
        console.error('[sessionTranscriptListeners] Failed to load queued prompts:', error);
        store.set(sessionQueuedPromptsAtom(sessionId), []);
      }
    })
  );

  // =========================================================================
  // Prompt Claimed (remove from queue)
  // This is a custom DOM event, not an IPC event
  // =========================================================================
  const handlePromptClaimed = (event: CustomEvent<{ sessionId: string; promptId: string }>) => {
    const { sessionId, promptId } = event.detail;
    if (!sessionId || !promptId) return;

    const currentQueue = store.get(sessionQueuedPromptsAtom(sessionId));
    store.set(
      sessionQueuedPromptsAtom(sessionId),
      currentQueue.filter(p => p.id !== promptId)
    );
  };

  window.addEventListener('ai:promptClaimed', handlePromptClaimed as EventListener);
  cleanups.push(() => {
    window.removeEventListener('ai:promptClaimed', handlePromptClaimed as EventListener);
  });

  return () => {
    cleanups.forEach(fn => fn?.());
  };
}

/**
 * Load initial queued prompts for a session.
 * Call this when a session is created or loaded.
 */
export async function loadInitialQueuedPrompts(sessionId: string): Promise<void> {
  try {
    const pending = await window.electronAPI.invoke('ai:listPendingPrompts', sessionId);
    store.set(sessionQueuedPromptsAtom(sessionId), pending || []);
  } catch (error) {
    console.error('[sessionTranscriptListeners] Failed to load initial queued prompts:', error);
    store.set(sessionQueuedPromptsAtom(sessionId), []);
  }
}

/**
 * Clear error state for a session.
 * Call this after displaying/handling the error.
 */
export function clearSessionError(sessionId: string): void {
  store.set(sessionErrorAtom(sessionId), null);
}

// Note: ExitPlanMode uses inline widget rendering from tool call data
// No clearSessionExitPlanModeConfirm needed - widget state is derived from toolCall.result
