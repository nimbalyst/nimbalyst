import { sessionInbox } from './sessionInboxService';
import type { BrowserWindow } from 'electron';
import { applyRemoteReadReceipt } from '../../ipc/ReadReceiptHandlers';
import { applyRemoteTrackerPersonalState } from '../../ipc/TrackerPersonalStateHandlers';
import { logger } from '../../utils/logger';
import { getDefaultAIModel } from '../../utils/store';
import { createWindow, findWindowByWorkspace, windowStates } from '../../window/WindowManager';
import { getSyncProvider } from '../SyncManager';
import { AnalyticsService } from '../analytics/AnalyticsService.ts';
import { handleMobileVoiceToolCall } from '../voice/mobileVoiceToolHandler';
import { initMobileSessionControlHandler } from './MobileSessionControlHandler';
import { ingestMobileQueuedPrompts } from './mobileQueuedPromptIngest';
import * as fs from 'fs';
import type { SessionManager } from '@nimbalyst/runtime/ai/server';
import type { DriveReason } from './QueueDriveService';
import { getLocalHostDeviceId, isTargetedAtAnotherDevice, stampSessionHost } from './sessionHostAttribution';

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

      // Listen for session creation requests from mobile
      if (syncProvider.onCreateSessionRequest) {
        syncProvider.onCreateSessionRequest(async (request) => {
          const hostDeviceId = getLocalHostDeviceId();
          if (isTargetedAtAnotherDevice(request, hostDeviceId)) {
            logger.main.info('[AIService] Ignoring session request targeted at another device:', request.requestId);
            return;
          }
          logger.main.info('[AIService] Received create session request from mobile:', {
            requestId: request.requestId,
            projectId: request.projectId,
            hasInitialPrompt: !!request.initialPrompt
          });

          // Deduplicate requests - same request can be delivered multiple times
          if (this.processingMobileSessionRequests.has(request.requestId)) {
            // logger.main.info('[AIService] Ignoring duplicate session creation request:', request.requestId);
            return;
          }
          this.processingMobileSessionRequests.add(request.requestId);

          try {
            // Find a window for this project/workspace
            const { BrowserWindow } = await import('electron');
            const windows = BrowserWindow.getAllWindows().filter(w => !w.isDestroyed());

            if (windows.length === 0) {
              logger.main.warn('[AIService] No windows available to create session');
              if (syncProvider.sendCreateSessionResponse) {
                syncProvider.sendCreateSessionResponse({
                  requestId: request.requestId,
                  success: false,
                  error: 'No desktop windows available'
                });
              }
              return;
            }

            // Mobile MUST provide a valid projectId - sessions cannot be created without a workspace
            if (!request.projectId || request.projectId === 'default') {
              logger.main.error('[AIService] Mobile session request missing valid projectId:', request.projectId);
              if (syncProvider.sendCreateSessionResponse) {
                syncProvider.sendCreateSessionResponse({
                  requestId: request.requestId,
                  success: false,
                  error: 'projectId is required - cannot create session without workspace'
                });
              }
              return;
            }

            // Find the window that matches this project's workspace path
            let targetWindow: BrowserWindow | undefined;
            let workspacePath: string | undefined;

            // Try to find a window with this workspace using findWindowByWorkspace
            const matchedWindow = findWindowByWorkspace(request.projectId);
            if (matchedWindow) {
              targetWindow = matchedWindow;
              workspacePath = request.projectId;
            } else {
              // Try to find by project name (last path component)
              for (const win of windows) {
                const state = windowStates.get(win.id);
                if (state?.workspacePath) {
                  const pathBasename = state.workspacePath.split(/[\\/]/).pop();
                  if (pathBasename === request.projectId || state.workspacePath.includes(request.projectId)) {
                    targetWindow = win;
                    workspacePath = state.workspacePath;
                    break;
                  }
                }
              }
            }

            // If no matching window found, try to open the workspace automatically
            if (!targetWindow || !workspacePath) {
              // request.projectId should be a workspace path - check if it exists on disk
              if (fs.existsSync(request.projectId)) {
                logger.main.info('[AIService] Opening workspace for mobile session creation:', request.projectId);
                const newWindow = createWindow(false, true, request.projectId);

                // Wait for the window to finish loading
                await new Promise<void>((resolve) => {
                  newWindow.webContents.once('did-finish-load', () => resolve());
                });

                targetWindow = newWindow;
                workspacePath = request.projectId;
              } else {
                logger.main.error('[AIService] No window found and workspace path does not exist for projectId:', request.projectId);
                if (syncProvider.sendCreateSessionResponse) {
                  syncProvider.sendCreateSessionResponse({
                    requestId: request.requestId,
                    success: false,
                    error: `Workspace not found on disk: ${request.projectId}`
                  });
                }
                return;
              }
            }

            // Create the session using the SessionManager
            // Use mobile's provider/model selection if provided, otherwise fall back to desktop defaults
            const resolvedProvider = (request.provider || 'claude-code') as import('@nimbalyst/runtime/ai/server/types').AIProviderType;
            const resolvedModel = request.model || getDefaultAIModel() || 'claude-code:opus-1m';
            const resolvedSessionType = (request.sessionType || 'session') as import('@nimbalyst/runtime/ai/server/types').SessionType;
            const resolvedAgentRole = (request.agentRole || 'standard') as import('@nimbalyst/runtime/ai/server/types').AgentRole;
            const session = await this.ctx.sessionManager.createSession(
              resolvedProvider,        // provider - from mobile or default
              undefined,               // documentContext
              workspacePath,           // workspacePath
              undefined,               // providerConfig
              resolvedModel,           // model - from mobile or desktop default
              resolvedSessionType,     // sessionType - from mobile request
              'agent',                 // mode
              undefined,               // worktreeId
              undefined,               // worktreePath
              undefined,               // worktreeProjectPath
              resolvedAgentRole        // agentRole - from mobile request or 'standard'
            );
            await stampSessionHost(session.id, hostDeviceId);

            // If a parentSessionId was provided, set it on the session
            if (request.parentSessionId && session) {
              const { AISessionsRepository } = await import('@nimbalyst/runtime/storage/repositories/AISessionsRepository');
              await AISessionsRepository.updateMetadata(session.id, { parentSessionId: request.parentSessionId });
            }

            logger.main.info('[AIService] Created session for mobile request:', {
              requestId: request.requestId,
              sessionId: session.id,
              workspacePath
            });
            if (session && syncProvider.syncSessionsToIndex) {
              // logger.main.info('[AIService] Syncing new session to index:', session.id);
              // parentSessionId must be present here -- syncSessionsToIndex
              // builds a fresh index entry from this payload and clobbers any
              // partial parentSessionId set by the updateMetadata() above. Mobile
              // clients (iOS) need the parent association on the first sight of
              // the session or it shows up as a free-floating sibling.
              syncProvider.syncSessionsToIndex([{
                id: session.id,
                title: session.title ?? 'Untitled',
                provider: session.provider,
                model: session.model,
                mode: session.mode,
                sessionType: session.sessionType,
                parentSessionId: request.parentSessionId ?? session.parentSessionId ?? undefined,
                ...(hostDeviceId ? { hostDeviceId } : {}),
                agentRole: session.agentRole,
                createdBySessionId: session.createdBySessionId ?? undefined,
                workspaceId: session.workspacePath,
                workspacePath: session.workspacePath,
                messageCount: session.messages.length,
                updatedAt: session.updatedAt,
                createdAt: session.createdAt
              }]);
            } else {
              logger.main.warn('[AIService] Cannot sync session - syncSessionsToIndex not available');
            }

            // Notify renderer to refresh session list
            if (targetWindow && !targetWindow.isDestroyed()) {
              // logger.main.info('[AIService] Notifying renderer to refresh session list after mobile session creation');
              targetWindow.webContents.send('sessions:refresh-list', {
                workspacePath,
                sessionId: session.id
              });
            }

            // Send success response
            if (syncProvider.sendCreateSessionResponse) {
              // logger.main.info('[AIService] Sending success response to mobile for:', request.requestId);
              syncProvider.sendCreateSessionResponse({
                requestId: request.requestId,
                success: true,
                sessionId: session.id
              });
            } else {
              logger.main.warn('[AIService] Cannot send response - sendCreateSessionResponse not available');
            }

            // If there's an initial prompt, queue it for execution
            if (request.initialPrompt && session) {
              const promptId = `mobile-create-prompt-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
              const { getQueuedPromptsStore } = await import('../RepositoryManager');
              const queueStore = getQueuedPromptsStore();

              await queueStore.create({
                id: promptId,
                sessionId: session.id,
                prompt: request.initialPrompt
              });

              // logger.main.info('[AIService] Queued initial prompt from mobile:', {
              //   sessionId: session.id,
              //   promptId
              // });

              // Notify the window to process the queue
              if (targetWindow && !targetWindow.isDestroyed()) {
                targetWindow.webContents.send('ai:queuedPromptsReceived', {
                  sessionId: session.id,
                  promptCount: 1,
                  workspacePath
                });
              }
            }

            // Notify the window to show the new session
            if (targetWindow && !targetWindow.isDestroyed()) {
              targetWindow.webContents.send('ai:sessionCreatedFromMobile', {
                sessionId: session.id,
                requestId: request.requestId
              });
            }
          } catch (error) {
            logger.main.error('[AIService] Failed to create session from mobile:', error);
            if (syncProvider.sendCreateSessionResponse) {
              syncProvider.sendCreateSessionResponse({
                requestId: request.requestId,
                success: false,
                error: error instanceof Error ? error.message : 'Unknown error'
              });
            }
          } finally {
            this.releaseMobileRequestAfterGrace(request.requestId);
          }
        });

        // logger.main.info('[AIService] Session creation request handler initialized');
      } else {
        // logger.main.info('[AIService] onCreateSessionRequest not available on sync provider');
      }

      // Handle voice-tool requests from mobile (e.g. project-memory lookups).
      // The mobile voice agent proxies desktop-hosted voice tools through here;
      // we run the tool (gated to voiceAgent:true tools) and return the result.
      if (syncProvider.onVoiceToolRequest && syncProvider.sendVoiceToolResponse) {
        syncProvider.onVoiceToolRequest(async (request) => {
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
            const outcome = await handleMobileVoiceToolCall(
              request.toolName,
              request.argsJson,
              request.projectId,
            );
            await syncProvider.sendVoiceToolResponse!({
              requestId: request.requestId,
              success: outcome.success,
              resultJson: outcome.result ? JSON.stringify({ result: outcome.result }) : undefined,
              error: outcome.error,
            });
          } catch (error) {
            logger.main.error('[AIService] Voice tool request failed:', error);
            await syncProvider.sendVoiceToolResponse!({
              requestId: request.requestId,
              success: false,
              error: error instanceof Error ? error.message : String(error),
            });
          } finally {
            this.releaseMobileRequestAfterGrace(request.requestId);
          }
        });
      }

      // Handle worktree creation requests from mobile
      // Mirrors the desktop worktree:create IPC handler + AgentMode session creation exactly
      if (syncProvider.onCreateWorktreeRequest) {
        syncProvider.onCreateWorktreeRequest(async (request) => {
          const hostDeviceId = getLocalHostDeviceId();
          if (isTargetedAtAnotherDevice(request, hostDeviceId)) {
            logger.main.info('[AIService] Ignoring worktree request targeted at another device:', request.requestId);
            return;
          }
          logger.main.info('[AIService] Received worktree creation request from mobile:', request.requestId, 'projectId:', request.projectId);

          // Same guard as session creation. A redelivered worktree request that
          // starts a second flow races the first over the filesystem and the
          // worktree table, and both flows create a branch.
          if (this.processingMobileSessionRequests.has(request.requestId)) {
            logger.main.info('[AIService] Ignoring duplicate worktree creation request:', request.requestId);
            return;
          }
          this.processingMobileSessionRequests.add(request.requestId);

          try {
            // Step 1: Create git worktree with name deduplication (same as worktree:create handler)
            const { GitWorktreeService } = await import('../GitWorktreeService');
            const { createWorktreeStore } = await import('../WorktreeStore');
            const { getDatabase } = await import('../../database/initialize');
            const { gitRefWatcher } = await import('../../file/GitRefWatcher');

            const gitWorktreeService = new GitWorktreeService();
            const db = getDatabase();
            if (!db) throw new Error('Database not initialized');
            const worktreeStore = createWorktreeStore(db);

            // Deduplicate name across DB, filesystem, and branches (same as worktree:create)
            const [dbNames, filesystemNames, branchNames] = await Promise.all([
              worktreeStore.getAllNames(),
              Promise.resolve(gitWorktreeService.getExistingWorktreeDirectories(request.projectId)),
              gitWorktreeService.getAllBranchNames(request.projectId),
            ]);
            const existingNames = new Set<string>();
            for (const n of dbNames) existingNames.add(n);
            for (const n of filesystemNames) existingNames.add(n);
            for (const n of branchNames) existingNames.add(n);
            const finalName = gitWorktreeService.generateUniqueWorktreeName(existingNames);

            // Create the git worktree
            const worktree = await gitWorktreeService.createWorktree(request.projectId, { name: finalName });

            // Store in WorktreeStore (same as worktree:create)
            await worktreeStore.create(worktree);

            // Start git ref watcher (same as worktree:create)
            gitRefWatcher.start(worktree.path).catch((err: Error) => {
              logger.main.error('[AIService] Failed to start GitRefWatcher for worktree:', err);
            });

            logger.main.info('[AIService] Worktree created from mobile:', worktree.id, 'name:', worktree.name, 'branch:', worktree.branch);

            // Step 2: Create session with worktreeId (same as AgentMode + sessions:create)
            const { AISessionsRepository } = await import('@nimbalyst/runtime/storage/repositories/AISessionsRepository');
            const { randomUUID } = await import('crypto');
            const defaultModel = getDefaultAIModel() || 'claude-code:opus-1m';
            const sessionId = randomUUID();
            const sessionTitle = `Worktree: ${worktree.name}`;

            await AISessionsRepository.create({
              id: sessionId,
              provider: 'claude-code',
              model: defaultModel,
              title: sessionTitle,
              workspaceId: request.projectId,
              worktreeId: worktree.id,
            });
            await stampSessionHost(sessionId, hostDeviceId);
            logger.main.info('[AIService] Worktree session created:', sessionId, 'worktreeId:', worktree.id);

            // Step 3: Notify renderer to refresh and set workstream state
            const targetWindow = findWindowByWorkspace(request.projectId);
            if (targetWindow && !targetWindow.isDestroyed()) {
              targetWindow.webContents.send('sessions:refresh-list', {
                workspacePath: request.projectId,
                sessionId,
              });
              targetWindow.webContents.send('worktree:session-created', {
                sessionId,
                worktreeId: worktree.id,
              });
            }

            // Step 4: Sync to index so iOS sees it
            if (syncProvider.syncSessionsToIndex) {
              const now = Date.now();
              syncProvider.syncSessionsToIndex([{
                id: sessionId,
                title: sessionTitle,
                provider: 'claude-code',
                model: defaultModel,
                mode: 'agent',
                sessionType: 'session',
                worktreeId: worktree.id,
                ...(hostDeviceId ? { hostDeviceId } : {}),
                workspaceId: request.projectId,
                workspacePath: request.projectId,
                messageCount: 0,
                updatedAt: now,
                createdAt: now,
              }]);
            }

            if (syncProvider.sendCreateWorktreeResponse) {
              syncProvider.sendCreateWorktreeResponse({
                requestId: request.requestId,
                success: true,
              });
            }
          } catch (error) {
            logger.main.error('[AIService] Failed to create worktree from mobile:', error);
            if (syncProvider.sendCreateWorktreeResponse) {
              syncProvider.sendCreateWorktreeResponse({
                requestId: request.requestId,
                success: false,
                error: error instanceof Error ? error.message : 'Unknown error',
              });
            }
          } finally {
            this.releaseMobileRequestAfterGrace(request.requestId);
          }
        });
        // logger.main.info('[AIService] Worktree creation request handler initialized');
      }

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
