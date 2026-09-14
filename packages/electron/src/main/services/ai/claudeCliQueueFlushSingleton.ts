/**
 * Production wiring for the `claude-code-cli` queue flusher (NIM-806 — input
 * integration / queued prompts).
 *
 * Binds the real `getQueuedPromptsStore()` (the SAME store the renderer and
 * mobile write to via `ai:createQueuedPrompt`) and the shared submit composer,
 * and guards against concurrent flushes for a session. Invoked from the
 * launcher's PID `idle` transition (`claudeCliLauncherSingleton`). Kept separate
 * from the pure core so the core unit-tests without pulling in electron.
 */

import { BrowserWindow } from 'electron';
import { getQueuedPromptsStore } from '../RepositoryManager';
import { getSyncProvider } from '../SyncManager';
import { submitClaudeCliPromptProduction } from './claudeCliSubmitSingleton';
import { flushNextClaudeCliQueuedPrompt } from './claudeCliQueueFlush';
import { publishQueuedPromptClaim } from './queuedPromptClaimEvents';
import { publishQueuedPromptsToSync } from './queuedPromptSyncPublisher';
import { claudeCliSubmitLatch } from './claudeCliSubmitLatch';
import { claudeCliInterruptGate } from './claudeCliInterruptGate';

/** Per-session guard so two close `idle` events can't double-flush. */
const flushInFlight = new Set<string>();
/** Sessions with a pending re-check queued for when the submit latch lifts. */
const latchRetryPending = new Set<string>();
/** Sessions with a pending re-check queued for when the interrupt gate clears. */
const interruptRetryPending = new Set<string>();

/**
 * A flush skipped because a stop press was still escalating must retry once the
 * escalation is over: the idle edge that triggered it has already passed, and
 * after the escalation the session sits idle with the prompt still queued. The
 * short settle keeps the retry clear of the escalation's final keystroke.
 */
function retryWhenInterruptGateClears(sessionId: string, workspacePath: string): void {
  if (interruptRetryPending.has(sessionId)) return;
  interruptRetryPending.add(sessionId);
  void claudeCliInterruptGate.waitUntilClear(sessionId).then(() => {
    setTimeout(() => {
      interruptRetryPending.delete(sessionId);
      void flushNextClaudeCliQueuedPromptForSession(sessionId, workspacePath);
    }, 500).unref?.();
  });
}

/**
 * A flush skipped because a submit was still draining has to be retried, or the
 * prompt waits for an idle transition that may never come — a submit that never
 * makes the CLI start a turn (a slash command, say) leaves it idle throughout, so
 * there is no running->idle edge to ride.
 */
function retryWhenSubmitLatchLifts(sessionId: string, workspacePath: string): void {
  if (latchRetryPending.has(sessionId)) return;
  latchRetryPending.add(sessionId);
  const wait = claudeCliSubmitLatch.remainingMs(sessionId) + 250;
  setTimeout(() => {
    latchRetryPending.delete(sessionId);
    void flushNextClaudeCliQueuedPromptForSession(sessionId, workspacePath);
  }, wait).unref?.();
}

/**
 * Flush the next queued prompt for a session on PID `idle`. Best-effort and
 * self-guarded — never throws into the turn-state callback.
 */
export async function flushNextClaudeCliQueuedPromptForSession(
  sessionId: string,
  workspacePath: string,
): Promise<boolean> {
  if (flushInFlight.has(sessionId)) return false;
  if (claudeCliSubmitLatch.isInFlight(sessionId)) {
    retryWhenSubmitLatchLifts(sessionId, workspacePath);
    return false;
  }
  if (claudeCliInterruptGate.isInFlight(sessionId)) {
    retryWhenInterruptGateClears(sessionId, workspacePath);
    return false;
  }
  flushInFlight.add(sessionId);
  try {
    const store = getQueuedPromptsStore();
    // This path claims rows outside AIService, so it owns its own mirror of the
    // queue to mobile — see queuedPromptSyncPublisher.ts (NIM-2402).
    const publishQueueState = () =>
      publishQueuedPromptsToSync(
        {
          listPending: (s) => store.listPending(s),
          getSyncProvider,
          logWarn: (message) => console.warn(message),
        },
        sessionId,
      );

    const flushed = await flushNextClaudeCliQueuedPrompt(
      { sessionId, workspacePath },
      {
        listPending: (s) => store.listPending(s),
        claim: (id) => store.claim(id),
        complete: (id) => store.complete(id),
        fail: (id, m) => store.fail(id, m),
        submit: (i) => submitClaudeCliPromptProduction(i),
        isSubmitInFlight: () => claudeCliSubmitLatch.isInFlight(sessionId),
        isInterruptInFlight: () => claudeCliInterruptGate.isInFlight(sessionId),
        // The flush runs from the PID-idle transition with no originating IPC
        // event, so there is no single target window; broadcasting is safe
        // because the renderer filters by sessionId (NIM-830).
        notifyClaimed: (promptId) => {
          publishQueuedPromptClaim({ sessionId, promptId });
          for (const win of BrowserWindow.getAllWindows()) {
            if (!win.isDestroyed()) {
              win.webContents.send('ai:promptClaimed', { sessionId, promptId });
            }
          }
          void publishQueueState();
        },
      },
    );

    // Only when a row actually moved — this runs on every PID-idle transition,
    // and an unconditional publish would be one index update per idle tick.
    if (flushed) {
      await publishQueueState();
    }
    return flushed;
  } catch (error) {
    console.warn('[ClaudeCliQueueFlush] flush failed:', error);
    return false;
  } finally {
    flushInFlight.delete(sessionId);
  }
}
