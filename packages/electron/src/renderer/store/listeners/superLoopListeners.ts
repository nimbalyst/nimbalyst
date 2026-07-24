/**
 * Centralized IPC listeners for Super Loop events
 *
 * Follows the centralized IPC listener architecture (see docs/IPC_LISTENERS.md):
 * - Components NEVER subscribe to IPC events directly
 * - Central listeners update atoms
 * - Components read from atoms
 *
 * Events handled:
 * - super-loop:event -> processSuperEventAtom (loop state changes)
 * - super-loop:iteration-prompt -> orchestrates AI session for iteration
 *
 * Call initSuperLoopListeners() once in AgentMode.tsx on mount.
 */

import { store } from '../index';
import { processSuperEventAtom } from '../atoms/superLoop';
import type { SuperLoopEvent } from '../../../shared/types/superLoop';

/** Maximum number of reminders to send if Claude forgets to call the progress tool */
const MAX_PROGRESS_REMINDERS = 2;

/**
 * Initialize Super Loop IPC listeners.
 * Should be called once at app startup.
 *
 * @returns Cleanup function to call on unmount
 */
export function initSuperLoopListeners(): () => void {
  const cleanups: Array<() => void> = [];

  // Track pending sessions so we can clean up listeners on shutdown.
  // Maps sessionId -> cleanup function for its ai:streamResponse/ai:error listeners.
  const pendingSessionCleanups = new Map<string, () => void>();

  // =========================================================================
  // Super Loop Events (state changes)
  // =========================================================================
  cleanups.push(
    window.electronAPI.on('super-loop:event', (superLoopEvent: SuperLoopEvent) => {
      if (!superLoopEvent || typeof superLoopEvent !== 'object') {
        console.warn('[superLoopListeners] Received invalid super loop event:', superLoopEvent);
        return;
      }
      store.set(processSuperEventAtom, superLoopEvent);
    })
  );

  // =========================================================================
  // Super Loop Iteration Prompts (session orchestration)
  // =========================================================================

  /**
   * Create a promise that resolves when the AI stream completes for a session.
   * Reusable for both the initial prompt and reminder re-prompts.
   */
  function createStreamCompletePromise(sessionId: string): Promise<void> {
    return new Promise<void>((resolve) => {
      let resolved = false;

      const doResolve = () => {
        if (resolved) return;
        resolved = true;
        const cleanup = pendingSessionCleanups.get(sessionId);
        if (cleanup) {
          cleanup();
          pendingSessionCleanups.delete(sessionId);
        }
        resolve();
      };

      const handleStreamResponse = (response: {
        sessionId: string;
        isComplete?: boolean;
      }) => {
        if (response.sessionId === sessionId && response.isComplete) {
          doResolve();
        }
      };

      const handleError = (error: { sessionId: string }) => {
        if (error.sessionId === sessionId) {
          doResolve();
        }
      };

      const cleanupStream = window.electronAPI.on('ai:streamResponse', handleStreamResponse);
      const cleanupError = window.electronAPI.on('ai:error', handleError);

      pendingSessionCleanups.set(sessionId, () => {
        cleanupStream?.();
        cleanupError?.();
      });
    });
  }

  cleanups.push(
    window.electronAPI.on('super-loop:iteration-prompt', async (
      data: {
        superLoopId: string;
        sessionId: string;
        prompt: string;
        worktreePath: string;
        workspaceId: string;
      }
    ) => {
      if (!data || typeof data !== 'object' || !data.superLoopId || !data.sessionId) {
        console.warn('[superLoopListeners] Received invalid iteration prompt data:', data);
        return;
      }

      try {
        console.log('[superLoopListeners] Processing iteration prompt:', {
          superLoopId: data.superLoopId,
          sessionId: data.sessionId,
        });

        // Set up listener for stream completion BEFORE sending message
        const streamCompletePromise = createStreamCompletePromise(data.sessionId);

        // Send the message to the AI service
        await window.electronAPI.invoke(
          'ai:sendMessage',
          data.prompt,
          undefined, // No document context
          data.sessionId,
          data.workspaceId
        );

        // Wait for the stream to complete
        await streamCompletePromise;

        // =====================================================================
        // Verify progress tool was called, re-prompt if not
        // =====================================================================
        let reminderCount = 0;

        while (reminderCount < MAX_PROGRESS_REMINDERS) {
          const result = await window.electronAPI.invoke(
            'super-loop:was-progress-tool-called',
            data.sessionId
          );

          if (result.called) {
            break;
          }

          reminderCount++;
          console.log(
            `[superLoopListeners] Progress tool not called, sending reminder ${reminderCount}/${MAX_PROGRESS_REMINDERS}:`,
            data.sessionId
          );

          // Set up new stream completion listener for the reminder response
          const reminderCompletePromise = createStreamCompletePromise(data.sessionId);

          // Send reminder to the same session
          await window.electronAPI.invoke(
            'ai:sendMessage',
            'You have not yet called the `super_loop_progress_update` tool. You MUST call this tool before your turn ends to record your progress for the next iteration. Call it now with your progress update.',
            undefined,
            data.sessionId,
            data.workspaceId
          );

          await reminderCompletePromise;
        }

        // Clean up progress tool call tracking for this session
        await window.electronAPI.invoke(
          'super-loop:clear-progress-tool-call',
          data.sessionId
        );

        // Notify main process that session completed successfully
        console.log('[superLoopListeners] Notifying session complete:', data.sessionId);
        window.electronAPI.send('super-loop:session-complete', data.sessionId, true);
      } catch (err) {
        console.error('[superLoopListeners] Failed to process iteration prompt:', err);
        // Clean up any pending listeners
        const cleanup = pendingSessionCleanups.get(data.sessionId);
        if (cleanup) {
          cleanup();
          pendingSessionCleanups.delete(data.sessionId);
        }
        // Clean up progress tool call tracking
        window.electronAPI.invoke(
          'super-loop:clear-progress-tool-call',
          data.sessionId
        ).catch(() => {}); // Best-effort cleanup
        // Still notify completion so the loop can continue/handle error
        window.electronAPI.send('super-loop:session-complete', data.sessionId, false);
      }
    })
  );

  // Cleanup function
  return () => {
    // Remove IPC listeners
    cleanups.forEach(fn => fn?.());

    // Clean up any pending session listeners
    for (const cleanupFn of pendingSessionCleanups.values()) {
      cleanupFn();
    }
    pendingSessionCleanups.clear();
  };
}
