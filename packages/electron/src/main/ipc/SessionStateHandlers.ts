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

// Track if handlers are registered to prevent double registration
let handlersRegistered = false;

// Track active subscriptions per window
const windowSubscriptions = new Map<number, () => void>();

// Track sync subscription cleanup
let syncSubscriptionCleanup: (() => void) | null = null;
const sessionWorkspaceCache = new Map<string, string | null>();

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
    sessionWorkspaceCache.set(sessionId, workspacePath);
    return workspacePath;
  } catch (error) {
    console.error('[SessionStateHandlers] Failed to resolve canonical workspace path:', error);
    return null;
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

  // Subscribe to state changes and sync to mobile
  setupSyncSubscription(stateManager);

  // Get active session IDs
  safeHandle('ai-session-state:get-active', async (_event) => {
    try {
      const activeIds = stateManager.getActiveSessionIds();
      return { success: true, sessionIds: activeIds };
    } catch (error) {
      console.error('[SessionStateHandlers] Error getting active sessions:', error);
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
            if (!matched) {
              return;
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

  // End tracking a session (called when AI completes)
  safeHandle('ai-session-state:end', async (_event, sessionId: string) => {
    try {
      await stateManager.endSession(sessionId);
      return { success: true };
    } catch (error) {
      console.error('[SessionStateHandlers] Error ending session:', error);
      return { success: false, error: String(error) };
    }
  });

  // Interrupt a session (called on error or force stop)
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
 * Setup sync subscription to push execution state changes to mobile
 */
function setupSyncSubscription(stateManager: ReturnType<typeof getSessionStateManager>): void {
  // Lazy load sync manager to avoid circular dependencies
  import('../services/SyncManager').then(({ getSyncProvider }) => {
    const syncProvider = getSyncProvider();
    if (!syncProvider) {
      console.log('[SessionStateHandlers] Sync not enabled, skipping execution state sync');
      return;
    }

    console.log('[SessionStateHandlers] Setting up execution state sync to mobile');

    const unsubscribe = stateManager.subscribe((event: SessionStateEvent) => {
      // Sync execution state changes to mobile
      if (
        event.type === 'session:started' ||
        event.type === 'session:streaming' ||
        event.type === 'session:waiting' ||
        event.type === 'session:completed' ||
        event.type === 'session:interrupted'
      ) {
        const isExecuting = event.type === 'session:started' || event.type === 'session:streaming';
        const sessionId = event.sessionId;

        console.log('[SessionStateHandlers] Syncing execution state:', { sessionId, isExecuting });

        // Push metadata update with isExecuting state
        const now = Date.now();
        const agentStatus = event.type === 'session:waiting'
          ? { kind: 'waiting', label: 'Waiting for your response', updatedAt: now }
          : isExecuting
            ? {
                kind: event.type === 'session:streaming' ? 'responding' : 'thinking',
                label: event.type === 'session:streaming' ? 'Responding...' : 'Thinking...',
                updatedAt: now,
              }
            : {
                kind: event.type === 'session:interrupted' ? 'idle' : 'complete',
                label: event.type === 'session:interrupted' ? 'Interrupted' : 'Done',
                updatedAt: now,
              };
        const metadata: Record<string, unknown> = {
          isExecuting,
          agentStatus,
          updatedAt: now,
        };
        if (event.type === 'session:waiting') {
          metadata.hasPendingPrompt = true;
        }
        syncProvider.pushChange(sessionId, {
          type: 'metadata_updated',
          metadata: metadata as any,
        });
      }
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
  const stateManager = getSessionStateManager();
  const activeIds = stateManager.getActiveSessionIds();

  for (const sessionId of activeIds) {
    const state = stateManager.getSessionState(sessionId);
    if (state && (state.status === 'running' || state.isStreaming)) {
      return true;
    }
  }
  return false;
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
