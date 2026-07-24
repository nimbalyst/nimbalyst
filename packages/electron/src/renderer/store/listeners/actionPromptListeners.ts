/**
 * Central listener for `action-prompts:*` broadcasts.
 *
 * - `action-prompts:changed` — ai-actions.md changed on disk for a workspace;
 *   dispatch the new list into the per-workspace atom so the composer picks
 *   it up.
 * - `action-prompts:launched` — a new session was launched from a launcher
 *   action; prefill its draft (when autoSubmit was false) and switch the
 *   visible session (when foreground was true).
 *
 * Foreground focus must drive `selectedWorkstreamAtom` (not just the global
 * active-session atom): the right-hand AgentMode panel renders from
 * `selectedWorkstream`, so updating only `activeSessionIdAtom` would leave the
 * user looking at the previous session. See `setSelectedWorkstreamAtom` in
 * atoms/sessions.ts and the canonical navigation flow in trayListeners.ts.
 */

import { store } from '@nimbalyst/runtime/store';
import {
  actionPromptsAtomFamily,
  type ActionPromptListState,
  type ActionPrompt,
  type ActionPromptParseDiagnostic,
} from '../atoms/actionPrompts';
import {
  setSessionDraftInputAtom,
  setSelectedWorkstreamAtom,
} from '../atoms/sessions';
import {
  setWorkstreamActiveChildAtom,
  setWorktreeActiveSessionAtom,
  workstreamStateAtom,
} from '../atoms/workstreamState';

interface ChangedPayload {
  workspacePath?: string;
  actions?: ActionPrompt[];
  diagnostics?: ActionPromptParseDiagnostic[];
  filePath?: string;
  fileExists?: boolean;
}

interface LaunchedPayload {
  workspacePath?: string;
  parentSessionId?: string;
  sessionId?: string;
  workstreamId?: string | null;
  worktreeId?: string | null;
  draftInput?: string | null;
  focus?: boolean;
}

let initialized = false;

export function initActionPromptListeners(): () => void {
  if (initialized) {
    return () => {};
  }
  initialized = true;

  const cleanups: Array<() => void> = [];

  const unsubscribeChanged = window.electronAPI?.on?.(
    'action-prompts:changed',
    (data: ChangedPayload) => {
      if (!data?.workspacePath) return;
      const next: ActionPromptListState = {
        actions: data.actions ?? [],
        diagnostics: data.diagnostics ?? [],
        filePath: data.filePath ?? null,
        fileExists: data.fileExists ?? false,
        loaded: true,
      };
      store.set(actionPromptsAtomFamily(data.workspacePath), next);
    }
  );
  if (typeof unsubscribeChanged === 'function') cleanups.push(unsubscribeChanged);

  const unsubscribeLaunched = window.electronAPI?.on?.(
    'action-prompts:launched',
    (data: LaunchedPayload) => {
      if (!data?.sessionId) return;

      // Write the draft first so the AIInput renders with prefilled text when
      // it mounts. setSessionDraftInputAtom also persists via IPC when
      // workspacePath is provided.
      if (typeof data.draftInput === 'string' && data.draftInput.length > 0) {
        store.set(setSessionDraftInputAtom, {
          sessionId: data.sessionId,
          draftInput: data.draftInput,
          workspacePath: data.workspacePath,
          persist: true,
        });
      }

      if (!data.focus || !data.workspacePath) {
        return;
      }

      // Drive the right-hand panel by setting selectedWorkstreamAtom — mirrors
      // the tray-listener navigation flow for parity. Three cases:
      //
      //   1. New session lives in a worktree (parent had a worktree, so
      //      worktreeId is set and workstreamId is null — the worktree IS
      //      the container).
      //   2. New session lives in a regular workstream (workstreamId set,
      //      worktreeId null).
      //   3. Neither — shouldn't happen for sibling launches, but fall back
      //      to selecting the new session as a standalone root.
      if (data.worktreeId) {
        const state = store.get(workstreamStateAtom(data.sessionId));
        if (state.type !== 'worktree') {
          store.set(workstreamStateAtom(data.sessionId), {
            type: 'worktree',
            worktreeId: data.worktreeId,
          });
        }
        store.set(setWorktreeActiveSessionAtom, {
          worktreeId: data.worktreeId,
          sessionId: data.sessionId,
        });
        store.set(setSelectedWorkstreamAtom, {
          workspacePath: data.workspacePath,
          selection: { type: 'worktree', id: data.sessionId },
        });
      } else if (data.workstreamId) {
        store.set(setWorkstreamActiveChildAtom, {
          workstreamId: data.workstreamId,
          childId: data.sessionId,
        });
        store.set(setSelectedWorkstreamAtom, {
          workspacePath: data.workspacePath,
          selection: { type: 'workstream', id: data.workstreamId },
        });
      } else {
        store.set(setSelectedWorkstreamAtom, {
          workspacePath: data.workspacePath,
          selection: { type: 'session', id: data.sessionId },
        });
      }
    }
  );
  if (typeof unsubscribeLaunched === 'function') cleanups.push(unsubscribeLaunched);

  return () => {
    initialized = false;
    cleanups.forEach((c) => c());
  };
}
