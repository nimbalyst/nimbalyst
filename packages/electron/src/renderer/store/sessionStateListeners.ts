/**
 * Session State Listeners
 *
 * Centralized subscription to session state change events.
 * Updates Jotai atoms based on session lifecycle events from the AI provider.
 *
 * This replaces the scattered session state listeners that were in the old
 * AgenticPanel component. Now session state updates are centralized and
 * consistent across the entire app.
 *
 * ## Problem
 * The old AgenticPanel was subscribing to session:started/completed events
 * and updating sessionProcessingAtom. When we switched to the new Jotai-based
 * architecture, these listeners were removed, causing:
 * - Sessions showing as not running when they are
 * - Processing indicators not updating
 * - Messages not reloading properly
 *
 * ## Solution
 * This module provides centralized, global listeners for:
 * - Session processing state (session:started/completed/error)
 * - Message reloads (ai:message-logged) for sessions not currently mounted
 */

import { store } from '@nimbalyst/runtime/store';
import {
  sessionProcessingAtom,
  reloadSessionDataAtom,
  sessionListWorkspaceAtom,
  updateSessionStoreAtom,
  selectedWorkstreamAtom,
  setSelectedWorkstreamAtom,
  sessionUnreadAtom,
  sessionLastActivityAtom,
  sessionLastReadAtom,
  sessionHasPendingInteractivePromptAtom,
  sessionPendingPromptsAtom,
  sessionRegistryAtom,
  sessionChildrenAtom,
  sessionStoreAtom,
  sessionDraftInputAtom,
  sessionLastSubmitAtAtom,
  sessionDraftLocalModifiedAtAtom,
  type PendingPrompt,
} from './atoms/sessions';
import { workstreamActiveChildAtom, workstreamStateAtom } from './atoms/workstreamState';
import { setWindowModeAtom } from './atoms/windowMode';
import { triggerWorktreeRefreshAtom } from './atoms/gitOperations';
import { multiProjectModeAtom, openProjectsAtom } from './atoms/openProjects';
import {
  markSessionStreamingAtom,
  clearSessionStreamingAtom,
  markSessionUnreadAtom,
  clearSessionUnreadAtom,
  markSessionTurnActivityAtom,
} from './atoms/sessionActivity';
import type { TranscriptEvent } from '@nimbalyst/runtime/ai/server/transcript/types';
import { TranscriptStreamAccumulator } from './transcriptStreamAccumulator';
import { resolveOwnedWorkspacePath } from '../../shared/sessionWorkspaceRouting';
import { sessionErrorAtom } from './atoms/sessionTranscript';

/**
 * Per-session accumulator of canonical events received via IPC.
 *
 * Coalesces high-frequency `transcript:event` updates into at most one
 * atom write per animation frame per session. See NIM-411: long Claude
 * Code streaming turns (thousands of token chunks against a transcript
 * with hundreds of events) used to do an O(N) re-projection per chunk
 * here, freezing the renderer and exhausting the JS heap.
 */
const transcriptAccumulator = new TranscriptStreamAccumulator({
  emit: ({ sessionId, messages }) => {
    const currentSession = store.get(sessionStoreAtom(sessionId));
    if (!currentSession) return;
    store.set(sessionStoreAtom(sessionId), {
      ...currentSession,
      messages,
    });
  },
  readDbMessages: (sessionId) => {
    const currentSession = store.get(sessionStoreAtom(sessionId));
    return currentSession?.messages ?? [];
  },
  // requestAnimationFrame caps flushes at the display refresh rate (~60 Hz)
  // and gives the JS thread a chance to do other work between frames.
  // Falls back to setTimeout in non-DOM environments (Vitest, headless).
  schedule:
    typeof requestAnimationFrame === 'function'
      ? (cb) => {
          requestAnimationFrame(() => cb());
        }
      : (cb) => {
          setTimeout(cb, 16);
        },
});

// Track blitz IDs for which an analysis session creation has already been triggered.
// Prevents duplicate IPC calls when multiple children complete near-simultaneously.
const blitzAnalysisTriggered = new Set<string>();

// Per-session throttle state for reloadSessionDataAtom.
// During active streaming, message-logged fires on every chunk, which would
// trigger a full DB reload of ALL messages each time. PGLite is
// single-threaded, so these reads queue up and block writes, causing a
// cascading slowdown. Throttling (leading + trailing edge) ensures at most
// one reload per RELOAD_THROTTLE_MS while still responding promptly to
// the first event (e.g., a tool result arriving mid-stream).
const reloadThrottleTimers = new Map<string, ReturnType<typeof setTimeout>>();
const reloadLastFiredAt = new Map<string, number>();
const RELOAD_THROTTLE_MS = 1000;

// Per-session verification reload timers.
// After session:completed fires the immediate reload, a second "verification" reload
// runs after a short delay. This catches race conditions where:
// - The immediate reload raced with DB writes and got stale data
// - The reload was aborted by version tracking due to concurrent reloads
// - The IPC call failed silently
const verificationReloadTimers = new Map<string, ReturnType<typeof setTimeout>>();
const VERIFICATION_RELOAD_DELAY_MS = 2000;

// Per-session debounce timers for syncing lastReadAt to other devices.
// When the user is actively viewing a session that's streaming, we need to
// push lastReadAt so iOS doesn't show it as unread. But message-logged fires
// on every chunk, so we debounce to avoid spamming the sync server.
const readStateSyncTimers = new Map<string, ReturnType<typeof setTimeout>>();
const READ_STATE_SYNC_DEBOUNCE_MS = 5000;

// Active workspace-scoped subscription in main process.
// Kept module-level so we can update routing without re-registering all IPC listeners.
//
// Multi-project rail: in single-project mode the subscription is keyed to
// the active workspace; in multi-project mode the subscription receives
// events for every open (warm) project so a session that completes while
// its project is hidden still flips the UI out of "Thinking…".
let activeWorkspacePathSnapshot: string | null = null;
let lastSubscriptionKey = '';

function getCurrentSubscriptionPaths(): string[] | undefined {
  const isMulti = store.get(multiProjectModeAtom);
  if (isMulti) {
    const open = store.get(openProjectsAtom);
    if (open.length > 0) return open.map((p) => p.path);
    return activeWorkspacePathSnapshot ? [activeWorkspacePathSnapshot] : undefined;
  }
  return activeWorkspacePathSnapshot ? [activeWorkspacePathSnapshot] : undefined;
}

function reconcileSessionStateSubscription(): void {
  if (!window.electronAPI?.sessionState) return;

  const paths = getCurrentSubscriptionPaths();
  const key = paths ? [...paths].sort().join('\0') : '__no_filter__';
  if (key === lastSubscriptionKey) return;
  lastSubscriptionKey = key;

  const arg: string | string[] | undefined = !paths
    ? undefined
    : paths.length === 1
      ? paths[0]
      : paths;

  window.electronAPI.sessionState.subscribe(arg)
    .then((result: any) => {
      if (!result?.success) {
        console.error('[sessionStateListeners] Failed to subscribe to session state manager:', result?.error);
      }
    })
    .catch((error: any) => {
      console.error('[sessionStateListeners] Error subscribing to session state manager:', error);
    });
}

export function updateSessionStateListenerWorkspace(workspacePath: string): void {
  activeWorkspacePathSnapshot = workspacePath || null;
  reconcileSessionStateSubscription();
}

// React to multi-project mode toggle / rail open-projects changes by
// re-subscribing with the right set of workspace paths.
let multiProjectSubscribersInstalled = false;
function ensureMultiProjectSubscribers(): void {
  if (multiProjectSubscribersInstalled) return;
  multiProjectSubscribersInstalled = true;
  store.sub(multiProjectModeAtom, reconcileSessionStateSubscription);
  store.sub(openProjectsAtom, reconcileSessionStateSubscription);
}

/**
 * Initialize global session state listeners.
 * Should be called once at app startup (or when AgentMode mounts).
 *
 * @returns Cleanup function to remove listeners
 */
export function initSessionStateListeners(): () => void {
  if (!window.electronAPI?.sessionState) {
    console.warn('[sessionStateListeners] sessionState API not available');
    return () => {};
  }

  // Wire reconciliation against multi-project rail state so subscriptions
  // include every warm project, not just the visible one.
  ensureMultiProjectSubscribers();
  reconcileSessionStateSubscription();

  /**
   * If the session that just had turn-boundary or message activity has a
   * workstream parent in the registry, also bump the parent's
   * `markSessionTurnActivityAtom` for the same workspace. Without this, the
   * agent-mode sort in SessionHistory reads `turnActivity.get(parent.id)`,
   * gets undefined, and falls back to the parent's registry `updatedAt` —
   * which never bumps during streaming (intentionally, to avoid render churn).
   * The visible symptom: workstream containers stayed several rows down the
   * TODAY group even while their active child was streaming new messages.
   */
  const bumpParentTurnActivity = (
    sessionId: string,
    workspacePath: string,
    timestamp: number,
  ) => {
    const meta = store.get(sessionRegistryAtom).get(sessionId);
    const parentId = meta?.parentSessionId;
    if (!parentId) return;
    store.set(markSessionTurnActivityAtom, {
      sessionId: parentId,
      workspacePath,
      timestamp,
    });
  };

  /**
   * Handle session state change events.
   * These events come from the AI provider and track the session lifecycle.
   */
  const handleStateChange = (event: {
    type: string;
    sessionId: string;
    workspacePath?: string;
    [key: string]: any;
  }) => {
    const { type, sessionId, workspacePath: eventWorkspacePath } = event;
    if (!sessionId) return;

    const registry = store.get(sessionRegistryAtom);
    const sessionMeta = registry.get(sessionId);
    const sessionWorkspacePath = sessionMeta?.workspaceId || null;
    const ownedWorkspacePath = resolveOwnedWorkspacePath({
      eventWorkspacePath,
      sessionWorkspacePath,
    });

    // The main-process subscription is scoped to the set of workspace paths
    // this window actually hosts (single project or rail-warm) and does the
    // worktree-aware routing (see SessionStateHandlers), so any event that
    // reaches us here is intended for us. We don't re-filter by the visible
    // project — that would drop lifecycle events for sessions in inactive
    // rail projects, leaving the UI stuck on "Thinking…" after a session
    // completed while its project was hidden.
    //
    // We still require an owned workspacePath (event-carried or registry
    // hit) for the non-terminal events (started / streaming / waiting),
    // because those drive workspace-scoped state like
    // `markSessionStreamingAtom` which needs a real workspacePath to
    // bucket per project. Falling back to the active project's path would
    // silently process started/streaming for unrelated sessions.
    //
    // For TERMINAL events (`session:completed` / `error` / `interrupted`)
    // we instead clear `sessionProcessingAtom(sessionId)` unconditionally
    // BEFORE the null-guard below. The processing atom is keyed only by
    // sessionId (no workspace component) and represents "is this turn
    // still running." The main process already routes the event to this
    // window, so a missing workspacePath here means the session isn't yet
    // in the registry — typically a startup race or post-HMR
    // re-evaluation where the lifecycle event arrives before the session
    // list has been hydrated. Dropping the terminal event silently in
    // that case left the "Thinking…" indicator pinned forever; the user
    // had to click Cancel to clear it. arcenik86 reported exactly this
    // on extended-thinking sessions where slow turns increase the chance
    // of the race. See #116.
    const isTerminalEvent =
      type === 'session:completed' ||
      type === 'session:error' ||
      type === 'session:interrupted';
    if (isTerminalEvent) {
      store.set(sessionProcessingAtom(sessionId), false);
      store.set(sessionHasPendingInteractivePromptAtom(sessionId), false);
      store.set(sessionPendingPromptsAtom(sessionId), []);
      // Also clear the workspace-scoped streaming flag. The atom looks up
      // workspacePath from `sessionActivityIndexAtom` when not provided, so
      // cross-workspace rail activity for this session gets cleared even
      // when the terminal event itself lacks workspacePath. Without this,
      // the rail badge ("streaming" dot on inactive projects) stayed stuck
      // after the session ended in the no-workspacePath race documented
      // above. Per @ghinkle's review on the closed #293.
      store.set(clearSessionStreamingAtom, { sessionId });
      // A session reached a terminal state, so it left the backend's active set.
      // Re-derive the processing atoms against that authoritative set now (debounced
      // ~600ms) instead of waiting up to 15s for the interval. A meta-agent header
      // includes child processing too, so when a
      // child finishes this clears the parent's spinner within ~1s rather than
      // leaving it stuck until the user clicks the child.
      scheduleProcessingReconcile();
    }

    if (!ownedWorkspacePath) {
      return;
    }

    const resolvedWorkspacePath = ownedWorkspacePath;
    const turnBoundaryTimestamp = typeof event.timestamp === 'number' ? event.timestamp : Date.now();

    switch (type) {
      // Session is actively running
      case 'session:started':
        // A new turn is an explicit retry. Retire the previous turn's error;
        // acknowledgment without retry remains owned by clearSessionError().
        store.set(sessionErrorAtom(sessionId), null);
        store.set(sessionProcessingAtom(sessionId), true);
        store.set(markSessionStreamingAtom, { sessionId, workspacePath: resolvedWorkspacePath });
        store.set(markSessionTurnActivityAtom, {
          sessionId,
          workspacePath: resolvedWorkspacePath,
          timestamp: turnBoundaryTimestamp,
        });
        bumpParentTurnActivity(sessionId, resolvedWorkspacePath, turnBoundaryTimestamp);
        break;

      case 'session:streaming':
        store.set(sessionProcessingAtom(sessionId), true);
        // Intentionally do NOT clear sessionHasPendingInteractivePromptAtom here.
        // session:streaming fires for any token chunk produced by the provider,
        // including tail-end chunks that arrive after the model emits a tool_use
        // for AskUserQuestion / ExitPlanMode / ToolPermission / GitCommitProposal.
        // The pending flag is the responsibility of the explicit resolve events
        // (ai:askUserQuestionAnswered, ai:exitPlanModeResolved,
        // ai:toolPermissionResolved, ai:gitCommitProposalResolved, ai:sessionCancelled)
        // and the terminal lifecycle events (session:completed/error/interrupted)
        // below. Letting "streaming" clear it caused the warning indicator to
        // flip back to a generic spinner mid-prompt — particularly visible in
        // multi-project rail mode, where this window receives streaming events
        // for sessions in inactive projects whose transcripts are not mounted
        // and thus cannot re-derive the flag from messages.
        store.set(markSessionStreamingAtom, { sessionId, workspacePath: resolvedWorkspacePath });
        break;

      // Session is waiting for user input (AskUserQuestion, ExitPlanMode, ToolPermission)
      case 'session:waiting':
        store.set(sessionProcessingAtom(sessionId), true);
        // NIM-850: the genuine Claude CLI (claude-code-cli) drives this event off
        // a coarse `waiting` pid-file status that fires transiently mid-turn — e.g.
        // while the CLI is merely blocked on a tool/MCP round-trip — not only for
        // real user prompts. Letting it set the pending-interactive-prompt flag
        // poisoned `isWaitingForResponse`, suppressing the "Thinking…" indicator
        // for the rest of the turn (the flag is only cleared by terminal events;
        // session:streaming deliberately doesn't clear it). For CLI sessions the
        // flag is owned solely by the real durable-prompt events
        // (ai:askUserQuestion / ai:exitPlanModeConfirm / ai:toolPermission /
        // ai:requestUserInput), which set AND clear it explicitly. Keeping
        // sessionProcessingAtom true above means the indicator keeps showing.
        if (sessionMeta?.provider !== 'claude-code-cli') {
          store.set(sessionHasPendingInteractivePromptAtom(sessionId), true);
        }
        // Treat "waiting on user" as still processing for rail badge purposes —
        // the user typically hasn't switched away because of the prompt.
        store.set(markSessionStreamingAtom, { sessionId, workspacePath: resolvedWorkspacePath });
        store.set(markSessionTurnActivityAtom, {
          sessionId,
          workspacePath: resolvedWorkspacePath,
          timestamp: turnBoundaryTimestamp,
        });
        bumpParentTurnActivity(sessionId, resolvedWorkspacePath, turnBoundaryTimestamp);
        break;

      // Session has finished (successfully or with error)
      case 'session:completed':
      case 'session:error':
      case 'session:interrupted':
        // The three atoms cleared in the unconditional terminal-event block
        // above (processing, pendingInteractivePrompt, streaming) cover this
        // case. We intentionally do NOT re-clear them here; the streaming
        // atom is idempotent but the duplicate would obscure the invariant
        // that terminal-event cleanup is workspace-agnostic.
        // markSessionTurnActivityAtom stays here because it requires a
        // concrete workspacePath and feeds sidebar ordering for the owning
        // workspace only.
        store.set(markSessionTurnActivityAtom, {
          sessionId,
          workspacePath: resolvedWorkspacePath,
          timestamp: turnBoundaryTimestamp,
        });
        bumpParentTurnActivity(sessionId, resolvedWorkspacePath, turnBoundaryTimestamp);

        // Clear any pending throttle timer for this session - the final reload below
        // will fetch the complete state, so a stale throttled reload is unnecessary
        {
          const pendingTimer = reloadThrottleTimers.get(sessionId);
          if (pendingTimer) {
            clearTimeout(pendingTimer);
            reloadThrottleTimers.delete(sessionId);
          }
          reloadLastFiredAt.delete(sessionId);
        }

        // Trigger a final session data reload as a safety net.
        // During streaming, ai:message-logged events trigger throttled reloads.
        // But those events can be silently dropped if sessionListWorkspaceAtom
        // is null (e.g., after HMR re-evaluates the sessions module, or during
        // a race between listener init and session list init). This final reload
        // on session:completed ensures all messages are loaded regardless.
        //
        // For sessions with live canonical events, DB reloads are safe because
        // handleTranscriptEvent merges DB messages with live-projected messages.
        if (resolvedWorkspacePath) {
          // Immediate reload
          store.set(reloadSessionDataAtom, { sessionId, workspacePath: resolvedWorkspacePath });

          // Schedule a verification reload after a short delay.
          const verificationWorkspacePath = resolvedWorkspacePath;
          const existingVerification = verificationReloadTimers.get(sessionId);
          if (existingVerification) {
            clearTimeout(existingVerification);
          }
          verificationReloadTimers.set(sessionId, setTimeout(() => {
            verificationReloadTimers.delete(sessionId);
            store.set(reloadSessionDataAtom, { sessionId, workspacePath: verificationWorkspacePath });
          }, VERIFICATION_RELOAD_DELAY_MS));
        }

        // If this session is in a worktree, trigger a git panel refresh
        // This ensures the GitOperationsPanel shows updated status after agent work
        //
        // We check multiple sources for worktreeId since there can be race conditions
        // between IPC events and renderer state updates:
        // 1. sessionRegistryAtom - populated by addSessionFullAtom (optimistic)
        // 2. sessionStoreAtom - loaded session data from database
        // 3. workstreamStateAtom - initialized when session is selected
        {
          let worktreeId: string | null = null;

          // Try registry first (most common case)
          const registry = store.get(sessionRegistryAtom);
          const sessionMeta = registry.get(sessionId);
          if (sessionMeta?.worktreeId) {
            worktreeId = sessionMeta.worktreeId;
          }

          // Fallback to session store (loaded session data)
          if (!worktreeId) {
            const sessionData = store.get(sessionStoreAtom(sessionId));
            if (sessionData?.worktreeId) {
              worktreeId = sessionData.worktreeId;
            }
          }

          // Fallback to workstream state (set when session is initialized)
          if (!worktreeId) {
            const workstreamState = store.get(workstreamStateAtom(sessionId));
            if (workstreamState?.worktreeId) {
              worktreeId = workstreamState.worktreeId;
            }
          }

          if (worktreeId) {
            store.set(triggerWorktreeRefreshAtom, worktreeId);
          }
        }

        // Check if this session is part of a blitz and all siblings are done.
        // If so, trigger creation of an analysis session.
        {
          const registry = store.get(sessionRegistryAtom);
          const sessionMeta = registry.get(sessionId);
          if (sessionMeta?.parentSessionId) {
            const parentMeta = registry.get(sessionMeta.parentSessionId);
            if (parentMeta?.sessionType === 'blitz') {
              const blitzId = parentMeta.id;
              if (!blitzAnalysisTriggered.has(blitzId)) {
                // Find all child sessions of this blitz
                const childSessionIds: string[] = [];
                for (const [id, meta] of registry) {
                  if (meta.parentSessionId === blitzId && id !== blitzId) {
                    childSessionIds.push(id);
                  }
                }
                // Check if ALL children are done (not processing)
                const allDone = childSessionIds.every(
                  id => !store.get(sessionProcessingAtom(id))
                );
                if (allDone) {
                  blitzAnalysisTriggered.add(blitzId);
                  const wsPath = sessionMeta.workspaceId;
                  if (wsPath) {
                    window.electronAPI.invoke('blitz:create-analysis-session', blitzId, wsPath)
                      .catch((err: Error) => {
                        console.error('[sessionStateListeners] Failed to trigger blitz analysis:', err);
                        blitzAnalysisTriggered.delete(blitzId);
                      });
                  }
                }
              }
            }
          }
        }
        break;

      default:
        // Unknown event type - ignore
        break;
    }
  };

  const removePendingPromptIdentity = (sessionId: string, promptId?: string) => {
    const current = store.get(sessionPendingPromptsAtom(sessionId));
    const remaining = promptId
      ? current.filter((prompt) => prompt.promptId !== promptId)
      : [];
    store.set(sessionPendingPromptsAtom(sessionId), remaining);
    store.set(sessionHasPendingInteractivePromptAtom(sessionId), remaining.length > 0);
  };

  const upsertPendingPromptIdentity = (prompt: PendingPrompt) => {
    const current = store.get(sessionPendingPromptsAtom(prompt.sessionId));
    const withoutDuplicate = current.filter((entry) => entry.promptId !== prompt.promptId);
    store.set(sessionPendingPromptsAtom(prompt.sessionId), [...withoutDuplicate, prompt]);
    store.set(sessionHasPendingInteractivePromptAtom(prompt.sessionId), true);
  };

  /**
   * Handle message-logged events globally.
   * This ensures that sessions get reloaded even when their SessionTranscript
   * component is not currently mounted (e.g., inactive tabs, child sessions not selected).
   *
   * SessionTranscript also subscribes to this event for the active session,
   * but this handler provides a safety net for all other sessions.
   *
   * Also marks sessions as unread when they receive output messages while not being
   * the currently viewed session.
   */
  const handleMessageLogged = (data: { sessionId: string; direction: string; workspacePath?: string }) => {
    const { sessionId, direction, workspacePath: eventWorkspacePath } = data;
    if (!sessionId) return;

    const registry = store.get(sessionRegistryAtom);
    const sessionMeta = registry.get(sessionId);
    // Prefer the workspacePath sent by main — it is the session's owning
    // path (resolved against the worktree's parent workspace_id by the main
    // process), which the registry only knows about while that project is
    // the active one. After a rail switch the registry has been replaced
    // with the new project's sessions and `sessionMeta?.workspaceId` is
    // undefined, so a legacy fallback to the visible project would route
    // the reload to the wrong workspace.
    //
    // Multi-project rail: any event we receive is intended for a workspace
    // this window owns (the main process scopes the subscription). Don't
    // re-filter against the visible project — that drops events for
    // sessions in inactive rail projects and leaves their UI stale.
    const ownedWorkspacePath = eventWorkspacePath || sessionMeta?.workspaceId || null;
    if (!ownedWorkspacePath) {
      return;
    }

    const workspacePath = ownedWorkspacePath;

    // Throttle session data reload per session (leading + trailing edge).
    // During active streaming, message-logged fires on every chunk which would
    // trigger a full DB reload of ALL messages (2000+) each time. PGLite is
    // single-threaded, so these reads queue up and block writes, causing a
    // cascading slowdown. Throttling limits to one reload per RELOAD_THROTTLE_MS
    // while firing immediately on the first event after a quiet period (so tool
    // results are picked up promptly, not delayed until streaming stops).
    //
    // For sessions with live canonical events, DB reloads are still safe because
    // handleTranscriptEvent merges DB messages with live-projected messages.
    {
      const now = Date.now();
      const lastFired = reloadLastFiredAt.get(sessionId) ?? 0;

      // Cancel any pending trailing-edge reload
      const existingTimer = reloadThrottleTimers.get(sessionId);
      if (existingTimer) {
        clearTimeout(existingTimer);
      }

      if (now - lastFired >= RELOAD_THROTTLE_MS) {
        // Enough time since last reload — fire immediately (leading edge)
        reloadLastFiredAt.set(sessionId, now);
        store.set(reloadSessionDataAtom, { sessionId, workspacePath });
      }

      // Always schedule a trailing-edge reload to catch the final event
      reloadThrottleTimers.set(sessionId, setTimeout(() => {
        reloadThrottleTimers.delete(sessionId);
        reloadLastFiredAt.set(sessionId, Date.now());
        store.set(reloadSessionDataAtom, { sessionId, workspacePath });
      }, RELOAD_THROTTLE_MS));
    }

    // Bump the per-session activity atom. Individual list-item subscribers
    // re-render their own relative-time labels without churning
    // sessionRegistryAtom (which would cascade through sessionListRootAtom,
    // SessionHistory's filter effect, and every workstream/group derivation).
    // The registry's `updatedAt` stays at the value from the last DB refresh
    // — sort order during a live turn is driven by `markSessionTurnActivityAtom`,
    // not by per-message timestamps.
    // Per-message bumps are limited to the row's own relative-time label.
    // Do NOT write `markSessionTurnActivityAtom` here or bump the parent's
    // turn-activity: those drive the agent-mode sort (via
    // `workspaceSessionTurnActivityAtom`), and per-chunk writes re-fire the
    // SessionHistory sort cascade and the downstream `session-files:get-by-session`
    // storm that the May 28 fix (commit 3d613ecfc) eliminated. Parent
    // workstream rows still rise to the top via the turn-boundary bumps in
    // the `session:started`/`waiting`/`completed` cases above; that's the
    // intended cadence for re-sorts.
    store.set(sessionLastActivityAtom(sessionId), Date.now());

    // Only mutate the registry to flip `isArchived: false` when it actually
    // is currently archived. The database layer unarchives on insert; the
    // unconditional registry write that used to happen here was the single
    // biggest source of SessionHistory churn during streaming (706-entry
    // Map rebuilt + sessionListRootAtom re-derived + setSessions cascade per
    // streamed chunk).
    if (sessionMeta?.isArchived) {
      store.set(updateSessionStoreAtom, { sessionId, updates: { isArchived: false } });
    }

    // Mark as unread if this is an output message (agent response) and the session
    // is not currently being viewed
    if (direction === 'output') {
      const selectedWorkstream = store.get(selectedWorkstreamAtom(workspacePath));

      // Determine the currently viewed session ID
      // For a single session, it's the workstream ID itself
      // For a workstream/worktree, it's the active child within it
      let currentlyViewedSessionId: string | null = null;
      if (selectedWorkstream) {
        const activeChild = store.get(workstreamActiveChildAtom(selectedWorkstream.id));
        currentlyViewedSessionId = activeChild || selectedWorkstream.id;
      }

      // If this message is for a session that's not currently viewed, mark it as unread
      if (sessionId !== currentlyViewedSessionId) {
        store.set(sessionUnreadAtom(sessionId), true);
        store.set(markSessionUnreadAtom, { sessionId, workspacePath });

        // Persist to database metadata for cross-device sync
        window.electronAPI?.invoke('ai:updateSessionMetadata', sessionId, {
          metadata: { hasUnread: true },
        }).catch((err: Error) => {
          console.error('[sessionStateListeners] Failed to persist unread state:', err);
        });
      } else {
        // Session IS currently viewed - push lastReadAt (debounced) so other
        // devices (iOS) know the user is reading these messages in real time.
        // Without this, iOS would show the session as unread because it sees
        // lastMessageAt increasing but lastReadAt staying stale.
        store.set(clearSessionUnreadAtom, { sessionId, workspacePath });
        const existingReadTimer = readStateSyncTimers.get(sessionId);
        if (existingReadTimer) {
          clearTimeout(existingReadTimer);
        }
        readStateSyncTimers.set(sessionId, setTimeout(() => {
          readStateSyncTimers.delete(sessionId);
          window.electronAPI?.invoke('ai:updateSessionMetadata', sessionId, {
            metadata: { hasUnread: false, lastReadAt: Date.now() },
          }).catch((err: Error) => {
            console.error('[sessionStateListeners] Failed to sync read state:', err);
          });
        }, READ_STATE_SYNC_DEBOUNCE_MS));
      }
    }
  };

  /**
   * Handle transcript reparse completion without mutating unread/activity
   * state. A canonical reparse changes transcript structure, not session
   * activity.
   */
  const handleTranscriptSessionReparsed = (data: { sessionId: string; workspacePath?: string }) => {
    const { sessionId, workspacePath: eventWorkspacePath } = data;
    if (!sessionId) return;

    const registry = store.get(sessionRegistryAtom);
    const sessionMeta = registry.get(sessionId);
    const workspacePath = eventWorkspacePath || sessionMeta?.workspaceId || null;
    if (!workspacePath) return;

    store.set(reloadSessionDataAtom, { sessionId, workspacePath });
  };

  /**
   * Handle coalesced batch-write events from AgentMessageWriteQueue.
   *
   * The queue emits one event per affected session per flush, replacing the
   * per-chunk `ai:message-logged` events that used to fire from
   * `logAgentMessageNonBlocking`. Adapt the batch payload to the existing
   * per-row handler so the same throttled reload + unread-marking logic
   * applies. A 'mixed' direction (input + output rows in the same flush)
   * is treated as 'output' for unread purposes since it always contains at
   * least one output row.
   *
   * Hidden rows are already excluded from the batch's count by the queue,
   * so we don't need to filter again here.
   */
  const handleMessagesLoggedBatch = (data: {
    sessionId: string;
    count: number;
    direction: 'input' | 'output' | 'mixed';
    workspacePath?: string;
  }) => {
    if (!data?.sessionId || !data.count) return;
    const effectiveDirection = data.direction === 'input' ? 'input' : 'output';
    handleMessageLogged({
      sessionId: data.sessionId,
      direction: effectiveDirection,
      workspacePath: data.workspacePath,
    });
  };

  /**
   * Handle session title updates globally.
   * This ensures the session list updates when the agent names a session via MCP tool.
   */
  const handleTitleUpdated = (data: { sessionId: string; title: string }) => {
    const { sessionId, title } = data;
    if (!sessionId || !title) return;

    // Update session with new title
    // This automatically syncs both sessionStoreAtom and sessionRegistryAtom
    store.set(updateSessionStoreAtom, { sessionId, updates: { title, updatedAt: Date.now() } });
  };

  /**
   * Handle AskUserQuestion events globally.
   * Sets the pending interactive prompt indicator for the sidebar.
   * Also pushes the prompt data directly into sessionPendingPromptsAtom
   * so voice mode listeners can immediately read the question text/options
   * (without waiting for a DB roundtrip that may race with persistence).
   */
  const handleAskUserQuestion = (data: { sessionId: string; questionId: string; questions?: any[] }) => {
    const { sessionId, questionId } = data;
    if (!sessionId) return;
    // Push prompt data directly into the prompts atom so voice mode
    // can read it immediately. The DB may not have persisted it yet.
    const prompt: PendingPrompt = {
      id: questionId,
      sessionId,
      promptType: 'ask_user_question_request',
      promptId: questionId,
      data: { type: 'ask_user_question_request', questionId, questions: data.questions || [] },
      createdAt: Date.now(),
    };
    upsertPendingPromptIdentity(prompt);
  };

  /**
   * Handle AskUserQuestion answered/cancelled events globally.
   * Clears the pending interactive prompt indicator.
   */
  const handleAskUserQuestionResolved = (data: { sessionId: string; questionId?: string }) => {
    const { sessionId } = data;
    if (!sessionId) return;
    removePendingPromptIdentity(sessionId, data.questionId);
  };

  /**
   * Handle ExitPlanMode confirm events globally.
   * Sets pending interactive prompt indicator for the sidebar.
   */
  const handleExitPlanModeConfirm = (data: { sessionId: string; requestId: string }) => {
    const { sessionId, requestId } = data;
    if (!sessionId) return;
    const prompt: PendingPrompt = {
      id: requestId,
      sessionId,
      promptType: 'exit_plan_mode_request',
      promptId: requestId,
      data: { type: 'exit_plan_mode_request', requestId },
      createdAt: Date.now(),
    };
    upsertPendingPromptIdentity(prompt);
  };

  /**
   * Handle ExitPlanMode response events globally.
   * Clears pending indicator and updates session mode if approved.
   */
  const handleExitPlanModeResolved = (data: { sessionId: string; approved?: boolean; requestId?: string }) => {
    const { sessionId, approved } = data;
    if (!sessionId) return;
    removePendingPromptIdentity(sessionId, data.requestId);

    // If approved, update the session mode atom to 'agent' to sync with database
    if (approved) {
      store.set(updateSessionStoreAtom, {
        sessionId,
        updates: { mode: 'agent' },
      });
    }
  };

  /**
   * Handle ToolPermission events globally.
   * Sets pending interactive prompt indicator for the sidebar.
   */
  const handleToolPermission = (data: { sessionId: string; requestId: string; toolName?: string; description?: string }) => {
    const { sessionId, requestId } = data;
    if (!sessionId) return;
    const prompt: PendingPrompt = {
      id: requestId,
      sessionId,
      promptType: 'permission_request',
      promptId: requestId,
      data: { type: 'permission_request', requestId, toolName: data.toolName, description: data.description },
      createdAt: Date.now(),
    };
    upsertPendingPromptIdentity(prompt);
  };

  /**
   * Handle ToolPermission resolved events globally.
   * Clears pending interactive prompt indicator.
   */
  const handleToolPermissionResolved = (data: { sessionId: string; requestId: string }) => {
    const { sessionId, requestId } = data;
    if (!sessionId) return;
    removePendingPromptIdentity(sessionId, requestId);
  };

  /**
   * Handle GitCommitProposal events globally.
   * Sets pending interactive prompt indicator for the sidebar.
   */
  const handleGitCommitProposal = (data: {
    sessionId: string;
    proposalId: string;
    commitMessage?: string;
    filesToStage?: Array<string | { path: string; status?: string }>;
    workspacePath?: string;
  }) => {
    const { sessionId, proposalId } = data;
    if (!sessionId) return;
    const prompt: PendingPrompt = {
      id: proposalId,
      sessionId,
      promptType: 'git_commit_proposal_request',
      promptId: proposalId,
      data: {
        type: 'git_commit_proposal_request',
        proposalId,
        commitMessage: data.commitMessage,
        filesToStage: data.filesToStage,
        workspacePath: data.workspacePath,
      },
      createdAt: Date.now(),
    };
    upsertPendingPromptIdentity(prompt);
  };

  /**
   * Handle GitCommitProposal resolved events globally.
   * Clears pending interactive prompt indicator.
   */
  const handleGitCommitProposalResolved = (data: { sessionId: string; proposalId: string }) => {
    const { sessionId, proposalId } = data;
    if (!sessionId) return;
    removePendingPromptIdentity(sessionId, proposalId);
  };

  /**
   * Handle RequestUserInput events globally.
   * Push prompt data into the atom so voice mode can read it (and so the
   * sidebar pending indicator lights up). The widget itself reads from
   * `toolCall.arguments` -- this atom is for cross-cutting consumers.
   */
  const handleRequestUserInput = (data: { sessionId: string; promptId: string; args: any }) => {
    const { sessionId, promptId, args } = data;
    if (!sessionId || !promptId) return;
    const prompt: PendingPrompt = {
      id: promptId,
      sessionId,
      promptType: 'request_user_input_request',
      promptId,
      data: { type: 'request_user_input_request', promptId, args },
      createdAt: Date.now(),
    };
    upsertPendingPromptIdentity(prompt);
  };

  /**
   * Handle RequestUserInput resolved events globally.
   * Clears pending interactive prompt indicator.
   */
  const handleRequestUserInputResolved = (data: { sessionId: string; promptId: string }) => {
    const { sessionId, promptId } = data;
    if (!sessionId) return;
    removePendingPromptIdentity(sessionId, promptId);
  };

  /**
   * Handle notification click events.
   * Switches to the session that was clicked in the OS notification.
   * If the session is a child of a workstream, selects the parent instead.
   */
  const handleNotificationClicked = (data: { sessionId: string }) => {
    const { sessionId } = data;
    if (!sessionId) return;

    const workspacePath = store.get(sessionListWorkspaceAtom);
    if (!workspacePath) {
      console.warn('[sessionStateListeners] No workspace path available for notification click');
      return;
    }

    // Switch to agent mode so the session is visible
    store.set(setWindowModeAtom, 'agent');

    // Check if this is a child session - if so, select the parent workstream
    const registry = store.get(sessionRegistryAtom);
    const sessionMeta = registry.get(sessionId);
    if (sessionMeta?.parentSessionId) {
      // Child session - select parent and set this child as active
      const parentState = store.get(workstreamStateAtom(sessionMeta.parentSessionId));
      const parentType = parentState.type === 'worktree' ? 'worktree'
        : parentState.type === 'workstream' ? 'workstream'
        : 'workstream'; // Default to workstream since it has children
      store.set(setSelectedWorkstreamAtom, {
        workspacePath,
        selection: { type: parentType, id: sessionMeta.parentSessionId },
      });
      return;
    }

    // Root session - determine its type
    const state = store.get(workstreamStateAtom(sessionId));
    const type = state.type === 'worktree' ? 'worktree'
      : state.type === 'workstream' ? 'workstream'
      : 'session';

    store.set(setSelectedWorkstreamAtom, {
      workspacePath,
      selection: { type, id: sessionId },
    });
  };

  /**
   * Handle cross-device draft input from sync.
   * Apply the remote draft unless it's a stale echo from before a local submit
   * or older than what the user is currently typing locally.
   */
  const handleSyncDraftInput = (data: { sessionId: string; draftInput: string; draftUpdatedAt?: number }) => {
    const { sessionId, draftInput, draftUpdatedAt } = data;
    if (!sessionId) return;

    // Reject stale draft echoes: if we recently submitted a prompt and the
    // remote draft is non-empty with a timestamp from before our submit, skip it.
    if (draftInput && draftUpdatedAt) {
      const lastSubmitAt = store.get(sessionLastSubmitAtAtom(sessionId));
      if (lastSubmitAt > 0 && draftUpdatedAt <= lastSubmitAt) {
        return;
      }
    }

    // Reject sync echoes older than our local typing.
    // When the user is actively typing, the local modification timestamp advances
    // ahead of any echoed drafts from the server. Only accept remote drafts that
    // are genuinely newer (e.g., typed on mobile after we stopped typing here).
    if (draftUpdatedAt) {
      const localModifiedAt = store.get(sessionDraftLocalModifiedAtAtom(sessionId));
      if (localModifiedAt > 0 && draftUpdatedAt <= localModifiedAt) {
        return;
      }
    }

    store.set(sessionDraftInputAtom(sessionId), draftInput);
  };

  /**
   * Handle cross-device read state from sync.
   * When another device (e.g. mobile) reads a session, update the unread atom.
   */
  const handleSyncReadState = (data: { sessionId: string; lastReadAt: number; lastMessageAt: number }) => {
    const { sessionId, lastReadAt, lastMessageAt } = data;
    if (!sessionId) return;

    // If the session was read after the last message, mark it as read
    if (lastReadAt >= lastMessageAt) {
      store.set(sessionUnreadAtom(sessionId), false);
      store.set(sessionLastReadAtom(sessionId), lastReadAt);
    }
  };

  // Handle for the self-healing processing-state reconcile interval (below).
  let processingReconcileInterval: ReturnType<typeof setInterval> | undefined;

  // First, subscribe to the session state manager (IPC call to register this window).
  // Workspace can change during app lifetime; this is updated via updateSessionStateListenerWorkspace().
  activeWorkspacePathSnapshot = store.get(sessionListWorkspaceAtom) || null;
  reconcileSessionStateSubscription();

  // Restore + reconcile processing spinners using getRunningSessionIds (status
  // running/streaming), NOT bare activeSessions membership: the latter retains
  // idle claude-code-cli sessions between turns and pinned their spinner forever
  // (NIM-846). We also heal strays: clear the processing atom for any known
  // session that is NOT running, so a dropped terminal event (or a stale spinner)
  // cannot stay stuck. If the preload predates getRunningSessionIds, skip rather
  // than fall back to membership; a running session's spinner is re-established by
  // its next streaming event.
  //
  // Runs once on init, on a slow interval, AND - debounced - on every terminal
  // session event (via scheduleProcessingReconcile), so a parent meta-agent header
  // (which reflects child processing through the canonical indicator inputs) clears
  // within ~1s when a child finishes instead of staying stuck until the user clicks
  // the child.
  const reconcileProcessingState = async () => {
    const api = window.electronAPI.sessionState;
    if (!api.getRunningSessionIds) return;
    try {
      const result = await api.getRunningSessionIds();
      if (!result?.success) return;
      const running = new Set(result.sessionIds);
      for (const sessionId of running) {
        store.set(sessionProcessingAtom(sessionId), true);
      }
      // Heal strays across the SAME superset the meta-agent header aggregates
      // over the parent plus its child-processing inputs. The header reads
      // children from sessionChildrenAtom too, and a meta-agent child can sit in
      // sessionChildrenAtom while NOT being a sessionRegistryAtom key (child-added
      // patches the former; archived / worktree-archived children are dropped from
      // sessions:list). Iterating the registry alone left such a child's stuck
      // processing atom unhealed, pinning the header until the user clicked the
      // child. Union the registry keys with every parent's loaded children.
      const candidates = new Set<string>(store.get(sessionRegistryAtom).keys());
      for (const parentId of store.get(sessionRegistryAtom).keys()) {
        const children = store.get(sessionChildrenAtom(parentId));
        if (Array.isArray(children)) {
          for (const childId of children) candidates.add(childId);
        }
      }
      let healed = 0;
      for (const sessionId of candidates) {
        if (!running.has(sessionId) && store.get(sessionProcessingAtom(sessionId))) {
          store.set(sessionProcessingAtom(sessionId), false);
          healed++;
        }
      }
      if (healed > 0) {
        console.debug(
          `[sessionStateListeners] reconcile: healed ${healed} stuck processing session(s)`,
        );
      }
    } catch (error) {
      console.error('[sessionStateListeners] reconcileProcessingState failed:', error);
    }
  };
  void reconcileProcessingState();
  processingReconcileInterval = setInterval(() => void reconcileProcessingState(), 15000);

  // Debounced trigger wired now that reconcileProcessingState exists; fired from
  // the terminal-event branch of handleStateChange. Coalesces a burst of
  // completions (several children finishing) into one re-sync.
  let reconcileDebounceTimer: ReturnType<typeof setTimeout> | undefined;
  const scheduleProcessingReconcile = () => {
    if (reconcileDebounceTimer) clearTimeout(reconcileDebounceTimer);
    reconcileDebounceTimer = setTimeout(() => void reconcileProcessingState(), 600);
  };

  // Then, listen for state change events
  window.electronAPI.sessionState.onStateChange(handleStateChange);

  // Subscribe to message logged events and interactive prompt events
  let cleanupMessageLogged: (() => void) | undefined;
  let cleanupTitleUpdated: (() => void) | undefined;
  // ---------------------------------------------------------------------------
  // Live canonical transcript event handler
  // ---------------------------------------------------------------------------
  const handleTranscriptEvent = (transcriptEvent: TranscriptEvent) => {
    if (!transcriptEvent.sessionId) return;
    // The accumulator decides whether the change is a cheap in-place patch
    // or requires a full re-projection, then flushes once per animation
    // frame. See `transcriptStreamAccumulator.ts` for the rationale.
    transcriptAccumulator.apply(transcriptEvent);
  };

  let cleanupAskUserQuestion: (() => void) | undefined;
  let cleanupAskUserQuestionAnswered: (() => void) | undefined;
  let cleanupSessionCancelled: (() => void) | undefined;
  let cleanupExitPlanModeConfirm: (() => void) | undefined;
  let cleanupExitPlanModeResolved: (() => void) | undefined;
  let cleanupToolPermission: (() => void) | undefined;
  let cleanupToolPermissionResolved: (() => void) | undefined;
  let cleanupGitCommitProposal: (() => void) | undefined;
  let cleanupGitCommitProposalResolved: (() => void) | undefined;
  let cleanupRequestUserInput: (() => void) | undefined;
  let cleanupRequestUserInputResolved: (() => void) | undefined;
  let cleanupNotificationClicked: (() => void) | undefined;
  let cleanupSyncReadState: (() => void) | undefined;
  let cleanupSyncDraftInput: (() => void) | undefined;
  let cleanupTranscriptEvent: (() => void) | undefined;
  let cleanupTranscriptSessionReparsed: (() => void) | undefined;
  let cleanupMessagesLoggedBatch: (() => void) | undefined;
  if (window.electronAPI?.on) {
    cleanupTranscriptEvent = window.electronAPI.on('transcript:event', handleTranscriptEvent);
    cleanupTranscriptSessionReparsed = window.electronAPI.on('transcript:session-reparsed', handleTranscriptSessionReparsed);
    cleanupMessageLogged = window.electronAPI.on('ai:message-logged', handleMessageLogged);
    cleanupMessagesLoggedBatch = window.electronAPI.on('ai:messages-logged-batch', handleMessagesLoggedBatch);
    cleanupTitleUpdated = window.electronAPI.on('session:title-updated', handleTitleUpdated);
    cleanupAskUserQuestion = window.electronAPI.on('ai:askUserQuestion', handleAskUserQuestion);
    cleanupAskUserQuestionAnswered = window.electronAPI.on('ai:askUserQuestionAnswered', handleAskUserQuestionResolved);
    cleanupSessionCancelled = window.electronAPI.on('ai:sessionCancelled', handleAskUserQuestionResolved);
    cleanupExitPlanModeConfirm = window.electronAPI.on('ai:exitPlanModeConfirm', handleExitPlanModeConfirm);
    cleanupExitPlanModeResolved = window.electronAPI.on('ai:exitPlanModeResolved', handleExitPlanModeResolved);
    cleanupToolPermission = window.electronAPI.on('ai:toolPermission', handleToolPermission);
    cleanupToolPermissionResolved = window.electronAPI.on('ai:toolPermissionResolved', handleToolPermissionResolved);
    cleanupGitCommitProposal = window.electronAPI.on('ai:gitCommitProposal', handleGitCommitProposal);
    cleanupGitCommitProposalResolved = window.electronAPI.on('ai:gitCommitProposalResolved', handleGitCommitProposalResolved);
    cleanupRequestUserInput = window.electronAPI.on('ai:requestUserInput', handleRequestUserInput);
    cleanupRequestUserInputResolved = window.electronAPI.on('ai:requestUserInputResolved', handleRequestUserInputResolved);
    cleanupNotificationClicked = window.electronAPI.on('notification-clicked', handleNotificationClicked);
    cleanupSyncReadState = window.electronAPI.on('sessions:sync-read-state', handleSyncReadState);
    cleanupSyncDraftInput = window.electronAPI.on('sessions:sync-draft-input', handleSyncDraftInput);
  }

  // Return cleanup function
  return () => {
    // Clear all pending throttle timers
    for (const timer of reloadThrottleTimers.values()) {
      clearTimeout(timer);
    }
    reloadThrottleTimers.clear();
    reloadLastFiredAt.clear();

    for (const timer of verificationReloadTimers.values()) {
      clearTimeout(timer);
    }
    verificationReloadTimers.clear();

    for (const timer of readStateSyncTimers.values()) {
      clearTimeout(timer);
    }
    readStateSyncTimers.clear();

    blitzAnalysisTriggered.clear();

    if (processingReconcileInterval) {
      clearInterval(processingReconcileInterval);
      processingReconcileInterval = undefined;
    }
    if (reconcileDebounceTimer) {
      clearTimeout(reconcileDebounceTimer);
      reconcileDebounceTimer = undefined;
    }

    window.electronAPI.sessionState?.removeStateChangeListener?.(handleStateChange);
    window.electronAPI.sessionState?.unsubscribe?.();
    activeWorkspacePathSnapshot = null;
    lastSubscriptionKey = '';
    cleanupMessageLogged?.();
    cleanupMessagesLoggedBatch?.();
    cleanupTitleUpdated?.();
    cleanupAskUserQuestion?.();
    cleanupAskUserQuestionAnswered?.();
    cleanupSessionCancelled?.();
    cleanupExitPlanModeConfirm?.();
    cleanupExitPlanModeResolved?.();
    cleanupToolPermission?.();
    cleanupToolPermissionResolved?.();
    cleanupGitCommitProposal?.();
    cleanupGitCommitProposalResolved?.();
    cleanupRequestUserInput?.();
    cleanupRequestUserInputResolved?.();
    cleanupNotificationClicked?.();
    cleanupSyncReadState?.();
    cleanupSyncDraftInput?.();
    cleanupTranscriptEvent?.();
    cleanupTranscriptSessionReparsed?.();
    transcriptAccumulator.clear();
  };
}
