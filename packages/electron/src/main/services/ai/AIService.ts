/**
 * Main AI service that coordinates providers and sessions
 */

import { BrowserWindow, ipcMain } from 'electron';
import { execFile } from 'child_process';
import { promisify } from 'util';
import Store from 'electron-store';
import {
  isExtensionAgentProvider,
} from './providerResolution';
import {
  SessionManager,
  ProviderFactory,
  ModelRegistry,
  AIProvider,
  isAskUserQuestionProvider,
  ClaudeCodeProvider,
  OpenCodeProvider,
} from '@nimbalyst/runtime/ai/server';
import { CLAUDE_CODE_SAFE_FALLBACK_MODEL } from '@nimbalyst/runtime/ai/modelConstants';
import { reconcileClaudeCodeModels } from './claudeCodeModelReconcile';
import { getSessionStateManager } from '@nimbalyst/runtime/ai/server/SessionStateManager';
import { parseContextUsageMessage } from '@nimbalyst/runtime/ai/server/utils/contextUsage';
import { resolveEffortLevel, resolveThinkingMode } from '@nimbalyst/runtime/ai/server/effortLevels';
import type { SessionStore } from '@nimbalyst/runtime';
import {
  type DocumentContext,
  type Message,
  type ProviderConfig,
  type ToolHandler,
  type DiffArgs,
  type DiffResult,
  type AIProviderType,
  type SessionData,
} from '@nimbalyst/runtime/ai/server/types';
// MCP imports removed - no longer using MCP HTTP server
import { ToolExecutor, toolRegistry, BUILT_IN_TOOLS } from './tools';
import { getTerminalSessionManager } from '../TerminalSessionManager';
import { flushNextClaudeCliQueuedPromptForSession } from './claudeCliQueueFlushSingleton';
import { logger } from '../../utils/logger';
import { getSettingsService } from '../SettingsService';
import { subscribeProviderSettingsInvalidation } from './providerSettingsCacheInvalidation';
import { findWindowByWorkspace, createWindow, isAppQuitting } from '../../window/WindowManager';
import {AnalyticsService} from "../analytics/AnalyticsService.ts";
import {
  getAIProviderOverrides,
  getDefaultEffortLevel,
  getDefaultThinkingMode,
} from '../../utils/store';
import { getAIProviderOverridesWithWorktreeFallback } from '../../utils/aiSettingsMerge';
import { DocumentContextService } from '@nimbalyst/runtime';
import { getSyncProvider } from '../SyncManager';
import { normalizeCodexProviderConfig, stripTransientProviderFields } from '@nimbalyst/runtime/ai/server/utils/modelConfigUtils';
import { resolveProjectPath } from '../../utils/workspaceDetection';
import { inferWorktreePathFromFilePath, inferWorktreePathFromCommand } from './worktreeInference';
import * as fs from 'fs';
import * as path from 'path';
import {
  safeSend,
} from './aiServiceUtils';
import { MessageStreamingHandler } from './MessageStreamingHandler';
import { shouldForceIdleOnCancel } from './sessionSettlePolicy';
import { HooklessAgentFileWatcher } from './HooklessAgentFileWatcher';
import { MobileSyncHandler } from './MobileSyncHandler';
import type { AIServiceContext } from './ipc/AIServiceContext';
import { scheduleMobileSettingsSync } from './mobileSettingsSync';
import { registerInitHandlers } from './ipc/registerInitHandlers';
import { registerSessionHandlers } from './ipc/registerSessionHandlers';
import { registerQueuedPromptHandlers } from './ipc/registerQueuedPromptHandlers';
import { registerInteractivePromptHandlers } from './ipc/registerInteractivePromptHandlers';
import { registerTurnControlHandlers } from './ipc/registerTurnControlHandlers';
import { registerSettingsHandlers } from './ipc/registerSettingsHandlers';
import { registerModelHandlers } from './ipc/registerModelHandlers';
import { registerProjectSettingsHandlers } from './ipc/registerProjectSettingsHandlers';
import { registerExtensionChatHandlers } from './ipc/registerExtensionChatHandlers';
import { SessionProcessingGuard, tryClaimAndDispatchNextQueuedPrompt } from './queuedPromptDispatcher';
import {
  QueueDriveService,
  type DriveOutcome,
  type DriveReason,
} from './QueueDriveService';
import { createWorkspaceWindowResolver } from './resolveWorkspaceWindow';
import { runQueueDriveAttempt } from './queueDriveAttempt';
import { clearStuckRunningState } from './clearStuckRunningState';
import { publishQueuedPromptsToSync } from './queuedPromptSyncPublisher';
import { onWorkspaceWindowAvailable } from '../../window/workspaceWindowAvailability';
import { dispatchQueuedPromptToClaudeCli } from './claudeCliQueueDispatch';
import { publishQueuedPromptClaim } from './queuedPromptClaimEvents';
import { ensureClaudeCliSession } from './claudeCliLauncherSingleton';
import {
  resolveProviderWorkflowCatalog,
  type ProviderWorkflowCatalog,
} from './providerWorkflowCatalog';

const execFileAsync = promisify(execFile);

/**
 * Catalogs that survive the provider instance that discovered them.
 *
 * The `/` typeahead runs before a session has a live provider, and a provider
 * whose catalog is only learned from a running agent (claude-code from the SDK
 * init payload, opencode from `command.list` against its server) has nothing to
 * report at that moment. The static cache each of them keeps lets the commands
 * a previous session discovered show up immediately.
 *
 * Registering here rather than branching per provider name keeps the next one a
 * single line; providers absent from the map have no pre-instance catalog and
 * fall through to an empty one.
 */
const CROSS_SESSION_WORKFLOW_CATALOGS: Partial<
  Record<AIProviderType, () => { commands: string[]; skills: string[] }>
> = {
  'claude-code': () => ({
    commands: ClaudeCodeProvider.getCachedSdkSlashCommands(),
    skills: ClaudeCodeProvider.getCachedSdkSkills(),
  }),
  opencode: () => ({
    commands: OpenCodeProvider.getCachedSdkSlashCommands(),
    skills: [],
  }),
};


export interface InterruptCurrentTurnResult {
  success: boolean;
  error?: string;
  /** How the turn was stopped; absent when `success` is false. */
  method?: 'interrupt' | 'abort' | 'terminal-ctrl-c';
  /** True when the session was forced idle because no completion event could arrive. */
  forcedIdle?: boolean;
}

export class AIService {
  private sessionManager: SessionManager;
  private settingsStore: Store<Record<string, unknown>> | null = null;
  private readonly analytics = AnalyticsService.getInstance();
  private cachedNormalizedProviderSettings: Record<string, any> | null = null;
  // Store reference to sendMessage handler for queue processing
  private sendMessageHandler: ((event: Electron.IpcMainInvokeEvent, message: string, documentContext?: DocumentContext, sessionId?: string, workspacePath?: string) => Promise<{ content: string }>) | null = null;
  // NOTE: Providers are now tracked per-session in ProviderFactory, not per-window
  // This allows multiple concurrent sessions in the same window (e.g., agent mode tabs)

  // Track queued prompt IDs currently being processed to prevent duplicate execution
  // This is a backup to the atomic database claim - catches cases where claim succeeds
  // but the same prompt ID is somehow passed to sendMessage twice
  private processingQueuedPromptIds = new Set<string>();

  // Per-session file watcher for agent providers without edit-tracking hooks
  // (codex, opencode, copilot-cli, ...). Claude Code has its own SDK hooks and
  // does not use this watcher. See HooklessAgentFileWatcher for details.
  hooklessWatcher = new HooklessAgentFileWatcher();

  // Debounced tool call matching during active sessions.
  // After each tool execution is tracked, we schedule matchSession with a short delay
  // so file edits are linked to tool calls promptly (not just at session end).
  private matchDebounceTimers = new Map<string, ReturnType<typeof setTimeout>>();

  // Track sessions currently processing a queued prompt to prevent concurrent execution.
  // Without this, the completion handler and triggerQueueProcessing IPC can race,
  // each claiming a different prompt and sending both to the AI concurrently.
  // It is a Set of session ids plus an ownership lease, so a dispatch an interrupt
  // displaced cannot release the guard the priority prompt now holds (#1018).
  private sessionsProcessingQueue = new SessionProcessingGuard();

  // Service for preparing document context (transition detection, diff computation, etc.)
  private documentContextService = new DocumentContextService();

  // Owns the streaming send-message lifecycle (extracted from setupIpcHandlers).
  private streamingHandler: MessageStreamingHandler;

  // Mirrors queued prompts and session-control requests arriving over sync.
  private mobileSync: MobileSyncHandler;

  constructor(sessionStore: SessionStore) {
    logger.main.info('[AIService] Constructor called');
    this.sessionManager = new SessionManager(sessionStore);
    this.streamingHandler = new MessageStreamingHandler(this);

    // Set up persistence callback for DocumentContextService
    // Use AISessionsRepository directly since SessionManager doesn't have a generic updateMetadata
    this.documentContextService.setPersistCallback(async (sessionId, state) => {
      const { AISessionsRepository } = await import('@nimbalyst/runtime/storage/repositories/AISessionsRepository');
      await AISessionsRepository.updateMetadata(sessionId, {
        lastDocumentState: state,
      });
    });

    // Initialize mobile sync handler if sync is enabled
    this.mobileSync = new MobileSyncHandler({
      sessionManager: this.sessionManager,
      publishQueueStateToSync: (sessionId) => this.publishQueueStateToSync(sessionId),
      triggerQueuedPromptProcessingForSession: (sessionId, workspacePath, reason) =>
        this.triggerQueuedPromptProcessingForSession(sessionId, workspacePath, reason),
      requestQueueDrive: (sessionId, workspacePath, reason) =>
        this.requestQueueDrive(sessionId, workspacePath, reason),
    });
    this.mobileSync.initialize().catch(err => {
      logger.main.error('[AIService] mobile sync initialize threw:', err);
    });

    // Invalidate the normalized-provider-settings cache whenever a provider
    // config changes through the per-key SettingsService path (the renderer
    // settings panels use `settingsSet('ai.provider.<id>', ...)`). Without this,
    // toggling a provider off (e.g. Claude Code CLI) wrote enabled:false to disk
    // but `ai:getModels` kept serving the stale enabled:true snapshot until
    // restart. Mirrors the inline invalidation in the legacy ai:saveSettings
    // handler, including the mobile-picker refresh.
    subscribeProviderSettingsInvalidation(getSettingsService(), () => {
      this.cachedNormalizedProviderSettings = null;
      scheduleMobileSettingsSync();
    });

    // Initialize SessionStateManager with the database worker
    // Import dynamically to avoid circular dependencies
    import('../../database/PGLiteDatabaseWorker').then(({ database }) => {
      const stateManager = getSessionStateManager();
      stateManager.setDatabase(database);
    }).catch(err => {
      console.error('[AIService] Failed to initialize SessionStateManager:', err);
    });

    // Register built-in tools (which now includes file tools)
    for (const tool of BUILT_IN_TOOLS) {
      toolRegistry.register(tool);
    }

    // Wire up the custom binary path loader so each query reads the current
    // value fresh from the ai-settings store. This must live here (not in
    // index.ts) because only AIService owns the ai-settings store; the
    // store reference in index.ts points to app-settings and would always
    // return empty string.
    ClaudeCodeProvider.setCustomClaudeCodePathLoader((workspacePath: string) => {
      if (!workspacePath) {
        throw new Error('[ClaudeCodeProvider] customClaudeCodePathLoader called without a workspacePath');
      }
      const projectOverride = getAIProviderOverridesWithWorktreeFallback(workspacePath)?.customClaudeCodePath;
      if (projectOverride !== undefined) {
        return projectOverride;
      }
      return (this.getSettingsStore().get('customClaudeCodePath', '') as string) || '';
    });

    // API keys must be explicitly set by the user in settings.
    // NEVER auto-import keys from process.env. A user's .env file with
    // ANTHROPIC_API_KEY was silently picked up, persisted into settings,
    // and used instead of their subscription — costing them $100+.
    this.setupIpcHandlers();

    // Clean up any empty messages from existing sessions on startup
    const cleaned = this.sessionManager.cleanupAllSessions();
    if (cleaned > 0) {
      console.log(`[AIService] Cleaned ${cleaned} empty messages from existing sessions on startup`);
    }
  }

  public async queuePromptForSession(
    sessionId: string,
    prompt: string,
    attachments?: any[],
    documentContext?: any
  ): Promise<{ id: string; prompt: string; createdAt: number }> {
    const { getQueuedPromptsStore } = await import('../RepositoryManager');
    const queueStore = getQueuedPromptsStore();
    const promptId = `meta-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
    const queuedDocumentContext = documentContext?.promptProvenance
      ? {
          ...documentContext,
          promptProvenance: {
            ...documentContext.promptProvenance,
            queuedPromptId: promptId,
          },
        }
      : documentContext;
    const created = await queueStore.create({
      id: promptId,
      sessionId,
      prompt,
      attachments,
      documentContext: queuedDocumentContext,
    });
    return { id: created.id, prompt: created.prompt, createdAt: created.createdAt };
  }

  /**
   * Resolves (and, when allowed, opens) the window a queued prompt needs.
   * Shared by the mobile sync path and the queue driver so a prompt from the
   * phone behaves the same whichever trigger delivered it (#962).
   */
  private readonly queueWindowResolver = createWorkspaceWindowResolver<Electron.BrowserWindow>({
    findWindow: (workspacePath) => findWindowByWorkspace(workspacePath),
    isDestroyed: (window) => window.isDestroyed(),
    workspaceExists: (workspacePath) => fs.existsSync(workspacePath),
    createWindow: (workspacePath) => createWindow(false, true, workspacePath),
    waitForLoad: (window) =>
      new Promise<void>((resolve) => {
        window.webContents.once('did-finish-load', () => resolve());
      }),
    isQuitting: () => isAppQuitting(),
    now: () => Date.now(),
    logInfo: (message) => logger.main.info(message),
    logWarn: (message) => logger.main.warn(message),
  });

  private queueDriveService: QueueDriveService | null = null;

  /**
   * The single owner of queued-prompt drainage. Every trigger — renderer,
   * mobile control message, mobile sync, FIFO continuation, boot recovery,
   * wakeup — funnels through this so a blocked attempt re-drives itself
   * instead of evaporating (#962).
   */
  /**
   * Make Cancel authoritative over session state.
   *
   * `provider.abort()` only unwinds a turn that is still in flight; once the
   * per-turn AbortController has been cleared it is a no-op. If the turn died
   * without a terminal transition (e.g. a Codex app-server RPC error yielded an
   * in-band error chunk and returned), SessionStateManager still holds
   * `running`, so the renderer's 15s processing reconcile puts the spinner back
   * a few seconds after every click. Clearing the state here means one click
   * always stops the session, whichever way the turn ended.
   */
  private async forceSessionIdleOnCancel(sessionId: string): Promise<void> {
    try {
      const stateManager = getSessionStateManager();
      if (!shouldForceIdleOnCancel(stateManager.getSessionState(sessionId))) return;
      await stateManager.interruptSession(sessionId);
    } catch (error) {
      logger.main.error(`[AIService] Failed to clear session state on cancel for ${sessionId}:`, error);
    }
  }

  private getQueueDrive(): QueueDriveService {
    if (!this.queueDriveService) {
      this.queueDriveService = new QueueDriveService({
        attempt: (input) => this.attemptQueueDrive(input),
        onWindowAvailable: (workspacePath, listener) =>
          onWorkspaceWindowAvailable((availablePath) => {
            if (availablePath === workspacePath) listener();
          }),
        onSessionIdle: (sessionId, listener) => {
          const stateManager = getSessionStateManager();
          const handler = (event: { sessionId: string }) => {
            if (event.sessionId === sessionId) listener();
          };
          // Only the three terminal transitions; subscribing to all seven
          // would register more listeners per deferred session for nothing.
          stateManager.on('session:completed', handler);
          stateManager.on('session:error', handler);
          stateManager.on('session:interrupted', handler);
          return () => {
            stateManager.removeListener('session:completed', handler);
            stateManager.removeListener('session:error', handler);
            stateManager.removeListener('session:interrupted', handler);
          };
        },
        logInfo: (message) => logger.main.info(message),
        logWarn: (message) => logger.main.warn(message),
        logError: (message, error) => logger.main.error(message, error),
      });
    }
    return this.queueDriveService;
  }

  /** Ask the driver to drain a session's queue. Fire-and-forget. */
  public requestQueueDrive(sessionId: string, workspacePath: string, reason: DriveReason): void {
    this.getQueueDrive().requestDrive(sessionId, workspacePath, reason);
  }

  /**
   * Mirror a session's remaining pending queue into the sync index. Must run
   * after every queue transition, or mobile keeps re-showing a prompt the
   * desktop already claimed — see queuedPromptSyncPublisher.ts (NIM-2402).
   */
  public async publishQueueStateToSync(sessionId: string): Promise<void> {
    await publishQueuedPromptsToSync(
      {
        listPending: async (id) => {
          const { getQueuedPromptsStore } = await import('../RepositoryManager');
          return getQueuedPromptsStore().listPending(id);
        },
        getSyncProvider,
        logWarn: (message) => logger.main.warn(message),
      },
      sessionId,
    );
  }

  /** Drain a session's queue and report what happened. */
  public driveQueuedPrompts(
    sessionId: string,
    workspacePath: string,
    reason: DriveReason,
  ): Promise<DriveOutcome> {
    return this.getQueueDrive().drive(sessionId, workspacePath, reason);
  }

  /**
   * One drive attempt. Returns a deferred outcome (never a discarded `false`)
   * so the driver can arm the matching wake condition.
   */
  private async attemptQueueDrive({
    sessionId,
    workspacePath,
    reason,
  }: {
    sessionId: string;
    workspacePath: string;
    reason: DriveReason;
  }): Promise<DriveOutcome> {
    const { getQueuedPromptsStore } = await import('../RepositoryManager');
    let queueStore: ReturnType<typeof getQueuedPromptsStore>;
    try {
      queueStore = getQueuedPromptsStore();
    } catch {
      return { kind: 'deferred', reason: 'db-not-ready' };
    }

    return runQueueDriveAttempt<Electron.BrowserWindow>(
      {
        listPendingIds: async (id) => (await queueStore.listPending(id)).map((row) => row.id),
        isChainActive: (id) => this.sessionsProcessingQueue.has(id),
        isSessionBusy: (id) => {
          const liveState = getSessionStateManager().getSessionState(id);
          return !!liveState && (liveState.status === 'running' || liveState.isStreaming);
        },
        resolveWindow: (path, allowAutoOpen) =>
          this.queueWindowResolver.resolve(path, { allowAutoOpen }),
        failAllPending: async (id, errorMessage) => {
          const failed = await queueStore.failAllPendingForSession(id, errorMessage);
          await this.publishQueueStateToSync(id);
          return failed;
        },
        dispatch: ({ sessionId: id, workspacePath: path, window, reason: driveReason }) =>
          this.tryDispatchNextQueuedPrompt(id, path, window, `queue-drive:${driveReason}`),
        logWarn: (message) => logger.main.warn(message),
      },
      { sessionId, workspacePath, reason },
    );
  }

  public async triggerQueuedPromptProcessingForSession(
    sessionId: string,
    workspacePath: string,
    reason: DriveReason = 'renderer-trigger',
  ): Promise<boolean> {
    const outcome = await this.driveQueuedPrompts(sessionId, workspacePath, reason);
    return outcome.kind === 'dispatched';
  }

  /**
   * Interrupt the current turn (graceful when possible) so queued prompts are
   * processed sooner. Providers that support a true mid-stream interrupt
   * (Claude Code) wrap up cleanly; others fall back to abort() via the
   * BaseAIProvider default. Returns `method` so the caller can distinguish.
   *
   * Defensive cleanup runs before the interrupt: clear the in-memory
   * sessionsProcessingQueue guard and unwedge any rows stuck in 'executing' via
   * sweepExecutingForSession (delivery-aware -- already delivered prompts are
   * marked completed, not rolled back, so a follow-up queue drive doesn't
   * re-send the same input -- NIM-615).
   */
  public async interruptCurrentTurn(sessionId: string): Promise<InterruptCurrentTurnResult> {
    if (!sessionId) {
      throw new Error('Session ID is required to interrupt');
    }

    const { AISessionsRepository } = await import('@nimbalyst/runtime/storage/repositories/AISessionsRepository');
    const session = await AISessionsRepository.get(sessionId);
    if (!session) {
      return { success: false, error: 'Session not found' };
    }

    if (session.provider === 'claude-code-cli') {
      const terminalManager = getTerminalSessionManager();
      if (!terminalManager.isTerminalActive(sessionId)) {
        return { success: false, error: 'No active terminal for session' };
      }

      terminalManager.writeToTerminal(sessionId, '\x03');
      logger.main.info(`[AIService] Interrupted claude-code-cli terminal for session ${sessionId}`);
      return { success: true, method: 'terminal-ctrl-c' };
    }

    const provider = ProviderFactory.getProvider(session.provider as AIProviderType, sessionId);
    if (!provider) {
      return { success: false, error: 'No active provider for session' };
    }

    this.sessionsProcessingQueue.delete(sessionId);
    try {
      const { getQueuedPromptsStore } = await import('../RepositoryManager');
      const queueStore = getQueuedPromptsStore();
      const { completed, failed, rolledBack } = await queueStore.sweepExecutingForSession(sessionId);
      if (completed > 0 || failed > 0 || rolledBack > 0) {
        logger.main.info(
          `[AIService] interruptCurrentTurn: swept session ${sessionId} -- ${completed} answered marked completed, ${failed} delivered-but-unanswered marked failed, ${rolledBack} undelivered rolled back`
        );
        await this.publishQueueStateToSync(sessionId);
      }
    } catch (sweepErr) {
      logger.main.error('[AIService] interruptCurrentTurn: sweepExecutingForSession failed:', sweepErr);
    }

    const result = await provider.interruptCurrentTurn();
    logger.main.info(`[AIService] Interrupted current turn for session ${sessionId} (method=${result.method})`);

    // A session stuck at running/streaming with no turn behind it -- because
    // there never was one, or because `method: 'abort'` just destroyed it --
    // would otherwise defer the follow-up queue drive on a `session:completed`
    // that can never arrive (NIM-2434, NIM-2512).
    const stateManager = getSessionStateManager();
    const forcedIdle = await clearStuckRunningState(
      {
        getSessionState: (id) => stateManager.getSessionState(id),
        interruptSession: (id) => stateManager.interruptSession(id),
        logWarn: (message) => logger.main.warn(message),
      },
      { sessionId, hadActiveTurn: result.hadActiveTurn, method: result.method },
    );

    return { success: true, method: result.method, forcedIdle };
  }

  public async respondToInteractivePrompt(params: {
    sessionId: string;
    promptId: string;
    promptType: 'permission_request' | 'ask_user_question_request' | 'exit_plan_mode_request';
    response: any;
    respondedBy?: 'desktop' | 'mobile';
  }): Promise<{ success: boolean; error?: string }> {
    const { sessionId, promptId, promptType, response, respondedBy = 'desktop' } = params;
    const { AISessionsRepository } = await import('@nimbalyst/runtime/storage/repositories/AISessionsRepository');
    const { database } = await import('../../database/PGLiteDatabaseWorker');
    const session = await AISessionsRepository.get(sessionId);
    if (!session) {
      return { success: false, error: 'Session not found' };
    }

    let responseContent: Record<string, unknown>;
    if (promptType === 'permission_request') {
      responseContent = {
        type: 'permission_response',
        requestId: promptId,
        decision: response.decision,
        scope: response.scope,
        respondedAt: Date.now(),
        respondedBy,
      };
    } else if (promptType === 'ask_user_question_request') {
      responseContent = {
        type: 'ask_user_question_response',
        questionId: promptId,
        answers: response.answers || response,
        cancelled: response.cancelled || false,
        respondedAt: Date.now(),
        respondedBy,
      };
    } else {
      responseContent = {
        type: 'exit_plan_mode_response',
        requestId: promptId,
        approved: response.approved,
        clearContext: response.clearContext,
        feedback: response.feedback,
        respondedAt: Date.now(),
        respondedBy,
      };
    }

    await database.query(
      `INSERT INTO ai_agent_messages (session_id, source, direction, content, created_at, hidden)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [sessionId, 'nimbalyst', 'output', JSON.stringify(responseContent), new Date(), false]
    );

    if (promptType === 'permission_request') {
      const provider = ProviderFactory.getProvider(session.provider as AIProviderType, sessionId);
      if (!provider) {
        return { success: false, error: 'Provider not found' };
      }
      if (typeof (provider as any).resolveToolPermission !== 'function') {
        return { success: false, error: 'Provider does not support tool permission responses' };
      }
      (provider as any).resolveToolPermission(promptId, response, sessionId, respondedBy);
      return { success: true };
    }

    if (promptType === 'ask_user_question_request') {
      const provider = ProviderFactory.getProvider(session.provider as AIProviderType, sessionId);
      const resolved = provider && isAskUserQuestionProvider(provider)
        ? provider.resolveAskUserQuestion(promptId, response.answers || response, sessionId, respondedBy)
        : false;

      const { rows: askRequestRows } = await database.query<{ id: string }>(
        `SELECT id
         FROM ai_agent_messages
         WHERE session_id = $1
           AND content LIKE '%"type":"ask_user_question_request"%'
           AND content LIKE $2
         LIMIT 1`,
        [sessionId, `%"questionId":"${promptId}"%`]
      );
      const hasPersistedQuestionRequest = askRequestRows.length > 0;

      const askUserQuestionChannel = `ask-user-question-response:${sessionId}:${promptId}`;
      const hasAskUserQuestionWaiter = ipcMain.listenerCount(askUserQuestionChannel) > 0;
      if (hasAskUserQuestionWaiter) {
        ipcMain.emit(askUserQuestionChannel, {} as any, {
          questionId: promptId,
          answers: response.answers || response,
          cancelled: response.cancelled || false,
          respondedBy,
          sessionId,
        });
      }

      const sessionFallbackChannel = `ask-user-question:${sessionId}`;
      const hasSessionFallbackWaiter = ipcMain.listenerCount(sessionFallbackChannel) > 0;
      if (hasSessionFallbackWaiter) {
        ipcMain.emit(sessionFallbackChannel, {} as any, {
          questionId: promptId,
          answers: response.answers || response,
          cancelled: response.cancelled || false,
          respondedBy,
          sessionId,
        });
      }

      return resolved || hasAskUserQuestionWaiter || hasSessionFallbackWaiter || hasPersistedQuestionRequest
        ? { success: true }
        : { success: false, error: 'Question not found' };
    }

    const provider = ProviderFactory.getProvider(session.provider as AIProviderType, sessionId);
    if (!provider) {
      return { success: false, error: 'Provider not found' };
    }

    if (typeof (provider as any).resolveExitPlanModeConfirmation !== 'function') {
      return { success: false, error: 'Provider does not support ExitPlanMode responses' };
    }

    (provider as any).resolveExitPlanModeConfirmation(promptId, response, sessionId, respondedBy);
    if (response.approved) {
      await AISessionsRepository.updateMetadata(sessionId, { mode: 'agent' });
    }
    return { success: true };
  }

  /**
   * Back-fill any claude-code variants that shipped after this user's
   * `providerSettings['claude-code'].models` allow-list was first persisted.
   * Without this, `ai:getModels` filters out newly-introduced variants (they
   * aren't in the saved list and ClaudeCodePanel has no per-model UI to re-enable
   * them) — the drift that silently hid Fable 5 and sonnet-4-6.
   *
   * This is a single self-reconciliation against the catalog source of truth
   * (`CLAUDE_CODE_VARIANTS`) rather than one hand-written migration per variant:
   * a persisted snapshot of "known" variant ids records what we've seen before,
   * so any future variant is enabled by default with no code change, while a
   * variant the user has deliberately removed (already in the snapshot) is never
   * re-added. See `claudeCodeModelReconcile.ts`.
   */
  private reconcileClaudeCodeModelList(): void {
    const KNOWN_KEY = 'migrations.knownClaudeCodeVariants';
    const known = this.settingsStore!.get(KNOWN_KEY) as string[] | undefined;
    const providerSettings = this.settingsStore!.get('providerSettings', {}) as any;
    const claudeCode = providerSettings?.['claude-code'];

    // An empty/undefined models array means "allow all", so there is nothing to
    // back-fill — only reconcile an explicit allow-list.
    if (claudeCode && Array.isArray(claudeCode.models) && claudeCode.models.length > 0) {
      const result = reconcileClaudeCodeModels(claudeCode.models, known);
      if (result.changed) {
        claudeCode.models = result.models;
        this.settingsStore!.set('providerSettings', providerSettings);
      }
      this.settingsStore!.set(KNOWN_KEY, result.known);
    } else {
      // Still advance the snapshot so a later switch to an explicit list starts
      // from the current catalog instead of re-flagging everything as new.
      this.settingsStore!.set(KNOWN_KEY, reconcileClaudeCodeModels([], known).known);
    }
  }

  private getSettingsStore(): Store<Record<string, unknown>> {
    if (!this.settingsStore) {
      this.settingsStore = new Store<Record<string, unknown>>({
        name: 'ai-settings',
        schema: {
          defaultProvider: {
            type: 'string',
            default: 'claude-code'
          },
          apiKeys: {
            type: 'object',
            default: {}
          },
          providerSettings: {
            type: 'object',
            default: {
              claude: {
                enabled: false,
                testStatus: "idle",
              },
              'claude-code': {
                enabled: true,
                testStatus: "idle",
                installStatus: "not-installed",
                // Allow-all: no curated default list. There is no UI to curate
                // claude-code models and nothing writes this array, so shipping a
                // hardcoded subset only creates drift — a newly-added variant that
                // someone forgets to list gets silently filtered out of the picker
                // (this is how Fable 5 and sonnet-4-6 disappeared, NIM-1486). An
                // empty list means "show whatever the catalog emits", so the
                // catalog (ClaudeCodeProvider.getModels) is the single source of
                // truth and cannot drift.
                models: []
              },
              openai: {
                enabled: false,
                testStatus: "idle",
              },
              'openai-codex': {
                enabled: true,
                testStatus: "idle",
                installStatus: "not-installed",
              },
              lmstudio: {
                enabled: false,
                testStatus: "idle",
                baseUrl: "http://127.0.0.1:8234"
              }
            }
          },
          showToolCalls: {
            type: 'boolean',
            default: false  // Hidden by default, developer mode only
          },
          chatShowToolCalls: {
            type: 'boolean',
            default: true  // User-facing chat toggle; defaults true to preserve current UX
          },
          aiDebugLogging: {
            type: 'boolean',
            default: false  // Hidden by default, developer mode only
          }
        }
      });
      this.reconcileClaudeCodeModelList();
    }
    return this.settingsStore;
  }

  /**
   * Get API key for a provider, considering project-level overrides.
   * Project-specific API keys take precedence over global keys.
   */
  private getApiKeyForProvider(provider: string, workspacePath?: string): string | undefined {
    const globalApiKeys = this.getSettingsStore().get('apiKeys', {}) as Record<string, string>;
    const providerSettings = this.getNormalizedProviderSettings() as any;

    // Claude Code must never use implicit keys.
    // It only uses its dedicated key when API-key auth is explicitly selected.
    if (provider === 'claude-code') {
      const authMethod = providerSettings?.['claude-code']?.authMethod ?? 'login';
      if (authMethod !== 'api-key') {
        return undefined;
      }
    }

    // Check for project-level API key override
    if (workspacePath) {
      const overrides = getAIProviderOverrides(workspacePath);
      const overrideKey = overrides?.providers?.[provider]?.apiKey;
      if (overrideKey) {
        return overrideKey;
      }
    }

    // Return the explicitly-configured global API key.
    // NEVER fall back to process.env — users must explicitly set keys in settings.
    // Implicit env-var usage caused a user to burn $100+ on their personal Anthropic
    // account because Nimbalyst silently picked up ANTHROPIC_API_KEY from a .env file.

    // Extension-agent providers (aiAgentProviders contributions) defer auth to
    // the extension itself (e.g. Antigravity rides ~/.gemini OAuth). The host
    // does not manage their API key. See providerResolution.ts for the shim
    // until session.provider is widened to a discriminated union.
    if (isExtensionAgentProvider(provider)) {
      return 'not-required';
    }

    switch (provider) {
      case 'claude':
        return globalApiKeys['anthropic'];
      case 'claude-code':
        return globalApiKeys['claude-code'];
      case 'openai':
        return globalApiKeys['openai'];
      case 'openai-codex':
        return globalApiKeys['openai-codex'];
      case 'lmstudio':
        return 'not-required';
      case 'antigravity-gemini-agent':
        // Rides the user's existing Antigravity / ~/.gemini login. Nimbalyst
        // holds no key for it, and deliberately reads no env var -- see the
        // standing rule in CLAUDE.md.
        return 'not-required';
      default:
        return globalApiKeys[provider];
    }
  }

  /**
   * Build the latest Claude Code runtime config from current settings/session state.
   * This is used to refresh existing provider instances so auth changes take effect immediately.
   */
  private async buildClaudeCodeRuntimeConfig(
    session: SessionData,
    workspacePath?: string
  ): Promise<ProviderConfig> {
    const effectiveWorkspacePath = session.workspacePath || workspacePath;
    const apiKey = this.getApiKeyForProvider('claude-code', effectiveWorkspacePath);

    const effortLevel = resolveEffortLevel((session.metadata as any)?.effortLevel, getDefaultEffortLevel());
    const config: ProviderConfig = {
      maxTokens: (session.providerConfig as any)?.maxTokens,
      temperature: (session.providerConfig as any)?.temperature,
      ...(apiKey ? { apiKey } : {}),
      ...(effortLevel && { effortLevel }),
      thinkingMode: resolveThinkingMode((session.metadata as any)?.thinkingMode, getDefaultThinkingMode()),
    };

    const fullModel = session.model || session.providerConfig?.model;
    if (fullModel) {
      config.model = fullModel;
    } else {
      // Billing safety (#631 / NIM-848): a session with no resolved model must
      // fall back to a STANDARD 200k model, never the 1M user-facing default
      // (ModelRegistry.getDefaultModel('claude-code') is `opus-1m`). Sending the
      // paid 1M beta for an empty/lost model silently bills the user.
      config.model = CLAUDE_CODE_SAFE_FALLBACK_MODEL;
    }

    return config;
  }

  /**
   * Compute document transition and diff by comparing incoming content with stored state.
   * The renderer always sends full content - we compute optimization here on the backend.
   *
   * @param documentContext - The context received from renderer (always full content)
   * @param sessionId - The session ID for looking up last document state
   * @returns Context with transition info and optional diff for prompt optimization
   */

  /**
   * Check if a provider is enabled for a workspace, considering project-level overrides.
   */
  private isProviderEnabledForWorkspace(provider: string, workspacePath?: string): boolean {
    const providerSettings = this.getSettingsStore().get('providerSettings', {}) as any;

    // Claude Code is enabled by default (undefined means enabled).
    // This matches the logic in ai:getModels which uses `claudeCodeSettings.enabled !== false`.
    // Other providers require explicit enabling (undefined means disabled).
    const globalEnabled = provider === 'claude-code'
      ? providerSettings[provider]?.enabled !== false
      : providerSettings[provider]?.enabled ?? false;

    // Check for project-level override
    if (workspacePath) {
      const overrides = getAIProviderOverrides(workspacePath);
      if (overrides?.providers?.[provider]?.enabled !== undefined) {
        return overrides.providers[provider].enabled;
      }
    }

    return globalEnabled;
  }

  private async continueQueuedPromptChain(
    sessionId: string,
    workspacePath: string,
    targetWindow: Electron.BrowserWindow | null,
    source: string
  ): Promise<void> {
    const liveWindow =
      targetWindow && !targetWindow.isDestroyed()
        ? targetWindow
        : findWindowByWorkspace(workspacePath);
    if (!liveWindow || liveWindow.isDestroyed()) {
      logger.main.info(`[AIService] ${source}: no live window available to continue queued prompts for session ${sessionId}`);
      // Hand off instead of dropping the chain — the driver opens or waits for
      // a window and drives the remaining rows (#962).
      this.requestQueueDrive(sessionId, workspacePath, 'fifo-continuation');
      return;
    }

    const { getQueuedPromptsStore } = await import('../RepositoryManager');
    const queueStore = getQueuedPromptsStore();
    const pendingPrompts = await queueStore.listPending(sessionId);

    if (pendingPrompts.length === 0) {
      return;
    }

    logger.main.info(
      `[AIService] ${source}: ${pendingPrompts.length} pending prompts remain for session ${sessionId}, triggering next`
    );
    const dispatched = await this.processQueuedPrompt(sessionId, workspacePath, liveWindow);
    if (!dispatched) {
      this.requestQueueDrive(sessionId, workspacePath, 'fifo-continuation');
    }
  }

  public async tryDispatchNextQueuedPrompt(
    sessionId: string,
    workspacePath: string,
    targetWindow: Electron.BrowserWindow | null,
    source: string,
  ): Promise<boolean> {
    // NIM-834: claude-code-cli sessions have no in-process turn driver — the SDK
    // dispatch below would call the provider's Phase 1 sendMessage stub and mark
    // the prompt failed (broke meta-agent spawns, restart continuations, and
    // scheduled wakeups for CLI sessions). Route them onto the CLI's PTY
    // queue-drain rails instead: launch the genuine CLI if needed and let the
    // PID watcher's idle flush deliver the prompt.
    let dispatchSession: { provider?: string; model?: string | null; worktreeId?: string | null } | null = null;
    try {
      const { AISessionsRepository } = await import('@nimbalyst/runtime/storage/repositories/AISessionsRepository');
      dispatchSession = await AISessionsRepository.get(sessionId);
    } catch (lookupError) {
      logger.main.warn(`[AIService] ${source}: provider lookup failed before queued dispatch:`, lookupError);
    }
    if (dispatchSession?.provider === 'claude-code-cli') {
      return this.dispatchQueuedPromptToClaudeCliSession(sessionId, workspacePath, dispatchSession, source);
    }

    const { getQueuedPromptsStore } = await import('../RepositoryManager');
    const queueStore = getQueuedPromptsStore();

    // Captures whether the just-settled child chain ended in 'error' so the
    // meta-agent wakeup (onAfterSettled) can skip re-driving the parent for a
    // dead child. endSession (in onChainSettled, which runs before onAfterSettled)
    // evicts the child from the state manager, so its terminal status must be
    // read in onChainSettled before that happens.
    let settledChildErrored = false;

    return tryClaimAndDispatchNextQueuedPrompt({
      continueQueuedPromptChain: (nextSessionId, nextWorkspacePath, nextTargetWindow, nextSource) =>
        this.continueQueuedPromptChain(nextSessionId, nextWorkspacePath, nextTargetWindow, nextSource),
      logError: (message, error) => logger.main.error(message, error),
      logInfo: (message) => logger.main.info(message),
      resolveLiveWindow: findWindowByWorkspace,
      onAfterSettled: async () => {
        try {
          const { AISessionsRepository } = await import('@nimbalyst/runtime/storage/repositories/AISessionsRepository');
          const childSession = await AISessionsRepository.get(sessionId);
          if (!childSession?.createdBySessionId) return;

          // Honor fire-and-forget. spawn_session sets metadata.notifyParent=false
          // on the child for /launch-new-session-style hand-offs where the parent
          // does not want to be re-driven when the child settles. Without this
          // guard, every child settle wakes the parent unconditionally, which
          // re-drives the meta-agent in a loop. Matches the guard in
          // MetaAgentService.handleChildSessionEvent.
          const childMetadata = (childSession.metadata as Record<string, unknown> | undefined) ?? undefined;
          if (childMetadata && childMetadata.notifyParent === false) return;

          // Do not re-drive the parent when the child chain just settled in
          // 'error'. A failed child (e.g. an antigravity 429) has no result to
          // deliver, and waking the parent on every such settle is the meta-agent
          // spin loop. Native children settle 'completed', so this is a no-op for
          // them. settledChildErrored is captured in onChainSettled before
          // endSession evicts the child's in-memory state.
          if (settledChildErrored) return;

          const metaSession = await AISessionsRepository.get(childSession.createdBySessionId);
          if (!metaSession?.workspacePath) return;

          const stateManager = getSessionStateManager();
          const metaState = stateManager.getSessionState(metaSession.id);
          const metaStatus = metaState?.status || 'idle';
          if (metaStatus === 'idle' || metaStatus === 'error') {
            logger.main.info(`[AIService] ${source}: waking meta-agent ${metaSession.id} after child ${sessionId} completed`);
            this.requestQueueDrive(metaSession.id, metaSession.workspacePath, 'meta-agent');
          }
        } catch (metaErr) {
          logger.main.error(`[AIService] ${source}: error checking meta-agent wakeup:`, metaErr);
        }
      },
      onChainSettled: async ({ sessionId: settledSessionId, source: settledSource }) => {
        // The completion handler in MessageStreamingHandler deferred endSession
        // because processingSet still contained this session while the inner
        // sendMessage was running. Now that the chain has fully drained, mark
        // the session idle and stop its file watcher.
        const stateManager = getSessionStateManager();
        // Capture the child's terminal status BEFORE endSession evicts it from
        // the state manager, so onAfterSettled can avoid waking the parent for a
        // child that just failed. getSessionState reads the in-memory map, which
        // endSession clears on the next line.
        settledChildErrored = stateManager.getSessionState(settledSessionId)?.status === 'error';
        logger.main.info(`[AIService] ${settledSource}: chain settled for session ${settledSessionId}, ending session`);
        await stateManager.endSession(settledSessionId);
        this.hooklessWatcher.scheduleStop(settledSessionId, 500);
      },
      onPromptClaimed: ({ sessionId: claimedSessionId, promptId }) => {
        publishQueuedPromptClaim({ sessionId: claimedSessionId, promptId });
        targetWindow?.webContents.send('ai:promptClaimed', {
          sessionId: claimedSessionId,
          promptId,
        });
        // The claimed row leaves the queue mobile sees; the publisher never throws.
        void this.publishQueueStateToSync(claimedSessionId);
      },
      processingSet: this.sessionsProcessingQueue,
      queueStore,
      sendMessageHandler: this.sendMessageHandler,
      sessionId,
      source,
      startSession: ({ sessionId: activeSessionId, workspacePath: activeWorkspacePath }) =>
        getSessionStateManager().startSession({
          sessionId: activeSessionId,
          workspacePath: activeWorkspacePath,
        }),
      targetWindow,
      workspacePath,
    });
  }

  /**
   * NIM-834: deliver queued prompts to a claude-code-cli session via the CLI
   * rails (launch + PID-watcher idle flush) instead of the SDK dispatcher.
   * Worktree-linked sessions spawn the CLI in the worktree so edits land where
   * the session's view points.
   */
  private async dispatchQueuedPromptToClaudeCliSession(
    sessionId: string,
    workspacePath: string,
    session: { model?: string | null; worktreeId?: string | null },
    source: string,
  ): Promise<boolean> {
    let cwd: string | undefined;
    if (session.worktreeId) {
      try {
        const { createWorktreeStore } = await import('../WorktreeStore');
        const { getDatabase } = await import('../../database/initialize');
        const db = getDatabase();
        const worktree = db ? await createWorktreeStore(db).get(session.worktreeId) : null;
        cwd = worktree?.path ?? undefined;
      } catch (worktreeError) {
        logger.main.warn(`[AIService] ${source}: worktree lookup failed for CLI queued dispatch:`, worktreeError);
      }
    }

    const terminalManager = getTerminalSessionManager();
    return dispatchQueuedPromptToClaudeCli(
      {
        isTerminalActive: (id) => terminalManager.isTerminalActive(id),
        ensureSession: (input) => ensureClaudeCliSession(input),
        getLiveTurnState: (id) => terminalManager.getClaudeCliLiveTurnState(id),
        getSnapshotStatus: (id) => getSessionStateManager().getSessionState(id)?.status ?? null,
        flushNext: (id, ws) => flushNextClaudeCliQueuedPromptForSession(id, ws),
        logInfo: (message) => logger.main.info(`[AIService] ${source}: ${message}`),
        logWarn: (message) => logger.main.warn(`[AIService] ${source}: ${message}`),
      },
      { sessionId, workspacePath, model: session.model, cwd },
    );
  }

  /**
   * Process the next queued prompt for a session.
   * Called from mobile sync handler to ensure prompts are processed even when session isn't open.
   * Also used by the ai:triggerQueueProcessing IPC handler.
   */
  private async processQueuedPrompt(sessionId: string, workspacePath: string, targetWindow: Electron.BrowserWindow): Promise<boolean> {
    return this.tryDispatchNextQueuedPrompt(
      sessionId,
      workspacePath,
      targetWindow,
      'processQueuedPrompt',
    );
  }


  private async getProviderForSession(session: SessionData): Promise<AIProvider | null> {
    const providerType = session.provider as AIProviderType;

    // Try to get existing provider first
    let provider = ProviderFactory.getProvider(providerType, session.id);

    // If no existing provider, create one
    if (!provider) {
      logger.main.info('[AIService] Creating new provider for session:', session.id, 'type:', providerType);
      try {
        provider = ProviderFactory.createProvider(providerType, session.id);
      } catch (error) {
        logger.main.error('[AIService] Failed to create provider:', providerType, error);
        return null;
      }
    }

    // NOTE: Message sync is handled automatically by SyncedAgentMessagesStore

    return provider;
  }

  private getProviderWorkflowCatalog(request: {
    sessionId?: string;
    provider?: string | null;
  }): ProviderWorkflowCatalog {
    // Absent an explicit provider, probe the agent providers for a live
    // instance on this session; the first one that exists tells us the type.
    const providerCandidates = request.provider
      ? [request.provider]
      : ['claude-code', 'openai-codex', 'openai-codex-acp', 'opencode', 'grok-build', 'cursor-agent'];

    let instance: AIProvider | undefined;
    let resolvedType: string | null = request.provider ?? null;
    if (request.sessionId) {
      for (const providerType of providerCandidates) {
        instance = ProviderFactory.getProvider(providerType as AIProviderType, request.sessionId) ?? undefined;
        if (instance) {
          resolvedType = providerType;
          break;
        }
      }
    }
    // Callers that name no provider are asking about the default one.
    const effectiveType = resolvedType ?? 'claude-code';

    return resolveProviderWorkflowCatalog(effectiveType, {
      instance,
      cachedCatalog: CROSS_SESSION_WORKFLOW_CATALOGS[effectiveType as AIProviderType],
    });
  }

  /**
   * Automatically runs the /context command for claude-code sessions to fetch accurate token usage.
   * @param session The AI session
   * @param workspacePath The workspace path to use (should be worktree path for worktree sessions)
   * @param event The IPC event for sending updates
   */
  private async runAutoContextCommand(
    session: SessionData,
    workspacePath: string,
    event: Electron.IpcMainInvokeEvent
  ): Promise<void> {
    if (session.provider !== 'claude-code') {
      return;
    }

    const sendAutoContextEvent = (phase: 'start' | 'end') => {
      try {
        // console.log(`[AIService] Sending ai:auto-context-${phase} event for session:`, session.id);
        safeSend(event, `ai:auto-context-${phase}`, {
          sessionId: session.id
        });
        // console.log(`[AIService] Successfully sent ai:auto-context-${phase} event`);
      } catch (err) {
        console.error('[AIService] Failed to send auto-context lifecycle event:', err);
      }
    };

    sendAutoContextEvent('start');

    try {
      const contextProvider = ProviderFactory.getProvider(session.provider as AIProviderType, session.id);
      if (!contextProvider) {
        console.warn('[AIService] No context provider found for session:', session.id);
        return;
      }

      const updatedSession = await this.sessionManager.loadSession(session.id, workspacePath);
      if (!updatedSession) {
        console.error('[AIService] Failed to reload session for /context command');
        logger.main.error('Failed to reload session for /context command');
        return;
      }

      if (contextProvider.setHiddenMode) {
        contextProvider.setHiddenMode(true);
      }

      let contextResponse = '';
      for await (const chunk of contextProvider.sendMessage('/context', undefined, session.id, updatedSession.messages, workspacePath, [])) {
        if (!chunk) continue;

        if (chunk.type === 'text') {
          contextResponse += chunk.content || '';
        } else if (chunk.type === 'complete') {
          // Prefer the SDK's structured twin of the report when the binary
          // attaches one (agent-SDK 0.3.241+): it carries exact token counts
          // where the markdown is rendered to three significant figures, and it
          // does not depend on the CLI's table layout staying byte-stable.
          const parsedUsage = chunk.contextReport ?? parseContextUsageMessage(contextResponse);

          if (parsedUsage) {
            // Get current session to preserve cumulative tokens
            const currentSession = await this.sessionManager.loadSession(session.id, workspacePath);
            const currentUsage = currentSession?.tokenUsage ?? {
              inputTokens: 0,
              outputTokens: 0,
              totalTokens: 0
            };

            // Store /context data in currentContext (snapshot of context window)
            // Preserve cumulative input/output tokens from modelUsage
            const tokenUsage = {
              inputTokens: currentUsage.inputTokens,
              outputTokens: currentUsage.outputTokens,
              totalTokens: currentUsage.totalTokens,
              costUSD: currentUsage.costUSD,
              // Legacy fields for backward compatibility
              contextWindow: parsedUsage.contextWindow,
              categories: parsedUsage.categories,
              // New field for context window snapshot
              currentContext: {
                tokens: parsedUsage.totalTokens,
                contextWindow: parsedUsage.contextWindow,
                categories: parsedUsage.categories,
                rawResponse: contextResponse  // Store raw markdown for display on session reload
              }
            };

            // Persist token usage to session metadata
            await this.sessionManager.updateSessionTokenUsage(session.id, tokenUsage);

            // Push context usage to mobile sync
            const syncProvider = getSyncProvider();
            if (syncProvider) {
              syncProvider.pushChange(session.id, {
                type: 'metadata_updated',
                metadata: {
                  currentContext: {
                    tokens: parsedUsage.totalTokens,
                    contextWindow: parsedUsage.contextWindow,
                  },
                } as any,
              });
            }

            // Also send IPC event to update UI immediately
            safeSend(event, 'ai:tokenUsageUpdated', {
              sessionId: session.id,
              tokenUsage
            });
          } else {
            console.error('[AIService] Failed to parse /context response for token usage. Full response:', contextResponse);
            logger.main.warn('Failed to parse /context response for token usage');
          }

          break;
        } else if (chunk.type === 'error') {
          console.error('[AIService] Error chunk from /context:', chunk.error || 'Unknown error');
          logger.main.error('Error fetching context:', chunk.error || 'Unknown error');
          break;
        }
      }
    } catch (contextError) {
      console.error('[AIService] Exception while fetching context usage:', contextError);
      logger.main.error('Failed to fetch context usage:', contextError);
      // Don't fail the main request if context fetch fails
    } finally {
      sendAutoContextEvent('end');
    }
  }

  /**
   * The seam the `ipc/register*Handlers` modules bind to. Built as an object
   * literal (not a cast) so TypeScript checks it for completeness — a member
   * dropped or misnamed while handlers move out of `setupIpcHandlers` becomes
   * a compile error instead of a runtime failure in a rarely-exercised handler.
   *
   * Methods are wrapped in arrows rather than bound, so `this` stays correct
   * and the wrapper reads the current field on every call.
   */
  private buildIpcContext(): AIServiceContext {
    return {
      sessionManager: this.sessionManager,
      analytics: this.analytics,
      // Same value the field was just assigned. Taken from the source so the
      // context's non-null type holds without a narrowing assertion.
      sendMessageHandler: this.streamingHandler.handle,
      sessionsProcessingQueue: this.sessionsProcessingQueue,
      documentContextService: this.documentContextService,
      streamingHandler: this.streamingHandler,
      hooklessWatcher: this.hooklessWatcher,

      getSettingsStore: () => this.getSettingsStore(),
      getApiKeyForProvider: (provider, workspacePath) => this.getApiKeyForProvider(provider, workspacePath),
      getProviderSetting: (provider, key) => this.getProviderSetting(provider, key),
      getNormalizedProviderSettings: () => this.getNormalizedProviderSettings(),
      normalizeProviderSettings: (providerSettings) => this.normalizeProviderSettings(providerSettings),
      invalidateNormalizedProviderSettingsCache: () => {
        this.cachedNormalizedProviderSettings = null;
      },
      isProviderEnabledForWorkspace: (provider, workspacePath) => this.isProviderEnabledForWorkspace(provider, workspacePath),
      getProviderWorkflowCatalog: (request) => this.getProviderWorkflowCatalog(request),
      maskApiKey: (key) => this.maskApiKey(key),
      maskApiKeys: (keys) => this.maskApiKeys(keys),

      publishQueueStateToSync: (sessionId) => this.publishQueueStateToSync(sessionId),
      driveQueuedPrompts: (sessionId, workspacePath, reason) => this.driveQueuedPrompts(sessionId, workspacePath, reason),
      forceSessionIdleOnCancel: (sessionId) => this.forceSessionIdleOnCancel(sessionId),
      interruptCurrentTurn: (sessionId) => this.interruptCurrentTurn(sessionId),

      createToolHandler: (webContents, documentContext, sessionId, workspaceId) =>
        this.createToolHandler(webContents, documentContext, sessionId, workspaceId),
      advanceDiffBaseline: (sessionId, filePath, content) => this.advanceDiffBaseline(sessionId, filePath, content),
    };
  }

  private setupIpcHandlers() {
    // Send message to AI -- delegated to MessageStreamingHandler.
    // Stored on this.sendMessageHandler so queue processing and other paths can
    // re-invoke it. Assigned before the context is built so `ctx` captures the
    // real handler rather than the null it holds at construction time.
    this.sendMessageHandler = this.streamingHandler.handle;

    const ctx = this.buildIpcContext();

    registerInitHandlers(ctx);
    registerSessionHandlers(ctx);
    registerQueuedPromptHandlers(ctx);
    registerInteractivePromptHandlers(ctx);
    registerTurnControlHandlers(ctx);
    registerSettingsHandlers(ctx);
    registerModelHandlers(ctx);
    registerProjectSettingsHandlers(ctx);
    registerExtensionChatHandlers(ctx);
  }

  private createToolHandler(webContents: Electron.WebContents, documentContext?: DocumentContext, sessionId?: string, workspaceId?: string): ToolHandler {
    const executor = new ToolExecutor(webContents, sessionId, workspaceId);

    // Capture targetFilePath from documentContext at message-send time
    // This prevents race conditions if user switches tabs while waiting for AI response
    const targetFilePath = documentContext?.filePath;

    const handler: ToolHandler = {
      applyDiff: async (args: DiffArgs): Promise<DiffResult> => {
        console.log(`[AIService] applyDiff called, targetFilePath from closure:`, targetFilePath);
        return executor.applyDiff({ ...args, targetFilePath });
      },
      streamContent: async (args: unknown): Promise<unknown> => {
        console.log(`[AIService] streamContent called, targetFilePath from closure:`, targetFilePath);
        return executor.streamContent({ ...(args as any), targetFilePath });
      },
      executeTool: async (name: string, args: unknown): Promise<unknown> => {
        // For tools that need targetFilePath, inject it from the closure
        if (name === 'streamContent' || name === 'applyDiff') {
          return executor.executeTool(name, { ...(args as any), targetFilePath });
        }
        return executor.executeTool(name, args);
      }
    };
    return handler;
  }

  private getNormalizedProviderSettings(): Record<string, any> {
    if (this.cachedNormalizedProviderSettings) {
      return this.cachedNormalizedProviderSettings;
    }
    const providerSettings = this.getSettingsStore().get('providerSettings', {}) as Record<string, any>;
    const normalized = this.normalizeProviderSettings(providerSettings);
    if (normalized !== providerSettings) {
      this.getSettingsStore().set('providerSettings', normalized);
    }
    this.cachedNormalizedProviderSettings = normalized;
    return normalized;
  }

  private normalizeProviderSettings(providerSettings: Record<string, any>): Record<string, any> {
    return normalizeCodexProviderConfig(
      stripTransientProviderFields(providerSettings)
    );
  }

  private getProviderSetting(provider: string, key: string): any {
    const providerSettings = this.getNormalizedProviderSettings() as any;
    return providerSettings[provider]?.[key];
  }

  private maskApiKey(key: string): string {
    if (!key || key.length <= 20) return key;
    return `${key.substring(0, 10)}...${key.substring(key.length - 4)}`;
  }

  private maskApiKeys(keys: Record<string, string>): Record<string, string> {
    const masked: Record<string, string> = {};
    for (const [provider, key] of Object.entries(keys)) {
      masked[provider] = this.maskApiKey(key);
    }
    return masked;
  }

  private inferWorktreePathFromFilePath(workspacePath: string, filePath: string): string | null {
    return inferWorktreePathFromFilePath(workspacePath, filePath);
  }

  private inferWorktreePathFromCommand(command: string | undefined, workspacePath: string): string | null {
    return inferWorktreePathFromCommand(command, workspacePath);
  }

  /**
   * Advance the FileSnapshotCache baseline for a file after a diff is accepted/rejected.
   * This ensures subsequent AI edits use the post-review content as the diff baseline,
   * preventing "baseline drift" where already-accepted changes reappear in future diffs.
   */
  advanceDiffBaseline(sessionId: string, filePath: string, content: string): void {
    this.hooklessWatcher.advanceDiffBaseline(sessionId, filePath, content);
  }

  private async adoptWorktreeForSession(
    session: SessionData,
    worktreePath: string,
    event: Electron.IpcMainInvokeEvent
  ): Promise<void> {
    if (!worktreePath || session.worktreePath === worktreePath) {
      return;
    }

    const worktreeProjectPath = resolveProjectPath(worktreePath);
    const { AISessionsRepository } = await import('@nimbalyst/runtime/storage/repositories/AISessionsRepository');
    await AISessionsRepository.updateMetadata(session.id, {
      worktreePath,
      worktreeProjectPath,
    });

    session.worktreePath = worktreePath;
    session.worktreeProjectPath = worktreeProjectPath;
    await this.hooklessWatcher.ensureForSession(session.id, worktreePath);

    logger.main.info('[AIService] Adopted worktree path for session:', {
      sessionId: session.id,
      worktreePath,
      worktreeProjectPath,
    });
  }

  public destroy() {
    try {
      // Clean up all providers with error handling
      ProviderFactory.destroyAll();
    } catch (error) {
      console.error('[AIService] Error destroying providers:', error);
      // Continue destruction even if providers fail
    }

    // Stop all watchers + clear scheduled-stop timers
    this.hooklessWatcher.destroy();

    // Clear any pending match debounce timers
    for (const timer of this.matchDebounceTimers.values()) {
      clearTimeout(timer);
    }
    this.matchDebounceTimers.clear();

  }

  // ============================================================================
  // Extension Chat Completion helpers
  // ============================================================================

}
