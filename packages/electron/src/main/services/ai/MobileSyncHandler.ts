import { decodeMobileLiveRequest } from "../voice/mobileLiveRelay";
import { handleMobileLiveTool } from "../voice/mobileLiveTools";
import { sessionInbox } from './sessionInboxService';
import { applyRemoteReadReceipt } from '../../ipc/ReadReceiptHandlers';
import { applyRemoteTrackerPersonalState } from '../../ipc/TrackerPersonalStateHandlers';
import { logger } from '../../utils/logger';
import { findWindowByWorkspace } from '../../window/WindowManager';
import { getSyncProvider } from '../SyncManager';
import { AnalyticsService } from '../analytics/AnalyticsService.ts';
import { handleMobileVoiceToolCall } from '../voice/mobileVoiceToolHandler';
import { initMobileSessionControlHandler } from './MobileSessionControlHandler';
import { ingestMobileQueuedPrompts } from './mobileQueuedPromptIngest';
import {
  registerMobileCreateSessionHandler,
  registerMobileCreateWorktreeHandler,
  type MobileCreateRequestContext,
} from './mobileCreateRequestHandlers';
import type { SessionManager } from '@nimbalyst/runtime/ai/server';
import type { DriveReason } from './QueueDriveService';
import { getLocalHostDeviceId } from './sessionHostAttribution';

/** How long a finished mobile request ID stays guarded against redelivery. */
const MOBILE_REQUEST_DEDUP_GRACE_MS = 60_000;

/**
 * Mobile sync bridge: mirrors queued prompts and session-control requests
 * arriving over sync into the local queue, and keeps re-arming itself as the
 * sync provider comes and goes.
 *
 * Extracted from AIService, where it was a 566-line pair of methods plus four
 * fields. Its outward surface is only the four members below -- everything
 * else it needs it owns.
 */
export interface MobileSyncContext {
  sessionManager: SessionManager;
  publishQueueStateToSync(sessionId: string): Promise<void>;
  triggerQueuedPromptProcessingForSession(
    sessionId: string,
    workspacePath: string,
    reason?: DriveReason,
  ): Promise<boolean>;
  requestQueueDrive(sessionId: string, workspacePath: string, reason: DriveReason): void;
}

export class MobileSyncHandler {
  private mobileSyncHandlerInitialized = false;
  private lastSyncProvider: import('@nimbalyst/runtime/sync').SyncProvider | null = null;
  private syncStatusUnsubscribe: (() => void) | null = null;

  // Track mobile-initiated requests to prevent duplicate processing
  // (can happen if the same request is delivered multiple times)
  private processingMobileSessionRequests = new Set<string>();

  constructor(private readonly ctx: MobileSyncContext) {}

  /**
   * Release a mobile request ID once its work has settled.
   *
   * The grace period only covers a redelivery arriving just after completion.
   * The entry is deliberately NOT released while the work is still running: an
   * eviction timer started at dispatch expires mid-flight on anything slower
   * than a minute, and the redelivery it then admits runs a second copy of an
   * operation already halfway through creating a worktree or a session.
   */
  private releaseMobileRequestAfterGrace(requestId: string): void {
    setTimeout(() => {
      this.processingMobileSessionRequests.delete(requestId);
    }, MOBILE_REQUEST_DEDUP_GRACE_MS);
  }

  /** The dedup guard the create-session and create-worktree flows share. */
  private createRequestContext(): MobileCreateRequestContext {
    return {
      sessionManager: this.ctx.sessionManager,
      claimRequest: (requestId) => {
        if (this.processingMobileSessionRequests.has(requestId)) {
          logger.main.info('[AIService] Ignoring duplicate mobile creation request:', requestId);
          return false;
        }
        this.processingMobileSessionRequests.add(requestId);
        return true;
      },
      releaseRequest: (requestId) => this.releaseMobileRequestAfterGrace(requestId),
    };
  }

  async initialize() {
    // Listen for index changes from mobile sync and insert queuedPrompts into the database.
    // The renderer's processQueuedPrompts function handles execution from the database queue.
    // Both local queuing (via ai:createQueuedPrompt) and mobile sync use the same database queue.

    // If already initialized, don't do it again
    if (this.mobileSyncHandlerInitialized) {
      // logger.main.info('[AIService] Mobile sync handler already initialized, skipping');
      return;
    }

    // logger.main.info('[AIService] Initializing mobile sync handler (metadata sync only)...');

    // First, subscribe to sync status changes so we can initialize later if sync becomes available
    if (!this.syncStatusUnsubscribe) {
      const { onSyncStatusChange } = await import('../SyncManager');
      this.syncStatusUnsubscribe = onSyncStatusChange((status) => {
        if (status.connected) {
          // Always attempt on connect - tryInitializeMobileSyncHandler checks provider identity
          // to re-register listeners when the provider is recreated on reconnection
          // logger.main.info('[AIService] Sync connected, attempting to initialize mobile sync handler...');
          this.tryInitializeMobileSyncHandler();
        }
      });
    }

    // Try to initialize immediately
    await this.tryInitializeMobileSyncHandler();
  }

  private async tryInitializeMobileSyncHandler() {
    try {
      const syncProvider = getSyncProvider();

      if (!syncProvider) {
        // logger.main.info('[AIService] Sync provider not available yet');
        return;
      }

      // If already initialized on THIS provider instance, skip.
      // When the provider is recreated (reconnection), we must re-register listeners.
      if (this.mobileSyncHandlerInitialized && this.lastSyncProvider === syncProvider) {
        return;
      }
      this.lastSyncProvider = syncProvider;

      // Listen for index changes and insert queued prompts into the queued_prompts table
      if (syncProvider.onIndexChange) {
        syncProvider.onIndexChange(async (sessionId, entry) => {
            // Foreign hosts own both queue persistence and execution. Never
            // echo their queue from this desktop, even before a local row exists.
            const host = entry.hostDeviceId ?? syncProvider.getCachedIndexEntry?.(sessionId)?.hostDeviceId;
            if (host && host !== getLocalHostDeviceId()) return;
            // Notify renderer about session list changes
            // This ensures new sessions from mobile appear immediately in the UI
            // Use getCachedIndexEntry to get projectId without database lookup
            if (syncProvider.getCachedIndexEntry) {
              const cachedEntry = syncProvider.getCachedIndexEntry(sessionId);
              if (cachedEntry?.projectId) {
                const targetWindow = findWindowByWorkspace(cachedEntry.projectId);
                if (targetWindow && !targetWindow.isDestroyed()) {
                  targetWindow.webContents.send('sessions:refresh-list', {
                    workspacePath: cachedEntry.projectId,
                    sessionId
                  });

                  // Forward lastReadAt from sync for cross-device read state
                  if (entry.lastReadAt) {
                    targetWindow.webContents.send('sessions:sync-read-state', {
                      sessionId,
                      lastReadAt: entry.lastReadAt,
                      lastMessageAt: entry.lastMessageAt,
                    });
                  }

                  // Forward draftInput from remote device
                  if (entry.draftInput !== undefined) {
                    // logger.main.info('[AIService] Forwarding draftInput to renderer:', { sessionId, draftInput: entry.draftInput });
                    targetWindow.webContents.send('sessions:sync-draft-input', {
                      sessionId,
                      draftInput: entry.draftInput ?? '',
                      draftUpdatedAt: entry.draftUpdatedAt,
                    });
                  }
                } else {
                  if (entry.draftInput !== undefined) {
                    // logger.main.info('[AIService] DEBUG: draftInput present but no targetWindow for projectId:', cachedEntry.projectId);
                  }
                }
              } else {
                if (entry.draftInput !== undefined) {
                  // logger.main.info('[AIService] DEBUG: draftInput present but no projectId in cachedEntry for session:', sessionId);
                }
              }
            }

            // Only process if there are queuedPrompts in the broadcast
            if (entry.queuedPrompts && entry.queuedPrompts.length > 0) {
              await ingestMobileQueuedPrompts(
                {
                  getExisting: async (promptId) => {
                    const { getQueuedPromptsStore } = await import('../RepositoryManager');
                    return getQueuedPromptsStore().get(promptId);
                  },
                  createPrompt: async (input) => {
                    const { getQueuedPromptsStore } = await import('../RepositoryManager');
                    return getQueuedPromptsStore().create(input);
                  },
                  publishQueueState: (id) => this.ctx.publishQueueStateToSync(id),
                  getSession: async (id) => {
                    // Repository directly: we only need metadata, not a full session load.
                    const { AISessionsRepository } = await import('@nimbalyst/runtime/storage/repositories/AISessionsRepository');
                    return AISessionsRepository.get(id);
                  },
                  trackQueued: (provider) => {
                    AnalyticsService.getInstance().sendEvent('ai_message_queued', {
                      provider,
                      source: 'mobile',
                      hasDocumentContext: false,
                      hasAttachments: false,
                    });
                  },
                  notifyWindow: ({ sessionId: id, promptCount, workspacePath }) => {
                    // Only the window owning this workspace, or multiple windows
                    // race to execute the same prompt. workspacePath rides along
                    // for renderer-side filtering.
                    const openWindow = findWindowByWorkspace(workspacePath);
                    if (openWindow && !openWindow.isDestroyed()) {
                      openWindow.webContents.send('ai:queuedPromptsReceived', {
                        sessionId: id,
                        promptCount,
                        workspacePath,
                      });
                    }
                  },
                  requestDrive: (id, path) => this.ctx.requestQueueDrive(id, path, 'mobile-index'),
                  logInfo: (message) => logger.main.info(message),
                  logWarn: (message) => logger.main.warn(message),
                  logError: (message, error) => logger.main.error(message, error),
                },
                sessionId,
                entry.queuedPrompts,
              );
            }
          });

        this.mobileSyncHandlerInitialized = true;
        // logger.main.info('[AIService] Mobile sync handler initialized (using queued_prompts table)');
      } else {
        // logger.main.info('[AIService] onIndexChange not available on sync provider');
      }

      // Personal read receipts arriving from the user's other devices — persist
      // locally (advance-only) and notify renderers so unread dots recompute.
      if (syncProvider.onReadReceipt) {
        syncProvider.onReadReceipt((receipt) => {
          void applyRemoteReadReceipt(receipt);
        });
      }

      if (syncProvider.onTrackerPersonalState) {
        syncProvider.onTrackerPersonalState((change) => {
          void applyRemoteTrackerPersonalState(change);
        });
      }

      // Session and worktree creation from mobile. Both flows must ack only
      // after the index publish for the new session settles, so they live
      // together in a sibling module with that rule in one place.
      registerMobileCreateSessionHandler(syncProvider, this.createRequestContext());

      // Handle voice-tool requests from mobile (e.g. project-memory lookups).
      // The mobile voice agent proxies desktop-hosted voice tools through here;
      // we run the tool (gated to voiceAgent:true tools) and return the result.
      if (syncProvider.onVoiceToolRequest && syncProvider.sendVoiceToolResponse) {
        syncProvider.onVoiceToolRequest(async (request) => {
          const live = request.toolName === 'nimbalyst_live_v1'
            ? decodeMobileLiveRequest(request.argsJson, request.projectId, getLocalHostDeviceId()) : null;
          if (request.toolName === 'nimbalyst_live_v1' && !live) return;
          // Deduplicate - the same request can be delivered more than once.
          if (this.processingMobileSessionRequests.has(request.requestId)) {
            return;
          }
          this.processingMobileSessionRequests.add(request.requestId);

          try {
            // Static import (top of file): a dynamic import() here re-runs the
            // electron-log init chain in a separate chunk -> "Attempted to
            // register a second handler for '__ELECTRON_LOG__'" crash. See the
            // "No Dynamic Imports in Electron Main Process" rule in CLAUDE.md.
            // request.projectId is the desktop workspace path.
            const outcome = live ? await handleMobileLiveTool(live) : await handleMobileVoiceToolCall(
              request.toolName,
              request.argsJson,
              request.projectId,
            );
            await syncProvider.sendVoiceToolResponse!({
              requestId: request.requestId,
              success: outcome.success,
              resultJson: live ? JSON.stringify({ scope: live.scope, ...outcome }) : outcome.result ? JSON.stringify({ result: outcome.result }) : undefined,
              error: outcome.error,
            });
          } catch (error) {
            logger.main.error('[AIService] Voice tool request failed:', error);
            await syncProvider.sendVoiceToolResponse!({
              requestId: request.requestId,
              success: false,
              error: live ? undefined : error instanceof Error ? error.message : String(error),
              resultJson: live ? JSON.stringify({ scope: live.scope, success: false, error: 'The selected computer could not execute the voice action.' }) : undefined,
            });
          } finally {
            this.releaseMobileRequestAfterGrace(request.requestId);
          }
        });
      }

      registerMobileCreateWorktreeHandler(syncProvider, this.createRequestContext());

      // Initialize mobile session control handler (cancel, question responses, etc.)
      // This is in a separate module to keep AIService focused
      initMobileSessionControlHandler(syncProvider, findWindowByWorkspace, {
        triggerQueuedPromptProcessing: (sessionId, workspacePath) =>
          this.ctx.triggerQueuedPromptProcessingForSession(sessionId, workspacePath, 'mobile-control'),
        rollbackExecutingPrompts: async (sessionId) => {
          await sessionInbox.end(sessionInbox.current(sessionId), false).catch(err => logger.main.error('[AIService] Inbox retirement failed during mobile interruption:', err));
          // Use the delivery-aware sweep so that a mobile-initiated cancel
          // doesn't re-deliver a prompt that already landed in the
          // conversation. Returns the count of rows that actually moved
          // back to pending (matches the prior contract).
          const { getQueuedPromptsStore } = await import('../RepositoryManager');
          const { rolledBack } = await getQueuedPromptsStore().sweepExecutingForSession(sessionId);
          await this.ctx.publishQueueStateToSync(sessionId);
          return rolledBack;
        },
      });
    } catch (error) {
      logger.main.error('[AIService] Failed to initialize mobile sync handler:', error);
    }
  }
}
