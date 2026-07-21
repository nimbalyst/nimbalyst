/**
 * IPC Handlers for Session State Management
 *
 * Provides cross-process communication for session state tracking.
 */

import { BrowserWindow } from 'electron';
import { getSessionStateManager } from '@nimbalyst/runtime/ai/server/SessionStateManager';
import type { SessionStateEvent } from '@nimbalyst/runtime/ai/server/types/SessionState';
import { safeHandle, safeOn } from '../utils/ipcRegistry';
import { database } from '../database/PGLiteDatabaseWorker';
import {
  resolveOwnedWorkspacePath,
  sessionEventMatchesWorkspace,
} from '../../shared/sessionWorkspaceRouting';
import { parseJsonObjectColumn } from '../utils/jsonColumn';
import { setSessionPendingPrompt } from '../services/ai/pendingPromptPersistence';
import { attentionEventService } from '../services/AttentionEventService';
import {
  clearStalePendingPromptOnTerminal,
  findCompletedSessionsWithPendingPrompt,
} from '../services/ai/pendingPromptTerminalClear';
import { endHostBoundAiSession } from '../services/ai/aiServiceQueuedChainSettlement';

// Track if handlers are registered to prevent double registration
let handlersRegistered = false;

// Track active subscriptions per window
const windowSubscriptions = new Map<number, () => void>();

// Track sync subscription cleanup
let syncSubscriptionCleanup: (() => void) | null = null;
const sessionWorkspaceCache = new Map<string, string | null>();

type SessionStateEndManager = Pick<
  ReturnType<typeof getSessionStateManager>,
  'endSession' | 'getSessionState'
>;

export function registerHostBoundSessionEndHandler(
  stateManager: SessionStateEndManager,
  register: typeof safeHandle = safeHandle,
): void {
  // Explicit renderer command targets the turn current at invocation time.
  register('ai-session-state:end', async (_event, sessionId: string) => {
    try {
      const attentionGeneration = stateManager.getSessionState(sessionId)?.attentionGeneration;
      if (!attentionGeneration) return { success: false, error: 'session turn is no longer active' };
      const ended = await endHostBoundAiSession(stateManager, sessionId, {
        attentionGeneration,
      });
      return ended
        ? { success: true }
        : { success: false, error: 'session turn is no longer active' };
    } catch (error) {
      console.error('[SessionStateHandlers] Error ending session:', error);
      return { success: false, error: String(error) };
    }
  });
}

async function getCanonicalWorkspacePathForSession(sessionId: string): Promise<string | null> {
  if (sessionWorkspaceCache.has(sessionId)) {
    return sessionWorkspaceCache.get(sessionId) ?? null;
  }

  try {
    const { rows } = await database.query<{ workspace_id: string | null }>(
      `SELECT workspace_id
       FROM ai_sessions
       WHERE id = $1
       LIMIT 1`,
      [sessionId]
    );
    const workspacePath = rows[0]?.workspace_id ?? null;
    // Only cache a RESOLVED (non-null) path. A null here usually means the
    // session row was not committed yet when the first event fired (common for
    // meta-agent child sessions created mid-run). Caching null would PERMANENTLY
    // drop every later event for this session, because the workspace filter
    // never matches null -- which pinned child spinners on "Thinking..." forever
    // and left the meta-agent's aggregate stuck. Leaving null uncached lets the
    // next event re-resolve once the row is committed.
    if (workspacePath !== null) {
      sessionWorkspaceCache.set(sessionId, workspacePath);
    }
    return workspacePath;
  } catch (error) {
    console.error('[SessionStateHandlers] Failed to resolve canonical workspace path:', error);
    return null;
  }
}

/**
 * Read the authoritative persisted prompt bit plus its turn identity.
 * Returns null when the row is missing or unreadable so callers can no-op
 * instead of churning a write. Parses the metadata column with the
 * backend-divergent helper (SQLite hands back a raw JSON string).
 */
async function readPersistedHasPendingPrompt(sessionId: string): Promise<{
  hasPendingPrompt: boolean;
  promptId?: string;
  generation?: string;
} | null> {
  try {
    const { rows } = await database.query<{ metadata: unknown }>(
      `SELECT metadata FROM ai_sessions WHERE id = $1 LIMIT 1`,
      [sessionId]
    );
    if (rows.length === 0) return null;
    const metadata = parseJsonObjectColumn(rows[0].metadata);
    const promptId = metadata.pendingPromptId;
    const generation = metadata.pendingPromptGeneration;
    return {
      hasPendingPrompt: metadata.hasPendingPrompt === true,
      ...(typeof promptId === 'string' && promptId ? { promptId } : {}),
      ...(typeof generation === 'string' && generation ? { generation } : {}),
    };
  } catch (error) {
    console.error('[SessionStateHandlers] Failed to read hasPendingPrompt:', error);
    return null;
  }
}

/** One-time-by-state startup repair for rows created before NIM-871. */
async function clearHistoricalCompletedPendingPrompts(): Promise<void> {
  try {
    const { rows } = await database.query<{ id: string; metadata: unknown }>(
      `SELECT id, metadata FROM ai_sessions`,
    );
    const staleIds = findCompletedSessionsWithPendingPrompt(
      rows.map((row) => ({ id: row.id, metadata: parseJsonObjectColumn(row.metadata) })),
    );
    for (const sessionId of staleIds) {
      await setSessionPendingPrompt(sessionId, false);
    }
    if (staleIds.length > 0) {
      console.log(`[SessionStateHandlers] Cleared stale pending-prompt state from ${staleIds.length} completed session(s)`);
    }
  } catch (error) {
    console.error('[SessionStateHandlers] Failed to repair completed pending prompts:', error);
  }
}

export async function registerSessionStateHandlers() {
  if (handlersRegistered) {
    console.log('[SessionStateHandlers] Handlers already registered, skipping');
    return;
  }

  const stateManager = getSessionStateManager();

  // Initialize the state manager
  await stateManager.initialize();
  await clearHistoricalCompletedPendingPrompts();

  // Subscribe to state changes and sync to mobile
  setupSyncSubscription(stateManager);

  // NIM-871 / NIM-362: when a turn reaches a terminal state, clear only the
  // prompt owned by that event's captured attention generation.
  // pending-prompt bit. An interactive prompt that was abandoned (e.g. the user
  // submitted a new prompt instead of answering the widget) otherwise leaves
  // `metadata.hasPendingPrompt` set, and the session-list loader re-seeds the
  // "awaiting user input" indicator from it on every refresh — stuck forever.
  // Single subscription (not per-window) so it fires once per transition; the
  // read/compare guard avoids both prompt-free churn and stale A -> B clears.
  stateManager.subscribe((event: SessionStateEvent) => {
    // Serialize the two JSON-metadata writes. PGLiteSessionStore performs a
    // shallow read/merge/write, so racing them could otherwise resurrect the
    // prompt bit or discard the attention cancellation.
    void (async () => {
      await clearStalePendingPromptOnTerminal(event, {
        readHasPendingPrompt: readPersistedHasPendingPrompt,
        clearPendingPrompt: async (sessionId, options) => {
          const result = await setSessionPendingPrompt(sessionId, false, options);
          if (!result.local.succeeded) {
            throw new Error(`Terminal prompt clear was not durable: ${result.local.error || result.local.skippedReason}`);
          }
          if (!result.sync.succeeded) {
            throw new Error(`Terminal prompt clear sync frame was not written: ${result.sync.error || result.sync.skippedReason}`);
          }
        },
        onError: (err) =>
          console.error('[SessionStateHandlers] Failed to clear stale pending prompt on terminal event:', err),
      });
      await attentionEventService.handleSessionStateEvent(event);
    })().catch((error) => {
      console.error('[SessionStateHandlers] Failed to clear terminal prompt/attention:', error);
    });
  });

  // Get tracked session IDs (bare map membership; may include idle sessions).
  // NOT a "running" signal — see getTrackedSessionIds / NIM-846. Most callers
  // want ai-session-state:get-running instead.
  safeHandle('ai-session-state:get-tracked', async (_event) => {
    try {
      const trackedIds = stateManager.getTrackedSessionIds();
      return { success: true, sessionIds: trackedIds };
    } catch (error) {
      console.error('[SessionStateHandlers] Error getting tracked sessions:', error);
      return { success: false, error: String(error), sessionIds: [] };
    }
  });

  // Get session IDs whose turn is actually in progress (running / streaming).
  // This is the canonical "is it running?" query (NIM-846).
  safeHandle('ai-session-state:get-running', async (_event) => {
    try {
      const sessionIds = stateManager.getRunningSessionIds();
      return { success: true, sessionIds };
    } catch (error) {
      console.error('[SessionStateHandlers] Error getting running sessions:', error);
      return { success: false, error: String(error), sessionIds: [] };
    }
  });

  // Get state for a specific session
  safeHandle('ai-session-state:get-state', async (_event, sessionId: string) => {
    try {
      const state = stateManager.getSessionState(sessionId);
      return { success: true, state };
    } catch (error) {
      console.error('[SessionStateHandlers] Error getting session state:', error);
      return { success: false, error: String(error), state: null };
    }
  });

  // Check if session is active
  safeHandle('ai-session-state:is-active', async (_event, sessionId: string) => {
    try {
      const isActive = stateManager.isSessionActive(sessionId);
      return { success: true, isActive };
    } catch (error) {
      console.error('[SessionStateHandlers] Error checking session active:', error);
      return { success: false, error: String(error), isActive: false };
    }
  });

  // Subscribe to state changes
  safeHandle('ai-session-state:subscribe', async (event, workspacePath?: string | string[]) => {
    try {
      const window = BrowserWindow.fromWebContents(event.sender);
      if (!window) {
        return { success: false, error: 'No window found for sender' };
      }

      const windowId = window.id;

      // Unsubscribe any existing subscription for this window
      const existingUnsubscribe = windowSubscriptions.get(windowId);
      if (existingUnsubscribe) {
        existingUnsubscribe();
      }

      // Normalize the filter to a Set of allowed workspace paths. Multi-project
      // rail windows host several projects at once and must keep receiving
      // lifecycle events for each one, otherwise the UI gets stuck on
      // "Thinking…" when a session in an inactive project completes.
      const allowedPaths = Array.isArray(workspacePath)
        ? new Set(workspacePath.filter((p): p is string => typeof p === 'string' && p.length > 0))
        : workspacePath
          ? new Set([workspacePath])
          : null;

      // Create new subscription
      const unsubscribe = stateManager.subscribe((stateEvent: SessionStateEvent) => {
        void (async () => {
          let sessionWorkspacePath: string | null = null;

          // Workspace-scoped subscription: only send events for workspaces this
          // window cares about. Pass an empty/undefined filter to receive events
          // for all workspaces. Multi-project rail windows host several projects
          // at once, so `allowedPaths` may contain multiple entries; an event
          // matches if it routes to ANY of them. Worktree sessions emit events
          // from the worktree path while their canonical workspace_id is the
          // parent project, so we resolve the session's canonical workspace
          // first and let `sessionEventMatchesWorkspace` consider both.
          if (allowedPaths) {
            sessionWorkspacePath = await getCanonicalWorkspacePathForSession(stateEvent.sessionId);
            let matched = false;
            for (const subscribed of allowedPaths) {
              if (sessionEventMatchesWorkspace({
                subscribedWorkspacePath: subscribed,
                eventWorkspacePath: stateEvent.workspacePath,
                sessionWorkspacePath,
              })) {
                matched = true;
                break;
              }
            }
            const isTerminal =
              stateEvent.type === 'session:completed' ||
              stateEvent.type === 'session:error' ||
              stateEvent.type === 'session:interrupted';
            if (!matched) {
              // A workspace-filter miss on a NON-terminal event is dropped as
              // before (those drive workspace-scoped state and need a real path).
              // But a TERMINAL event is forwarded anyway: the renderer's terminal
              // clear is keyed only by sessionId (workspace-agnostic), so
              // over-delivering it is harmless, while dropping it pins the
              // session's spinner (and a parent meta-agent header) on "Thinking..."
              // - common for a worktree-resident meta-agent child whose canonical
              // workspace_id has not committed or does not match this window.
              if (!isTerminal) return;
              console.warn(
                `[SessionStateHandlers] forwarding unmatched terminal ${stateEvent.type} for session ` +
                `${stateEvent.sessionId} (sessionWorkspacePath=${sessionWorkspacePath ?? 'null'}, ` +
                `eventWorkspacePath=${stateEvent.workspacePath ?? 'null'}) to avoid a stuck spinner`,
              );
            }
          }

          // Send event to renderer with the canonical workspace path when known.
          if (!window.isDestroyed()) {
            window.webContents.send('ai-session-state:event', {
              ...stateEvent,
              workspacePath: resolveOwnedWorkspacePath({
                eventWorkspacePath: stateEvent.workspacePath,
                sessionWorkspacePath,
              }) ?? stateEvent.workspacePath,
            });
          }
        })();
      });

      // Store unsubscribe function
      windowSubscriptions.set(windowId, unsubscribe);

      // Clean up when window closes
      window.once('closed', () => {
        const unsub = windowSubscriptions.get(windowId);
        if (unsub) {
          unsub();
          windowSubscriptions.delete(windowId);
        }
      });

      return { success: true };
    } catch (error) {
      console.error('[SessionStateHandlers] Error subscribing to state changes:', error);
      return { success: false, error: String(error) };
    }
  });

  // Unsubscribe from state changes
  safeHandle('ai-session-state:unsubscribe', async (event) => {
    try {
      const window = BrowserWindow.fromWebContents(event.sender);
      if (!window) {
        return { success: false, error: 'No window found for sender' };
      }

      const windowId = window.id;
      const unsubscribe = windowSubscriptions.get(windowId);

      if (unsubscribe) {
        unsubscribe();
        windowSubscriptions.delete(windowId);
      }

      return { success: true };
    } catch (error) {
      console.error('[SessionStateHandlers] Error unsubscribing:', error);
      return { success: false, error: String(error) };
    }
  });

  // Start tracking a session (called when AI starts processing)
  safeHandle('ai-session-state:start', async (_event, sessionId: string, workspacePath?: string) => {
    try {
      await stateManager.startSession({ sessionId, workspacePath });
      return { success: true };
    } catch (error) {
      console.error('[SessionStateHandlers] Error starting session:', error);
      return { success: false, error: String(error) };
    }
  });

  // Update session activity
  safeHandle('ai-session-state:update-activity', async (_event, sessionId: string, status?: string, isStreaming?: boolean) => {
    try {
      await stateManager.updateActivity({
        sessionId,
        status: status as any,
        isStreaming,
      });
      return { success: true };
    } catch (error) {
      console.error('[SessionStateHandlers] Error updating activity:', error);
      return { success: false, error: String(error) };
    }
  });

  registerHostBoundSessionEndHandler(stateManager);

  // Explicit renderer command targeting the session's current turn. Keep this
  // generationless so a user force-stop interrupts the turn that is current
  // when the command arrives, not a captured historical prompt generation.
  safeHandle('ai-session-state:interrupt', async (_event, sessionId: string) => {
    try {
      await stateManager.interruptSession(sessionId);
      return { success: true };
    } catch (error) {
      console.error('[SessionStateHandlers] Error interrupting session:', error);
      return { success: false, error: String(error) };
    }
  });

  handlersRegistered = true;
  console.log('[SessionStateHandlers] Handlers registered successfully');
}

/**
 * Push a session lifecycle event's execution state (isExecuting) to the mobile
 * sync channel. The sync provider is resolved per-event by the caller rather
 * than captured once, so this works regardless of whether sync was ready when
 * the subscription was registered, and survives provider swaps from
 * `reinitializeSyncWithNewConfig`.
 *
 * NIM-945: when sync is not yet ready (provider null), we skip just this event
 * and leave the subscription live — a stale "isExecuting=true" on mobile is
 * otherwise never cleared, pinning the mobile spinner on "Thinking..." forever.
 */
export function pushExecutionStateToMobile(
  event: SessionStateEvent,
  syncProvider: import('@nimbalyst/runtime/sync').SyncProvider | null,
): void {
  if (
    event.type !== 'session:started' &&
    event.type !== 'session:completed' &&
    event.type !== 'session:interrupted'
  ) {
    return;
  }
  if (!syncProvider) {
    // Sync not enabled/ready yet for this event; the subscription stays live so
    // future lifecycle events still reach mobile once the provider exists.
    return;
  }

  const isExecuting = event.type === 'session:started';
  const sessionId = event.sessionId;

  console.log(`[SessionStateHandlers] Syncing execution state to mobile: sessionId=${sessionId} isExecuting=${isExecuting}`);

  syncProvider.pushChange(sessionId, {
    type: 'metadata_updated',
    metadata: {
      isExecuting,
      updatedAt: Date.now(),
    },
  });
}

/**
 * Setup sync subscription to push execution state changes to mobile
 */
function setupSyncSubscription(stateManager: ReturnType<typeof getSessionStateManager>): void {
  // Lazy load sync manager to avoid circular dependencies.
  // The subscription is ALWAYS registered (even if sync is not yet ready) and
  // resolves the provider per-event via getSyncProvider() — see NIM-945.
  import('../services/SyncManager').then(({ getSyncProvider }) => {
    console.log('[SessionStateHandlers] Setting up execution state sync to mobile');

    const unsubscribe = stateManager.subscribe((event: SessionStateEvent) => {
      pushExecutionStateToMobile(event, getSyncProvider());
    });

    syncSubscriptionCleanup = unsubscribe;
  }).catch((error) => {
    console.error('[SessionStateHandlers] Failed to setup sync subscription:', error);
  });
}

/**
 * Check if any AI sessions are currently running or streaming.
 * Used by the quit handler to show a confirmation dialog.
 */
export function hasActiveStreamingSessions(): boolean {
  return getSessionStateManager().getRunningSessionIds().length > 0;
}

/**
 * Shutdown handler - called when app is closing
 */
export async function shutdownSessionStateHandlers() {
  const stateManager = getSessionStateManager();
  await stateManager.shutdown();

  // Clean up sync subscription
  if (syncSubscriptionCleanup) {
    syncSubscriptionCleanup();
    syncSubscriptionCleanup = null;
  }

  // Clean up all subscriptions
  for (const unsubscribe of windowSubscriptions.values()) {
    unsubscribe();
  }
  windowSubscriptions.clear();

  console.log('[SessionStateHandlers] Shutdown complete');
}
