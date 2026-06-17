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
import { submitClaudeCliPromptProduction } from './claudeCliSubmitSingleton';
import { flushNextClaudeCliQueuedPrompt } from './claudeCliQueueFlush';

/** Per-session guard so two close `idle` events can't double-flush. */
const flushInFlight = new Set<string>();

/**
 * Flush the next queued prompt for a session on PID `idle`. Best-effort and
 * self-guarded — never throws into the turn-state callback.
 */
export async function flushNextClaudeCliQueuedPromptForSession(
  sessionId: string,
  workspacePath: string,
): Promise<boolean> {
  if (flushInFlight.has(sessionId)) return false;
  flushInFlight.add(sessionId);
  try {
    const store = getQueuedPromptsStore();
    return await flushNextClaudeCliQueuedPrompt(
      { sessionId, workspacePath },
      {
        listPending: (s) => store.listPending(s),
        claim: (id) => store.claim(id),
        complete: (id) => store.complete(id),
        fail: (id, m) => store.fail(id, m),
        submit: (i) => submitClaudeCliPromptProduction(i),
        // The flush runs from the PID-idle transition with no originating IPC
        // event, so there is no single target window; broadcasting is safe
        // because the renderer filters by sessionId (NIM-830).
        notifyClaimed: (promptId) => {
          for (const win of BrowserWindow.getAllWindows()) {
            if (!win.isDestroyed()) {
              win.webContents.send('ai:promptClaimed', { sessionId, promptId });
            }
          }
        },
      },
    );
  } catch (error) {
    console.warn('[ClaudeCliQueueFlush] flush failed:', error);
    return false;
  } finally {
    flushInFlight.delete(sessionId);
  }
}
