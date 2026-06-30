/**
 * Main AI service that coordinates providers and sessions
 */

import { BrowserWindow, ipcMain } from 'electron';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { safeHandle } from '../../utils/ipcRegistry';
import Store from 'electron-store';
import {
  isExtensionAgentProvider,
  resolveExtensionAgentRef,
} from './providerResolution';
import { getAgentProviderRegistry } from '../../extensions/AgentProviderRegistry';
import {
  SessionManager,
  ProviderFactory,
  ModelRegistry,
  AIProvider,
  isAskUserQuestionProvider,
  isAgentProvider,
  isSlashCommandCatalogProvider,
  ClaudeCodeProvider,
  OpenAICodexProvider,
} from '@nimbalyst/runtime/ai/server';
import { CLAUDE_CODE_SAFE_FALLBACK_MODEL } from '@nimbalyst/runtime/ai/modelConstants';
import { getSessionStateManager } from '@nimbalyst/runtime/ai/server/SessionStateManager';
import { parseContextUsageMessage } from '@nimbalyst/runtime/ai/server/utils/contextUsage';
import { isBedrockToolSearchError } from '@nimbalyst/runtime/ai/server/utils/errorDetection';
import { resolveEffortLevel } from '@nimbalyst/runtime/ai/server/effortLevels';
import type { SessionStore } from '@nimbalyst/runtime';
import {
  ModelIdentifier,
  OPENAI_COMPATIBLE_PROVIDER_TYPES,
  isOpenAICompatibleProvider,
  type DocumentContext,
  type Message,
  type ProviderConfig,
  type ToolHandler,
  type DiffArgs,
  type DiffResult,
  type ToolResult,
  type AIProviderType,
  type OpenAICompatibleProviderType,
  type AIModel,
  type SessionData,
  type SessionType,
} from '@nimbalyst/runtime/ai/server/types';
// MCP imports removed - no longer using MCP HTTP server
import { ToolExecutor, toolRegistry, BUILT_IN_TOOLS } from './tools';
import { initMobileSessionControlHandler } from './MobileSessionControlHandler';
import { SoundNotificationService } from '../SoundNotificationService';
import { getTerminalSessionManager } from '../TerminalSessionManager';
import { flushNextClaudeCliQueuedPromptForSession } from './claudeCliQueueFlushSingleton';
import { notificationService } from '../NotificationService';
import { TrayManager } from '../../tray/TrayManager';
import { logger } from '../../utils/logger';
import { getSettingsService } from '../SettingsService';
import { windowStates, findWindowByWorkspace, getWindowId, createWindow } from '../../window/WindowManager';
import { resolveActiveWorkspacePathForWindowId } from '../../window/windowState';
import { sessionFileTracker } from '../SessionFileTracker';
import { enrichTranscriptMessagesWithToolCallDiffs } from '../TranscriptToolCallEnricher';
import { extractFilePath } from './tools/extractFilePath';
import { handleBackendTool } from '../../mcp/tools/backendToolHandler';
import { findOwnedBackendTool } from '../../mcp/backendToolRegistry';
import { resolveBackendWorkspacePath } from '../../mcp/mcpWorkspaceResolver';
import { toolCallMatcher, unwrapShellCommand } from '../ToolCallMatcher';
import { workspaceFileEditAttributionService } from '../WorkspaceFileEditAttributionService';
import {AnalyticsService} from "../analytics/AnalyticsService.ts";
import { FeatureUsageService, FEATURES } from "../FeatureUsageService.ts";
import { historyManager } from '../../HistoryManager';
import { addGitignoreBypass } from '../../file/WorkspaceEventBus';
import {
  DEFAULT_LMSTUDIO_BASE_URL,
  DUMMY_OPENAI_COMPATIBLE_API_KEY,
  getConfiguredLMStudioBaseUrl,
  getConfiguredOpenAICompatibleBaseUrl,
  getConfiguredOpenAIBaseUrl,
} from './lmStudioConfig';
import {
  getAIProviderOverrides,
  saveAIProviderOverrides,
  clearAIProviderOverrides,
  getWorkspaceState,
  getDefaultAIModel,
  incrementCompletedSessionsWithTools,
  markCommunityPopupShown,
  normalizeAIProviderOverrides,
  shouldShowCommunityPopup,
  wasCommunityPopupShownThisLaunch,
  getDefaultEffortLevel
} from '../../utils/store';
import { mergeAISettings, getAIProviderOverridesWithWorktreeFallback } from '../../utils/aiSettingsMerge';
import { DocumentContextService, type RawDocumentContext, type PreparedDocumentContext } from '@nimbalyst/runtime';
import { getMessageSyncHandler, getSyncProvider, isDesktopTrulyAway } from '../SyncManager';
import { normalizeCodexProviderConfig, omitModelsField, stripTransientProviderFields } from '@nimbalyst/runtime/ai/server/utils/modelConfigUtils';
import { isFileInWorkspaceOrWorktree, resolveProjectPath } from '../../utils/workspaceDetection';
import { SessionFilesRepository } from '@nimbalyst/runtime';
import { buildToolPermissionResponseRecord } from './claudeCliToolPermission';
import * as fs from 'fs';
import * as path from 'path';
import {
  LOG_PREVIEW_LENGTH,
  readFileContentOrNull,
  isCreateLikeChangeKind,
  recoverBaselineFromHistory,
  previewForLog,
  bucketMessageLength,
  bucketResponseTime,
  bucketChunkCount,
  bucketContentLength,
  bucketCount,
  bucketAgeInDays,
  detectConfiguredAIProvider,
  safeSend,
  getFileExtensionForAnalytics,
  extractModelForProvider,
  detectNimbalystSlashCommand,
  extractFileMentions,
  isBinaryFile,
  attachMentionedFiles,
  tagFileBeforeEdit,
  formatCodexTestError,
  categorizeAIError,
} from './aiServiceUtils';
import { MessageStreamingHandler } from './MessageStreamingHandler';
import { HooklessAgentFileWatcher } from './HooklessAgentFileWatcher';
import { getAgentWorkflowService } from '../AgentWorkflowService';
import { tryClaimAndDispatchNextQueuedPrompt } from './queuedPromptDispatcher';
import { dispatchQueuedPromptToClaudeCli } from './claudeCliQueueDispatch';
import { ensureClaudeCliSession, claudeCliSessionSupportsPlugins } from './claudeCliLauncherSingleton';
import { supportsWorkspaceSlashWorkflowProvider } from '../../../shared/agentWorkflowProviders';

const execFileAsync = promisify(execFile);
const MAX_MODELS_PER_PROVIDER_FOR_UI = 500;

function capModelsPerProviderForUi(models: AIModel[]): AIModel[] {
  const counts = new Map<string, number>();
  return models.filter((model) => {
    const count = counts.get(model.provider) ?? 0;
    if (count >= MAX_MODELS_PER_PROVIDER_FOR_UI) return false;
    counts.set(model.provider, count + 1);
    return true;
  });
}

export class AIService {
  private sessionManager: SessionManager;
  private settingsStore: Store<Record<string, unknown>> | null = null;
  private readonly analytics = AnalyticsService.getInstance();
  private cachedNormalizedProviderSettings: Record<string, any> | null = null;
  private unsubscribeAISettingsListener: (() => void) | null = null;
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
  private sessionsProcessingQueue = new Set<string>();

  // Track mobile session creation requests to prevent duplicate processing
  // (can happen if the same request is delivered multiple times)
  private processingMobileSessionRequests = new Set<string>();

  // Service for preparing document context (transition detection, diff computation, etc.)
  private documentContextService = new DocumentContextService();

  // Owns the streaming send-message lifecycle (extracted from setupIpcHandlers).
  private streamingHandler: MessageStreamingHandler;

  constructor(sessionStore: SessionStore) {
    logger.main.info('[AIService] Constructor called');
    this.sessionManager = new SessionManager(sessionStore);
    this.streamingHandler = new MessageStreamingHandler(this);
    this.unsubscribeAISettingsListener = getSettingsService().subscribe((key) => {
      if (key.startsWith('ai.provider.') || key.startsWith('ai.apiKey.')) {
        this.cachedNormalizedProviderSettings = null;
      }
    });

    // Set up persistence callback for DocumentContextService
    // Use AISessionsRepository directly since SessionManager doesn't have a generic updateMetadata
    this.documentContextService.setPersistCallback(async (sessionId, state) => {
      const { AISessionsRepository } = await import('@nimbalyst/runtime/storage/repositories/AISessionsRepository');
      await AISessionsRepository.updateMetadata(sessionId, {
        lastDocumentState: state,
      });
    });

    // Initialize mobile sync handler if sync is enabled
    this.initializeMobileSyncHandler().catch(err => {
      logger.main.error('[AIService] initializeMobileSyncHandler threw:', err);
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
    const created = await queueStore.create({
      id: promptId,
      sessionId,
      prompt,
      attachments,
      documentContext,
    });
    return { id: created.id, prompt: created.prompt, createdAt: created.createdAt };
  }

  public async triggerQueuedPromptProcessingForSession(sessionId: string, workspacePath: string): Promise<boolean> {
    const targetWindow = findWindowByWorkspace(workspacePath);
    if (!targetWindow || targetWindow.isDestroyed()) {
      return false;
    }
    return this.processQueuedPrompt(sessionId, workspacePath, targetWindow);
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
   * Append any claude-code variants that were added after this user's
   * `providerSettings['claude-code'].models` list was first persisted. Without
   * this, `ai:getModels` filters out newly-introduced variants (e.g. the
   * `opus-4-6` pinned variant) because they aren't in the saved list and
   * there's no UI in ClaudeCodePanel to re-enable them.
   *
   * Each variant gets its own migration key so we can introduce new pinned
   * variants incrementally without re-running prior insertions.
   */
  private migrateClaudeCodeModelList(): void {
    this.migrateClaudeCodeVariantInsertion(
      'migrations.claudeCodeOpus46Added',
      'claude-code:opus-4-6',
      'claude-code:opus',
    );
    this.migrateClaudeCodeVariantInsertion(
      'migrations.claudeCodeOpus47Added',
      'claude-code:opus-4-7',
      'claude-code:opus',
    );
  }

  private migrateClaudeCodeVariantInsertion(
    migrationKey: string,
    variantId: string,
    insertAfterId: string,
  ): void {
    if (this.settingsStore!.get(migrationKey)) return;
    const providerSettings = this.settingsStore!.get('providerSettings', {}) as any;
    const claudeCode = providerSettings?.['claude-code'];
    if (claudeCode && Array.isArray(claudeCode.models) && !claudeCode.models.includes(variantId)) {
      const anchorIndex = claudeCode.models.indexOf(insertAfterId);
      const insertAt = anchorIndex >= 0 ? anchorIndex + 1 : claudeCode.models.length;
      claudeCode.models = [
        ...claudeCode.models.slice(0, insertAt),
        variantId,
        ...claudeCode.models.slice(insertAt),
      ];
      this.settingsStore!.set('providerSettings', providerSettings);
    }
    this.settingsStore!.set(migrationKey, true);
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
                models: ["claude-code:opus", "claude-code:opus-4-7", "claude-code:opus-4-6", "claude-code:sonnet", "claude-code:haiku"]
              },
              openai: {
                enabled: false,
                testStatus: "idle",
              },
              'openai-codex': {
                enabled: false,
                testStatus: "idle",
                installStatus: "not-installed",
              },
              lmstudio: {
                enabled: false,
                testStatus: "idle",
                baseUrl: DEFAULT_LMSTUDIO_BASE_URL
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
      this.migrateClaudeCodeModelList();
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
      case 'ollama':
      case 'anythingllm':
      case 'openrouter':
      case 'featherless':
      case 'featherless-official':
      case 'featherless-sane':
      case 'featherless-heretic':
      case 'featherless-keyword':
        return globalApiKeys[provider] || DUMMY_OPENAI_COMPATIBLE_API_KEY;
      case 'openai-codex':
        return globalApiKeys['openai-codex'];
      case 'lmstudio':
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

  private mobileSyncHandlerInitialized = false;
  private lastSyncProvider: import('@nimbalyst/runtime/sync').SyncProvider | null = null;
  private syncStatusUnsubscribe: (() => void) | null = null;

  private async continueQueuedPromptChain(
    sessionId: string,
    workspacePath: string,
    targetWindow: Electron.BrowserWindow | null,
    source: string
  ): Promise<void> {
    if (!targetWindow || targetWindow.isDestroyed()) {
      logger.main.info(`[AIService] ${source}: no live window available to continue queued prompts for session ${sessionId}`);
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
    await this.processQueuedPrompt(sessionId, workspacePath, targetWindow);
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
            this.triggerQueuedPromptProcessingForSession(metaSession.id, metaSession.workspacePath).catch((err) => {
              logger.main.error('[AIService] Failed to trigger meta-agent queue processing:', err);
            });
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
        targetWindow?.webContents.send('ai:promptClaimed', {
          sessionId: claimedSessionId,
          promptId,
        });
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

  private async initializeMobileSyncHandler() {
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
              logger.main.info('[AIService] Received queuedPrompts from mobile via onIndexChange:', {
                sessionId,
                count: entry.queuedPrompts.length,
                promptIds: entry.queuedPrompts.map(p => p.id)
              });

              try {
                // Insert prompts into the queued_prompts table
                const { getQueuedPromptsStore } = await import('../RepositoryManager');
                const queueStore = getQueuedPromptsStore();

                let newPromptsCount = 0;
                for (const prompt of entry.queuedPrompts) {
                  // Skip prompts that were created locally (echoed back via Y.js sync)
                  // Local prompts have IDs starting with 'local-'
                  if (prompt.id.startsWith('local-')) {
                    // logger.main.info(`[AIService] Prompt ${prompt.id} is a local prompt echoed via sync, skipping`);
                    continue;
                  }

                  // Check if prompt already exists
                  const existing = await queueStore.get(prompt.id);
                  if (existing) {
                    // logger.main.info(`[AIService] Prompt ${prompt.id} already exists, skipping`);
                    continue;
                  }

                  // Create the prompt in the queued_prompts table
                  await queueStore.create({
                    id: prompt.id,
                    sessionId,
                    prompt: prompt.prompt,
                    attachments: prompt.attachments,
                  });
                  newPromptsCount++;
                }

                if (newPromptsCount === 0) {
                  // logger.main.info('[AIService] No new prompts to process, all already exist');
                  return;
                }

                logger.main.info(`[AIService] Inserted ${newPromptsCount} new prompts into queued_prompts table`);

                // Load session to get its workspacePath for window routing
                // Use repository directly since we just need metadata, not full session load
                const { AISessionsRepository } = await import('@nimbalyst/runtime/storage/repositories/AISessionsRepository');
                const session = await AISessionsRepository.get(sessionId);
                if (!session) {
                  logger.main.warn('[AIService] Session not found for queuedPrompts:', sessionId);
                  return;
                }

                // Track ai_message_queued analytics event for each prompt from mobile
                // Note: Mobile doesn't currently support attachments or documentContext
                for (let i = 0; i < newPromptsCount; i++) {
                  AnalyticsService.getInstance().sendEvent('ai_message_queued', {
                    provider: session.provider,
                    source: 'mobile',
                    hasDocumentContext: false,
                    hasAttachments: false,
                  });
                }

                // Only notify the window that owns this session's workspace
                // This prevents duplicate execution when multiple windows are open
                if (session.workspacePath) {
                  let targetWindow = findWindowByWorkspace(session.workspacePath);

                  // If no window is open for this workspace, open it automatically
                  // so mobile prompts don't silently fail
                  if ((!targetWindow || targetWindow.isDestroyed()) && fs.existsSync(session.workspacePath)) {
                    logger.main.info('[AIService] Opening workspace for mobile queued prompt:', session.workspacePath);
                    const newWindow = createWindow(false, true, session.workspacePath);

                    // Wait for the window to finish loading before processing the prompt
                    await new Promise<void>((resolve) => {
                      newWindow.webContents.once('did-finish-load', () => resolve());
                    });

                    targetWindow = newWindow;
                  }

                  if (targetWindow && !targetWindow.isDestroyed()) {
                    // logger.main.info('[AIService] Notifying window to process queue for workspace:', session.workspacePath);
                    targetWindow.webContents.send('ai:queuedPromptsReceived', {
                      sessionId,
                      promptCount: newPromptsCount,
                      workspacePath: session.workspacePath  // Include for renderer-side filtering
                    });

                    // Directly trigger queue processing from main process
                    // This ensures mobile messages are processed even when the session isn't open in the UI
                    // logger.main.info('[AIService] Triggering queue processing for mobile prompt');
                    this.processQueuedPrompt(sessionId, session.workspacePath, targetWindow);
                  } else {
                    logger.main.warn('[AIService] No window found and workspace path does not exist:', session.workspacePath);
                  }
                } else {
                  // Sessions MUST have a workspacePath - this indicates a data integrity issue
                  logger.main.error('[AIService] Session has no workspacePath - cannot route queued prompts. SessionId:', sessionId);
                  // Do NOT fall back to windows[0] - that masks the real bug
                }
              } catch (err) {
                logger.main.error('[AIService] Failed to insert queuedPrompts into table:', err);
              }
            }
          });

        this.mobileSyncHandlerInitialized = true;
        // logger.main.info('[AIService] Mobile sync handler initialized (using queued_prompts table)');
      } else {
        // logger.main.info('[AIService] onIndexChange not available on sync provider');
      }

      // Listen for session creation requests from mobile
      if (syncProvider.onCreateSessionRequest) {
        syncProvider.onCreateSessionRequest(async (request) => {
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
          // Clean up after 60 seconds to prevent memory leak
          setTimeout(() => {
            this.processingMobileSessionRequests.delete(request.requestId);
          }, 60000);

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
            const session = await this.sessionManager.createSession(
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
          }
        });

        // logger.main.info('[AIService] Session creation request handler initialized');
      } else {
        // logger.main.info('[AIService] onCreateSessionRequest not available on sync provider');
      }

      // Handle worktree creation requests from mobile
      // Mirrors the desktop worktree:create IPC handler + AgentMode session creation exactly
      if (syncProvider.onCreateWorktreeRequest) {
        syncProvider.onCreateWorktreeRequest(async (request) => {
          logger.main.info('[AIService] Received worktree creation request from mobile:', request.requestId, 'projectId:', request.projectId);
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
          }
        });
        // logger.main.info('[AIService] Worktree creation request handler initialized');
      }

      // Initialize mobile session control handler (cancel, question responses, etc.)
      // This is in a separate module to keep AIService focused
      initMobileSessionControlHandler(syncProvider, findWindowByWorkspace, {
        triggerQueuedPromptProcessing: (sessionId, workspacePath) =>
          this.triggerQueuedPromptProcessingForSession(sessionId, workspacePath),
        rollbackExecutingPrompts: async (sessionId) => {
          // Use the delivery-aware sweep so that a mobile-initiated cancel
          // doesn't re-deliver a prompt that already landed in the
          // conversation. Returns the count of rows that actually moved
          // back to pending (matches the prior contract).
          const { getQueuedPromptsStore } = await import('../RepositoryManager');
          const { rolledBack } = await getQueuedPromptsStore().sweepExecutingForSession(sessionId);
          return rolledBack;
        },
      });
    } catch (error) {
      logger.main.error('[AIService] Failed to initialize mobile sync handler:', error);
    }
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
  }): { commands: string[]; skills: string[] } {
    const providerCandidates = request.provider
      ? [request.provider]
      : ['claude-code', 'openai-codex', 'openai-codex-acp', 'opencode'];

    let provider: AIProvider | undefined;
    for (const providerType of providerCandidates) {
      if (!request.sessionId) {
        break;
      }

      provider = ProviderFactory.getProvider(providerType as AIProviderType, request.sessionId) ?? undefined;
      if (provider) {
        break;
      }
    }

    if (isSlashCommandCatalogProvider(provider)) {
      const commands = typeof provider.getSlashCommands === 'function'
        ? provider.getSlashCommands()
        : [];
      const skills = typeof provider.getSkills === 'function'
        ? provider.getSkills()
        : [];

      if (commands.length > 0 || skills.length > 0) {
        return { commands, skills };
      }
    }

    if (request.provider === 'claude-code' || !request.provider) {
      return {
        commands: ClaudeCodeProvider.getCachedSdkSlashCommands(),
        skills: ClaudeCodeProvider.getCachedSdkSkills(),
      };
    }

    if (request.provider === 'openai-codex' || request.provider === 'openai-codex-acp') {
      return {
        commands: OpenAICodexProvider.getKnownSlashCommands(),
        skills: [],
      };
    }

    if (supportsWorkspaceSlashWorkflowProvider(request.provider)) {
      return { commands: [], skills: [] };
    }

    return { commands: [], skills: [] };
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
          const parsedUsage = parseContextUsageMessage(contextResponse);

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

  private setupIpcHandlers() {
    // Check if any AI provider is configured with usable models
    safeHandle('ai:hasApiKey', async () => {  // Keeping the name for backward compatibility
      const apiKeys = this.getSettingsStore().get('apiKeys', {}) as Record<string, string>;
      const providerSettings = this.getNormalizedProviderSettings() as any;

      // Claude Code uses its own auth (SSO) - always available if enabled
      const claudeCodeEnabled = providerSettings['claude-code']?.enabled !== false;
      if (claudeCodeEnabled) return true;

      // Claude Chat needs an Anthropic API key and enabled models
      const hasAnthropicKey = !!apiKeys['anthropic'];
      if (hasAnthropicKey) {
        const hasClaude = providerSettings['claude']?.enabled &&
                         providerSettings['claude']?.models?.length > 0;
        if (hasClaude) return true;
      }

      // Check OpenAI (needs API key and enabled models)
      const hasOpenAIKey = !!apiKeys['openai'];
      if (hasOpenAIKey) {
        const hasOpenAI = providerSettings['openai']?.enabled &&
                         providerSettings['openai']?.models?.length > 0;
        if (hasOpenAI) return true;
      }

      for (const provider of OPENAI_COMPATIBLE_PROVIDER_TYPES) {
        if (provider === 'openai') continue;
        if (providerSettings[provider]?.enabled === true && providerSettings[provider]?.models?.length > 0) {
          return true;
        }
      }

      // Check OpenAI Codex (uses its own auth, doesn't need API key in settings)
      const hasCodex = providerSettings['openai-codex']?.enabled === true;
      if (hasCodex) return true;

      // Check LM Studio (doesn't need API key but needs enabled models)
      const hasLMStudio = providerSettings['lmstudio']?.enabled === true &&
                         providerSettings['lmstudio']?.models?.length > 0;
      if (hasLMStudio) return true;

      return false;
    });

    // Initialize/configure AI
    safeHandle('ai:initialize', async (event, provider?: string, apiKey?: string) => {
      if (apiKey) {
        // Save API key for the Claude Chat provider only
        // Claude Code has its own auth (SSO) and should never use this key
        const apiKeys = this.getSettingsStore().get('apiKeys', {}) as Record<string, string>;
        apiKeys['anthropic'] = apiKey;
        this.getSettingsStore().set('apiKeys', apiKeys);
      }

      return { success: true };
    });

    // Create new session with provider and model selection
    safeHandle('ai:createSession', async (
      event,
      provider: AIProviderType,
      documentContext?: DocumentContext,
      workspacePath?: string,
      modelId?: string,
      sessionType?: string,
      worktreeId?: string
    ) => {
      // TODO: Debug logging - uncomment if needed
      //   provider,
      //   modelId,
      //   hasDocumentContext: !!documentContext,
      //   workspacePath,
      //   sessionType,
      //   worktreeId
      // });

      // If worktreeId is provided, fetch the worktree data to get its path and project path
      let worktreePath: string | undefined;
      let worktreeProjectPath: string | undefined;
      if (worktreeId) {
        const { getDatabase } = await import('../../database/initialize');
        const { createWorktreeStore } = await import('../WorktreeStore');
        const db = getDatabase();
        if (!db) {
          throw new Error('Database not initialized');
        }
        const worktreeStore = createWorktreeStore(db);
        const worktree = await worktreeStore.get(worktreeId);
        if (!worktree) {
          throw new Error(`Worktree ${worktreeId} not found in database`);
        }

        // Validate that the worktree directory actually exists
        if (!fs.existsSync(worktree.path)) {
          throw new Error(
            `Worktree directory does not exist: ${worktree.path}\n` +
            `The worktree may have been deleted manually. Please remove the worktree from the UI and create a new one.`
          );
        }

        worktreePath = worktree.path;
        worktreeProjectPath = worktree.projectPath;  // Store for permission lookups
      }

      // Check if provider is enabled for this workspace (considers project overrides)
      if (!this.isProviderEnabledForWorkspace(provider, workspacePath)) {
        throw new Error(`Provider ${provider} is not enabled for this workspace`);
      }

      // Get API key using project-aware helper (considers project overrides)
      let apiKey = this.getApiKeyForProvider(provider, workspacePath);

      // Validate API key requirement based on provider.
      // Extension-agent providers defer auth to the extension itself, so they
      // skip this switch entirely (no apiKey requirement on the host side).
      if (!isExtensionAgentProvider(provider)) {
        switch (provider) {
          case 'claude':
            if (!apiKey) {
              throw new Error('Anthropic API key not configured');
            }
            break;
          case 'claude-code':
            // Claude Code: API key is optional, uses SSO login if not provided
            // No error if missing - will use SSO login
            break;
          case 'claude-code-cli':
            // Genuine `claude` CLI: uses its own login/subscription, no API key.
            break;
          case 'openai':
            if (!apiKey) {
              throw new Error('OpenAI API key not configured');
            }
            break;
          case 'ollama':
          case 'anythingllm':
          case 'openrouter':
          case 'featherless':
          case 'featherless-official':
          case 'featherless-sane':
          case 'featherless-heretic':
          case 'featherless-keyword':
            break;
          case 'openai-codex':
            // Codex SDK uses its own auth (codex auth login), API key is optional
            break;
          case 'opencode':
            // OpenCode uses its own config, API key is optional
            break;
          case 'copilot-cli':
            // Copilot uses its own CLI auth (copilot auth login), no API key needed
            break;
          case 'lmstudio':
            // LMStudio doesn't need an API key, just the base URL
            break;
          default:
            throw new Error(`Unknown provider: ${provider}`);
        }
      }

      // Get model details if specified
      let model = modelId;
      if (!model) {
        // Use provider defaults when no explicit model is supplied
        model = await ModelRegistry.getDefaultModel(provider);
      }

      // For claude-code, don't pass a model at all - let it handle its own selection
      const providerConfig: any = {
        maxTokens: this.getProviderSetting(provider, 'maxTokens'),
        temperature: this.getProviderSetting(provider, 'temperature')
      };

      if (isOpenAICompatibleProvider(provider)) {
        providerConfig.modelFilterRegex = this.getOpenAICompatibleModelFilterRegex(provider);
      }

      // Only add model to config if we have one and it's not claude-code
      if (model) {
        const modelForProvider = extractModelForProvider(model, provider);
        if (modelForProvider !== null) {
          providerConfig.model = modelForProvider;
        } else if (provider !== 'claude-code') {
          // extractModelForProvider returned null (invalid model) - fall back to default
          const defaultModel = await ModelRegistry.getDefaultModel(provider);
          if (defaultModel) {
            const defaultModelForProvider = extractModelForProvider(defaultModel, provider);
            if (defaultModelForProvider !== null) {
              providerConfig.model = defaultModelForProvider;
              logger.main.info(`[AIService] Fell back to default model "${defaultModel}" for provider ${provider}`);
            }
          }
        }
      } else if (provider !== 'claude-code') {
        // For other providers, fall back to settings
        const settingsModel = this.getProviderSetting(provider, 'model');
        if (settingsModel) {
          const modelForProvider = extractModelForProvider(settingsModel, provider);
          if (modelForProvider !== null) {
            providerConfig.model = modelForProvider;
          }
        }
        // If still no model, get provider default
        if (!providerConfig.model) {
          const defaultModel = await ModelRegistry.getDefaultModel(provider);
          if (defaultModel) {
            const defaultModelForProvider = extractModelForProvider(defaultModel, provider);
            if (defaultModelForProvider !== null) {
              providerConfig.model = defaultModelForProvider;
            }
          }
        }
      }

      // Create session with worktree association
      const session = await this.sessionManager.createSession(
        provider,
        documentContext,
        workspacePath,
        providerConfig,
        model,
        (sessionType || 'session') as SessionType, // Default to 'session' if not specified
        undefined, // mode
        worktreeId,
        worktreePath,
        worktreeProjectPath
      );

      // Track session creation in feature usage system
      FeatureUsageService.getInstance().recordUsage(FEATURES.SESSION_CREATED);

      // Track AI chat feature first use
      const { FeatureTrackingService } = await import('../analytics/FeatureTrackingService');
      const { AnalyticsService } = await import('../analytics/AnalyticsService');
      const featureTracking = FeatureTrackingService.getInstance();
      if (featureTracking.isFirstUse('ai_chat')) {
        const daysSinceInstall = featureTracking.getDaysSinceInstall();
        AnalyticsService.getInstance().sendEvent('feature_first_use', {
          feature: 'ai_chat',
          daysSinceInstall,
        });
      }

      // Create and initialize provider. Extension-contributed agent providers
      // are not in the built-in AIProviderType switch, so route them to the
      // extension-agent factory (mirrors MessageStreamingHandler's lazy path).
      // Calling createProvider for them would throw "Unknown provider".
      const eagerExtAgentRef = resolveExtensionAgentRef(provider);
      const providerInstance = eagerExtAgentRef
        ? ProviderFactory.createExtensionAgentProvider({
            extensionId: eagerExtAgentRef.extensionId,
            contributionId: eagerExtAgentRef.contributionId,
            sessionId: session.id,
            model: session.model,
          })
        : ProviderFactory.createProvider(provider, session.id);

      // Build config based on provider type
      const initConfig: any = {
        maxTokens: (session.providerConfig as any)?.maxTokens,
        temperature: (session.providerConfig as any)?.temperature
      };

      // Claude Code can use a dedicated API key, but must never use anthropic.
      if (provider === 'claude-code') {
        if (apiKey) {
          initConfig.apiKey = apiKey;
        }
      } else {
        initConfig.apiKey = apiKey;
      }

      // Only skip explicit model assignment for claude-code (it manages variants internally)
      // Check both session.model (set via UI) and providerConfig.model (set at creation)
      if ((session.model || session.providerConfig?.model) && provider !== 'claude-code') {
        const fullModel = session.model || session.providerConfig?.model;
        if (fullModel) {
          const modelForProvider = extractModelForProvider(fullModel, provider);
          if (modelForProvider !== null) {
            initConfig.model = modelForProvider;
          } else {
            // extractModelForProvider returned null - fall back to default
            const defaultModel = await ModelRegistry.getDefaultModel(provider);
            if (defaultModel) {
              const defaultModelForProvider = extractModelForProvider(defaultModel, provider);
              if (defaultModelForProvider !== null) {
                initConfig.model = defaultModelForProvider;
                logger.main.info(`[AIService] Fell back to default model "${defaultModel}" for provider ${provider}`);
              }
            }
          }
        }
      } else if (provider !== 'claude-code') {
        // No model specified - get default
        const defaultModel = await ModelRegistry.getDefaultModel(provider);
        if (defaultModel) {
          const defaultModelForProvider = extractModelForProvider(defaultModel, provider);
          if (defaultModelForProvider !== null) {
            initConfig.model = defaultModelForProvider;
          }
        }
      }

      // Add LMStudio-specific config
      if (provider === 'lmstudio') {
        initConfig.baseUrl = getConfiguredLMStudioBaseUrl(this.getSettingsStore());
      }
      if (provider === 'openai') {
        initConfig.baseUrl = getConfiguredOpenAIBaseUrl(this.getSettingsStore());
      } else if (isOpenAICompatibleProvider(provider)) {
        initConfig.baseUrl = getConfiguredOpenAICompatibleBaseUrl(this.getSettingsStore(), provider);
        initConfig.modelFilterRegex = this.getOpenAICompatibleModelFilterRegex(provider);
      }

      // Pass through allowedTools and effort level settings for Claude Code
      if (provider === 'claude-code') {
        const providerSettings = this.getSettingsStore().get('providerSettings', {}) as any;
        if (providerSettings?.['claude-code']?.allowedTools) {
          initConfig.allowedTools = providerSettings['claude-code'].allowedTools;
        }
        // Effort level: explicit session value, else the app-wide default the
        // selector displays (Opus 4.6 adaptive reasoning).
        const effortLevel = resolveEffortLevel((session.metadata as any)?.effortLevel, getDefaultEffortLevel());
        if (effortLevel) {
          initConfig.effortLevel = effortLevel;
        }
      }

      // Pass effort level for OpenAI Codex
      if (provider === 'openai-codex') {
        const effortLevel = resolveEffortLevel((session.metadata as any)?.effortLevel, getDefaultEffortLevel());
        if (effortLevel) {
          initConfig.effortLevel = effortLevel;
        }
      }

      await providerInstance.initialize(initConfig);

      // Register tool handler - targetFilePath will be determined dynamically per tool call
      const toolHandler = this.createToolHandler(event.sender, documentContext, session.id, workspacePath);
      providerInstance.registerToolHandler(toolHandler);

      // NOTE: No longer tracking provider per-window - ProviderFactory handles per-session tracking
      // This allows multiple concurrent sessions in the same window

      // NOTE: Mobile message handling is done via startIndexListener() which watches
      // the index for pendingExecution flags. We do NOT call watchSession() here because
      // it creates a WebSocket connection per session, causing performance issues.

      this.analytics.sendEvent('create_ai_session', {
        provider,
        is_worktree_session: !!session.worktreeId,
        is_workstream_child: !!session.parentSessionId,
      });
      return session;
    });

    // Send message to AI -- delegated to MessageStreamingHandler.
    // Stored on this.sendMessageHandler so queue processing and other paths can re-invoke it.
    this.sendMessageHandler = this.streamingHandler.handle;
    safeHandle('ai:sendMessage', this.sendMessageHandler);

    // Get session history (full session data with messages - slow)
    safeHandle('ai:getSessions', async (event, workspacePath?: string) => {
      return await this.sessionManager.getSessions(workspacePath);
    });

    // Get session list (lightweight - just metadata, no messages)
    safeHandle('ai:getSessionList', async (event, workspacePath?: string) => {
      return await this.sessionManager.getSessionList(workspacePath);
    });

    // Load a session
    // trackAsResume: only pass true when user intentionally opens a session from history
    // (not for tab restoration, lazy loading, or session reloading)
    // Deduplicate: if a load is already in-flight for the same sessionId, reuse the promise
    // to avoid queuing redundant heavy DB queries in PGLite's single-threaded worker
    const loadSessionInFlight = new Map<string, Promise<any>>();
    safeHandle('ai:loadSession', async (event, sessionId: string, workspacePath?: string, trackAsResume?: boolean) => {
      const existing = loadSessionInFlight.get(sessionId);
      if (existing && !trackAsResume) {
        return existing;
      }

      const loadPromise = (async () => {
      const loadStart = performance.now();
      const session = await this.sessionManager.loadSession(sessionId, workspacePath);
      const loadTime = performance.now() - loadStart;
      if (!session) {
        console.log(`[SESSION] Session not found: ${sessionId} (this is normal if the session was deleted)`);
        return null;
      }

      session.messages = await enrichTranscriptMessagesWithToolCallDiffs(session.id, session.messages);

      // Restore document context state from persisted data (if available)
      // This enables transition detection across app restarts
      if (session.lastDocumentState) {
        this.documentContextService.loadPersistedState(sessionId, session.lastDocumentState);
      }

      // Track ai_session_resumed only when user intentionally opens a session from history
      // Skip for: app startup tab restoration, tab switching (lazy load), session reloading
      if (trackAsResume && session.messages && session.messages.length > 0) {
        const messageCount = session.messages.length;
        const createdAt = session.createdAt || Date.now();

        this.analytics.sendEvent('ai_session_resumed', {
          provider: session.provider,
          messageCount: bucketCount(messageCount),
          ageInDays: bucketAgeInDays(createdAt)
        });
      }

      // NOTE: Mobile message handling is done via startIndexListener() which watches
      // the index for pendingExecution flags. We do NOT call watchSession() here because
      // it creates a WebSocket connection per session, causing performance issues.

      return session;
      })();

      loadSessionInFlight.set(sessionId, loadPromise);
      try {
        return await loadPromise;
      } finally {
        loadSessionInFlight.delete(sessionId);
      }
    });

    // Clear session
    safeHandle('ai:clearSession', async (event, sessionId?: string) => {
      this.sessionManager.clearCurrentSession();

      // Abort any ongoing request for the specific session
      if (sessionId) {
        // Use repository directly - we just need session metadata (provider type)
        const { AISessionsRepository } = await import('@nimbalyst/runtime/storage/repositories/AISessionsRepository');
        const session = await AISessionsRepository.get(sessionId);
        if (session) {
          const provider = ProviderFactory.getProvider(session.provider as AIProviderType, sessionId);
          if (provider) {
            provider.abort();
            console.log(`[AIService] Aborted provider for session ${sessionId}`);
          }
        }
      }

      return { success: true };
    });

    // Update session messages
    safeHandle('ai:updateSessionMessages', async (
      event,
      sessionId: string,
      messages: Message[],
      workspacePath?: string
    ) => {
      const success = await this.sessionManager.updateSessionMessages(sessionId, messages, workspacePath);
      return { success };
    });

    // Update session metadata (for queue, etc.)
    safeHandle('ai:updateSessionMetadata', async (
      event,
      sessionId: string,
      metadata: Record<string, any>,
      workspacePath?: string
    ) => {
      const { AISessionsRepository } = await import('@nimbalyst/runtime/storage/repositories/AISessionsRepository');
      await AISessionsRepository.updateMetadata(sessionId, { metadata });

      // Notify TrayManager when hasUnread state changes so the tray menu stays in sync
      if (metadata.metadata?.hasUnread !== undefined) {
        TrayManager.getInstance().onSessionUnread(sessionId, !!metadata.metadata.hasUnread);
      }

      // If lastReadAt is being updated, also push through sync for cross-device read state
      // NOTE: Do NOT include updatedAt here. Reading a session is not meaningful activity
      // and should not cause the session to resort to the top of the list on other devices.
      const syncProvider = getSyncProvider();
      if (metadata.metadata?.lastReadAt && syncProvider) {
        syncProvider.pushChange(sessionId, {
          type: 'metadata_updated',
          metadata: {
            lastReadAt: metadata.metadata.lastReadAt,
          },
        });
      }

      return { success: true };
    });

    // Atomically claim a queued prompt for processing
    // Returns the prompt data if successfully claimed, null if already claimed by another instance
    // Uses the new queued_prompts table with proper row-level atomic updates
    safeHandle('ai:claimQueuedPrompt', async (
      event,
      sessionId: string,
      promptId: string
    ) => {
      // Use the new QueuedPromptsStore for atomic claim
      const { getQueuedPromptsStore } = await import('../RepositoryManager');
      const queueStore = getQueuedPromptsStore();

      // Atomic claim - only succeeds if status is still 'pending'
      const claimed = await queueStore.claim(promptId);

      if (claimed) {
        logger.main.info(`[AIService] claimQueuedPrompt: claimed ${promptId} for session ${sessionId}`);
        // Return in the format expected by the renderer
        return {
          id: claimed.id,
          prompt: claimed.prompt,
          timestamp: claimed.createdAt,
          attachments: claimed.attachments,
          documentContext: claimed.documentContext,
        };
      }

      logger.main.info(`[AIService] claimQueuedPrompt: prompt ${promptId} not found or already claimed`);
      return null;
    });

    // Mark a queued prompt as completed
    safeHandle('ai:completeQueuedPrompt', async (
      event,
      promptId: string
    ) => {
      const { getQueuedPromptsStore } = await import('../RepositoryManager');
      const queueStore = getQueuedPromptsStore();
      await queueStore.complete(promptId);
      logger.main.info(`[AIService] completeQueuedPrompt: ${promptId}`);
    });

    // Mark a queued prompt as failed
    safeHandle('ai:failQueuedPrompt', async (
      event,
      promptId: string,
      errorMessage: string
    ) => {
      const { getQueuedPromptsStore } = await import('../RepositoryManager');
      const queueStore = getQueuedPromptsStore();
      await queueStore.fail(promptId, errorMessage);
      logger.main.info(`[AIService] failQueuedPrompt: ${promptId} - ${errorMessage}`);
    });

    // List pending prompts for a session
    safeHandle('ai:listPendingPrompts', async (
      event,
      sessionId: string
    ) => {
      const { getQueuedPromptsStore } = await import('../RepositoryManager');
      const queueStore = getQueuedPromptsStore();
      const pending = await queueStore.listPending(sessionId);
      return pending.map(p => ({
        id: p.id,
        prompt: p.prompt,
        timestamp: p.createdAt,
        attachments: p.attachments,
        documentContext: p.documentContext,
      }));
    });

    // Create a new queued prompt (for local queuing)
    safeHandle('ai:createQueuedPrompt', async (
      event,
      sessionId: string,
      prompt: string,
      attachments?: any[],
      documentContext?: any
    ) => {
      const { getQueuedPromptsStore } = await import('../RepositoryManager');
      const queueStore = getQueuedPromptsStore();

      // Generate a unique ID with 'local-' prefix to identify locally-created prompts
      // This prevents the mobile sync handler from re-broadcasting these prompts
      const promptId = `local-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;

      const created = await queueStore.create({
        id: promptId,
        sessionId,
        prompt,
        attachments,
        documentContext,
      });

      logger.main.info(`[AIService] createQueuedPrompt: created ${promptId} for session ${sessionId}`);

      // Look up the session once (lightweight — no message log) for both the
      // analytics event and the claude-code-cli idle-flush kick below.
      let queuedSession: { provider?: string; workspacePath?: string } | null = null;
      try {
        const { AISessionsRepository } = await import('@nimbalyst/runtime/storage/repositories/AISessionsRepository');
        queuedSession = await AISessionsRepository.get(sessionId);
      } catch (lookupError) {
        logger.main.warn('[AIService] createQueuedPrompt: session lookup failed:', lookupError);
      }

      // Track ai_message_queued analytics event
      try {
        if (queuedSession) {
          const fileExtension = getFileExtensionForAnalytics(documentContext?.filePath);
          AnalyticsService.getInstance().sendEvent('ai_message_queued', {
            provider: queuedSession.provider,
            source: 'local',
            hasDocumentContext: !!documentContext,
            hasAttachments: !!(attachments && attachments.length > 0),
            ...(fileExtension && { fileExtension }),
          });
        }
      } catch (analyticsError) {
        logger.main.warn('[AIService] Failed to track ai_message_queued:', analyticsError);
      }

      // Notify the renderer to update the queue list UI
      // This ensures locally-queued prompts are visible (same as mobile sync path)
      safeSend(event, 'ai:queuedPromptsReceived', {
        sessionId,
        promptCount: 1
      });

      // claude-code-cli (NIM-806): the CLI queue normally drains on the PID
      // watcher's running->idle transition. But a prompt queued while the CLI is
      // ALREADY idle (e.g. smart-commit on a session sitting at its prompt) has no
      // transition to ride, so it would sit forever. If the terminal is live and
      // the session is idle right now, kick a flush directly. The flush singleton's
      // in-flight guard + DB claim make this safe against a concurrent transition
      // flush; if the CLI is mid-turn (running/waiting), we skip and let the next
      // idle transition drain it.
      //
      // NIM-821: idleness is decided from the LIVE PID file, not just
      // SessionStateManager's snapshot — the snapshot is updated asynchronously
      // from the PID watcher, and a prompt queued inside that gap (PID already
      // idle, state still 'running') skipped the kick with no future idle
      // transition ever coming. Either signal saying idle kicks the flush; the
      // claim is race-safe, so erring toward flushing is fine.
      if (queuedSession?.provider === 'claude-code-cli') {
        const terminalManager = getTerminalSessionManager();
        const state = getSessionStateManager().getSessionState(sessionId);
        const workspacePath = queuedSession.workspacePath ?? state?.workspacePath;
        if (terminalManager.isTerminalActive(sessionId) && workspacePath) {
          if (state?.status === 'idle') {
            void flushNextClaudeCliQueuedPromptForSession(sessionId, workspacePath);
          } else {
            void terminalManager.getClaudeCliLiveTurnState(sessionId).then((live) => {
              if (live === 'idle') {
                void flushNextClaudeCliQueuedPromptForSession(sessionId, workspacePath);
              }
            }).catch(() => {});
          }
        }
      }

      return {
        id: created.id,
        prompt: created.prompt,
        timestamp: created.createdAt,
        attachments: created.attachments,
        documentContext: created.documentContext,
      };
    });

    // Delete a queued prompt (for user cancellation)
    safeHandle('ai:deleteQueuedPrompt', async (
      event,
      promptId: string
    ) => {
      const { getQueuedPromptsStore } = await import('../RepositoryManager');
      const queueStore = getQueuedPromptsStore();
      await queueStore.delete(promptId);
      logger.main.info(`[AIService] deleteQueuedPrompt: deleted ${promptId}`);
      return { success: true };
    });

    // Trigger queue processing for a session (e.g., when voice command queued while AI is idle)
    safeHandle('ai:triggerQueueProcessing', async (
      event,
      sessionId: string,
      workspacePath: string
    ) => {
      const processed = await this.tryDispatchNextQueuedPrompt(
        sessionId,
        workspacePath,
        BrowserWindow.fromWebContents(event.sender),
        'triggerQueueProcessing',
      );

      return { processed };
    });

    // Save draft input
    safeHandle('ai:saveDraftInput', async (
      event,
      sessionId: string,
      draftInput: string,
      workspacePath?: string
    ) => {
      const success = await this.sessionManager.saveDraftInput(sessionId, draftInput, workspacePath);
      return { success };
    });

    // Clean up empty messages from all sessions
    safeHandle('ai:cleanupEmptyMessages', async () => {
      const cleaned = this.sessionManager.cleanupAllSessions();
      console.log(`[AIService] Manual cleanup: removed ${cleaned} empty messages`);
      return { success: true, cleaned };
    });

    // Delete session
    safeHandle('ai:deleteSession', async (event, sessionId: string, workspacePath?: string) => {
      const success = await this.sessionManager.deleteSession(sessionId, workspacePath);

      // Clean up provider if it exists
      if (success) {
        ProviderFactory.destroyProvider(sessionId);
        // Clean up document state tracking
        this.documentContextService.clearSessionState(sessionId);
        // Clean up the agent file watcher if one was active.
        await this.hooklessWatcher.stopForSession(sessionId);
      }

      return { success };
    });

    // Handle ExitPlanMode confirmation response from renderer
    safeHandle('ai:exitPlanModeConfirmResponse', async (event, requestId: string, sessionId: string, response: { approved: boolean; clearContext?: boolean; feedback?: string }) => {
      logger.main.info(`[AIService] ExitPlanMode confirmation response: requestId=${requestId}, approved=${response.approved}, clearContext=${response.clearContext}, hasFeedback=${!!response.feedback}`);

      // Use repository directly - we just need session metadata (provider type),
      // not the full session load with messages
      const { AISessionsRepository } = await import('@nimbalyst/runtime/storage/repositories/AISessionsRepository');
      const session = await AISessionsRepository.get(sessionId);
      if (!session) {
        logger.main.warn(`[AIService] Session not found for ExitPlanMode response: ${sessionId}`);
        return { success: false, error: 'Session not found' };
      }

      const provider = ProviderFactory.getProvider(session.provider as AIProviderType, sessionId);
      if (!provider) {
        logger.main.warn(`[AIService] Provider not found for ExitPlanMode response: ${sessionId}`);
        return { success: false, error: 'Provider not found' };
      }

      // Check if this is a ClaudeCodeProvider with the resolve method
      if (typeof (provider as any).resolveExitPlanModeConfirmation === 'function') {
        (provider as any).resolveExitPlanModeConfirmation(requestId, response, sessionId, 'desktop');

        // If approved, update the session mode to 'agent' in the database
        // This ensures the mode persists across session switches and app restarts
        if (response.approved) {
          await AISessionsRepository.updateMetadata(sessionId, { mode: 'agent' });
          logger.main.info(`[AIService] Session ${sessionId} mode updated to 'agent' after ExitPlanMode approval`);
        }

        // Emit resolved event so the sidebar indicator updates and UI syncs mode change
        const { BrowserWindow } = await import('electron');
        const windows = BrowserWindow.getAllWindows().filter(w => !w.isDestroyed());
        for (const win of windows) {
          if (!win.webContents.isDestroyed()) {
            win.webContents.send('ai:exitPlanModeResolved', { sessionId, approved: response.approved });
          }
        }

        // Clear pending prompt state for mobile sync and tray
        TrayManager.getInstance().onPromptResolved(sessionId);
        const syncProvider = getSyncProvider();
        if (syncProvider) {
          syncProvider.pushChange(sessionId, {
            type: 'metadata_updated',
            metadata: { hasPendingPrompt: false, updatedAt: Date.now() },
          });
        }

        return { success: true };
      } else {
        logger.main.warn(`[AIService] Provider does not support ExitPlanMode confirmation: ${session.provider}`);
        return { success: false, error: 'Provider does not support ExitPlanMode confirmation' };
      }
    });

    // Handle AskUserQuestion answer response from renderer
    // Used when Claude's AskUserQuestion tool needs user input
    safeHandle('claude-code:answer-question', async (event, { questionId, answers, sessionId }: { questionId: string; answers: Record<string, string>; sessionId?: string }) => {
      logger.main.info(`[AIService] AskUserQuestion answer received: questionId=${questionId}, sessionId=${sessionId}`);

      // sessionId can be passed directly or extracted from legacy questionId format (ask-{sessionId}-{timestamp})
      let resolvedSessionId = sessionId;
      if (!resolvedSessionId) {
        const sessionIdMatch = questionId.match(/^ask-(.+)-\d+$/);
        if (sessionIdMatch && sessionIdMatch[1] !== 'unknown') {
          resolvedSessionId = sessionIdMatch[1];
        }
      }

      if (!resolvedSessionId) {
        logger.main.warn(`[AIService] No sessionId for AskUserQuestion: ${questionId}`);
        return { success: false, error: 'Session ID required' };
      }

      // Use repository directly - we just need session metadata (provider type),
      // not the full session load with messages
      const { AISessionsRepository } = await import('@nimbalyst/runtime/storage/repositories/AISessionsRepository');
      const session = await AISessionsRepository.get(resolvedSessionId);
      if (!session) {
        logger.main.warn(`[AIService] Session not found for AskUserQuestion: ${resolvedSessionId}`);
        return { success: false, error: 'Session not found' };
      }

      // External/agentless providers (e.g. claude-code-cli) have NO in-process
      // provider instance holding the pending question — the MCP server handler is
      // blocked on the IPC response channel instead (see interactiveToolHandlers
      // handleAskUserQuestion). So a missing provider is NOT fatal: skip the
      // provider-level resolve and fall through to the MCP-channel emit / DB
      // fallback / auto-resume below. (Previously this returned early, so a CLI
      // session's answered widget never reached the waiting MCP handler — NIM-806.)
      const provider = ProviderFactory.getProvider(session.provider as AIProviderType, resolvedSessionId);
      if (!provider) {
        logger.main.info(`[AIService] No in-process provider for AskUserQuestion (${session.provider}); routing via MCP/IPC channel: ${resolvedSessionId}`);
      }

      const providerResolved = provider && isAskUserQuestionProvider(provider)
        ? provider.resolveAskUserQuestion(questionId, answers, resolvedSessionId, 'desktop')
        : false;

      // MCP interactive tools (Codex path) wait on a session-scoped channel.
      // Emit best-effort so pending MCP calls can resolve even if provider-level pending map
      // is unavailable (e.g., after restart/recovery).
      const mcpQuestionResponseChannel = `ask-user-question-response:${resolvedSessionId || 'unknown'}:${questionId}`;
      const hasMcpWaiter = ipcMain.listenerCount(mcpQuestionResponseChannel) > 0;
      if (hasMcpWaiter) {
        logger.main.info(`[AIService] AskUserQuestion emitting on MCP channel: ${mcpQuestionResponseChannel}`);
        ipcMain.emit(mcpQuestionResponseChannel, event, {
          questionId,
          answers,
          cancelled: false,
          respondedBy: 'desktop',
          sessionId: resolvedSessionId,
        });
      }

      const sessionFallbackChannel = `ask-user-question:${resolvedSessionId}`;
      const hasSessionFallbackWaiter = ipcMain.listenerCount(sessionFallbackChannel) > 0;
      if (hasSessionFallbackWaiter) {
        logger.main.info(`[AIService] AskUserQuestion emitting on session fallback channel: ${sessionFallbackChannel}`);
        ipcMain.emit(sessionFallbackChannel, event, {
          questionId,
          answers,
          cancelled: false,
          respondedBy: 'desktop',
          sessionId: resolvedSessionId,
        });
      }

      // When AskUserQuestion comes through the MCP server path (not the provider's canUseTool path),
      // the provider's pendingAskUserQuestions map won't have the entry. In that case, also write
      // the response to the database as a fallback so the MCP server's database polling can find it.
      if (!providerResolved && resolvedSessionId) {
        const { AgentMessagesRepository } = await import('@nimbalyst/runtime/storage/repositories/AgentMessagesRepository');
        AgentMessagesRepository.create({
          sessionId: resolvedSessionId,
          source: 'claude-code',
          direction: 'output' as const,
          createdAt: new Date(),
          content: JSON.stringify({
            type: 'ask_user_question_response',
            questionId,
            answers,
            cancelled: false,
            respondedBy: 'desktop',
            respondedAt: Date.now()
          })
        }).catch(err => {
          logger.main.warn(`[AIService] Failed to persist AskUserQuestion response to database: ${err}`);
        });
      }

      logger.main.info(`[AIService] AskUserQuestion resolution: providerResolved=${providerResolved}, hasMcpWaiter=${hasMcpWaiter}, hasSessionFallbackWaiter=${hasSessionFallbackWaiter}`);

      if (providerResolved || hasMcpWaiter || hasSessionFallbackWaiter) {
        return { success: true };
      }

      // No live handler exists -- the SDK subprocess is dead (e.g., app restarted
      // while session was waiting for input). Auto-resume the session by sending
      // a new message that includes the user's answer. The Claude Code SDK will
      // resume using the stored providerSessionId, picking up conversation history.
      if (resolvedSessionId && this.sendMessageHandler && session) {
        const answerText = Object.entries(answers)
          .map(([question, answer]) => `${question}: ${answer}`)
          .join('\n');
        const resumeMessage = `[Resuming after answering a question]\n\n${answerText}`;

        logger.main.info(`[AIService] No live handler for AskUserQuestion, auto-resuming session: ${resolvedSessionId}`);

        // Fire-and-forget: resume the session in the background
        const workspacePath = session.workspacePath;
        setImmediate(async () => {
          try {
            await this.sendMessageHandler!(event, resumeMessage, undefined, resolvedSessionId, workspacePath);
          } catch (err) {
            logger.main.error(`[AIService] Failed to auto-resume session after AskUserQuestion: ${err}`);
          }
        });

        return { success: true };
      }

      logger.main.warn(`[AIService] Question not found for provider/session: ${resolvedSessionId}`);
      return { success: false, error: 'Question not found' };
    });

    // Handle AskUserQuestion cancel from renderer
    // Rejects the pending promise and aborts the AI request
    safeHandle('claude-code:cancel-question', async (event, { questionId, sessionId }: { questionId: string; sessionId?: string }) => {
      logger.main.info(`[AIService] AskUserQuestion cancel received: questionId=${questionId}`);

      // sessionId can be passed directly or extracted from legacy questionId format (ask-{sessionId}-{timestamp})
      let resolvedSessionId = sessionId;
      if (!resolvedSessionId) {
        const sessionIdMatch = questionId.match(/^ask-(.+)-\d+$/);
        if (sessionIdMatch && sessionIdMatch[1] !== 'unknown') {
          resolvedSessionId = sessionIdMatch[1];
        }
      }

      if (!resolvedSessionId) {
        logger.main.warn(`[AIService] No sessionId for AskUserQuestion cancel: ${questionId}`);
        return { success: false, error: 'Session ID required' };
      }

      // Use repository directly - we just need session metadata (provider type),
      // not the full session load with messages
      const { AISessionsRepository } = await import('@nimbalyst/runtime/storage/repositories/AISessionsRepository');
      const session = await AISessionsRepository.get(resolvedSessionId);
      if (!session) {
        logger.main.warn(`[AIService] Session not found for AskUserQuestion cancel: ${resolvedSessionId}`);
        return { success: false, error: 'Session not found' };
      }

      // Missing provider is non-fatal here too (claude-code-cli has no in-process
      // instance) — fall through to the MCP/IPC cancel emit + DB fallback. NIM-806.
      const provider = ProviderFactory.getProvider(session.provider as AIProviderType, resolvedSessionId);
      if (!provider) {
        logger.main.info(`[AIService] No in-process provider for AskUserQuestion cancel (${session.provider}); routing via MCP/IPC channel: ${resolvedSessionId}`);
      }

      const providerSupportsCancel = !!provider && typeof (provider as any).rejectAskUserQuestion === 'function';
      if (providerSupportsCancel) {
        (provider as any).rejectAskUserQuestion(questionId, new Error('User cancelled'));
      }

      const mcpQuestionResponseChannel = `ask-user-question-response:${resolvedSessionId || 'unknown'}:${questionId}`;
      const hasMcpWaiter = ipcMain.listenerCount(mcpQuestionResponseChannel) > 0;
      if (hasMcpWaiter) {
        ipcMain.emit(mcpQuestionResponseChannel, event, {
          questionId,
          answers: {},
          cancelled: true,
          respondedBy: 'desktop',
          sessionId: resolvedSessionId,
        });
      }

      const sessionFallbackChannel = `ask-user-question:${resolvedSessionId}`;
      const hasSessionFallbackWaiter = ipcMain.listenerCount(sessionFallbackChannel) > 0;
      if (hasSessionFallbackWaiter) {
        ipcMain.emit(sessionFallbackChannel, event, {
          questionId,
          answers: {},
          cancelled: true,
          respondedBy: 'desktop',
          sessionId: resolvedSessionId,
        });
      }

      // Write cancellation to database as fallback for MCP server polling
      if (!providerSupportsCancel && resolvedSessionId) {
        const { AgentMessagesRepository } = await import('@nimbalyst/runtime/storage/repositories/AgentMessagesRepository');
        AgentMessagesRepository.create({
          sessionId: resolvedSessionId,
          source: 'claude-code',
          direction: 'output' as const,
          createdAt: new Date(),
          content: JSON.stringify({
            type: 'ask_user_question_response',
            questionId,
            answers: {},
            cancelled: true,
            respondedBy: 'desktop',
            respondedAt: Date.now()
          })
        }).catch(err => {
          logger.main.warn(`[AIService] Failed to persist AskUserQuestion cancel to database: ${err}`);
        });
      }

      if (!providerSupportsCancel && !hasMcpWaiter && !hasSessionFallbackWaiter) {
        logger.main.warn(`[AIService] Question cancel target not found: ${resolvedSessionId}`);
        return { success: false, error: 'Question not found' };
      }

      // For MCP-backed AskUserQuestion (Codex), let the MCP tool call resolve with
      // a cancelled result instead of force-aborting the provider. Immediate abort can
      // interrupt the in-flight MCP request before the cancellation result is delivered.
      if (!hasMcpWaiter && !hasSessionFallbackWaiter) {
        // Provider-backed AskUserQuestion path (Claude Code): abort active turn.
        provider?.abort();
      }

      return { success: true };
    });

    // Handle tool permission response from renderer
    // Used when a tool requires user approval
    safeHandle('claude-code:answer-tool-permission', async (event, {
      requestId,
      sessionId,
      response
    }: {
      requestId: string;
      sessionId: string;
      response: { decision: 'allow' | 'deny'; scope: 'once' | 'session' | 'always' | 'always-all' }
    }) => {
      logger.main.info(`[AIService] Tool permission response received: requestId=${requestId}, decision=${response.decision}, scope=${response.scope}`);

      if (sessionId === 'unknown') {
        logger.main.warn(`[AIService] Unknown session for tool permission: ${requestId}`);
        return { success: false, error: 'Unknown session' };
      }

      // Use repository directly - we just need session metadata (provider type),
      // not the full session load with messages
      const { AISessionsRepository } = await import('@nimbalyst/runtime/storage/repositories/AISessionsRepository');
      const session = await AISessionsRepository.get(sessionId);
      if (!session) {
        logger.main.warn(`[AIService] Session not found for tool permission: ${sessionId}`);
        return { success: false, error: 'Session not found' };
      }

      // SDK path (ClaudeCodeProvider) resolves via the in-process provider.
      const provider = ProviderFactory.getProvider(session.provider as AIProviderType, sessionId);
      if (provider && typeof (provider as any).resolveToolPermission === 'function') {
        (provider as any).resolveToolPermission(requestId, response, sessionId, 'desktop');
        return { success: true };
      }

      // External/agentless providers (e.g. claude-code-cli) have NO in-process
      // provider holding the pending permission — the MCP handler
      // (handleToolPermission) is blocked on the per-request IPC channel instead.
      // So a missing/unsupported provider is NOT fatal: emit on that channel so
      // the waiting MCP handler resolves and returns the decision to the CLI.
      // (Mirrors the AskUserQuestion CLI fix — NIM-806.)
      const { AgentMessagesRepository } = await import('@nimbalyst/runtime/storage/repositories/AgentMessagesRepository');
      await AgentMessagesRepository.create({
        sessionId,
        source: 'nimbalyst',
        direction: 'output',
        createdAt: new Date(),
        content: JSON.stringify(buildToolPermissionResponseRecord({
          requestId,
          answer: response,
          respondedBy: 'desktop',
        })),
      });

      const mcpPermissionChannel = `tool-permission-response:${sessionId}:${requestId}`;
      const hasMcpWaiter = ipcMain.listenerCount(mcpPermissionChannel) > 0;
      if (hasMcpWaiter) {
        logger.main.info(`[AIService] Tool permission emitting on MCP channel: ${mcpPermissionChannel}`);
        ipcMain.emit(mcpPermissionChannel, event, {
          requestId,
          sessionId,
          decision: response.decision,
          scope: response.scope,
          respondedBy: 'desktop',
        });
        return { success: true };
      }

      logger.main.info(`[AIService] Tool permission response persisted without live MCP waiter: ${session.provider} (${sessionId})`);
      return { success: true };
    });

    // Handle tool permission cancel from renderer
    // Rejects the pending promise and aborts the AI request
    safeHandle('claude-code:cancel-tool-permission', async (event, {
      requestId,
      sessionId
    }: {
      requestId: string;
      sessionId: string;
    }) => {
      logger.main.info(`[AIService] Tool permission cancel received: requestId=${requestId}`);

      if (sessionId === 'unknown') {
        logger.main.warn(`[AIService] Unknown session for tool permission cancel: ${requestId}`);
        return { success: false, error: 'Unknown session' };
      }

      // Use repository directly - we just need session metadata (provider type),
      // not the full session load with messages
      const { AISessionsRepository } = await import('@nimbalyst/runtime/storage/repositories/AISessionsRepository');
      const session = await AISessionsRepository.get(sessionId);
      if (!session) {
        logger.main.warn(`[AIService] Session not found for tool permission cancel: ${sessionId}`);
        return { success: false, error: 'Session not found' };
      }

      // SDK path: reject via the in-process provider and abort the turn.
      const provider = ProviderFactory.getProvider(session.provider as AIProviderType, sessionId);
      if (provider && typeof (provider as any).rejectToolPermission === 'function') {
        (provider as any).rejectToolPermission(requestId, new Error('User cancelled'));
        provider.abort();
        return { success: true };
      }

      // External CLI: no provider to reject. Settle the blocked MCP handler with a
      // cancelled deny so it returns {behavior:'deny'} to the CLI (NIM-806).
      const mcpPermissionChannel = `tool-permission-response:${sessionId}:${requestId}`;
      const hasMcpWaiter = ipcMain.listenerCount(mcpPermissionChannel) > 0;
      if (hasMcpWaiter) {
        logger.main.info(`[AIService] Tool permission cancel emitting on MCP channel: ${mcpPermissionChannel}`);
        ipcMain.emit(mcpPermissionChannel, event, {
          requestId,
          sessionId,
          decision: 'deny',
          scope: 'once',
          cancelled: true,
          respondedBy: 'desktop',
        });
        return { success: true };
      }

      logger.main.warn(`[AIService] No provider or MCP waiter for tool permission cancel: ${session.provider} (${sessionId})`);
      return { success: false, error: 'No handler for tool permission cancel' };
    });

    // Cancel current request
    safeHandle('ai:cancelRequest', async (event, sessionId: string, chunksReceived?: number) => {
      // console.log(`[AIService] ai:cancelRequest received for sessionId: ${sessionId}`);
      // Abort the provider for the specific session
      if (!sessionId) {
        throw new Error('Session ID is required to cancel request');
      }

      // Use repository directly - we just need session metadata (provider type),
      // not the full session load with messages
      const { AISessionsRepository } = await import('@nimbalyst/runtime/storage/repositories/AISessionsRepository');
      const session = await AISessionsRepository.get(sessionId);
      if (!session) {
        console.warn(`[AIService] Cancel failed - session not found: ${sessionId}`);
        return { success: false, error: 'Session not found' };
      }

      if (session.provider === 'claude-code-cli') {
        const terminalManager = getTerminalSessionManager();
        if (!terminalManager.isTerminalActive(sessionId)) {
          console.warn(`[AIService] Cancel failed - no active claude-code-cli terminal for session: ${sessionId}`);
          return { success: false, error: 'No active terminal for session' };
        }

        terminalManager.writeToTerminal(sessionId, '\x03');
        this.analytics.sendEvent('ai_stream_interrupted', {
          provider: 'claude-code-cli',
          chunksReceived: chunksReceived || 0,
          reason: 'user_cancel'
        });
        this.analytics.sendEvent('cancel_ai_request', { provider: 'claude-code-cli' });
        return { success: true };
      }

      // console.log(`[AIService] Session found, provider type: ${session.provider}`);
      const provider = ProviderFactory.getProvider(session.provider as AIProviderType, sessionId);
      // console.log(`[AIService] Provider lookup result: ${provider ? 'found' : 'NOT FOUND'}`);
      if (provider) {
        // Get provider type
        const providerType = (provider as any).providerType || 'unknown';

        // Track stream interruption
        this.analytics.sendEvent('ai_stream_interrupted', {
          provider: providerType,
          chunksReceived: chunksReceived || 0,
          reason: 'user_cancel'
        });

        // Defensive cleanup: if the in-flight turn was processing a queued
        // prompt, drop the in-memory guard and unwedge any DB row stuck in
        // 'executing'. sweepExecutingForSession is delivery-aware -- a
        // prompt whose user message already landed in ai_agent_messages is
        // marked completed instead of rolled back, so the queue trigger
        // that follows the abort doesn't immediately re-claim and re-send
        // the same input (NIM-615).
        this.sessionsProcessingQueue.delete(sessionId);
        try {
          const { getQueuedPromptsStore } = await import('../RepositoryManager');
          const queueStore = getQueuedPromptsStore();
          const { completed, rolledBack } = await queueStore.sweepExecutingForSession(sessionId);
          if (completed > 0 || rolledBack > 0) {
            logger.main.info(
              `[AIService] cancelRequest: swept session ${sessionId} -- ${completed} delivered marked completed, ${rolledBack} undelivered rolled back`
            );
          }
        } catch (sweepErr) {
          logger.main.error('[AIService] cancelRequest: sweepExecutingForSession failed:', sweepErr);
        }

        provider.abort();
        // console.log(`[AIService] Cancelled request for session ${sessionId}`);
        this.analytics.sendEvent('cancel_ai_request', {provider: providerType})
        return { success: true };
      }
      console.warn(`[AIService] Cancel failed - no active provider for session: ${sessionId}`);
      return { success: false, error: 'No active provider for session' };
    });

    // Interrupt the current turn (graceful when possible) so queued prompts
    // are processed sooner. Providers that support a true mid-stream interrupt
    // (Claude Code) wrap up cleanly; others fall back to abort() via the
    // BaseAIProvider default. Returns { method } so the renderer can
    // distinguish the two paths.
    //
    // Defensive cleanup runs before the interrupt: clear the in-memory
    // sessionsProcessingQueue guard and unwedge any PGLite rows stuck in
    // 'executing' via sweepExecutingForSession (delivery-aware -- already
    // delivered prompts are marked completed, not rolled back, so the
    // follow-up ai:triggerQueueProcessing doesn't re-send the same input
    // -- NIM-615).
    safeHandle('ai:interruptCurrentTurn', async (_event, sessionId: string) => {
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
        const { completed, rolledBack } = await queueStore.sweepExecutingForSession(sessionId);
        if (completed > 0 || rolledBack > 0) {
          logger.main.info(
            `[AIService] interruptCurrentTurn: swept session ${sessionId} -- ${completed} delivered marked completed, ${rolledBack} undelivered rolled back`
          );
        }
      } catch (sweepErr) {
        logger.main.error('[AIService] interruptCurrentTurn: sweepExecutingForSession failed:', sweepErr);
      }

      const result = await provider.interruptCurrentTurn();
      logger.main.info(`[AIService] Interrupted current turn for session ${sessionId} (method=${result.method})`);
      return { success: true, method: result.method };
    });

    // Settings handlers
    safeHandle('ai:getSettings', async () => {
      const apiKeys = this.getSettingsStore().get('apiKeys', {}) as Record<string, string>;
      const providerSettings = this.getNormalizedProviderSettings();
      const showToolCalls = this.getSettingsStore().get('showToolCalls', false) as boolean;
      const chatShowToolCalls = this.getSettingsStore().get('chatShowToolCalls', true) as boolean;
      const aiDebugLogging = this.getSettingsStore().get('aiDebugLogging', false) as boolean;
      const showPromptAdditions = this.getSettingsStore().get('showPromptAdditions', false) as boolean;
      const showUsageIndicator = this.getSettingsStore().get('showUsageIndicator', true) as boolean;
      const showCodexUsageIndicator = this.getSettingsStore().get('showCodexUsageIndicator', true) as boolean;
      const showGeminiUsageIndicator = this.getSettingsStore().get('showGeminiUsageIndicator', true) as boolean;
      const customClaudeCodePath = this.getSettingsStore().get('customClaudeCodePath', '') as string;
      const autoCommitEnabled = this.getSettingsStore().get('autoCommitEnabled', false) as boolean;
      const trackerAutomation = this.getSettingsStore().get('trackerAutomation', {
        enabled: false,
        autoCloseOnCommit: true,
      }) as {
        enabled: boolean;
        autoCloseOnCommit: boolean;
      };
      const diffPeekSize = this.getSettingsStore().get('diffPeekSize', null) as
        | { width: number; height: number }
        | null;

      return {
        defaultProvider: this.getSettingsStore().get('defaultProvider', 'claude-code'),
        apiKeys: this.maskApiKeys(apiKeys),
        providerSettings,
        showToolCalls,
        chatShowToolCalls,
        aiDebugLogging,
        showPromptAdditions,
        showUsageIndicator,
        showCodexUsageIndicator,
        showGeminiUsageIndicator,
        customClaudeCodePath,
        autoCommitEnabled,
        trackerAutomation,
        diffPeekSize,
      };
    });

    safeHandle('ai:saveSettings', async (event, settings: any) => {
      // Legacy compat shim: this used to spread the incoming blob over the
      // stored blob (`{...currentProviderSettings, ...settings.providerSettings}`),
      // which silently dropped fields whenever the renderer's view was stale
      // (NIM-801, codex-lost). Now every field is routed through the per-key
      // SettingsService -- one validated write per key, broadcast to every
      // window, no blob in the wire payload to lose anything from.
      //
      // Renderer code that wants to be safe should call `window.electronAPI.settingsSet`
      // directly; this handler stays only for callers that haven't been
      // migrated yet (and as the implementation behind the convenience helpers
      // like `scheduleAIDebugPersist` until those are removed too).
      const svc = getSettingsService();

      const safeSet = (key: string, value: unknown): void => {
        try {
          svc.set(key as any, value as any);
        } catch (err) {
          logger.main.error(`[ai:saveSettings] svc.set(${key}) rejected:`, err);
        }
      };

      if (settings.defaultProvider !== undefined) {
        safeSet('ai.defaultProvider', settings.defaultProvider);
      }

      if (settings.apiKeys) {
        // The renderer sends the masked form of unchanged keys so it can show
        // them in form fields. Don't overwrite real keys with masks; compare
        // each incoming value against the stored mask before writing.
        const stored = (this.getSettingsStore().get('apiKeys', {}) as Record<string, string>) ?? {};
        const writeApiKey = (name: string, incoming: unknown): void => {
          if (incoming === undefined) return;
          if (!incoming) {
            // Empty string / null clears the key.
            safeSet(`ai.apiKey.${name}`, '');
            return;
          }
          if (typeof incoming !== 'string') return;
          if (incoming === this.maskApiKey(stored[name] || '')) return; // unchanged
          safeSet(`ai.apiKey.${name}`, incoming);
          if (name === 'openai') {
            // Sync openai key to mobile devices for voice mode.
            import('../SyncManager').then(({ syncSettingsToMobile }) => {
              syncSettingsToMobile(incoming);
            }).catch(() => { /* sync manager may not be available */ });
          }
        };
        writeApiKey('anthropic', settings.apiKeys.anthropic);
        writeApiKey('claude-code', settings.apiKeys['claude-code']);
        writeApiKey('openai', settings.apiKeys.openai);
        writeApiKey('ollama', settings.apiKeys.ollama);
        writeApiKey('anythingllm', settings.apiKeys.anythingllm);
        writeApiKey('openrouter', settings.apiKeys.openrouter);
        writeApiKey('featherless', settings.apiKeys.featherless);
        writeApiKey('featherless-official', settings.apiKeys['featherless-official']);
        writeApiKey('featherless-sane', settings.apiKeys['featherless-sane']);
        writeApiKey('featherless-heretic', settings.apiKeys['featherless-heretic']);
        writeApiKey('featherless-keyword', settings.apiKeys['featherless-keyword']);
        writeApiKey('openai-codex', settings.apiKeys['openai-codex']);
        if (settings.apiKeys.lmstudio_url !== undefined) {
          // lmstudio_url is a regular setting -- no masking, just write it.
          safeSet('ai.apiKey.lmstudio_url', settings.apiKeys.lmstudio_url);
        }
      }

      if (settings.providerSettings && typeof settings.providerSettings === 'object') {
        // Each incoming slice replaces the stored slice wholesale -- the
        // renderer owns the full config for any provider it sends. By writing
        // per provider id we never touch providers the caller didn't name.
        //
        // normalizeProviderSettings runs per-slice so transient/UI-only fields
        // (testStatus: 'testing', etc.) don't reach disk.
        const normalizedAll = this.normalizeProviderSettings(
          settings.providerSettings as Record<string, unknown>,
        ) as Record<string, unknown>;
        for (const [providerId, config] of Object.entries(normalizedAll)) {
          if (config === undefined) continue;
          safeSet(`ai.provider.${providerId}`, config);
          if (
            providerId === 'lmstudio' &&
            config &&
            typeof config === 'object' &&
            typeof (config as { baseUrl?: unknown }).baseUrl === 'string'
          ) {
            safeSet('ai.apiKey.lmstudio_url', (config as { baseUrl: string }).baseUrl);
          }
        }
        // Provider cache must be invalidated after writes so the next read
        // returns the new value rather than the pre-save snapshot.
        this.cachedNormalizedProviderSettings = null;
      }

      if (settings.showToolCalls !== undefined)        safeSet('ai.showToolCalls', settings.showToolCalls);
      if (settings.chatShowToolCalls !== undefined)    safeSet('ai.chatShowToolCalls', settings.chatShowToolCalls);
      if (settings.aiDebugLogging !== undefined)       safeSet('ai.aiDebugLogging', settings.aiDebugLogging);
      if (settings.showPromptAdditions !== undefined)  safeSet('ai.showPromptAdditions', settings.showPromptAdditions);
      if (settings.customClaudeCodePath !== undefined) safeSet('ai.customClaudeCodePath', settings.customClaudeCodePath);
      if (settings.autoCommitEnabled !== undefined)    safeSet('ai.autoCommitEnabled', settings.autoCommitEnabled);

      if (settings.showUsageIndicator !== undefined)       safeSet('ai.showUsageIndicator', settings.showUsageIndicator);
      if (settings.showCodexUsageIndicator !== undefined)  safeSet('ai.showCodexUsageIndicator', settings.showCodexUsageIndicator);
      if (settings.showGeminiUsageIndicator !== undefined) safeSet('ai.showGeminiUsageIndicator', settings.showGeminiUsageIndicator);

      if (settings.trackerAutomation !== undefined && typeof settings.trackerAutomation === 'object') {
        // Merge with current for partial updates (callers may send just the
        // toggled field). Whole-object write through SettingsService below.
        const current = (this.getSettingsStore().get('trackerAutomation', {
          enabled: false,
          autoCloseOnCommit: true,
        }) as Record<string, unknown>) ?? {};
        safeSet('ai.trackerAutomation', { ...current, ...settings.trackerAutomation });
      }

      if (settings.diffPeekSize !== undefined) {
        // null clears, otherwise expect { width, height }. SettingsService's
        // Zod schema validates the structure too -- safeSet is just additional
        // input shaping.
        if (
          settings.diffPeekSize === null ||
          (typeof settings.diffPeekSize === 'object' &&
            typeof settings.diffPeekSize.width === 'number' &&
            typeof settings.diffPeekSize.height === 'number')
        ) {
          safeSet('ai.diffPeekSize', settings.diffPeekSize);
        }
      }

      return { success: true };
    });

    // Test connection
    safeHandle('ai:testConnection', async (event, provider: string, workspacePath?: string) => {
      const apiKeys = this.getSettingsStore().get('apiKeys', {}) as Record<string, string>;

      // Get the appropriate API key based on provider.
      // Extension-agent providers (aiAgentProviders contributions) handle their
      // own auth inside the extension's backend module (e.g. Antigravity rides
      // ~/.gemini OAuth via AntigravityServerManager.hasGeminiAuth). On the host
      // side we treat them as 'not-required' and return success: the extension's
      // own backend healthcheck would be the ideal probe, but that contract
      // sits behind the seed PR's coordinated host scaffolding work. For now,
      // accepting indicates the extension is installed + the provider is
      // registered, which is what the user sees the green check confirming.
      let apiKey: string | undefined;
      if (isExtensionAgentProvider(provider)) {
        apiKey = 'not-required';
      } else {
        switch (provider) {
          case 'claude':
            apiKey = apiKeys['anthropic'];
            if (!apiKey) {
              return { success: false, error: 'Anthropic API key not configured' };
            }
            break;
          case 'claude-code':
            // Claude Code: API key is optional, uses SSO login if not provided
            apiKey = apiKeys['claude-code'];
            // No error if missing - will use SSO login
            break;
          case 'openai':
            apiKey = apiKeys['openai'];
            if (!apiKey) {
              return { success: false, error: 'OpenAI API key not configured' };
            }
            break;
          case 'ollama':
          case 'anythingllm':
          case 'openrouter':
          case 'featherless':
          case 'featherless-official':
          case 'featherless-sane':
          case 'featherless-heretic':
          case 'featherless-keyword':
            apiKey = apiKeys[provider] || DUMMY_OPENAI_COMPATIBLE_API_KEY;
            break;
          case 'openai-codex':
            apiKey = apiKeys['openai-codex'];
            break;
          case 'opencode':
            // OpenCode: API key is optional, uses its own config
            apiKey = apiKeys['opencode'] || 'not-required';
            break;
          case 'copilot-cli':
            // Copilot uses its own CLI auth, no API key needed
            apiKey = 'not-required';
            break;
          case 'lmstudio':
            // LMStudio doesn't need an API key, just test the connection
            apiKey = 'not-required';
            break;
          default:
            return { success: false, error: `Unknown provider: ${provider}` };
        }
      }

      // Extension-agent providers: skip the per-provider connectivity probes
      // below and return success directly. The 'try' block below contains
      // provider-specific connectivity logic (list models, run a real SDK
      // request, etc.) tied to each built-in id; none of it applies to an
      // extension-agent and the IDs would all miss the conditional checks.
      if (isExtensionAgentProvider(provider)) {
        return { success: true, provider };
      }

      try {
        // For OpenAI-compatible providers, list models as a connection test
        if (isOpenAICompatibleProvider(provider)) {
          const models = await ModelRegistry.getModelsForProvider(
            provider,
            apiKey,
            getConfiguredOpenAICompatibleBaseUrl(this.getSettingsStore(), provider),
            this.getOpenAICompatibleModelFilterRegex(provider),
          );
          return { success: models.length > 0, provider };
        }

        // For OpenAI Codex, run a real SDK request to validate credentials and connectivity
        if (provider === 'openai-codex') {
          const defaultModel = await ModelRegistry.getDefaultModel('openai-codex');
          const testProvider = new OpenAICodexProvider(apiKey ? { apiKey } : undefined);
          // Honor the project rail's active selection (#544). windowStates is
          // keyed by Nimbalyst's window id, not webContents.id, so resolve the
          // window id via getWindowId before the lookup.
          const browserWindow = BrowserWindow.fromWebContents(event.sender);
          const windowId = browserWindow ? getWindowId(browserWindow) : null;
          const effectiveWorkspacePath =
            workspacePath || resolveActiveWorkspacePathForWindowId(windowId);

          if (!effectiveWorkspacePath) {
            return {
              success: false,
              error: 'Open a workspace and trust it to test OpenAI Codex.',
            };
          }

          await testProvider.initialize({
            model: defaultModel,
            maxTokens: 256,
            ...(apiKey ? { apiKey } : {}),
          });

          let sawResponse = false;
          const response = testProvider.sendMessage(
            'Reply with exactly "ok".',
            undefined,
            undefined,
            [],
            effectiveWorkspacePath
          );

          for await (const chunk of response) {
            if (!chunk) continue;
            if (chunk.type === 'error') {
              const raw = chunk.error || 'Unknown Codex error';
              throw new Error(formatCodexTestError(raw, !!apiKey));
            }
            if (chunk.type === 'text' && (chunk.content || '').trim().length > 0) {
              sawResponse = true;
            }
            if (chunk.type === 'complete') {
              break;
            }
          }

          testProvider.destroy();
          if (!sawResponse) {
            throw new Error('No response content received from Codex SDK');
          }

          return { success: true, provider };
        }

        // For OpenCode, verify the CLI is installed. Electron's spawn
        // inherits a restricted PATH that does not include version-manager
        // bin directories (nvm, asdf, Volta, fnm). When the user installs
        // opencode-ai under nvm the binary lives at
        // ~/.nvm/versions/node/<version>/bin/opencode and naked execSync
        // returns "command not found" -- the user sees "OpenCode CLI not
        // found" even though `opencode` resolves fine in their shell.
        // CLIManager.getEnhancedPath() already builds the augmented PATH
        // used by every other CLI check; route through it here too.
        // See nimbalyst#184.
        if (provider === 'opencode') {
          try {
            const { execSync } = await import('child_process');
            const { getEnhancedPath } = await import('../CLIManager');
            const enhancedPath = getEnhancedPath();
            const version = execSync('opencode --version', {
              encoding: 'utf8',
              timeout: 5000,
              env: { ...process.env, PATH: enhancedPath } as Record<string, string>,
              stdio: ['pipe', 'pipe', 'pipe'],
            }).trim();
            return { success: true, provider, version };
          } catch {
            return {
              success: false,
              error: 'OpenCode CLI not found. Install it with: npm i -g opencode-ai',
            };
          }
        }

        // For Claude providers, test the API connection
        if (provider === 'claude') {
          console.log('[AIService] testConnection - Testing provider:', provider);

          // Create provider with appropriate config
          const config: any = { apiKey };

          const testProvider = new (await import('@nimbalyst/runtime/ai/server/providers/ClaudeProvider')).ClaudeProvider();

          // Use the provider's default model for testing (already includes prefix)
          const defaultModel = await ModelRegistry.getDefaultModel('claude');
          console.log('[AIService] testConnection - Got default model:', defaultModel);
          config.model = defaultModel;
          console.log('[AIService] testConnection - Initializing with config:', { hasApiKey: !!config.apiKey, model: config.model });
          await testProvider.initialize(config);

          console.log('[AIService] Testing connection by sending a simple message...');
          // Try a simple message
          const response = testProvider.sendMessage('Say "Hello" in one word');
          for await (const chunk of response) {
            if (!chunk) continue;
            if (chunk.type === 'error') {
              throw new Error(chunk.error || 'Unknown error');
            }
          }
          testProvider.destroy();
        }

        // For Claude Code, just verify the API key works with the regular Claude API
        if (provider === 'claude-code') {
          console.log('[AIService] testConnection - Testing Claude Code provider');

          // Test using the regular Claude API to verify the key
          const testProvider = new (await import('@nimbalyst/runtime/ai/server/providers/ClaudeProvider')).ClaudeProvider();
          const config: any = {
            apiKey,
            model: 'claude-haiku-4-5-20251001'
          };

          await testProvider.initialize(config);

          // Quick test message
          const response = testProvider.sendMessage('Say "Hello" in one word');
          for await (const chunk of response) {
            if (!chunk) continue;
            if (chunk.type === 'error') {
              throw new Error(chunk.error || 'Unknown error');
            }
            // Exit after first response
            if (chunk.type === 'text') {
              break;
            }
          }
          testProvider.destroy();
        }

        // For LMStudio, test the endpoint
        if (provider === 'lmstudio') {
          const baseUrl = getConfiguredLMStudioBaseUrl(this.getSettingsStore());
          const response = await fetch(`${baseUrl}/v1/models`);
          if (!response.ok) {
            throw new Error(`LMStudio server not responding at ${baseUrl}`);
          }
        }

        return { success: true, provider };
      } catch (error: any) {
        return { success: false, error: error.message };
      }
    });

    // Get ALL available models for configuration UI
    safeHandle('ai:getAllModels', async () => {
      // Clear cache to get fresh models
      ModelRegistry.clearCache();

      const providerSettings = this.getNormalizedProviderSettings() as Record<AIProviderType, any>;
      const apiKeys = this.getSettingsStore().get('apiKeys', {}) as Record<string, string>;

      // Only fetch from providers that are enabled (skip LMStudio network call when disabled)
      const enabledSet = new Set<AIProviderType>();
      if (providerSettings['claude']?.enabled === true && !!apiKeys['anthropic']) enabledSet.add('claude');
      if (providerSettings['claude-code']?.enabled !== false) enabledSet.add('claude-code');
      if (providerSettings['openai']?.enabled === true && !!apiKeys['openai']) enabledSet.add('openai');
      for (const provider of OPENAI_COMPATIBLE_PROVIDER_TYPES) {
        if (provider === 'openai') continue;
        if (providerSettings[provider]?.enabled === true) enabledSet.add(provider);
      }
      if (providerSettings['openai-codex']?.enabled === true) enabledSet.add('openai-codex');
      if (providerSettings['opencode']?.enabled === true) enabledSet.add('opencode');
      if (providerSettings['lmstudio']?.enabled === true) enabledSet.add('lmstudio');

      const modelsConfig = {
        ...apiKeys,
        openai_base_url: getConfiguredOpenAIBaseUrl(this.getSettingsStore()) || '',
        ollama: apiKeys.ollama || DUMMY_OPENAI_COMPATIBLE_API_KEY,
        ollama_base_url: getConfiguredOpenAICompatibleBaseUrl(this.getSettingsStore(), 'ollama') || '',
        anythingllm: apiKeys.anythingllm || DUMMY_OPENAI_COMPATIBLE_API_KEY,
        anythingllm_base_url: getConfiguredOpenAICompatibleBaseUrl(this.getSettingsStore(), 'anythingllm') || '',
        openrouter: apiKeys.openrouter || DUMMY_OPENAI_COMPATIBLE_API_KEY,
        openrouter_base_url: getConfiguredOpenAICompatibleBaseUrl(this.getSettingsStore(), 'openrouter') || '',
        featherless: apiKeys.featherless || DUMMY_OPENAI_COMPATIBLE_API_KEY,
        featherless_base_url: getConfiguredOpenAICompatibleBaseUrl(this.getSettingsStore(), 'featherless') || '',
        'featherless-official': apiKeys['featherless-official'] || DUMMY_OPENAI_COMPATIBLE_API_KEY,
        'featherless-official_base_url': getConfiguredOpenAICompatibleBaseUrl(this.getSettingsStore(), 'featherless-official') || '',
        'featherless-sane': apiKeys['featherless-sane'] || DUMMY_OPENAI_COMPATIBLE_API_KEY,
        'featherless-sane_base_url': getConfiguredOpenAICompatibleBaseUrl(this.getSettingsStore(), 'featherless-sane') || '',
        'featherless-heretic': apiKeys['featherless-heretic'] || DUMMY_OPENAI_COMPATIBLE_API_KEY,
        'featherless-heretic_base_url': getConfiguredOpenAICompatibleBaseUrl(this.getSettingsStore(), 'featherless-heretic') || '',
        'featherless-keyword': apiKeys['featherless-keyword'] || DUMMY_OPENAI_COMPATIBLE_API_KEY,
        'featherless-keyword_base_url': getConfiguredOpenAICompatibleBaseUrl(this.getSettingsStore(), 'featherless-keyword') || '',
        lmstudio_url: getConfiguredLMStudioBaseUrl(this.getSettingsStore())
      };
      const openAICompatibleModelFilterRegexes = Object.fromEntries(
        OPENAI_COMPATIBLE_PROVIDER_TYPES.map((provider) => [provider, this.getOpenAICompatibleModelFilterRegex(provider)]),
      ) as Partial<Record<AIProviderType, string>>;
      const allModels = capModelsPerProviderForUi(
        await ModelRegistry.getAllModels(modelsConfig, enabledSet, openAICompatibleModelFilterRegexes),
      );

      // Append extension-contributed agent provider models (see ai:getModels).
      for (const agentEntry of getAgentProviderRegistry().list()) {
        if (agentEntry.status === 'denied') continue;
        for (const m of agentEntry.contribution.models ?? []) {
          allModels.push({
            id: m.id,
            name: m.name,
            provider: agentEntry.contributionId as AIProviderType,
          });
        }
      }

      // Group ALL models by provider (for configuration UI)
      const grouped: Record<string, any[]> = {};
      for (const model of allModels) {
        if (!grouped[model.provider]) {
          grouped[model.provider] = [];
        }
        grouped[model.provider].push(model);
      }

      logger.main.info('[AIService] ai:getAllModels result', JSON.stringify({
        enabledProviders: Array.from(enabledSet),
        groupedCounts: Object.fromEntries(
          Object.entries(grouped).map(([provider, models]) => [provider, models.length]),
        ),
      }));

      return {
        success: true,
        models: allModels,
        grouped
      };
    });

    // Clear model cache
    safeHandle('ai:clearModelCache', async () => {
      ModelRegistry.clearCache();
      return { success: true };
    });

    safeHandle('ai:refreshSessionProvider', async (_event, sessionId: string) => {
      ProviderFactory.destroyProvider(sessionId);
      return { success: true };
    });

    safeHandle('ai:getAgentWorkflows', async (
      _event,
      payload?: {
        workspacePath?: string;
        sessionId?: string;
        provider?: string | null;
      }
    ) => {
      try {
        const request = payload ?? {};
        if (!request.workspacePath) {
          throw new Error('ai:getAgentWorkflows requires workspacePath');
        }

        const resolvedProvider = request.provider ?? 'claude-code';
        const nativeCatalog = this.getProviderWorkflowCatalog({
          sessionId: request.sessionId,
          provider: resolvedProvider,
        });

        // NIM-845: for a genuine claude-code-cli session, hide extension-plugin
        // (namespaced) commands when the resolved `claude` is too old to accept
        // `--plugin-dir` — those plugins can't load, so the commands would never
        // resolve. The SDK `claude-code` path always loads them in-process.
        const excludePluginCommands =
          resolvedProvider === 'claude-code-cli' && !claudeCliSessionSupportsPlugins();

        const workflows = await getAgentWorkflowService(request.workspacePath).listEntries({
          provider: resolvedProvider,
          nativeCommands: nativeCatalog.commands,
          nativeSkills: nativeCatalog.skills,
          excludePluginCommands,
        });

        return { success: true, workflows };
      } catch (error) {
        console.error('[AIService] Error getting agent workflows:', error);
        return {
          success: false,
          workflows: [],
          error: error instanceof Error ? error.message : 'Unknown error',
        };
      }
    });

    safeHandle('ai:getSlashCommands', async (
      _event,
      payload?: string | { sessionId?: string; provider?: string | null }
    ) => {
      try {
        const request = typeof payload === 'string'
          ? { sessionId: payload, provider: undefined }
          : payload ?? {};
        const { commands, skills } = this.getProviderWorkflowCatalog(request);
        return { success: true, commands, skills };
      } catch (error) {
        console.error('[AIService] Error getting slash commands:', error);
        return { success: false, commands: [], skills: [], error: error instanceof Error ? error.message : 'Unknown error' };
      }
    });

    // Get ENABLED models for actual use
    safeHandle('ai:getModels', async () => {
      // console.log('[AIService] ai:getModels called - fetching enabled models');
      const providerSettings = this.getNormalizedProviderSettings() as Record<AIProviderType, any>;
      const apiKeys = this.getSettingsStore().get('apiKeys', {}) as Record<string, string>;
      const claudeCodeSettings = providerSettings['claude-code'] || {};

      // console.log('[AIService] ai:getModels - claude-code settings:', {
      //   enabled: claudeCodeSettings.enabled,
      //   models: claudeCodeSettings.models
      // });

      // Build enabled providers map (needed before fetching to skip disabled providers)
      const enabledProviders: Record<AIProviderType, { enabled: boolean; models?: string[] }> = {
        'claude': {
          enabled: providerSettings['claude']?.enabled === true && !!apiKeys['anthropic'],
          models: providerSettings['claude']?.models
        },
        'claude-code': {
          // Respect the user's toggle but don't require an API key—Claude Code uses CLI auth
          enabled: claudeCodeSettings.enabled !== false,
          models: claudeCodeSettings.models
        },
        'claude-code-cli': {
          // Genuine `claude` CLI on the user's subscription. On by default (like
          // `claude-code`); no API key required — the CLI uses its own login.
          enabled: providerSettings['claude-code-cli']?.enabled !== false,
          models: providerSettings['claude-code-cli']?.models
        },
        'openai': {
          enabled: providerSettings['openai']?.enabled === true && !!apiKeys['openai'],
          models: providerSettings['openai']?.models
        },
        'ollama': {
          enabled: providerSettings['ollama']?.enabled === true,
          models: providerSettings['ollama']?.models
        },
        'anythingllm': {
          enabled: providerSettings['anythingllm']?.enabled === true,
          models: providerSettings['anythingllm']?.models
        },
        'openrouter': {
          enabled: providerSettings['openrouter']?.enabled === true,
          models: providerSettings['openrouter']?.models
        },
        'featherless': {
          enabled: providerSettings['featherless']?.enabled === true,
          models: providerSettings['featherless']?.models
        },
        'featherless-official': {
          enabled: providerSettings['featherless-official']?.enabled === true,
          models: providerSettings['featherless-official']?.models
        },
        'featherless-sane': {
          enabled: providerSettings['featherless-sane']?.enabled === true,
          models: providerSettings['featherless-sane']?.models
        },
        'featherless-heretic': {
          enabled: providerSettings['featherless-heretic']?.enabled === true,
          models: providerSettings['featherless-heretic']?.models
        },
        'featherless-keyword': {
          enabled: providerSettings['featherless-keyword']?.enabled === true,
          models: providerSettings['featherless-keyword']?.models
        },
        'openai-codex': {
          // Codex SDK uses its own auth (codex auth login), API key is optional
          enabled: providerSettings['openai-codex']?.enabled === true,
        },
        'openai-codex-acp': {
          // Codex ACP uses the codex-acp binary directly; API key is optional
          enabled: providerSettings['openai-codex-acp']?.enabled === true,
        },
        'opencode': {
          // OpenCode uses its own config, API key is optional
          enabled: providerSettings['opencode']?.enabled === true,
        },
        'copilot-cli': {
          // Copilot uses its own CLI auth (copilot auth login), no API key needed
          enabled: providerSettings['copilot-cli']?.enabled === true,
        },
        'lmstudio': {
          enabled: providerSettings['lmstudio']?.enabled === true,
          models: providerSettings['lmstudio']?.models
        }
      };

      // Only fetch models from enabled providers (avoids network errors for disabled ones like LMStudio)
      const enabledProviderSet = new Set(
        (Object.entries(enabledProviders) as [AIProviderType, { enabled: boolean }][])
          .filter(([, v]) => v.enabled)
          .map(([k]) => k)
      );
      const modelsConfig = {
        ...apiKeys,
        openai_base_url: getConfiguredOpenAIBaseUrl(this.getSettingsStore()) || '',
        ollama: apiKeys.ollama || DUMMY_OPENAI_COMPATIBLE_API_KEY,
        ollama_base_url: getConfiguredOpenAICompatibleBaseUrl(this.getSettingsStore(), 'ollama') || '',
        anythingllm: apiKeys.anythingllm || DUMMY_OPENAI_COMPATIBLE_API_KEY,
        anythingllm_base_url: getConfiguredOpenAICompatibleBaseUrl(this.getSettingsStore(), 'anythingllm') || '',
        openrouter: apiKeys.openrouter || DUMMY_OPENAI_COMPATIBLE_API_KEY,
        openrouter_base_url: getConfiguredOpenAICompatibleBaseUrl(this.getSettingsStore(), 'openrouter') || '',
        featherless: apiKeys.featherless || DUMMY_OPENAI_COMPATIBLE_API_KEY,
        featherless_base_url: getConfiguredOpenAICompatibleBaseUrl(this.getSettingsStore(), 'featherless') || '',
        'featherless-official': apiKeys['featherless-official'] || DUMMY_OPENAI_COMPATIBLE_API_KEY,
        'featherless-official_base_url': getConfiguredOpenAICompatibleBaseUrl(this.getSettingsStore(), 'featherless-official') || '',
        'featherless-sane': apiKeys['featherless-sane'] || DUMMY_OPENAI_COMPATIBLE_API_KEY,
        'featherless-sane_base_url': getConfiguredOpenAICompatibleBaseUrl(this.getSettingsStore(), 'featherless-sane') || '',
        'featherless-heretic': apiKeys['featherless-heretic'] || DUMMY_OPENAI_COMPATIBLE_API_KEY,
        'featherless-heretic_base_url': getConfiguredOpenAICompatibleBaseUrl(this.getSettingsStore(), 'featherless-heretic') || '',
        'featherless-keyword': apiKeys['featherless-keyword'] || DUMMY_OPENAI_COMPATIBLE_API_KEY,
        'featherless-keyword_base_url': getConfiguredOpenAICompatibleBaseUrl(this.getSettingsStore(), 'featherless-keyword') || '',
        lmstudio_url: getConfiguredLMStudioBaseUrl(this.getSettingsStore())
      };
      const openAICompatibleModelFilterRegexes = Object.fromEntries(
        OPENAI_COMPATIBLE_PROVIDER_TYPES.map((provider) => [provider, this.getOpenAICompatibleModelFilterRegex(provider)]),
      ) as Partial<Record<AIProviderType, string>>;
      const allModels = capModelsPerProviderForUi(
        await ModelRegistry.getAllModels(modelsConfig, enabledProviderSet, openAICompatibleModelFilterRegexes),
      );

      // const claudeCodeModels = allModels.filter(m => m.provider === 'claude-code');
      // console.log('[AIService] ai:getModels - claude-code models from registry:',
      //   claudeCodeModels.map(m => ({ id: m.id, name: m.name })));

      // Filter to only enabled models
      const enabledModels = allModels.filter(model => {
        const provider = enabledProviders[model.provider as AIProviderType];
        // if (model.provider === 'openai-codex') {
        //   console.log('[AIService] Filtering openai-codex model:', {
        //     modelId: model.id,
        //     providerEnabled: provider?.enabled,
        //     selectedModels: provider?.models
        //   });
        // }
        if (!provider?.enabled) return false;
        // If specific models are selected, filter to those
        if (provider.models && provider.models.length > 0) {
          if (model.provider === 'claude-code' && provider.models.includes('claude-code')) {
            return true;
          }
          // For Claude Code: if base model is selected, also include 1M variants
          // e.g., if 'claude-code:sonnet' is selected, also include 'claude-code:sonnet-1m'
          if (model.provider === 'claude-code' && model.id.includes('-1m')) {
            const baseModelId = model.id.replace(/-1m$/, '');
            if (provider.models.includes(baseModelId)) {
              return true;
            }
          }
          return provider.models.includes(model.id);
        }
        // Otherwise include all models for this provider
        return true;
      });

      // Surface extension-contributed agent providers (aiAgentProviders) in the
      // picker. The built-in `enabledProviders` map is keyed on AIProviderType,
      // so the filter above drops them; append after it. Each registered,
      // non-denied entry contributes its manifest models under its flat
      // contribution id -- the value session.provider carries and the host-side
      // resolver (providerResolution.ts) looks up. Descriptor/affordance shape
      // flagged for Greg's call in the seed PR.
      const providerLabels: Record<string, string> = {};
      const providerIcons: Record<string, string> = {};
      for (const agentEntry of getAgentProviderRegistry().list()) {
        if (agentEntry.status === 'denied') continue;
        providerLabels[agentEntry.contributionId] =
          agentEntry.contribution.displayName || agentEntry.contributionId;
        if (agentEntry.contribution.icon) {
          providerIcons[agentEntry.contributionId] = agentEntry.contribution.icon;
        }
        for (const m of agentEntry.contribution.models ?? []) {
          enabledModels.push({
            id: m.id,
            name: m.name,
            provider: agentEntry.contributionId as AIProviderType,
          });
        }
      }

      // Group ENABLED models by provider (not all models)
      const grouped: Record<string, any[]> = {};
      for (const model of enabledModels) {
        if (!grouped[model.provider]) {
          grouped[model.provider] = [];
        }
        grouped[model.provider].push(model);
      }

      logger.main.info('[AIService] ai:getModels result', JSON.stringify({
        enabledProviders: Array.from(enabledProviderSet),
        groupedCounts: Object.fromEntries(
          Object.entries(grouped).map(([provider, models]) => [provider, models.length]),
        ),
      }));

      // Log final claude-code models being returned
      const enabledClaudeCodeModels = enabledModels.filter(m => m.provider === 'claude-code');
      console.log('[AIService] ai:getModels - returning enabled claude-code models:',
        enabledClaudeCodeModels.map(m => ({ id: m.id, name: m.name })));

      return {
        success: true,
        models: enabledModels.map(m => ({
          id: m.id,
          display_name: m.name,
          provider: m.provider,
          maxTokens: m.maxTokens
        })),
        grouped,  // This now contains only enabled models
        providers: enabledProviders,
        // Maps of extension contribution id -> manifest displayName / icon, so
        // the picker labels extension agent groups (e.g. "Gemini" + auto_awesome)
        // instead of prettifying the raw contribution id.
        providerLabels,
        providerIcons
      };
    });

    // MCP integration for applyDiff results
    safeHandle('mcp:applyDiff:result', async (event, resultChannel: string, result: any) => {
      // Forward result back through the result channel
      safeSend(event, resultChannel, result);
    });

    // ============================================================
    // Project-level AI Settings Override Handlers
    // ============================================================

    // Get project-level AI provider overrides
    safeHandle('ai:getProjectSettings', async (_event, workspacePath: string) => {
      if (!workspacePath) {
        return { success: false, error: 'workspacePath is required' };
      }

      const overrides = getAIProviderOverrides(workspacePath);

      return {
        success: true,
        overrides: overrides || null,
      };
    });

    // Get project-level tracker automation override
    safeHandle('ai:getProjectTrackerAutomation', async (_event, workspacePath: string) => {
      if (!workspacePath) return { success: false, error: 'workspacePath is required' };
      const { getTrackerAutomationOverride } = await import('../../utils/store');
      return { success: true, override: getTrackerAutomationOverride(workspacePath) ?? null };
    });

    // Save project-level tracker automation override
    safeHandle('ai:saveProjectTrackerAutomation', async (_event, workspacePath: string, override: any) => {
      if (!workspacePath) return { success: false, error: 'workspacePath is required' };
      const { saveTrackerAutomationOverride } = await import('../../utils/store');
      saveTrackerAutomationOverride(workspacePath, override || undefined);
      return { success: true };
    });

    // Save project-level AI provider overrides
    safeHandle('ai:saveProjectSettings', async (_event, workspacePath: string, overrides: any) => {
      if (!workspacePath) {
        return { success: false, error: 'workspacePath is required' };
      }

      const normalizedOverrides = normalizeAIProviderOverrides(overrides);

      // If overrides is null/undefined or empty, clear the overrides
      if (!normalizedOverrides || (Object.keys(normalizedOverrides).length === 0)) {
        saveAIProviderOverrides(workspacePath, undefined);
      } else {
        saveAIProviderOverrides(workspacePath, normalizedOverrides);
      }

      return { success: true };
    });

    // Get effective (merged) AI settings for a workspace
    safeHandle('ai:getEffectiveSettings', async (_event, workspacePath?: string) => {

      // Get global settings
      const apiKeys = this.getSettingsStore().get('apiKeys', {}) as Record<string, string>;
      const providerSettings = this.getSettingsStore().get('providerSettings', {}) as any;
      const showToolCalls = this.getSettingsStore().get('showToolCalls', false) as boolean;
      const chatShowToolCalls = this.getSettingsStore().get('chatShowToolCalls', true) as boolean;
      const aiDebugLogging = this.getSettingsStore().get('aiDebugLogging', false) as boolean;
      const showPromptAdditions = this.getSettingsStore().get('showPromptAdditions', false) as boolean;
      const defaultProvider = this.getSettingsStore().get('defaultProvider', 'claude-code') as string;

      const globalSettings = {
        defaultProvider,
        apiKeys: this.maskApiKeys(apiKeys),
        providerSettings,
        showToolCalls,
        chatShowToolCalls,
        aiDebugLogging,
        showPromptAdditions,
      };

      // Merge with project overrides
      const effective = mergeAISettings(globalSettings, workspacePath);

      return {
        success: true,
        settings: effective,
      };
    });

    // Clear project-level AI overrides
    safeHandle('ai:clearProjectSettings', async (_event, workspacePath: string) => {
      if (!workspacePath) {
        return { success: false, error: 'workspacePath is required' };
      }

      clearAIProviderOverrides(workspacePath);

      return { success: true };
    });

    // Extension SDK: Send a prompt and wait for the full response
    safeHandle('extensions:ai-send-prompt', async (
      event,
      options: { prompt: string; sessionName?: string; provider?: string; model?: string }
    ) => {
      const { prompt, sessionName } = options;
      const provider = (options.provider || 'claude-code') as AIProviderType;
      if (!prompt) {
        throw new Error('prompt is required');
      }

      // Resolve the workspace from the window, honoring the project rail's
      // active selection. Reading the raw primary `workspacePath` would route
      // the new session to the startup project in Multi-Project mode (#544).
      const browserWindow = BrowserWindow.fromWebContents(event.sender);
      const windowId = browserWindow ? getWindowId(browserWindow) : null;
      const workspacePath = resolveActiveWorkspacePathForWindowId(windowId);
      if (!workspacePath) {
        throw new Error('No workspace path available for extension AI prompt');
      }

      // Validate provider is enabled and has required credentials
      if (!this.isProviderEnabledForWorkspace(provider, workspacePath)) {
        throw new Error(`Provider ${provider} is not enabled for this workspace`);
      }

      // Check API key (claude-code uses SSO, so key is optional)
      if (provider !== 'claude-code') {
        const apiKey = this.getApiKeyForProvider(provider, workspacePath);
        if (!apiKey) {
          throw new Error(`API key not configured for provider ${provider}. Configure it in Settings > AI.`);
        }
      }

      // Use explicitly requested model, or fall back to provider default
      const model = options.model || await ModelRegistry.getDefaultModel(provider);
      const providerConfig: any = {
        maxTokens: this.getProviderSetting(provider, 'maxTokens'),
        temperature: this.getProviderSetting(provider, 'temperature'),
      };

      if (isOpenAICompatibleProvider(provider)) {
        providerConfig.modelFilterRegex = this.getOpenAICompatibleModelFilterRegex(provider);
      }

      // For non-claude-code providers, set the model in provider config
      if (model && provider !== 'claude-code') {
        const modelForProvider = extractModelForProvider(model, provider);
        if (modelForProvider !== null) {
          providerConfig.model = modelForProvider;
        }
      }

      const session = await this.sessionManager.createSession(
        provider,
        undefined, // no document context
        workspacePath,
        providerConfig,
        model,
        'session',
      );

      // Set session title
      if (sessionName) {
        await this.sessionManager.updateSessionTitle(session.id, sessionName, { force: true, markAsNamed: true });
      }

      // Notify renderer to refresh session list so the new session appears
      safeSend(event, 'sessions:refresh-list', { workspacePath, sessionId: session.id });

      // Send the prompt via the existing sendMessage handler
      if (!this.sendMessageHandler) {
        throw new Error('sendMessageHandler not initialized');
      }

      const result = await this.sendMessageHandler(event, prompt, undefined, session.id, workspacePath);
      const response = result?.content || '';

      return { sessionId: session.id, response };
    });

    // Extension SDK: renderer->backend READ bridge. Lets an extension's renderer
    // half (settings panel, voice context provider) call one of ITS OWN backend
    // module's MCP tools and get the parsed result. Tool calls otherwise route
    // main->backend with no renderer hop; this is the one path the renderer needs
    // for read access (live index status, listing facts, triggering a rebuild).
    //
    // SECURITY: `callerExtensionId` is injected by the host that builds the
    // bridge (ExtensionLoader / settings panel) from the extension's own
    // manifest id — it is NOT supplied by extension code. We enforce that the
    // resolved tool belongs to the calling extension so one enabled extension
    // can't reach into another extension's backend tools (e.g. memory.delete_fact)
    // just by knowing the name.
    safeHandle('extensions:ai-call-backend-tool', async (
      event,
      options: {
        toolName: string;
        args?: Record<string, unknown>;
        workspacePath?: string;
        callerExtensionId?: string;
      }
    ) => {
      const toolName = options?.toolName;
      if (!toolName) {
        throw new Error('toolName is required');
      }
      const callerExtensionId = options?.callerExtensionId;
      if (!callerExtensionId) {
        throw new Error('callerExtensionId is required for backend tool call');
      }

      // Resolve the workspace: explicit arg wins, else the window's active
      // project (honors the project rail selection in Multi-Project mode).
      let workspacePath = options?.workspacePath;
      if (!workspacePath) {
        const browserWindow = BrowserWindow.fromWebContents(event.sender);
        const windowId = browserWindow ? getWindowId(browserWindow) : null;
        workspacePath = resolveActiveWorkspacePathForWindowId(windowId) ?? undefined;
      }
      if (!workspacePath) {
        throw new Error('No workspace path available for backend tool call');
      }

      // Resolve worktree paths to the project path the backend module was started
      // for, then route to the module over the typed RPC bridge.
      const resolved = await resolveBackendWorkspacePath(workspacePath);

      // Enforce caller ownership of the tool. Fail closed: an unknown tool and a
      // cross-extension call both reject without dispatching.
      const entry = findOwnedBackendTool(resolved, toolName, callerExtensionId);
      if (!entry) {
        throw new Error(`Backend tool not available to this extension: ${toolName}`);
      }

      const result = await handleBackendTool(toolName, toolName, options?.args ?? {}, resolved);
      const text = result.content?.[0]?.text ?? '';
      if (result.isError) {
        throw new Error(text || `Backend tool ${toolName} failed`);
      }
      try {
        return JSON.parse(text);
      } catch {
        // Tool returned a non-JSON string payload; hand it back as-is.
        return text;
      }
    });

    // Extension SDK: List available chat models
    safeHandle('extensions:ai-list-models', async () => {
      const CHAT_PROVIDERS: AIProviderType[] = ['claude', ...OPENAI_COMPATIBLE_PROVIDER_TYPES, 'lmstudio'];
      const providerSettings = this.getNormalizedProviderSettings() as any;
      const globalApiKeys = this.getSettingsStore().get('apiKeys', {}) as Record<string, string>;

      const allModels: Array<{ id: string; name: string; provider: string }> = [];

      for (const provider of CHAT_PROVIDERS) {
        // Check if provider is enabled
        const settings = providerSettings?.[provider];
        if (settings && settings.enabled === false) continue;

        const apiKey = provider === 'claude' ? globalApiKeys['anthropic']
          : isOpenAICompatibleProvider(provider) ? (globalApiKeys[provider] || DUMMY_OPENAI_COMPATIBLE_API_KEY)
          : undefined;
        const baseUrl = provider === 'lmstudio'
          ? getConfiguredLMStudioBaseUrl(this.getSettingsStore())
          : isOpenAICompatibleProvider(provider)
            ? getConfiguredOpenAICompatibleBaseUrl(this.getSettingsStore(), provider)
            : undefined;

        try {
          const models = await ModelRegistry.getModelsForProvider(
            provider,
            apiKey,
            baseUrl,
            isOpenAICompatibleProvider(provider)
              ? this.getOpenAICompatibleModelFilterRegex(provider)
              : undefined,
          );
          const enabledModelIds = settings?.models as string[] | undefined;

          for (const model of models) {
            // If provider has specific model selections, filter to those
            if (enabledModelIds && enabledModelIds.length > 0 && !enabledModelIds.includes(model.id)) {
              continue;
            }
            allModels.push({
              id: model.id,
              name: model.name,
              provider: model.provider,
            });
          }
        } catch (err) {
          // console.warn(`[AIService] Failed to list models for ${provider}:`, err);
        }
      }

      return allModels;
    });

    // Extension SDK: Stateless chat completion (full response)
    safeHandle('extensions:ai-chat-completion', async (
      event,
      options: {
        messages: Array<{ role: string; content: string }>;
        model?: string;
        maxTokens?: number;
        temperature?: number;
        systemPrompt?: string;
        responseFormat?: any;
      }
    ) => {
      return this.handleExtensionChatCompletion(event, options);
    });

    // Extension SDK: Streaming chat completion - start
    const activeStreams = new Map<string, AIProvider>();

    safeHandle('extensions:ai-chat-completion-stream-start', async (
      event,
      options: {
        streamId: string;
        messages: Array<{ role: string; content: string }>;
        model?: string;
        maxTokens?: number;
        temperature?: number;
        systemPrompt?: string;
        responseFormat?: any;
      }
    ) => {
      const { streamId, ...completionOptions } = options;
      const { provider, providerConfig, syntheticSessionId } = await this.resolveExtensionChatProvider(event, completionOptions);

      activeStreams.set(streamId, provider);

      // Build messages for the provider
      const { currentMessage, previousMessages } = this.buildProviderMessages(completionOptions);

      // Stream in the background
      (async () => {
        let fullContent = '';
        let usage: { inputTokens: number; outputTokens: number } | undefined;

        try {
          const iterator = provider.sendMessage(
            currentMessage,
            undefined,  // no document context
            syntheticSessionId,
            previousMessages,
          );

          for await (const chunk of iterator) {
            if (event.sender.isDestroyed()) break;

            if (chunk.type === 'text' && chunk.content) {
              fullContent += chunk.content;
              safeSend(event, 'extensions:ai-chat-completion-stream-chunk', {
                streamId,
                chunk: { type: 'text', content: chunk.content },
              });
            } else if (chunk.type === 'error') {
              safeSend(event, 'extensions:ai-chat-completion-stream-chunk', {
                streamId,
                chunk: { type: 'error', error: chunk.error || 'Unknown error' },
              });
              return;
            } else if (chunk.type === 'complete') {
              if (chunk.content) fullContent = chunk.content;
              if (chunk.usage) {
                usage = {
                  inputTokens: chunk.usage.input_tokens,
                  outputTokens: chunk.usage.output_tokens,
                };
              }
            }
          }

          safeSend(event, 'extensions:ai-chat-completion-stream-chunk', {
            streamId,
            chunk: { type: 'done' },
            result: {
              content: fullContent,
              model: providerConfig.model || '',
              usage,
            },
          });
        } catch (err: any) {
          safeSend(event, 'extensions:ai-chat-completion-stream-chunk', {
            streamId,
            chunk: { type: 'error', error: err.message || 'Stream failed' },
          });
        } finally {
          activeStreams.delete(streamId);
          ProviderFactory.destroyProvider(syntheticSessionId);
        }
      })();

      return { streamId };
    });

    // Extension SDK: Streaming chat completion - abort
    safeHandle('extensions:ai-chat-completion-stream-abort', async (_event, streamId: string) => {
      const provider = activeStreams.get(streamId);
      if (provider) {
        provider.abort();
        activeStreams.delete(streamId);
      }
    });

    // Advance the FileSnapshotCache baseline after diff acceptance/rejection
    safeHandle('ai:advance-diff-baseline', async (_event, sessionId: string, filePath: string, content: string) => {
      this.advanceDiffBaseline(sessionId, filePath, content);
    });
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

  private getOpenAICompatibleModelFilterRegex(provider: OpenAICompatibleProviderType): string | undefined {
    return this.getProviderSetting(provider, 'modelFilterRegex');
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
    if (!workspacePath || !filePath) return null;
    const normalizedWorkspace = path.normalize(workspacePath);
    const normalizedFile = path.normalize(filePath);
    const worktreePrefix = `${normalizedWorkspace}_worktrees${path.sep}`;
    if (!normalizedFile.startsWith(worktreePrefix)) return null;

    const remainder = normalizedFile.slice(worktreePrefix.length);
    const worktreeName = remainder.split(path.sep)[0];
    if (!worktreeName || worktreeName.includes('..')) return null;

    const worktreePath = path.resolve(path.join(`${normalizedWorkspace}_worktrees`, worktreeName));
    if (!worktreePath.startsWith(worktreePrefix.slice(0, -1))) return null;
    return worktreePath;
  }

  private inferWorktreePathFromCommand(command: string | undefined, workspacePath: string): string | null {
    if (!command || !workspacePath) return null;
    const normalizedWorkspace = path.normalize(workspacePath);
    const worktreePrefix = `${normalizedWorkspace}_worktrees${path.sep}`;
    const normalizedCommand = command.replace(/\\/g, path.sep);
    const idx = normalizedCommand.indexOf(worktreePrefix);
    if (idx === -1) return null;

    const after = normalizedCommand.slice(idx + worktreePrefix.length);
    const worktreeName = after.split(/[\s'"\r\n\\/]/)[0];
    if (!worktreeName || worktreeName.includes('..')) return null;

    const result = path.resolve(path.join(`${normalizedWorkspace}_worktrees`, worktreeName));
    if (!result.startsWith(worktreePrefix.slice(0, -1))) return null;
    return result;
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

  /**
   * Resolve which chat provider and config to use for an extension completion request.
   * Only chat providers (Claude, OpenAI-compatible providers, LM Studio) are supported.
   */
  private async resolveExtensionChatProvider(
    event: Electron.IpcMainInvokeEvent,
    options: { model?: string; maxTokens?: number; temperature?: number; responseFormat?: any }
  ): Promise<{ provider: AIProvider; providerConfig: ProviderConfig; providerType: AIProviderType; syntheticSessionId: string }> {
    const CHAT_PROVIDERS: AIProviderType[] = ['claude', ...OPENAI_COMPATIBLE_PROVIDER_TYPES, 'lmstudio'];

    // Determine provider from model ID or find first available
    let providerType: AIProviderType | undefined;
    let modelId: string | undefined;

    if (options.model) {
      const parsed = ModelIdentifier.tryParse(options.model);
      if (parsed && CHAT_PROVIDERS.includes(parsed.provider as AIProviderType)) {
        providerType = parsed.provider as AIProviderType;
        modelId = parsed.model;
      } else {
        // Try to find this model across providers
        for (const p of CHAT_PROVIDERS) {
          const models = await ModelRegistry.getModelsForProvider(
            p,
            isOpenAICompatibleProvider(p) ? this.getApiKeyForProvider(p) : undefined,
            p === 'lmstudio'
              ? getConfiguredLMStudioBaseUrl(this.getSettingsStore())
              : isOpenAICompatibleProvider(p)
                ? getConfiguredOpenAICompatibleBaseUrl(this.getSettingsStore(), p)
                : undefined,
            isOpenAICompatibleProvider(p)
              ? this.getOpenAICompatibleModelFilterRegex(p)
              : undefined,
          );
          if (models.some(m => m.id === options.model)) {
            providerType = p;
            modelId = options.model;
            break;
          }
        }
      }
    }

    if (!providerType) {
      // Find first enabled chat provider
      for (const p of CHAT_PROVIDERS) {
        if (this.isProviderEnabledForWorkspace(p)) {
          providerType = p;
          break;
        }
      }
    }

    if (!providerType) {
      throw new Error('No chat provider available. Enable Claude, OpenAI, or LM Studio in Settings > AI.');
    }

    // Get API key
    const apiKey = this.getApiKeyForProvider(providerType);
    if (providerType !== 'lmstudio' && !apiKey) {
      throw new Error(`API key not configured for provider ${providerType}. Configure it in Settings > AI.`);
    }

    // Resolve model
    if (!modelId) {
      const defaultModel = await ModelRegistry.getDefaultModel(providerType);
      const extracted = extractModelForProvider(defaultModel, providerType);
      modelId = extracted || defaultModel;
    }

    const providerConfig: ProviderConfig = {
      apiKey,
      model: modelId,
      maxTokens: options.maxTokens,
      temperature: options.temperature,
      responseFormat: options.responseFormat,
      skipLogging: true,
    };

    // LM Studio needs baseUrl
    if (providerType === 'lmstudio') {
      providerConfig.baseUrl = getConfiguredLMStudioBaseUrl(this.getSettingsStore());
    } else if (isOpenAICompatibleProvider(providerType)) {
      providerConfig.baseUrl = getConfiguredOpenAICompatibleBaseUrl(this.getSettingsStore(), providerType);
      providerConfig.modelFilterRegex = this.getOpenAICompatibleModelFilterRegex(providerType);
    }

    const syntheticSessionId = `ext-completion-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const provider = ProviderFactory.createProvider(providerType, syntheticSessionId);
    await provider.initialize(providerConfig);

    return { provider, providerConfig, providerType, syntheticSessionId };
  }

  /**
   * Convert extension ChatCompletionMessage[] into the format expected by providers:
   * a current user message string and an array of previous Message objects.
   */
  private buildProviderMessages(options: {
    messages: Array<{ role: string; content: string }>;
    systemPrompt?: string;
  }): { currentMessage: string; previousMessages: Message[] } {
    const msgs = [...options.messages];

    // Prepend system prompt as a system message if provided
    if (options.systemPrompt) {
      msgs.unshift({ role: 'system', content: options.systemPrompt });
    }

    if (msgs.length === 0) {
      throw new Error('At least one message is required');
    }

    // The last user message becomes the "current message" argument
    // All previous messages become the messages array
    const lastMessage = msgs[msgs.length - 1];
    const currentMessage = lastMessage.content;

    const previousMessages: Message[] = msgs.slice(0, -1).map(m => ({
      role: m.role as Message['role'],
      content: m.content,
      timestamp: Date.now(),
    }));

    return { currentMessage, previousMessages };
  }

  /**
   * Handle a stateless (non-session) chat completion from an extension.
   */
  private async handleExtensionChatCompletion(
    event: Electron.IpcMainInvokeEvent,
    options: {
      messages: Array<{ role: string; content: string }>;
      model?: string;
      maxTokens?: number;
      temperature?: number;
      systemPrompt?: string;
      responseFormat?: any;
    }
  ): Promise<{ content: string; model: string; usage?: { inputTokens: number; outputTokens: number } }> {
    const { provider, providerConfig, providerType, syntheticSessionId } = await this.resolveExtensionChatProvider(event, options);
    const { currentMessage, previousMessages } = this.buildProviderMessages(options);

    try {
      let fullContent = '';
      let usage: { inputTokens: number; outputTokens: number } | undefined;

      const iterator = provider.sendMessage(
        currentMessage,
        undefined,  // no document context
        syntheticSessionId,
        previousMessages,
      );

      for await (const chunk of iterator) {
        if (chunk.type === 'text' && chunk.content) {
          fullContent += chunk.content;
        } else if (chunk.type === 'error') {
          throw new Error(chunk.error || 'Provider error');
        } else if (chunk.type === 'complete') {
          if (chunk.content) fullContent = chunk.content;
          if (chunk.usage) {
            usage = {
              inputTokens: chunk.usage.input_tokens,
              outputTokens: chunk.usage.output_tokens,
            };
          }
        }
      }

      return {
        content: fullContent,
        model: providerConfig.model || '',
        usage,
      };
    } finally {
      ProviderFactory.destroyProvider(syntheticSessionId, providerType);
    }
  }
}
