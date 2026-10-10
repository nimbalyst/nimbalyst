import type { BrowserWindow } from 'electron';
import * as fs from 'fs';
import { logger } from '../../utils/logger';
import { getDefaultAIModel } from '../../utils/store';
import { createWindow, findWindowByWorkspace, windowStates } from '../../window/WindowManager';
import { getLocalHostDeviceId, isTargetedAtAnotherDevice, stampSessionHost } from './sessionHostAttribution';
import type { SessionManager } from '@nimbalyst/runtime/ai/server';
import type { IndexPublishOutcome, SessionIndexData, SyncProvider } from '@nimbalyst/runtime/sync';

/**
 * Mobile create-session and create-worktree request handling.
 *
 * Split out of MobileSyncHandler, which was carrying both flows inline. The
 * rule both flows follow, and the reason they live together: the phone is told
 * a session exists only after the index row for it has an outcome. An ack that
 * runs ahead of the publish is the race fixed in b4f29cbc6 -- the phone opens a
 * session id the index has never heard of.
 */

export interface MobileCreateRequestContext {
  sessionManager: SessionManager;
  /**
   * Claim a request id for processing. Returns false when the same request is
   * already in flight -- sync can deliver one request more than once, and a
   * second flow races the first over the worktree table and the filesystem.
   */
  claimRequest(requestId: string): boolean;
  /** Release the claim once the work has settled. */
  releaseRequest(requestId: string): void;
}

/** Bulk-publish reason when a newer publication of the same row landed during encryption. */
const INDEX_STATE_CHANGED_REASON = 'index state changed during publication';
const MAX_ROW_PUBLISH_ATTEMPTS = 4;

/**
 * Publication must explicitly cover this row before the phone receives success.
 *
 * Creating the session fires its own metadata publish for the new row (and host
 * stamping fires another). Those routinely land while this batch is encrypting,
 * and the batch then drops the row as stale -- every mobile create reported
 * failure even though the session was on the server. Retry once they settle so
 * the full row (parent, host) is the last one published and the ack is honest.
 */
async function publishSessionRow(syncProvider: SyncProvider, row: SessionIndexData): Promise<IndexPublishOutcome> {
  let outcome = await syncProvider.syncSessionsToIndex?.([row]);
  for (
    let attempt = 1;
    attempt < MAX_ROW_PUBLISH_ATTEMPTS && outcome?.reason === INDEX_STATE_CHANGED_REASON && syncProvider.isIndexReady?.() !== false;
    attempt++
  ) {
    await new Promise<void>((resolve) => setTimeout(resolve, 25 * attempt));
    outcome = await syncProvider.syncSessionsToIndex?.([row]);
  }
  if (outcome?.published && outcome.publishedSessionIds.includes(row.id)) return outcome;
  return {
    published: false,
    reason: outcome?.reason ?? 'the sync provider did not confirm publication of this session',
    retryable: outcome?.retryable ?? false,
    publishedSessionIds: outcome?.publishedSessionIds ?? [],
  };
}

/** Avoid local side effects when the desktop already knows it cannot publish. */
function creationUnavailable(provider: SyncProvider): string | null {
  if (!provider.syncSessionsToIndex) return 'This desktop cannot publish sessions to sync.';
  const gate = provider.getPersonalSyncWriteGate?.();
  if (gate?.state === 'blocked') return 'Update Nimbalyst on this computer to resume session sync.';
  if (gate?.state === 'unverified') return 'The desktop is checking session sync. Try again when it is ready.';
  if (provider.isIndexReady?.() === false) return 'The desktop is disconnected from session sync. Reconnect before trying again.';
  return null;
}

function unpublishedMessage(outcome: IndexPublishOutcome): string {
  return `The desktop created the session but could not publish it to sync (${outcome.reason ?? 'reason unknown'}). Check the session list before trying again.`;
}

/** Send a response, logging rather than rejecting when the send itself fails. */
async function sendResponse(
  send: ((response: never) => Promise<void>) | undefined,
  response: unknown,
  label: string,
): Promise<void> {
  if (!send) {
    logger.main.warn(`[MobileSync] Cannot send ${label} - the sync provider does not support it`);
    return;
  }
  try {
    await (send as (r: unknown) => Promise<void>)(response);
  } catch (error) {
    logger.main.error(`[MobileSync] Failed to send ${label}:`, error);
  }
}

export function registerMobileCreateSessionHandler(
  syncProvider: SyncProvider,
  ctx: MobileCreateRequestContext,
): void {
  if (!syncProvider.onCreateSessionRequest) return;

  syncProvider.onCreateSessionRequest(async (request) => {
    const respond = (response: Parameters<NonNullable<SyncProvider['sendCreateSessionResponse']>>[0]) =>
      sendResponse(syncProvider.sendCreateSessionResponse as never, response, 'createSessionResponse');

    const hostDeviceId = getLocalHostDeviceId();
    if (isTargetedAtAnotherDevice(request, hostDeviceId)) {
      logger.main.info('[MobileSync] Ignoring session request targeted at another device:', request.requestId);
      return;
    }
    logger.main.info('[MobileSync] Received create session request from mobile:', {
      requestId: request.requestId,
      projectId: request.projectId,
      hasInitialPrompt: !!request.initialPrompt
    });

    if (!ctx.claimRequest(request.requestId)) return;

    try {
      const unavailable = creationUnavailable(syncProvider);
      if (unavailable) {
        await respond({ requestId: request.requestId, success: false, error: unavailable });
        return;
      }
      // Find a window for this project/workspace
      const { BrowserWindow } = await import('electron');
      const windows = BrowserWindow.getAllWindows().filter(w => !w.isDestroyed());

      if (windows.length === 0) {
        logger.main.warn('[MobileSync] No windows available to create session');
        await respond({
          requestId: request.requestId,
          success: false,
          error: 'No desktop windows available'
        });
        return;
      }

      // Mobile MUST provide a valid projectId - sessions cannot be created without a workspace
      if (!request.projectId || request.projectId === 'default') {
        logger.main.error('[MobileSync] Mobile session request missing valid projectId:', request.projectId);
        await respond({
          requestId: request.requestId,
          success: false,
          error: 'projectId is required - cannot create session without workspace'
        });
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
          logger.main.info('[MobileSync] Opening workspace for mobile session creation:', request.projectId);
          const newWindow = createWindow(false, true, request.projectId);

          // Wait for the window to finish loading
          await new Promise<void>((resolve) => {
            newWindow.webContents.once('did-finish-load', () => resolve());
          });

          targetWindow = newWindow;
          workspacePath = request.projectId;
        } else {
          logger.main.error('[MobileSync] No window found and workspace path does not exist for projectId:', request.projectId);
          await respond({
            requestId: request.requestId,
            success: false,
            error: `Workspace not found on disk: ${request.projectId}`
          });
          return;
        }
      }

      // Create the session using the SessionManager
      // Use mobile's provider/model selection if provided, otherwise fall back to desktop defaults
      const resolvedProvider = (request.provider || 'claude-code') as import('@nimbalyst/runtime/ai/server/types').AIProviderType;
      const resolvedModel = request.model || getDefaultAIModel() || 'claude-code:opus-1m';
      const resolvedSessionType = (request.sessionType || 'session') as import('@nimbalyst/runtime/ai/server/types').SessionType;
      const resolvedAgentRole = (request.agentRole || 'standard') as import('@nimbalyst/runtime/ai/server/types').AgentRole;
      const { AISessionsRepository } = await import('@nimbalyst/runtime/storage/repositories/AISessionsRepository');
      const parent = request.parentSessionId ? await AISessionsRepository.get(request.parentSessionId) : null;
      if (request.parentSessionId && (!parent || parent.workspacePath !== workspacePath)) throw new Error('Parent session is not in this workspace');
      const session = await ctx.sessionManager.createSession(
        resolvedProvider,        // provider - from mobile or default
        undefined,               // documentContext
        workspacePath,           // workspacePath
        undefined,               // providerConfig
        resolvedModel,           // model - from mobile or desktop default
        resolvedSessionType,     // sessionType - from mobile request
        'agent',                 // mode
        parent?.worktreeId ?? undefined,
        parent?.worktreePath ?? undefined,
        parent?.worktreeId ? workspacePath : undefined,
        resolvedAgentRole,
        request.parentSessionId ?? null,
        undefined,
        request.parentSessionId ?? null
      );
      await stampSessionHost(session.id, hostDeviceId);

      logger.main.info('[MobileSync] Created session for mobile request:', {
        requestId: request.requestId,
        sessionId: session.id,
        workspacePath
      });

      // parentSessionId must be present here -- syncSessionsToIndex builds a
      // fresh index entry from this payload and clobbers any partial
      // parentSessionId written in the atomic insert. Mobile clients (iOS)
      // need the parent association on the first sight of the session or it
      // shows up as a free-floating sibling.
      const publishOutcome = await publishSessionRow(syncProvider, {
        id: session.id,
        title: session.title ?? 'Untitled',
        provider: session.provider,
        model: session.model,
        mode: session.mode,
        sessionType: session.sessionType,
        parentSessionId: request.parentSessionId ?? session.parentSessionId ?? null,
        ...(hostDeviceId ? { hostDeviceId } : {}),
        agentRole: session.agentRole,
        createdBySessionId: session.createdBySessionId ?? null,
        workspaceId: session.workspacePath,
        workspacePath: session.workspacePath,
        messageCount: session.messages.length,
        updatedAt: session.updatedAt,
        createdAt: session.createdAt
      });

      // Notify renderer to refresh session list
      if (targetWindow && !targetWindow.isDestroyed()) {
        targetWindow.webContents.send('sessions:refresh-list', {
          workspacePath,
          sessionId: session.id
        });
      }

      // The response goes out only now, after the index publish has settled.
      // An ack that arrives before the row does leaves the phone opening a
      // session the index has never heard of (b4f29cbc6).
      if (!publishOutcome.published) {
        logger.main.warn('[MobileSync] Session row not published to the index:', {
          requestId: request.requestId,
          sessionId: session.id,
          reason: publishOutcome.reason,
          retryable: publishOutcome.retryable,
        });
      }
      await respond(publishOutcome.published
        ? { requestId: request.requestId, success: true, sessionId: session.id }
        : {
            requestId: request.requestId,
            success: false,
            sessionId: session.id,
            error: unpublishedMessage(publishOutcome),
          });

      if (!publishOutcome.published) return;

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
      logger.main.error('[MobileSync] Failed to create session from mobile:', error);
      await respond({
        requestId: request.requestId,
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error'
      });
    } finally {
      ctx.releaseRequest(request.requestId);
    }
  });
}

/**
 * Worktree creation from mobile. Mirrors the desktop `worktree:create` IPC
 * handler plus AgentMode session creation.
 */
export function registerMobileCreateWorktreeHandler(
  syncProvider: SyncProvider,
  ctx: MobileCreateRequestContext,
): void {
  if (!syncProvider.onCreateWorktreeRequest) return;

  syncProvider.onCreateWorktreeRequest(async (request) => {
    const respond = (response: Parameters<NonNullable<SyncProvider['sendCreateWorktreeResponse']>>[0]) =>
      sendResponse(syncProvider.sendCreateWorktreeResponse as never, response, 'createWorktreeResponse');

    const hostDeviceId = getLocalHostDeviceId();
    if (isTargetedAtAnotherDevice(request, hostDeviceId)) {
      logger.main.info('[MobileSync] Ignoring worktree request targeted at another device:', request.requestId);
      return;
    }
    logger.main.info('[MobileSync] Received worktree creation request from mobile:', request.requestId, 'projectId:', request.projectId);

    if (!ctx.claimRequest(request.requestId)) return;

    try {
      const unavailable = creationUnavailable(syncProvider);
      if (unavailable) {
        await respond({ requestId: request.requestId, success: false, error: unavailable });
        return;
      }
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
      gitRefWatcher.start(worktree.path, undefined, request.projectId).catch((err: Error) => {
        logger.main.error('[MobileSync] Failed to start GitRefWatcher for worktree:', err);
      });

      logger.main.info('[MobileSync] Worktree created from mobile:', worktree.id, 'name:', worktree.name, 'branch:', worktree.branch);

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
      logger.main.info('[MobileSync] Worktree session created:', sessionId, 'worktreeId:', worktree.id);

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

      // Step 4: Publish to the index so iOS sees it, and only then answer.
      const now = Date.now();
      const publishOutcome = await publishSessionRow(syncProvider, {
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
      });

      if (!publishOutcome.published) {
        logger.main.warn('[MobileSync] Worktree session row not published to the index:', {
          requestId: request.requestId,
          sessionId,
          reason: publishOutcome.reason,
          retryable: publishOutcome.retryable,
        });
      }
      await respond(publishOutcome.published
        ? { requestId: request.requestId, success: true }
        : {
            requestId: request.requestId,
            success: false,
            error: unpublishedMessage(publishOutcome),
          });
    } catch (error) {
      logger.main.error('[MobileSync] Failed to create worktree from mobile:', error);
      await respond({
        requestId: request.requestId,
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error',
      });
    } finally {
      ctx.releaseRequest(request.requestId);
    }
  });
}
