/**
 * Streaming message handler for AIService.
 *
 * Extracted from AIService.ts to keep that file manageable. This class owns
 * the full per-message lifecycle: load session, ensure provider, wire provider
 * event listeners, run the streaming loop, handle tool calls, queue chain
 * re-entry on completion, and error recovery.
 *
 * It accesses several internal members of AIService (state Maps, helper methods)
 * via an `AIServiceInternal` cast — this keeps AIService's public API surface
 * unchanged while letting the handler reach into the same shared state it had
 * when it lived inline in `setupIpcHandlers()`.
 */

import { BrowserWindow } from 'electron';
import * as path from 'path';
import {
  ProviderFactory,
  ModelRegistry,
  isAgentProvider,
  onAgentMessageBatch,
  type AIProvider,
  type SessionManager,
} from '@nimbalyst/runtime/ai/server';
import {
  type Message,
  type AIProviderType,
  type SessionData,
  type ToolHandler,
  type ToolResult,
  type ProviderConfig,
  type DocumentContext,
} from '@nimbalyst/runtime/ai/server/types';
import { getSessionStateManager } from '@nimbalyst/runtime/ai/server/SessionStateManager';
import { isBedrockToolSearchError } from '@nimbalyst/runtime/ai/server/utils/errorDetection';
import { parseEffortLevel } from '@nimbalyst/runtime/ai/server/effortLevels';
import type { RawDocumentContext, DocumentContextService } from '@nimbalyst/runtime';
import { AISessionsRepository } from '@nimbalyst/runtime';
import { toolRegistry } from './tools';
import { extractFilePath } from './tools/extractFilePath';
import { SoundNotificationService } from '../SoundNotificationService';
import { notificationService } from '../NotificationService';
import { TrayManager } from '../../tray/TrayManager';
import { logger } from '../../utils/logger';
import { windowStates, findWindowByWorkspace } from '../../window/WindowManager';
import { sessionFileTracker } from '../SessionFileTracker';
import { codexEditWindowRegistry, shouldOpenCodexEditWindow } from '../CodexEditWindowRegistry';
import { toolCallMatcher, unwrapShellCommand } from '../ToolCallMatcher';
import { FeatureUsageService, FEATURES } from '../FeatureUsageService.ts';
import { historyManager } from '../../HistoryManager';
import { addGitignoreBypass } from '../../file/WorkspaceEventBus';
import { getSyncProvider, isDesktopTrulyAway } from '../SyncManager';
import { setSessionPendingPrompt } from './pendingPromptPersistence';
import { getAgentWorkflowService } from '../AgentWorkflowService';
import {
  shouldShowCommunityPopup,
  markCommunityPopupShown,
  wasCommunityPopupShownThisLaunch,
  incrementCompletedSessionsWithTools,
} from '../../utils/store';
import {
  safeSend,
  previewForLog,
  extractModelForProvider,
  bucketMessageLength,
  bucketResponseTime,
  bucketChunkCount,
  bucketContentLength,
  categorizeAIError,
  attachMentionedFiles,
  tagFileBeforeEdit,
  detectConfiguredAIProvider,
  detectNimbalystSlashCommand,
  readFileContentOrNull,
  getFileExtensionForAnalytics,
} from './aiServiceUtils';
import { disableParentNotificationsAfterDirectTakeover } from './childSessionTakeover';
import { installScopedProviderListener } from './providerListenerRegistry';
import type Store from 'electron-store';
import type { AIService } from './AIService';
import type { HooklessAgentFileWatcher } from './HooklessAgentFileWatcher';

export type SendMessageHandler = (
  event: Electron.IpcMainInvokeEvent,
  message: string,
  documentContext?: DocumentContext,
  sessionId?: string,
  workspacePath?: string,
) => Promise<{ content: string }>;

/**
 * Structural view of the AIService members this handler needs. Keeping it
 * declared here (rather than reaching into the AIService class via `private`
 * access) means AIService's class declaration stays untouched — we just cast
 * the injected service reference to this shape internally.
 */
interface AIServiceInternal {
  // Shared state
  sessionManager: SessionManager;
  analytics: { sendEvent(event: string, props?: any): void };
  sendMessageHandler: SendMessageHandler | null;
  processingQueuedPromptIds: Set<string>;
  matchDebounceTimers: Map<string, ReturnType<typeof setTimeout>>;
  sessionsProcessingQueue: Set<string>;
  documentContextService: DocumentContextService;
  hooklessWatcher: HooklessAgentFileWatcher;

  // Helper methods
  getSettingsStore(): Store<Record<string, unknown>>;
  getApiKeyForProvider(provider: string, workspacePath?: string): string | undefined;
  buildClaudeCodeRuntimeConfig(session: SessionData, workspacePath?: string): Promise<ProviderConfig>;
  continueQueuedPromptChain(
    sessionId: string,
    workspacePath: string,
    targetWindow: Electron.BrowserWindow | null,
    source: string,
  ): Promise<void>;
  tryDispatchNextQueuedPrompt(
    sessionId: string,
    workspacePath: string,
    targetWindow: Electron.BrowserWindow | null,
    source: string,
  ): Promise<boolean>;
  runAutoContextCommand(
    session: SessionData,
    workspacePath: string,
    event: Electron.IpcMainInvokeEvent,
  ): Promise<void>;
  createToolHandler(
    webContents: Electron.WebContents,
    documentContext?: DocumentContext,
    sessionId?: string,
    workspaceId?: string,
  ): ToolHandler;
  inferWorktreePathFromFilePath(workspacePath: string, filePath: string): string | null;
  inferWorktreePathFromCommand(command: string | undefined, workspacePath: string): string | null;
  adoptWorktreeForSession(
    session: SessionData,
    worktreePath: string,
    event: Electron.IpcMainInvokeEvent,
  ): Promise<void>;
}

/**
 * Codex `apply_patch` tool args carry per-file change descriptors under
 * `changes: { [path]: { type: 'add'|'update'|'delete'|'move', unified_diff?, move_path? } }`.
 * Returns the entry's type for a given file path, or null if the args don't
 * match the apply_patch shape (e.g. a non-Codex tool).
 */
function extractApplyPatchEntryType(args: any, filePath: string): string | null {
  const changes = args?.changes;
  if (!changes || typeof changes !== 'object' || Array.isArray(changes)) return null;
  const entry = (changes as Record<string, unknown>)[filePath];
  if (!entry || typeof entry !== 'object') return null;
  const type = (entry as { type?: unknown }).type;
  return typeof type === 'string' ? type : null;
}

// Notification listeners outlive the local `session` reference loaded at the top
// of `sendMessage`, and SessionManager.updateSessionTitle creates a new session
// object rather than mutating the existing one. Reading from the DB at notify
// time picks up SessionNamingService renames that happen mid-turn.
async function getCurrentSessionTitle(sessionId: string, fallback = 'AI Session'): Promise<string> {
  try {
    const fresh = await AISessionsRepository.get(sessionId);
    if (fresh?.title) return fresh.title;
  } catch {
    // Ignore - fall back below
  }
  return fallback;
}

// Cache of sessionId -> workspacePath so per-batch broadcast routing doesn't
// hit the DB on every flush. A session's workspace is immutable, so the cache
// never needs invalidation; it grows with the number of distinct sessions
// seen. First lookup for an unknown session pays one AISessionsRepository.get;
// subsequent lookups are O(1).
const sessionWorkspaceCache = new Map<string, string>();

async function getWorkspacePathForSession(sessionId: string): Promise<string | null> {
  const cached = sessionWorkspaceCache.get(sessionId);
  if (cached) return cached;
  try {
    const session = await AISessionsRepository.get(sessionId);
    if (session?.workspacePath) {
      sessionWorkspaceCache.set(sessionId, session.workspacePath);
      return session.workspacePath;
    }
  } catch {
    // Ignore — caller will skip the broadcast.
  }
  return null;
}

export class MessageStreamingHandler {
  private readonly svc: AIServiceInternal;
  private readonly unsubscribeBatchListener: () => void;
  // Per-provider map of event -> currently-installed listener. Used by
  // installListener so handle() can re-wire its own subscriptions on every
  // ai:sendMessage call without nuking listeners owned by other modules.
  // WeakMap so a discarded provider instance is garbage-collected normally.
  private readonly providerListeners = new WeakMap<
    AIProvider,
    Map<string, (...args: any[]) => void>
  >();

  constructor(service: AIService) {
    this.svc = service as unknown as AIServiceInternal;

    // The shared AgentMessageWriteQueue (in BaseAIProvider) coalesces streaming
    // chunk writes to relieve PGLite writer-lock contention. Per-row
    // 'message:logged' is still emitted from BaseAIProvider.logAgentMessage
    // (awaited writes: user input, final output, errors, can_use_tool audit),
    // but the streaming firehose no longer fires per-row. Forward one batch
    // event per flush per session so any window viewing that session can
    // refresh once instead of N times. The queue already excludes hidden rows
    // from the count, so we don't filter again here.
    this.unsubscribeBatchListener = onAgentMessageBatch((batch) => {
      // Route to only the window owning this session's workspace. The previous
      // BrowserWindow.getAllWindows() fan-out caused every window to react to
      // every other window's session activity, which surfaced as
      // [SessionManager] Rejecting session ... rejection logs because the
      // receiving window's renderer would call aiLoadSession with its own
      // workspace path. The session's workspace is immutable, so we cache the
      // lookup. findWindowByWorkspace is rail-aware, so it correctly resolves
      // a window that hosts the session's project as a rail-warm
      // (additionalWorkspacePaths) entry, not just as the active one.
      // See docs/IPC_GUIDE.md "Workspace-Scoped IPC".
      void getWorkspacePathForSession(batch.sessionId).then((workspacePath) => {
        if (!workspacePath) {
          return;
        }
        const targetWindow = findWindowByWorkspace(workspacePath);
        if (targetWindow && !targetWindow.isDestroyed()) {
          targetWindow.webContents.send('ai:messages-logged-batch', {
            ...batch,
            workspacePath,
          });
        }
      });
    });
  }

  /** Used by AIService teardown to unwire the singleton batch listener. */
  destroy(): void {
    this.unsubscribeBatchListener();
  }

  /**
   * Replace the previously-installed listener for this (provider, event) pair
   * without touching listeners owned by other modules. handle() registers its
   * subscriptions on every ai:sendMessage call against the same cached
   * per-session provider instance, so it needs to remove its own prior
   * listener but not the whole event channel (the old removeAllListeners
   * pattern silently dropped any other module that started subscribing).
   */
  private installListener(
    provider: AIProvider,
    event: string,
    listener: (...args: any[]) => void,
  ): void {
    installScopedProviderListener(this.providerListeners, provider, event, listener);
  }

  handle: SendMessageHandler = async (
    event,
    message: string,
    documentContext?: DocumentContext,
    sessionId?: string,
    workspacePath?: string,
  ) => {
    // Check for queued prompt deduplication - prevents duplicate execution from multiple renderer panels
    const queuedPromptId = (documentContext as any)?.queuedPromptId as string | undefined;
    if (queuedPromptId) {
      if (this.svc.processingQueuedPromptIds.has(queuedPromptId)) {
        logger.main.info(`[AIService] SKIPPING duplicate queued prompt: ${queuedPromptId}`);
        return { content: '' }; // Already being processed, return empty response
      }

      // Mark prompt ID as processing
      // Note: session lock is already set in claimQueuedPrompt handler, no need to check here
      this.svc.processingQueuedPromptIds.add(queuedPromptId);
      logger.main.info(`[AIService] Processing queued prompt: ${queuedPromptId}, session: ${sessionId}, total prompts in progress: ${this.svc.processingQueuedPromptIds.size}`);
    }

    // Track prompt submission in feature usage system
    FeatureUsageService.getInstance().recordUsage(FEATURES.AI_PROMPT_SUBMITTED);

    // Extract attachments from documentContext if present
    // Mobile attachments arrive as EncryptedAttachment[] (with encryptedData/iv fields)
    // and need decryption + temp file writing before they can be used as ChatAttachments
    let attachments = (documentContext as any)?.attachments;
    if (attachments && attachments.length > 0 && attachments[0].encryptedData && workspacePath) {
      try {
        const { decryptMobileAttachments } = await import('../SyncManager');
        attachments = await decryptMobileAttachments(attachments, workspacePath, sessionId!);
        logger.main.info(`[AIService] Decrypted ${attachments.length} mobile attachments`);
      } catch (err) {
        logger.main.error('[AIService] Failed to decrypt mobile attachments:', err);
        attachments = undefined;
      }
    }
    const startTime = Date.now();
    const perfLog: any = {
      startTime,
      provider: '',
      model: '',
      messageLength: message.length,
      hasDocumentContext: !!documentContext
    };

    // ALWAYS load session by ID - never use "current" session (causes cross-window issues)
    if (!sessionId) {
      throw new Error('No session ID provided - cannot send message');
    }

    // Get workspace path from window state if not provided
    if (!workspacePath) {
      const windowState = windowStates.get(event.sender.id);
      workspacePath = windowState?.workspacePath || undefined;
    }

    // Require workspace path for AI operations
    if (!workspacePath) {
      throw new Error('No workspace path available - AI operations require an open workspace');
    }

    const loadStartTime = Date.now();
    const session = await this.svc.sessionManager.loadSession(sessionId, workspacePath);
    perfLog.sessionLoadTime = Date.now() - loadStartTime;

    if (!session) {
      throw new Error(`Session ${sessionId} not found`);
    }


    // Verify we got the right session
    if (session.id !== sessionId) {
      console.error(`[AIService] CRITICAL ERROR: Requested session ${sessionId} but got session ${session.id}!`);
      throw new Error(`Session mismatch: requested ${sessionId} but got ${session.id}`);
    }

    const inputType = (documentContext as any)?.inputType as string | undefined;
    if (inputType === 'user' && !queuedPromptId) {
      await this.disableParentNotificationsAfterDirectTakeover(session);
    }

    // CRITICAL: If session has a worktree, use its path instead of workspace path
    // This ensures Claude Code runs in the worktree directory
    let effectiveWorkspacePath = session.worktreePath || workspacePath;

    // For worktree sessions, use the parent project path for permission lookups
    // This is passed through documentContext to avoid changing sendMessage signature
    let permissionsPath = session.worktreeProjectPath || effectiveWorkspacePath;
    if (isAgentProvider(session.provider)) {
      await this.svc.hooklessWatcher.ensureForSession(session.id, effectiveWorkspacePath, event);
    }

    // Comprehensive logging of what we're sending to Claude
    //   hasDocument: !!documentContext,
    //   filePath: documentContext?.filePath || 'none',
    //   fileType: documentContext?.fileType || 'none',
    //   contentLength: documentContext?.content?.length || 0,
    // });

    if (documentContext?.content) {
      //   documentContext.content.substring(0, 500) +
      //   (documentContext.content.length > 500 ? '...' : ''));

      // Check for frontmatter (`\r?\n` tolerates Windows CRLF; nimbalyst#68)
      const frontmatterMatch = documentContext.content.match(/^---\r?\n([\s\S]*?)\r?\n---/);
      if (frontmatterMatch) {
      } else {
      }
    }

    // Show available tools
    const tools = toolRegistry.getAll();
    console.groupEnd();

    perfLog.provider = session.provider;
    perfLog.model = session.model || 'default';

    // Add user message to session (include attachments if present)
    const userMessage: Message = {
      role: 'user',
      content: message,
      timestamp: Date.now(),
      attachments: attachments && attachments.length > 0 ? attachments : undefined,
      mode: documentContext?.mode,
    };
    // logger.main.info(`[AIService] Adding user message to session ${session.id}: "${message.substring(0, 50)}..." (queuedPromptId: ${queuedPromptId || 'none'}, mode: ${documentContext?.mode})`);
    await this.svc.sessionManager.addMessage(userMessage, session.id);
    // logger.main.info(`[AIService] User message added successfully to session ${session.id}`);

    // Update session title if this is the first user message
    if (session.messages.length === 0 || (session.messages.length === 1 && session.messages[0].type === 'user_message')) {
      // Generate a provisional title from the first message without locking out auto-naming
      const title = message.length > 100 ? message.substring(0, 97) + '...' : message;
      await this.svc.sessionManager.updateSessionTitle(session.id, title, {
        force: true,
        markAsNamed: false,
      });

      // Keep session-history UI in sync with provisional title updates without forcing a full refresh.
      for (const window of BrowserWindow.getAllWindows()) {
        if (!window.isDestroyed()) {
          window.webContents.send('sessions:session-updated', session.id, { title });
        }
      }
    }

    // Get or create provider for this session
    const providerStartTime = Date.now();
    const isProviderClaudeCode = session.provider === 'claude-code';

    // if (isProviderClaudeCode) {
    // }

    let provider = ProviderFactory.getProvider(session.provider as AIProviderType, session.id);
    perfLog.getProviderTime = Date.now() - providerStartTime;

    // If provider doesn't exist, create and initialize it
    if (!provider) {
      if (isProviderClaudeCode) {
      }

      // Get the correct API key based on provider
      let apiKey: string | undefined;
      let errorMessage = 'API key not configured';
      let requiresApiKey = true;
      const effectiveWorkspacePath = session.workspacePath || workspacePath;
      apiKey = this.svc.getApiKeyForProvider(session.provider, effectiveWorkspacePath);
      switch (session.provider) {
        case 'claude':
          errorMessage = 'Anthropic API key not configured';
          break;
        case 'claude-code':
          // Claude Code: API key is optional and uses OAuth login when not configured.
          requiresApiKey = false;
          break;
        case 'openai':
          errorMessage = 'OpenAI API key not configured';
          break;
        case 'openai-codex':
          // Codex SDK uses its own auth (codex auth login), API key is optional
          requiresApiKey = false;
          break;
        case 'openai-codex-acp':
          // Codex ACP uses the codex-acp binary's own auth, API key is optional
          requiresApiKey = false;
          break;
        case 'opencode':
          // OpenCode uses its own config, API key is optional
          requiresApiKey = false;
          break;
        case 'copilot-cli':
          // Copilot uses its own CLI auth, no API key needed
          requiresApiKey = false;
          break;
        case 'lmstudio':
          // LMStudio doesn't need an API key, just the base URL
          apiKey = 'not-required'; // Dummy value since LMStudio doesn't need a key
          break;
        default:
          throw new Error(`Unknown provider: ${session.provider}`);
      }

      if (!apiKey && requiresApiKey) {
        throw new Error(errorMessage);
      }

      // Create the provider
      if (isProviderClaudeCode) {
      }
      provider = ProviderFactory.createProvider(session.provider, session.id);

      if (isProviderClaudeCode) {
      }

      const reinitConfig: any = {
        apiKey,
        maxTokens: (session.providerConfig as any)?.maxTokens,
        temperature: (session.providerConfig as any)?.temperature,
        // Pass effort level from session metadata (Opus 4.6 adaptive reasoning)
        ...((session.metadata as any)?.effortLevel && {
          effortLevel: parseEffortLevel((session.metadata as any).effortLevel),
        }),
      };

      // Add baseUrl for LMStudio
      if (session.provider === 'lmstudio') {
        const providerSettings = this.svc.getSettingsStore().get('providerSettings', {}) as any;
        reinitConfig.baseUrl = providerSettings['lmstudio']?.baseUrl || 'http://127.0.0.1:8234';
      }

      // Pass model to provider config for all providers including claude-code
      // Claude Code uses the model field to select variants (opus/sonnet/haiku)
      if (session.model || session.providerConfig?.model) {
        const fullModel = session.model || session.providerConfig?.model;

        if (fullModel) {
          // For claude-code, pass the full model ID (e.g., "claude-code:opus")
          // For other providers, extract the model-only part
          if (isProviderClaudeCode) {
            reinitConfig.model = fullModel;
          } else {
            const modelForProvider = extractModelForProvider(fullModel, session.provider as AIProviderType);
            if (modelForProvider !== null) {
              reinitConfig.model = modelForProvider;
            } else {
              // extractModelForProvider returned null - fall back to default
              const defaultModel = await ModelRegistry.getDefaultModel(session.provider as AIProviderType);
              if (defaultModel) {
                const defaultModelForProvider = extractModelForProvider(defaultModel, session.provider as AIProviderType);
                if (defaultModelForProvider !== null) {
                  reinitConfig.model = defaultModelForProvider;
                  logger.main.info(`[AIService] Fell back to default model "${defaultModel}" for provider ${session.provider}`);
                }
              }
            }
          }
        }
      } else {
        // No model specified - get default
        const defaultModel = await ModelRegistry.getDefaultModel(session.provider as AIProviderType);
        if (defaultModel) {
          if (isProviderClaudeCode) {
            reinitConfig.model = defaultModel;
          } else {
            const defaultModelForProvider = extractModelForProvider(defaultModel, session.provider as AIProviderType);
            if (defaultModelForProvider !== null) {
              reinitConfig.model = defaultModelForProvider;
            }
          }
        }
      }

      if (isProviderClaudeCode) {
        const safeConfig = { ...reinitConfig, apiKey: reinitConfig.apiKey ? '***' : undefined };
      }
      const safeConfig = { ...reinitConfig, apiKey: reinitConfig.apiKey ? '***' : undefined };
      const initStartTime = Date.now();

      try {
        await provider.initialize(reinitConfig);
        perfLog.providerInitTime = Date.now() - initStartTime;

        if (isProviderClaudeCode) {
        }
      } catch (initError: any) {
        if (isProviderClaudeCode) {
          console.error('[CLAUDE-CODE-SERVICE] Failed to initialize provider:', initError);
          console.error('[CLAUDE-CODE-SERVICE] Init config was:', reinitConfig);
        }

        // Add provider initialization error as an assistant message in the conversation
        // This provides better UX than showing a generic "Failed to load session" error
        const errorMessage: Message = {
          role: 'assistant',
          content: `I encountered an error connecting to ${session.provider}:\n\n${initError.message || String(initError)}`,
          timestamp: Date.now()
        };

        await this.svc.sessionManager.addMessage(errorMessage, session.id);

        // Clean up processing state
        if (queuedPromptId) {
          this.svc.processingQueuedPromptIds.delete(queuedPromptId);
        }

        // Return empty response instead of throwing - the error message is now in the conversation
        return { content: '' };
      }

      // CRITICAL: Restore provider session data from database
      // This is essential for session resumption (e.g., Claude Code sessions)
      if (session.providerSessionId && provider.setProviderSessionData) {
        provider.setProviderSessionData(session.id, {
          providerSessionId: session.providerSessionId,
          // Backward-compatible keys for existing providers
          claudeSessionId: session.providerSessionId,
          codexThreadId: session.providerSessionId,
        });
      }

      // Register tool handler - targetFilePath will be determined dynamically per tool call
      const toolHandler = this.svc.createToolHandler(event.sender, documentContext, session.id, effectiveWorkspacePath);
      provider.registerToolHandler(toolHandler);
    }

    // CRITICAL: Restore provider session data unconditionally (even when the provider
    // already exists in the factory cache). The `if (!provider)` block above only runs
    // on first creation, but the provider can outlive its in-memory session ID mapping
    // across Nimbalyst restarts (process restart -> empty map). Running this on every
    // message guarantees `options.resume` is populated.
    if (session.providerSessionId && (provider as any).setProviderSessionData) {
      (provider as any).setProviderSessionData(session.id, {
        providerSessionId: session.providerSessionId,
        claudeSessionId: session.providerSessionId,
        codexThreadId: session.providerSessionId,
      });

      // Fail loud if the restore didn't actually take effect. Prevents us from
      // handing a resumable session to the provider with an empty in-memory map
      // (which would silently start a fresh conversation on the SDK side).
      const restored = (provider as any).getProviderSessionData?.(session.id);
      const restoredId = restored?.providerSessionId ?? restored?.claudeSessionId;
      if (restoredId !== session.providerSessionId) {
        throw new Error(
          `[AIService] Provider session restore failed for session ${session.id}: ` +
          `DB has providerSessionId="${session.providerSessionId}" but provider reports ` +
          `"${restoredId ?? 'undefined'}". Resume would silently start a fresh conversation.`
        );
      }
    }

    // NOTE: No longer tracking provider per-window - each session has its own provider instance

    // Resolve the selected model's context window from the model registry.
    // This is the authoritative source for context window size. We cannot use the SDK's modelUsage
    // because it contains entries for both the parent model AND subagent models (e.g., Haiku 200k),
    // and iteration order is not guaranteed, so we'd intermittently pick up a subagent's smaller window.
    let selectedModelContextWindow: number | undefined;
    const sessionModelId = session.model || session.providerConfig?.model;
    if (sessionModelId) {
      const models = await ModelRegistry.getModelsForProvider(session.provider as AIProviderType);
      selectedModelContextWindow = models.find(m => m.id === sessionModelId)?.contextWindow;
    }

    // Re-register tool handler with the CURRENT document context from this message
    // This ensures applyDiff targets the correct file even when switching tabs
    //   filePath: documentContext?.filePath,
    //   hasContext: !!documentContext
    // });
    const toolHandler = this.svc.createToolHandler(event.sender, documentContext, session.id, effectiveWorkspacePath);
    provider.registerToolHandler(toolHandler);

    // Listen for message:logged events and forward to renderer to trigger UI updates.
    // Skip hidden messages - they shouldn't trigger UI refreshes.
    //
    // Multi-project rail: include the session's workspacePath in the payload
    // so the renderer can route the reload to the correct workspace even
    // when the session is in a project that is not currently visible. The
    // renderer's session registry holds only the visible project's
    // sessions, so it can't always resolve the path on its own.
    const onMessageLogged = (data: { sessionId: string; direction: string; hidden?: boolean }) => {
      if (data.hidden) return;
      safeSend(event, 'ai:message-logged', { ...data, workspacePath: effectiveWorkspacePath });
    };
    // Replace this handler's previous 'message:logged' subscription only,
    // so other modules subscribing to the same provider event stay wired.
    this.installListener(provider, 'message:logged', onMessageLogged);

    // Forward provider-side title updates (from the SDK's generateSessionTitle
    // path) to all renderers so the session list updates in real time.
    // Mirrors the broadcast that SessionNamingService does for the MCP-tool path.
    const onSessionTitleUpdated = (data: { sessionId: string; title: string }) => {
      for (const window of BrowserWindow.getAllWindows()) {
        if (!window.isDestroyed()) {
          window.webContents.send('session:title-updated', data);
        }
      }
    };
    this.installListener(provider, 'session:title-updated', onSessionTitleUpdated);

    // Forward provider-side metadata updates (e.g. tags/phase from the SDK's
    // out-of-band naming side-question and the default-phase fallback) to all
    // renderers AND mobile sync. Mirrors what SessionNamingService does for
    // the MCP-tool path so direct repo writes from the provider do not bypass
    // the kanban refresh and iOS push.
    const onSessionMetadataUpdated = (data: { sessionId: string; metadata: Record<string, unknown> }) => {
      for (const window of BrowserWindow.getAllWindows()) {
        if (!window.isDestroyed()) {
          window.webContents.send('sessions:session-updated', data.sessionId, data.metadata);
        }
      }
      const sp = getSyncProvider();
      if (sp && (data.metadata.phase !== undefined || data.metadata.tags !== undefined)) {
        const syncMeta: Record<string, unknown> = {};
        if (data.metadata.phase !== undefined) syncMeta.phase = data.metadata.phase as string;
        if (data.metadata.tags !== undefined) syncMeta.tags = data.metadata.tags as string[];
        sp.pushChange(data.sessionId, {
          type: 'metadata_updated',
          metadata: syncMeta as any,
        });
      }
    };
    this.installListener(provider, 'session:metadata-updated', onSessionMetadataUpdated);

    // Helper to persist pending-prompt state to ai_sessions.metadata AND
    // push the change to mobile in one call. See pendingPromptPersistence.ts
    // for why we persist locally: the in-memory atom can desync from reality
    // if a resolve event is missed (renderer reload, HMR, late delivery),
    // and the only recovery is rehydrating from the DB on next list refresh.
    const syncPendingPrompt = (sessionId: string, hasPendingPrompt: boolean) => {
      void setSessionPendingPrompt(sessionId, hasPendingPrompt);
    };

    // Listen for ExitPlanMode confirmation requests and forward to renderer
    const onExitPlanModeConfirm = async (data: { requestId: string; sessionId: string; planSummary: string; timestamp: number }) => {
      logger.main.info('[AIService] ExitPlanMode confirmation requested:', data.requestId);
      safeSend(event, 'ai:exitPlanModeConfirm', { ...data, workspacePath: effectiveWorkspacePath });
      syncPendingPrompt(data.sessionId, true);
      TrayManager.getInstance().onPromptCreated(data.sessionId);

      // Update session status so all windows show the pending indicator
      getSessionStateManager().updateActivity({
        sessionId: data.sessionId,
        status: 'waiting_for_input',
      }).catch((err) => {
        logger.main.error('[AIService] Failed to update session status to waiting_for_input:', err);
      });

      // Show OS notification if app is backgrounded
      const sessionTitle = await getCurrentSessionTitle(data.sessionId);
      notificationService.showBlockedNotification(
        data.sessionId,
        sessionTitle,
        'plan_approval',
        effectiveWorkspacePath
      );
    };
    this.installListener(provider, 'exitPlanMode:confirm', onExitPlanModeConfirm);

    // Listen for ExitPlanMode resolutions (approve/deny) and flip session
    // status back to 'running' so SessionStateManager emits session:streaming
    // for every subscribed window. Required for the "Continued Planning"
    // denial path in the multi-project rail: without this, state stays at
    // waiting_for_input and the AGENT panel's "Thinking…" indicator does
    // not re-appear when the SDK resumes streaming. Mirrors the
    // askUserQuestion:answered and toolPermission:resolved patterns above.
    const onExitPlanModeResolved = (data: {
      requestId: string;
      sessionId: string;
      approved: boolean;
      respondedBy?: 'desktop' | 'mobile';
      timestamp: number;
    }) => {
      logger.main.info('[AIService] ExitPlanMode resolved:', data.requestId, 'approved=', data.approved);
      syncPendingPrompt(data.sessionId, false);
      TrayManager.getInstance().onPromptResolved(data.sessionId);

      getSessionStateManager().updateActivity({
        sessionId: data.sessionId,
        status: 'running',
        isStreaming: true,
      }).catch((err) => {
        logger.main.error('[AIService] Failed to update session status to running after ExitPlanMode resolve:', err);
      });
    };
    this.installListener(provider, 'exitPlanMode:resolved', onExitPlanModeResolved);

    // Listen for AskUserQuestion requests and forward to renderer
    const onAskUserQuestion = async (data: { questionId: string; sessionId: string; questions: any[]; timestamp: number }) => {
      // logger.main.info('[AIService] AskUserQuestion requested:', data.questionId);
      safeSend(event, 'ai:askUserQuestion', { ...data, workspacePath: effectiveWorkspacePath });
      syncPendingPrompt(data.sessionId, true);
      TrayManager.getInstance().onPromptCreated(data.sessionId);

      // Update session status to waiting_for_input so all windows show the pending indicator
      getSessionStateManager().updateActivity({
        sessionId: data.sessionId,
        status: 'waiting_for_input',
      }).catch((err) => {
        logger.main.error('[AIService] Failed to update session status to waiting_for_input:', err);
      });

      // Show OS notification if app is backgrounded
      const sessionTitle = await getCurrentSessionTitle(data.sessionId);
      notificationService.showBlockedNotification(
        data.sessionId,
        sessionTitle,
        'question',
        effectiveWorkspacePath
      );
    };
    this.installListener(provider, 'askUserQuestion:pending', onAskUserQuestion);

    // Listen for AskUserQuestion answers and forward to renderer to update tool call display
    const onAskUserQuestionAnswered = (data: { questionId: string; sessionId: string; questions: any[]; answers: Record<string, string>; timestamp: number }) => {
      // logger.main.info('[AIService] AskUserQuestion answered:', data.questionId);
      safeSend(event, 'ai:askUserQuestionAnswered', { ...data, workspacePath: effectiveWorkspacePath });
      syncPendingPrompt(data.sessionId, false);
      TrayManager.getInstance().onPromptResolved(data.sessionId);

      // Update session status back to running so all windows clear the pending indicator
      getSessionStateManager().updateActivity({
        sessionId: data.sessionId,
        status: 'running',
        isStreaming: true,
      }).catch(() => {});
    };
    this.installListener(provider, 'askUserQuestion:answered', onAskUserQuestionAnswered);

    // Listen for tool permission requests and forward to renderer
    const onToolPermissionPending = async (data: { requestId: string; sessionId: string; workspacePath: string; request: any; timestamp: number }) => {
      logger.main.info('[AIService] Tool permission requested:', data.requestId);
      safeSend(event, 'ai:toolPermission', data);
      syncPendingPrompt(data.sessionId, true);
      TrayManager.getInstance().onPromptCreated(data.sessionId);

      // Update session status so all windows show the pending indicator
      getSessionStateManager().updateActivity({
        sessionId: data.sessionId,
        status: 'waiting_for_input',
      }).catch((err) => {
        logger.main.error('[AIService] Failed to update session status to waiting_for_input:', err);
      });

      // Play permission request sound (don't block on async title lookup)
      const soundService = SoundNotificationService.getInstance();
      soundService.playPermissionSound(data.workspacePath);

      // Show OS notification if app is backgrounded
      const sessionTitle = await getCurrentSessionTitle(data.sessionId);
      notificationService.showBlockedNotification(
        data.sessionId,
        sessionTitle,
        'permission',
        data.workspacePath
      );
    };
    this.installListener(provider, 'toolPermission:pending', onToolPermissionPending);

    // Listen for tool permission resolved and forward to renderer
    const onToolPermissionResolved = (data: { requestId: string; sessionId: string; response: any; timestamp: number }) => {
      logger.main.info('[AIService] Tool permission resolved:', data.requestId);
      safeSend(event, 'ai:toolPermissionResolved', { ...data, workspacePath: effectiveWorkspacePath });
      syncPendingPrompt(data.sessionId, false);
      TrayManager.getInstance().onPromptResolved(data.sessionId);

      // Update session status back to running so all windows clear the pending indicator
      getSessionStateManager().updateActivity({
        sessionId: data.sessionId,
        status: 'running',
        isStreaming: true,
      }).catch(() => {});
    };
    this.installListener(provider, 'toolPermission:resolved', onToolPermissionResolved);

    // Listen for prompt additions and forward to renderer for debug display
    const onPromptAdditions = (data: {
      sessionId: string;
      systemPromptAddition: string | null;
      userMessageAddition: string | null;
      attachments?: Array<{ type: string; filename: string; mimeType?: string; filepath?: string }>;
      timestamp: number;
    }) => {
      safeSend(event, 'ai:promptAdditions', data);
    };
    this.installListener(provider, 'promptAdditions', onPromptAdditions);

    // Listen for expired session events and clear the providerSessionId from database
    // This ensures subsequent messages start fresh even after app restart
    const onProviderSessionExpired = async (data: { sessionId: string }) => {
      logger.main.info(`[AIService] Provider session expired for ${data.sessionId}, clearing providerSessionId from database`);
      try {
        await this.svc.sessionManager.updateProviderSessionData(data.sessionId, undefined);
      } catch (error) {
        logger.main.error('[AIService] Failed to clear expired providerSessionId:', error);
      }
    };
    this.installListener(provider, 'session:providerSessionExpired', onProviderSessionExpired);

    // Listen for provider session ID received and persist immediately
    // This ensures session can be resumed even if interrupted/cancelled
    const onProviderSessionReceived = async (data: { sessionId: string; providerSessionId: string }) => {
      try {
        await this.svc.sessionManager.updateProviderSessionData(data.sessionId, data.providerSessionId);
      } catch (error) {
        logger.main.error('[AIService] Failed to persist providerSessionId:', error);
      }
    };
    this.installListener(provider, 'session:providerSessionReceived', onProviderSessionReceived);

    // Listen for teammate messages when the lead is idle (no active query).
    // When the lead is active, messages are delivered via interrupt + streamInput
    // inside ClaudeCodeProvider.sendMessage(). This handler covers the idle case
    // by triggering a new sendMessage call with the teammate's message.
    const onTeammateMessageWhileIdle = async (data: {
      sessionId: string;
      message: string;
    }) => {
      if (!data.sessionId) {
        logger.main.warn('[AIService] teammate:messageWhileIdle with no sessionId');
        return;
      }
      // Guard: don't trigger sendMessage if session was already ended
      // (e.g., all teammates completed between message queue and this handler)
      const sessionStateManager = getSessionStateManager();
      if (!sessionStateManager.isSessionActive(data.sessionId)) {
        logger.main.info(`[AIService] Ignoring teammate message for ended session ${data.sessionId}`);
        return;
      }
      logger.main.info(`[AIService] Teammate message while lead idle, triggering sendMessage for session ${data.sessionId}`);
      try {
        // Ensure the session is marked as running so the UI shows the stop button.
        // sendMessageHandler also calls startSession, but there can be a gap between
        // the setImmediate and when that runs. Re-calling startSession is safe (idempotent).
        await sessionStateManager.startSession({
          sessionId: data.sessionId,
          workspacePath: effectiveWorkspacePath,
        });

        const targetWindow = findWindowByWorkspace(effectiveWorkspacePath);
        if (targetWindow && !targetWindow.isDestroyed()) {
          // Create a mock event and call sendMessage directly
          const mockEvent = {
            sender: targetWindow.webContents,
            senderFrame: targetWindow.webContents.mainFrame,
          } as Electron.IpcMainInvokeEvent;

          if (this.svc.sendMessageHandler) {
            // Fire-and-forget: sendMessage will stream results to the renderer
            setImmediate(async () => {
              try {
                await this.svc.sendMessageHandler!(mockEvent, data.message, {} as any, data.sessionId, effectiveWorkspacePath);
              } catch (err) {
                logger.main.error('[AIService] Failed to process teammate message while idle:', err);
              }
            });
          }
        }
      } catch (error) {
        logger.main.error('[AIService] Failed to handle teammate message while idle:', error);
      }
    };
    this.installListener(provider, 'teammate:messageWhileIdle', onTeammateMessageWhileIdle);

    // Listen for all teammates completing. When the lead finished but teammates
    // were still active, endSession was deferred. Now that all teammates are
    // done, end the session and play the completion sound.
    const onTeammatesAllCompleted = async (data: { sessionId: string }) => {
      if (!data.sessionId) return;
      // Only end the session if it's still tracked as active (lead deferred ending)
      if (stateManager.isSessionActive(data.sessionId)) {
        // Don't end the session if the lead is currently processing or about to
        // process a message. The lead's sendMessage completion will handle endSession.
        // This prevents a race where teammates:allCompleted fires while the lead's
        // resumed CLI subprocess is still spawning (can take 10+ seconds).
        const isLeadBusy = typeof (provider as any).isLeadBusy === 'function'
          && (provider as any).isLeadBusy();
        if (isLeadBusy) {
          logger.main.info(`[AIService] All teammates completed for ${data.sessionId}, but lead is busy — deferring endSession to sendMessage completion`);
          return;
        }

        logger.main.info(`[AIService] All teammates completed for session ${data.sessionId}, ending deferred session`);
        await stateManager.endSession(data.sessionId);
        // Stop file watcher - session is fully complete (teammates done)
        await this.svc.hooklessWatcher.stopForSession(data.sessionId);
        codexEditWindowRegistry.clearSession(data.sessionId);

        // Play completion sound now that the session is truly done
        const soundService = SoundNotificationService.getInstance();
        soundService.playCompletionSound(workspacePath);
      }
    };
    this.installListener(provider, 'teammates:allCompleted', onTeammatesAllCompleted);

    // Track user @ mentions in the message
    try {
      await sessionFileTracker.trackUserMessage(
        session.id,
        effectiveWorkspacePath,
        message,
        session.messages.length // Current message index
      );
      // Notify renderer that files were tracked (if message had @ mentions)
      if (message.includes('@')) {
        safeSend(event, 'session-files:updated', session.id);
      }
    } catch (error) {
      logger.main.warn('[AIService] Failed to track user @ mentions:', error);
    }

    // Track ai_message_sent analytics event
    const slashCommandInfo = detectNimbalystSlashCommand(message, effectiveWorkspacePath);
    const contentMode = (documentContext as any)?.contentMode;
    const fileExtension = getFileExtensionForAnalytics(documentContext?.filePath);
    this.svc.analytics.sendEvent('ai_message_sent', {
      provider: session.provider,
      hasDocumentContext: !!documentContext,
      hasAttachments: !!(attachments && attachments.length > 0),
      attachmentCount: attachments?.length || 0,
      messageLength: bucketMessageLength(message.length),
      contentMode: contentMode || 'unknown',
      // Include session mode (planning/agent) when available
      ...(session.mode && { sessionMode: session.mode }),
      // Include file extension when document context is present
      ...(fileExtension && { fileExtension }),
      // Slash command tracking - only included if a Nimbalyst package command was used
      ...(slashCommandInfo && {
        usedSlashCommand: true,
        slashCommandName: slashCommandInfo.commandName,
        slashCommandPackageId: slashCommandInfo.packageId,
      }),
    });

    // Mark session as running/active
    const stateManager = getSessionStateManager();
    await stateManager.startSession({
      sessionId: session.id,
      workspacePath: session.workspacePath || effectiveWorkspacePath,
    });

    // Mark session as executing for mobile sync (shows "Running" indicator)
    const syncProvider = getSyncProvider();
    if (syncProvider) {
      syncProvider.pushChange(session.id, {
        type: 'metadata_updated',
        metadata: { isExecuting: true } as any,
      });
    }

    try {
      let fullResponse = '';
      let lastTextSection = '';  // Track text after the last tool call (for notifications)
      let prevTextSection = '';  // Previous non-empty text section (fallback if last section is empty)
      const toolCalls: any[] = [];
      const edits: any[] = [];  // Track edits for the assistant message
      let hasStreamingContent = false;  // Track if we used streamContent tool
      let hadError = false;  // Track if an error occurred during the stream
      let firstChunkTime: number | undefined;
      let chunkCount = 0;
      let textChunks = 0;
      let toolCallCount = 0;
      const processedBashCommandItemIds = new Set<string>();
      const bashCommandOccurrences = new Map<string, number>();
      const pendingBashCommands = new Map<string, string>();

      // Get existing messages from session for context
      const sessionMessages = session.messages || [];

      const streamStartTime = Date.now();

      // Send performance metrics to renderer
      safeSend(event, 'ai:performanceMetrics', {
        phase: 'start',
        provider: session.provider,
        model: session.model || 'default',
        messageLength: message.length,
        contextMessages: sessionMessages.length
      });

      // Stream the response
      const isClaudeCode = session.provider === 'claude-code';
      const logPrefix = isClaudeCode ? '[CLAUDE-CODE-SERVICE]' : '[AIService]';

      if (isClaudeCode) {
        // Refresh provider config every turn so auth/key changes in settings apply immediately.
        const refreshedConfig = await this.svc.buildClaudeCodeRuntimeConfig(session, effectiveWorkspacePath);
        await provider.initialize(refreshedConfig);

        //   messageLength: message.length,
        //   hasContext: !!documentContext,
        //   sessionId: session.id,
        //   sessionMessages: sessionMessages.length,
        //   workspacePath
        // }, null, 2));

        // Session naming is now handled automatically via MCP URL parameters
        // No need to configure per-session context
      } else {
        // Refresh credentials every turn for all providers so key changes in settings apply immediately.
        const freshApiKey = this.svc.getApiKeyForProvider(session.provider, effectiveWorkspacePath);
        await provider.initialize({
          apiKey: freshApiKey,
          maxTokens: (session.providerConfig as any)?.maxTokens,
          temperature: (session.providerConfig as any)?.temperature,
          ...((session.metadata as any)?.effortLevel && {
            effortLevel: parseEffortLevel((session.metadata as any).effortLevel),
          }),
        });
      }

      // Attach @ mentioned files for non-agent providers
      const { enhancedMessage, attachedFiles } = await attachMentionedFiles(message, workspacePath, provider);
      const messageToSend = enhancedMessage;

      if (attachedFiles.length > 0) {
        logger.main.info(`[AIService] Attached ${attachedFiles.length} files via @ mentions`, {
          files: attachedFiles.map(f => ({ path: f.path, size: f.size }))
        });
      }

      // Prepare document context using the service (handles transition detection, diff computation, etc.)
      const rawContext: RawDocumentContext | undefined = documentContext ? {
        filePath: documentContext.filePath,
        fileType: documentContext.fileType,
        content: documentContext.content || '',
        cursorPosition: documentContext.cursorPosition,
        selection: documentContext.selection,
        textSelection: documentContext.textSelection,
        textSelectionTimestamp: documentContext.textSelectionTimestamp,
        mockupSelection: (documentContext as any).mockupSelection,
        mockupDrawing: (documentContext as any).mockupDrawing,
      } : undefined;

      const { documentContext: preparedContext, userMessageAdditions } = this.svc.documentContextService.prepareContext(
        rawContext,
        session.id,
        session.provider as AIProviderType,
        undefined // No mode transition for now - will be added when integrating with SessionTranscript
      );

      // Merge prepared document context with session metadata
      const effectiveMode = documentContext?.mode ?? session.mode;

      const contextWithSession: DocumentContext = {
        // Document fields from prepared context
        filePath: preparedContext.filePath,
        fileType: preparedContext.fileType,
        content: preparedContext.content,  // Omitted when transition is 'none' (content unchanged)
        documentDiff: preparedContext.documentDiff,
        documentTransition: preparedContext.documentTransition,
        previousFilePath: preparedContext.previousFilePath,

        // Selection fields
        textSelection: preparedContext.textSelection,

        // Legacy fields (keep for backward compatibility)
        selection: documentContext?.selection,
        textSelectionTimestamp: documentContext?.textSelectionTimestamp,
        cursorPosition: documentContext?.cursorPosition,

        // Session metadata
        sessionType: documentContext?.sessionType ?? session.sessionType,
        mode: effectiveMode,
        permissionsPath,  // For worktree sessions, this is the parent project path
        mcpConfigWorkspacePath: session.worktreeProjectPath || effectiveWorkspacePath,  // Use parent project for MCP config lookup
        attachments,

        // Worktree context
        worktreeId: session.worktreeId,
        worktreePath: session.worktreePath,
        worktreeProjectPath: session.worktreeProjectPath,

        // Branch tracking for session forking
        branchedFromSessionId: session.branchedFromSessionId,
        branchedFromProviderSessionId: session.branchedFromProviderSessionId,

        // Pre-built prompts from DocumentContextService (for user message additions)
        documentContextPrompt: userMessageAdditions.documentContextPrompt,
        editingInstructions: userMessageAdditions.editingInstructions,

        // Origin of this message (e.g. 'wakeup_resume' for ScheduleWakeup-triggered prompts).
        // The transcript parser uses this to render wakeup resumes as a system marker
        // instead of a user-lane message.
        promptOrigin: documentContext?.promptOrigin,
      };

      // Update MCP document state for Claude Code provider so it knows which tools to show
      // Always update with workspacePath, even if no file is open, so global-scoped tools are available
      if (isClaudeCode && effectiveWorkspacePath) {
        const { updateDocumentState, registerWorkspaceWindow } = await import('../../mcp/httpServer');
        updateDocumentState({
          filePath: contextWithSession?.filePath,
          workspacePath: effectiveWorkspacePath,
          fileType: contextWithSession?.fileType
        }, session.id);

        // Also register the workspace->window mapping so MCP tools can route to the correct window
        const { BrowserWindow } = await import('electron');
        const window = BrowserWindow.fromWebContents(event.sender);
        if (window) {
          registerWorkspaceWindow(effectiveWorkspacePath, window.id);
        }
      }

      // Start file snapshot cache + watcher for agentic sessions (diff support)
      // Only start once per session; persists across turns
      if (isAgentProvider(session.provider)
        && effectiveWorkspacePath
      ) {
        try {
          await this.svc.hooklessWatcher.ensureForSession(session.id, effectiveWorkspacePath, event);
        } catch (watcherError) {
          logger.main.error('[AIService] Failed to start Codex file cache:', watcherError);
        }
      }

      if (session.provider === 'openai-codex' && effectiveWorkspacePath) {
        try {
          await getAgentWorkflowService(effectiveWorkspacePath).ensureCodexExports();
        } catch (workflowError) {
          logger.main.error('[AIService] Failed to sync Codex workflow exports:', workflowError);
        }
      }

      for await (const chunk of provider.sendMessage(messageToSend, contextWithSession, session.id, sessionMessages, effectiveWorkspacePath, attachments)) {
        if (!chunk) continue;
        chunkCount++;

        if (!firstChunkTime) {
          firstChunkTime = Date.now();
          perfLog.timeToFirstChunk = firstChunkTime - startTime;

          // Send first chunk metrics
          safeSend(event, 'ai:performanceMetrics', {
            phase: 'firstChunk',
            timeToFirstChunk: perfLog.timeToFirstChunk
          });
        }
        switch (chunk.type) {
          case 'text':
            textChunks++;
            const chunkContent = chunk.content || '';
            fullResponse += chunkContent;
            lastTextSection += chunkContent;  // Accumulate for notification (reset on tool calls)

            // Update activity to indicate streaming
            if (textChunks === 1) {
              await stateManager.updateActivity({
                sessionId: session.id,
                isStreaming: true
              });
            }
            // if (isClaudeCode && textChunks <= 5) {
            // }
            // Send ACCUMULATED response to renderer (not just the chunk)
            safeSend(event, 'ai:streamResponse', {
              sessionId: session.id,
              partial: fullResponse,  // Send the full accumulated text
              isComplete: false
            });
            break;

          case 'pre_edit_snapshot':
            // OpenAICodexProvider yields this on the first `item.started`
            // observation of a `file_change` -- BEFORE Codex applies the
            // patch on disk. The chunk carries each affected path's true
            // pre-edit content, read from disk at the right moment. We
            // write it as a local-history pre-edit tag so the diff
            // renderer always has a real baseline (gitignored files,
            // never-cached files, post-boot-created files all included).
            // This replaces the watcher/cache/recoverBaseline fallback
            // that previously ran at item.completed and produced
            // empty-baseline diffs for any path the cache hadn't seen.
            if (chunk.preEditSnapshot) {
              const { toolUseId, entries, authoritative } = chunk.preEditSnapshot;

              // Worktree adoption: any change path may live under a
              // worktree the session hasn't adopted yet. Adopt before
              // writing tags so they land in the correct workspace
              // history.
              for (const entry of entries) {
                if (!entry?.path) continue;
                const absPath = path.isAbsolute(entry.path)
                  ? path.normalize(entry.path)
                  : path.resolve(effectiveWorkspacePath, entry.path);
                const inferredWorktreePath = this.svc.inferWorktreePathFromFilePath(workspacePath, absPath);
                if (inferredWorktreePath) {
                  await this.svc.adoptWorktreeForSession(session, inferredWorktreePath, event);
                  effectiveWorkspacePath = session.worktreePath || effectiveWorkspacePath;
                  permissionsPath = session.worktreeProjectPath || permissionsPath;
                  break;
                }
              }

              // Baseline source policy (per-transport):
              // - SDK transport (authoritative === undefined/false): the
              //   provider's disk-read at item.started races with Codex's
              //   apply_patch, so for 'update' kinds we prefer
              //   FileSnapshotCache (session-start snapshot, guaranteed
              //   pre-edit). For 'add', the provider already forces empty.
              // - App-server transport (authoritative === true): the
              //   provider reverse-applies the codex diff against post-apply
              //   disk content to recover pre-edit deterministically. That
              //   content is authoritative; the cache lookup must NOT
              //   override it (on fresh gitignored sessions chokidar may
              //   only have observed the post-edit write, which would
              //   clobber correct content with the post-edit body -- the
              //   all-green diff regression the migration was built to fix).
              const watcherEntryForBaseline = authoritative
                ? null
                : this.svc.hooklessWatcher.getEntry(session.id);
              for (const entry of entries) {
                if (!entry?.path) continue;
                const absPath = path.isAbsolute(entry.path)
                  ? path.normalize(entry.path)
                  : path.resolve(effectiveWorkspacePath, entry.path);
                addGitignoreBypass(effectiveWorkspacePath, absPath);
                const tagId = `ai-edit-pending-${session.id}-${toolUseId}`;

                let baselineContent: string = entry.content ?? '';
                const isAddKind = entry.kind === 'add' || entry.kind === 'create' || entry.kind === 'new';
                if (!authoritative && !isAddKind && watcherEntryForBaseline) {
                  try {
                    const cached = await watcherEntryForBaseline.cache.getBeforeState(absPath);
                    if (typeof cached === 'string') {
                      baselineContent = cached;
                    }
                  } catch {
                    // Cache miss / cache error -- fall through to disk-read content.
                  }
                }

                try {
                  // replaceSpeculative: this is the authoritative
                  // pre-edit baseline source for Codex `file_change` --
                  // FileSnapshotCache is the primary source (captured at
                  // session start, guaranteed pre-edit) with disk read as
                  // fallback. Override any tag the bash-watcher /
                  // workspace-watcher paths may have written speculatively
                  // earlier this turn (their attribution can mis-score a
                  // recent `sed` command higher than the still-being-stored
                  // file_change in the same chokidar tick).
                  await historyManager.createTag(
                    effectiveWorkspacePath,
                    absPath,
                    tagId,
                    baselineContent,
                    session.id,
                    toolUseId,
                    { replaceSpeculative: true },
                  );
                  await sessionFileTracker.trackToolExecution(
                    session.id,
                    effectiveWorkspacePath,
                    'file_change',
                    { changes: [{ path: absPath, kind: entry.kind ?? 'update' }] },
                    undefined,
                    toolUseId,
                    null,
                  );
                } catch (preEditError) {
                  const errorStr = String(preEditError);
                  if (
                    !errorStr.includes('unique') &&
                    !errorStr.includes('UNIQUE') &&
                    !errorStr.includes('duplicate')
                  ) {
                    logger.ai.error(
                      '[AIService] pre_edit_snapshot tag write failed',
                      preEditError,
                    );
                  }
                }
              }
            }
            break;

          case 'post_edit_snapshot':
            // OpenAICodexProvider yields this on `item.completed` for a
            // `file_change` -- AFTER Codex has applied the patch on disk. The
            // chunk carries each affected path's post-edit content. We write
            // it as an `ai-edit` history snapshot tagged with the session ID
            // so session-aware diffs can render pre-edit -> post-edit even
            // after the user later modifies the file (current-disk
            // comparison would otherwise conflate AI and user changes).
            // This is the codex analogue of Claude's
            // AgentToolHooks.createTurnEndSnapshots, which the codex
            // pipeline doesn't go through.
            if (chunk.postEditSnapshot) {
              const { toolUseId, entries } = chunk.postEditSnapshot;
              for (const entry of entries) {
                if (!entry?.path) continue;
                const absPath = path.isAbsolute(entry.path)
                  ? path.normalize(entry.path)
                  : path.resolve(effectiveWorkspacePath, entry.path);
                try {
                  await historyManager.createSnapshot(
                    absPath,
                    entry.content,
                    'ai-edit',
                    `AI edit (session: ${session.id})`,
                    { sessionId: session.id, toolUseId },
                  );
                } catch (postEditError) {
                  logger.ai.error(
                    '[AIService] post_edit_snapshot ai-edit write failed',
                    postEditError,
                  );
                }
              }
            }
            break;

          case 'tool_call':
            if (chunk.toolCall) {
              toolCallCount++;
              toolCalls.push(chunk.toolCall);
              if (lastTextSection.trim()) prevTextSection = lastTextSection.trim();
              lastTextSection = '';  // Reset so notification shows text after last tool call
              console.groupEnd();

              // Track file interactions for all tool calls
              // Also attach file watchers for edited files to detect subsequent changes
              // Note: Codex command_execution events have arguments=undefined (command is in name),
              // so we cannot guard on chunk.toolCall.arguments being truthy.
              if (effectiveWorkspacePath) {
                try {
                  // Get window from event sender to enable file watcher attachment
                  const window = BrowserWindow.fromWebContents(event.sender);

                  // Normalize Codex command_execution tool names to 'Bash' so the
                  // tracker's existing shell-command file extraction logic applies.
                  // Codex emits these with the raw command as the tool name (e.g. "/bin/zsh -lc ls").
                  // Unwrap the shell wrapper to get the inner command for file path extraction.
                  let trackToolName = chunk.toolCall.name;
                  let trackArgs = chunk.toolCall.arguments;
                  if (trackToolName === 'command_execution' && typeof trackArgs?.command === 'string') {
                    trackToolName = 'Bash';
                  } else if (/^\/(?:bin|usr\/bin)\//.test(trackToolName) || /\/(?:bash|zsh|sh)\b/.test(trackToolName) || /(?:powershell|pwsh|cmd)(?:\.exe)?\b/i.test(trackToolName)) {
                    trackArgs = { command: unwrapShellCommand(trackToolName) };
                    trackToolName = 'Bash';
                  }

                  if (trackToolName === 'Bash' && typeof trackArgs?.command === 'string') {
                    const inferredWorktreePath = this.svc.inferWorktreePathFromCommand(trackArgs.command, workspacePath);
                    if (inferredWorktreePath) {
                      await this.svc.adoptWorktreeForSession(session, inferredWorktreePath, event);
                      effectiveWorkspacePath = session.worktreePath || effectiveWorkspacePath;
                      permissionsPath = session.worktreeProjectPath || permissionsPath;
                    }
                  }

                  // Codex reuses raw item IDs (e.g. `item_0`) across turns, so we
                  // never persist them as toolUseId directly. The provider stamps
                  // a stable synthetic edit-group ID on the chunk via toolUseId
                  // (`nimtc|<encoded>|<ts>|<idx>`), matching what CodexRawParser
                  // mints on later reparse. Use that for ALL Codex tool calls --
                  // not just `file_change` -- so file edits caused by other
                  // write-capable tools attribute to the same edit group.
                  const chunkSyntheticToolUseId =
                    typeof (chunk.toolCall as any)?.toolUseId === 'string'
                      ? ((chunk.toolCall as any).toolUseId as string)
                      : undefined;
                  const isCodexProvider = session.provider === 'openai-codex';
                  const providerToolUseId = isCodexProvider
                    ? chunkSyntheticToolUseId
                    : (chunkSyntheticToolUseId ?? (typeof chunk.toolCall.id === 'string' ? chunk.toolCall.id : undefined));
                  const toolUseId = providerToolUseId;

                  // Open / close a Codex edit attribution window for write-capable
                  // tool calls. Watcher events that fire while a window is open
                  // (or within a short post-close grace period) attribute to the
                  // canonical synthetic edit-group ID instead of falling back to
                  // ToolCallMatcher's fuzzy time heuristics. We deliberately
                  // exclude command_execution per the Phase 2 scope decision.
                  if (isCodexProvider && chunkSyntheticToolUseId && shouldOpenCodexEditWindow(chunk.toolCall.name)) {
                    let codexTargetFilePath: string | null = null;
                    const argsRecord = chunk.toolCall.arguments as Record<string, unknown> | undefined;
                    if (argsRecord) {
                      if (typeof argsRecord.file_path === 'string') codexTargetFilePath = argsRecord.file_path;
                      else if (typeof argsRecord.path === 'string') codexTargetFilePath = argsRecord.path;
                    }
                    codexEditWindowRegistry.open({
                      sessionId: session.id,
                      editGroupId: chunkSyntheticToolUseId,
                      toolName: chunk.toolCall.name,
                      workspacePath: effectiveWorkspacePath,
                      targetFilePath: codexTargetFilePath,
                    });
                    // A tool_call carrying a result is terminal -- close the
                    // window so attribution stops claiming new watcher events
                    // after the post-close grace period elapses.
                    const hasResult = chunk.toolCall.result !== undefined && chunk.toolCall.result !== null;
                    if (hasResult) {
                      const resultObj = chunk.toolCall.result as Record<string, unknown> | string | undefined;
                      const looksError = typeof resultObj === 'object' && resultObj !== null
                        && (('success' in resultObj && (resultObj as Record<string, unknown>).success === false)
                          || 'error' in resultObj);
                      codexEditWindowRegistry.close(
                        chunkSyntheticToolUseId,
                        looksError ? 'error' : 'completed',
                      );
                    }
                  }

                  await sessionFileTracker.trackToolExecution(
                    session.id,
                    effectiveWorkspacePath,
                    trackToolName,
                    trackArgs,
                    chunk.toolCall.result,
                    toolUseId,
                    window  // Pass window to enable file watcher attachment for edited files
                  );

                  // Create pre-edit tags for OpenCode file-editing tools.
                  // OpenCode emits tool_call with status='running' BEFORE the file is modified,
                  // so we can snapshot the current disk content as the before-state.
                  // Tool names: edit, write, create (with filePath in arguments)
                  // Codex ACP emits the same shape via writeTextFile pre-edit hooks plus
                  // session/tool_call events for Edit/Write tools. The tool name list is
                  // kept separate per provider to avoid cross-talk if vocabularies diverge.
                  const OPENCODE_EDIT_TOOLS = ['edit', 'write', 'create'];
                  const CODEX_ACP_EDIT_TOOLS = ['Edit', 'Write', 'ApplyPatch', 'edit', 'write', 'apply_patch'];
                  const isOpenCodeEdit = OPENCODE_EDIT_TOOLS.includes(trackToolName) && session.provider === 'opencode';
                  const isCodexAcpEdit = CODEX_ACP_EDIT_TOOLS.includes(trackToolName) && session.provider === 'openai-codex-acp';
                  if (isOpenCodeEdit || isCodexAcpEdit) {
                    const editFilePath = extractFilePath(trackArgs);
                    const watcherEntry = this.svc.hooklessWatcher.getEntry(session.id);
                    // Only create the pre-edit tag for paths inside the workspace —
                    // OpenCode occasionally hands back paths the model invented outside
                    // the workspace (e.g. `/foo.txt`), and the diff workflow only needs
                    // to track edits to files we're actually watching.
                    const isInWorkspace = editFilePath
                      ? path.resolve(editFilePath).startsWith(path.resolve(effectiveWorkspacePath) + path.sep)
                      : false;
                    if (editFilePath && watcherEntry && isInWorkspace) {
                      try {
                        // Codex ApplyPatch is unique: by the time the ACP tool_call event
                        // arrives, Codex has already written the file. So both the
                        // FileSnapshotCache and disk read return the *post*-write content,
                        // not the baseline. For type:'add' (new file) we know the baseline
                        // is empty by definition -- force it so the diff renders correctly.
                        // (For type:'update' the true baseline would require reverse-applying
                        // the unified_diff; not handled here yet.)
                        const codexApplyPatchType = isCodexAcpEdit && trackToolName === 'ApplyPatch'
                          ? extractApplyPatchEntryType(trackArgs, editFilePath)
                          : null;

                        let beforeContent: string;
                        if (codexApplyPatchType === 'add') {
                          beforeContent = '';
                        } else {
                          let cached = await watcherEntry.cache.getBeforeState(editFilePath);
                          if (cached === null) {
                            // File not in cache -- read from disk (file hasn't been modified yet
                            // because OpenCode sends running state before executing the tool)
                            cached = await readFileContentOrNull(editFilePath) ?? '';
                          }
                          beforeContent = cached;
                        }
                        const editToolUseId = toolUseId || `${session.provider}-edit-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
                        const tagId = `ai-edit-pending-${session.id}-${editToolUseId}`;
                        // OpenCode / Codex-ACP edit tools fire on the
                        // `running` status of the actual write tool, so
                        // this is the authoritative pre-edit moment for
                        // their attribution -- override any speculative
                        // bash-watcher tag written earlier this turn.
                        await historyManager.createTag(
                          effectiveWorkspacePath,
                          editFilePath,
                          tagId,
                          beforeContent,
                          session.id,
                          editToolUseId,
                          { replaceSpeculative: true },
                        );
                      } catch (preEditError) {
                        const errorStr = String(preEditError);
                        if (!errorStr.includes('unique') && !errorStr.includes('UNIQUE') && !errorStr.includes('duplicate')) {
                          logger.ai.error(`[AIService] Failed to create pre-edit tag for ${session.provider} edit:`, preEditError);
                        }
                      }
                    }
                  }

                  // Fallback for Bash edits in ignored/unwatched paths.
                  // Codex emits both item.started and item.completed for command_execution;
                  // run fallback on the second occurrence (usually completed) so we diff
                  // against post-command file content.
                  if (trackToolName === 'Bash' && typeof trackArgs?.command === 'string') {
                    const commandItemId = typeof chunk.toolCall.id === 'string'
                      ? chunk.toolCall.id
                      : `${trackArgs.command.slice(0, 200)}:${toolCallCount}`;
                    const seenCount = (bashCommandOccurrences.get(commandItemId) ?? 0) + 1;
                    bashCommandOccurrences.set(commandItemId, seenCount);
                    pendingBashCommands.set(commandItemId, trackArgs.command);

                    // First observation == item.started: capture each
                    // referenced file's current disk content into the cache
                    // BEFORE the bash command runs. This is the only
                    // deterministic moment to record a true pre-edit baseline
                    // for command_execution. Without it, item.completed below
                    // would compare post-command disk content against a
                    // tier-2 git-`startSha` baseline, falsely attributing
                    // read-only commands (`sed -n`, `cat`, `nl`) on
                    // working-tree-modified files as edits.
                    if (seenCount === 1) {
                      try {
                        await this.svc.hooklessWatcher.captureBashPreEditSnapshots(
                          session.id,
                          workspacePath,
                          trackArgs.command,
                        );
                      } catch (snapshotError) {
                        logger.ai.warn('[AIService] Failed to seed bash pre-edit snapshots:', snapshotError);
                      }
                    }

                    if (seenCount >= 2 && !processedBashCommandItemIds.has(commandItemId)) {
                      const tracked = await this.svc.hooklessWatcher.trackBashEditsFromCommand(
                        session,
                        workspacePath,
                        trackArgs.command,
                        commandItemId
                      );
                      if (tracked) {
                        processedBashCommandItemIds.add(commandItemId);
                      }
                    }
                  }

                  // Notify renderer that files were tracked
                  safeSend(event, 'session-files:updated', session.id);

                  // Schedule debounced tool call matching so file edits are linked
                  // to tool calls promptly during the session, not just at the end.
                  const existingTimer = this.svc.matchDebounceTimers.get(session.id);
                  if (existingTimer) clearTimeout(existingTimer);
                  this.svc.matchDebounceTimers.set(session.id, setTimeout(() => {
                    this.svc.matchDebounceTimers.delete(session.id);
                    toolCallMatcher.matchSession(session.id).then(count => {
                      if (count > 0) {
                        safeSend(event, 'session-files:updated', session.id);
                      }
                    }).catch(() => {
                      // Non-critical - end-of-session matching will retry
                    });
                  }, 1000));
                } catch (trackError) {
                  console.error('[AIService] Failed to track tool call:', trackError);
                }
              }

              const toolName = chunk.toolCall.name;
              const toolArgs = chunk.toolCall.arguments as Record<string, unknown> | undefined;
              const replacementCount = Array.isArray((toolArgs as any)?.replacements)
                ? (toolArgs as any).replacements.length
                : undefined;
              // logger.ai.info('[AIService] Tool call received', {
              //   name: toolName,
              //   replacements: replacementCount,
              //   argKeys: toolArgs ? Object.keys(toolArgs) : []
              // });

              if (toolName === 'applyDiff' && (replacementCount === undefined || replacementCount === 0)) {
                const rawArgs = toolArgs ? JSON.stringify(toolArgs) : 'null';
                logger.ai.warn('[AIService] applyDiff payload missing replacements', previewForLog(rawArgs));
              }

              // file_change handling moved to the `pre_edit_snapshot` chunk
              // (yielded by OpenAICodexProvider on item.started, before Codex
              // applies the patch). That handler does worktree adoption,
              // gitignore bypass, history-tag creation, and session_files
              // tracking with the real pre-edit baseline -- no watcher,
              // no cache, no recoverBaseline fallback. By the time this
              // tool_call arrives at item.completed, the diff record is
              // already correctly populated.

              // Agent providers (claude-code, codex, opencode) render tool calls
              // through the canonical transcript pipeline. The legacy addMessage +
              // streamResponse toolCalls path below is only for chat providers
              // (claude, openai, lmstudio) that don't have canonical transcripts.
              // Running both paths creates duplicate tool call entries.
              if (!isAgentProvider(session.provider)) {
                // Save tool call as a separate message in the session
                const toolResult = chunk.toolCall.result as any;
                const isFailedResult = toolResult?.success === false;

                if (!isFailedResult) {
                  const toolMessage: Message = {
                    role: 'tool',
                    content: '',  // Tool messages don't have text content
                    timestamp: Date.now(),
                    toolCall: {
                      ...chunk.toolCall,
                      arguments: chunk.toolCall.arguments as Record<string, unknown> | undefined,
                      result: chunk.toolCall.result as string | ToolResult | undefined
                    },
                    ...(toolResult !== undefined ? { errorMessage: toolResult?.error, isError: toolResult?.success === false } : {})
                  };
                  await this.svc.sessionManager.addMessage(toolMessage, session.id);
                }

                // Send tool call to renderer
                // For applyDiff (including MCP variants), include it as BOTH an edit AND a toolCall
                if (toolName === 'applyDiff' || toolName?.endsWith('__applyDiff')) {
                  // Create pre-edit tag BEFORE applying diff (for non-agentic providers)
                  // This enables diff visualization and persistence across app restarts
                  if (documentContext?.filePath) {
                    const toolUseId = chunk.toolCall.id || `diff-${Date.now()}`;
                    await tagFileBeforeEdit(effectiveWorkspacePath, documentContext.filePath, session.id, toolUseId);
                  }

                  const edit = {
                    type: 'diff',
                    replacements: (chunk.toolCall.arguments as any)?.replacements,
                    // MCP edits are applied automatically by the MCP server
                    applied: toolName?.endsWith('__applyDiff')
                  };
                  edits.push(edit);  // Save edit for the assistant message

                  if (!Array.isArray(edit.replacements) || edit.replacements.length === 0) {
                    logger.ai.warn('[AIService] Forwarding applyDiff edit without replacements');
                  } else {
                    logger.ai.info('[AIService] Forwarding applyDiff edit', {
                      count: edit.replacements.length
                    });
                  }

                  safeSend(event, 'ai:streamResponse', {
                    sessionId: session.id,
                    partial: '',
                    isComplete: false,
                    edits: [edit],
                    toolCalls: [chunk.toolCall]  // Also send as toolCall so it displays in chat
                  });
                } else if (chunk.toolCall.name === 'streamContent') {
                  // Mark that we used streamContent AND track the tool call
                  hasStreamingContent = true;
                  toolCallCount++;
                  toolCalls.push(chunk.toolCall);
                  // Send to renderer so it displays in chat transcript
                  safeSend(event, 'ai:streamResponse', {
                    sessionId: session.id,
                    partial: '',
                    isComplete: false,
                    toolCalls: [chunk.toolCall]
                  });
                } else {
                  // For other tools, just send the tool call
                  safeSend(event, 'ai:streamResponse', {
                    sessionId: session.id,
                    partial: '',
                    isComplete: false,
                    toolCalls: [chunk.toolCall]
                  });
                }
              }
            }
            break;

          case 'tool_error':
            if (chunk.toolError) {
              logger.ai.warn('[AIService] Tool error reported', {
                name: chunk.toolError.name,
                error: chunk.toolError.error
              });

              const errorMessage: Message = {
                role: 'tool',
                content: '',
                timestamp: Date.now(),
                toolCall: {
                  name: chunk.toolError.name,
                  arguments: chunk.toolError.arguments as Record<string, unknown> | undefined,
                  result: chunk.toolError.result as string | ToolResult | undefined
                },
                isError: true,
                errorMessage: chunk.toolError.error
              };
              await this.svc.sessionManager.addMessage(errorMessage, session.id);

              safeSend(event, 'ai:streamResponse', {
                sessionId: session.id,
                partial: '',
                isComplete: false,
                toolError: chunk.toolError
              });
            }
            break;

          case 'stream_edit_start':
            // Create pre-edit tag BEFORE streaming content (for non-agentic providers)
            // This enables diff visualization and persistence across app restarts
            if (documentContext?.filePath && session.provider !== 'claude-code') {
              // Generate a tool use ID based on session and timestamp
              const streamToolUseId = `stream-${Date.now()}`;
              await tagFileBeforeEdit(effectiveWorkspacePath, documentContext.filePath, session.id, streamToolUseId);
            }

            // Forward streaming edit start event to renderer
            // Include targetFilePath so renderer knows which file to edit
            safeSend(event, 'ai:streamEditStart', {
              sessionId: session.id,
              targetFilePath: documentContext?.filePath,
              ...(chunk.config as Record<string, unknown> || {})
            });
            hasStreamingContent = true;  // Mark that we're doing streaming
            break;

          case 'stream_edit_content':
            // Forward streaming content to renderer
            safeSend(event, 'ai:streamEditContent', {
              sessionId: session.id,
              content: chunk.content
            });
            break;

          case 'stream_edit_end':
            // Forward streaming end event to renderer
            safeSend(event, 'ai:streamEditEnd', {
              sessionId: session.id,
              ...(chunk.error ? { error: chunk.error } : {})
            });

            // Track the streamContent file interaction
            // Also attach file watcher for the edited file
            if (documentContext?.filePath && effectiveWorkspacePath) {
              try {
                // Get window from event sender to enable file watcher attachment
                const window = BrowserWindow.fromWebContents(event.sender);
                await sessionFileTracker.trackToolExecution(
                  session.id,
                  effectiveWorkspacePath,
                  'streamContent',
                  { file_path: documentContext.filePath },
                  { success: !chunk.error },
                  undefined,
                  window  // Pass window to enable file watcher attachment for edited files
                );
                // Notify renderer that files were tracked
                safeSend(event, 'session-files:updated', session.id);
              } catch (trackError) {
                console.error('[AIService] Failed to track streamContent:', trackError);
              }
            }
            break;

          case 'error':
            hadError = true;  // Mark that an error occurred to skip auto /context
            if (isClaudeCode) {
              console.error('[CLAUDE-CODE-SERVICE] ERROR FROM PROVIDER:', chunk.error || 'Unknown error');
              console.error('[CLAUDE-CODE-SERVICE] Error context:', {
                chunksSoFar: chunkCount,
                textChunksSoFar: textChunks,
                responseLengthSoFar: fullResponse.length,
                timeElapsed: Date.now() - startTime,
                isAuthError: chunk.isAuthError || false
              });
            }
            console.error(`${logPrefix} Provider error:`, chunk.error || 'Unknown error');

            // Track stream interruption due to error. errorCategory lets us
            // split resume_mismatch / stream_closed / auth / ... instead of
            // lumping every Claude Code failure into a single bucket.
            this.svc.analytics.sendEvent('ai_stream_interrupted', {
              provider: session.provider,
              chunksReceived: chunkCount,
              reason: 'error',
              errorCategory: categorizeAIError(chunk.error),
            });

            // Detect Bedrock tool search error even if runtime didn't flag it
            const errorMsg = chunk.error || 'Unknown error occurred';
            const isBedrockToolError = chunk.isBedrockToolError || isBedrockToolSearchError(errorMsg);
            const isServerError = chunk.isServerError || false;

            safeSend(event, 'ai:error', {
              sessionId: session.id,
              message: errorMsg,
              isAuthError: chunk.isAuthError || false,
              isBedrockToolError,
              isServerError,
              isCodexAuthRequired: chunk.isCodexAuthRequired || false,
            });
            break;

          case 'complete':
            // if (isClaudeCode) {
            // }
            perfLog.totalTime = Date.now() - startTime;
            perfLog.streamTime = Date.now() - streamStartTime;
            perfLog.chunkCount = chunkCount;
            perfLog.textChunks = textChunks;
            perfLog.toolCallCount = toolCallCount;
            perfLog.responseLength = fullResponse.length;

            // Capture token usage if available
            const tokenUsage = chunk.usage;
            // Capture modelUsage for claude-code provider (provides per-model breakdown with input/output tokens)
            const modelUsage = chunk.modelUsage;
            // Context fill from last assistant message (actual tokens in context window)
            const contextFillTokens: number | undefined = chunk.contextFillTokens;
            // Context window for providers that emit per-turn context snapshots (e.g., OpenAI Codex)
            const contextWindowFromChunk: number | undefined = chunk.contextWindow;
            // Whether context was compacted this turn (clear stale currentContext)
            const contextCompacted: boolean = chunk.contextCompacted === true;

            // if (tokenUsage) {
            // }
            // if (modelUsage) {
            // }
            // if (fullResponse) {
            //   logger.ai.info('[AIService] Assistant final response', {
            //     length: fullResponse.length,
            //     preview: previewForLog(fullResponse)
            //   });
            // } else {
            //   logger.ai.info('[AIService] Assistant response empty', {
            //     edits: edits.length,
            //     streamed: hasStreamingContent,
            //     toolCalls: toolCallCount
            //   });
            // }
            // if (edits.length > 0) {
            //   logger.ai.info('[AIService] Collected edits', {
            //     editCount: edits.length,
            //     replacementCounts: edits.map(edit => Array.isArray(edit.replacements) ? edit.replacements.length : 0)
            //   });
            // }

            // Send completion metrics with token usage if available
            safeSend(event, 'ai:performanceMetrics', {
              phase: 'complete',
              totalTime: perfLog.totalTime,
              streamTime: perfLog.streamTime,
              chunkCount: chunkCount,
              textChunks: textChunks,
              toolCallCount: toolCallCount,
              responseLength: fullResponse.length,
              ...(tokenUsage && { tokenUsage })
            });

            // Track ai_response_received analytics event
            const hasError = false; // If we got here, no error occurred
            const responseType = toolCallCount > 0 ? 'tool_use' : 'text';
            const toolsUsed = toolCalls.map(tc => tc.name).filter((name, index, self) => self.indexOf(name) === index);
            const usedChartTool = toolsUsed.some(name => name === 'display_chart' || name === 'mcp__nimbalyst__display_chart');

            this.svc.analytics.sendEvent('ai_response_received', {
              provider: session.provider,
              responseType,
              toolsUsed,
              usedChartTool,
              responseTime: bucketResponseTime(perfLog.totalTime),
              chunkCount: bucketChunkCount(chunkCount),
              totalLength: bucketContentLength(fullResponse.length)
            });

            // Update session token usage if available
            // For claude-code: use modelUsage for cumulative tokens and contextWindow
            // For other providers: use tokenUsage from chunk.usage
            if (session.provider === 'claude-code' && modelUsage) {
              // For claude-code, accumulate tokens from modelUsage (SDK provides per-model breakdown)
              const currentUsage = session.tokenUsage ?? {
                inputTokens: 0,
                outputTokens: 0,
                totalTokens: 0
              };

              // Sum up tokens from all models in modelUsage.
              // Note: modelUsage tokens are CUMULATIVE across all steps (for billing).
              // For context window display, use contextFillTokens from last assistant message.
              let newInputTokens = 0;
              let newOutputTokens = 0;
              let newCostUSD = 0;
              for (const modelName of Object.keys(modelUsage)) {
                const modelStats = modelUsage[modelName];
                newInputTokens += modelStats.inputTokens || 0;
                newOutputTokens += modelStats.outputTokens || 0;
                newCostUSD += modelStats.costUSD || 0;
              }

              // Use the selected model's context window (resolved from model registry at session start).
              // modelUsage from the SDK contains entries for both the parent model AND subagent models
              // (e.g., Haiku 200k), and iteration order is not guaranteed, so extracting contextWindow
              // from modelUsage would intermittently pick up a subagent's smaller window.
              const contextWindowForDisplay = selectedModelContextWindow || currentUsage.contextWindow;

              const updatedUsage: NonNullable<SessionData['tokenUsage']> = {
                inputTokens: currentUsage.inputTokens + newInputTokens,
                outputTokens: currentUsage.outputTokens + newOutputTokens,
                totalTokens: currentUsage.totalTokens + newInputTokens + newOutputTokens,
                costUSD: (currentUsage.costUSD || 0) + newCostUSD,
                contextWindow: contextWindowForDisplay,
                // contextFillTokens = input + cacheRead + cacheCreation from last assistant message
                // This is the actual context fill, not cumulative - updates correctly after compaction
                // After compaction, clear stale currentContext (next real turn will set accurate value)
                currentContext: contextCompacted
                  ? undefined
                  : (contextFillTokens !== undefined && contextWindowForDisplay)
                    ? { tokens: contextFillTokens, contextWindow: contextWindowForDisplay }
                    : currentUsage.currentContext,
              };

              await this.svc.sessionManager.updateSessionTokenUsage(session.id, updatedUsage);

              // Send IPC event to update UI immediately
              safeSend(event, 'ai:tokenUsageUpdated', {
                sessionId: session.id,
                tokenUsage: updatedUsage
              });

              // Push context usage to mobile sync
              if (contextFillTokens !== undefined && contextWindowForDisplay) {
                const syncProvider = getSyncProvider();
                if (syncProvider) {
                  syncProvider.pushChange(session.id, {
                    type: 'metadata_updated',
                    metadata: {
                      currentContext: {
                        tokens: contextFillTokens,
                        contextWindow: contextWindowForDisplay,
                      },
                    } as any,
                  });
                }
              }

              // Update local session reference for next iteration
              session.tokenUsage = updatedUsage;
            } else if (tokenUsage && session.provider !== 'claude-code') {
              // For non-claude-code providers, use tokenUsage from chunk
              const currentUsage = session.tokenUsage ?? {
                inputTokens: 0,
                outputTokens: 0,
                totalTokens: 0
              };

              // Calculate new tokens for this message
              const newInputTokens = (tokenUsage.input_tokens || 0);
              const newOutputTokens = tokenUsage.output_tokens || 0;
              const newTotalTokens = newInputTokens + newOutputTokens;
              const isCodexProvider = session.provider === 'openai-codex';
              const codexInitData = isCodexProvider ? (provider as any).getInitData?.() : null;
              const isResumedCodexThread = codexInitData?.isResumedThread === true;

              const codexContextWindow =
                isCodexProvider
                  ? (contextWindowFromChunk || currentUsage.contextWindow)
                  : currentUsage.contextWindow;

              // Codex SDK turn.completed usage is cumulative for the provider thread.
              // Convert to per-session deltas using the last seen cumulative snapshot.
              let nextInputTokens = currentUsage.inputTokens + newInputTokens;
              let nextOutputTokens = currentUsage.outputTokens + newOutputTokens;
              let nextTotalTokens = currentUsage.totalTokens + newTotalTokens;
              let providerCumulativeInputTokens = currentUsage.providerCumulativeInputTokens;
              let providerCumulativeOutputTokens = currentUsage.providerCumulativeOutputTokens;

              if (isCodexProvider) {
                const cumulativeInput = tokenUsage.input_tokens ?? 0;
                const cumulativeOutput = tokenUsage.output_tokens ?? 0;

                const previousCumulativeInput =
                  typeof currentUsage.providerCumulativeInputTokens === 'number'
                    ? currentUsage.providerCumulativeInputTokens
                    : currentUsage.inputTokens > 0
                      ? currentUsage.inputTokens
                      : undefined;
                const previousCumulativeOutput =
                  typeof currentUsage.providerCumulativeOutputTokens === 'number'
                    ? currentUsage.providerCumulativeOutputTokens
                    : currentUsage.outputTokens > 0
                      ? currentUsage.outputTokens
                      : undefined;

                const hasPreviousCumulative =
                  typeof previousCumulativeInput === 'number' &&
                  typeof previousCumulativeOutput === 'number';

                const deltaInput = hasPreviousCumulative
                  ? Math.max(cumulativeInput - previousCumulativeInput, 0)
                  : (isResumedCodexThread ? 0 : cumulativeInput);
                const deltaOutput = hasPreviousCumulative
                  ? Math.max(cumulativeOutput - previousCumulativeOutput, 0)
                  : (isResumedCodexThread ? 0 : cumulativeOutput);

                nextInputTokens = currentUsage.inputTokens + deltaInput;
                nextOutputTokens = currentUsage.outputTokens + deltaOutput;
                nextTotalTokens = currentUsage.totalTokens + deltaInput + deltaOutput;
                providerCumulativeInputTokens = cumulativeInput;
                providerCumulativeOutputTokens = cumulativeOutput;
              }

              const updatedUsage: NonNullable<SessionData['tokenUsage']> = {
                inputTokens: nextInputTokens,
                outputTokens: nextOutputTokens,
                totalTokens: isCodexProvider
                  ? nextTotalTokens
                  : currentUsage.totalTokens + newTotalTokens,
                ...(isCodexProvider ? {
                  providerCumulativeInputTokens,
                  providerCumulativeOutputTokens,
                } : {}),
                contextWindow: codexContextWindow,
                currentContext:
                  isCodexProvider && !contextCompacted
                    ? (contextFillTokens !== undefined && codexContextWindow
                      ? { tokens: contextFillTokens, contextWindow: codexContextWindow }
                      : currentUsage.currentContext)
                    : currentUsage.currentContext,
              };

              await this.svc.sessionManager.updateSessionTokenUsage(session.id, updatedUsage);

              // Send IPC event to update UI immediately
              safeSend(event, 'ai:tokenUsageUpdated', {
                sessionId: session.id,
                tokenUsage: updatedUsage
              });

              // Push context usage to mobile sync for Codex sessions
              if (isCodexProvider && contextFillTokens !== undefined && codexContextWindow) {
                const syncProvider = getSyncProvider();
                if (syncProvider) {
                  syncProvider.pushChange(session.id, {
                    type: 'metadata_updated',
                    metadata: {
                      currentContext: {
                        tokens: contextFillTokens,
                        contextWindow: codexContextWindow,
                      },
                    } as any,
                  });
                }
              }

              // Update local session reference for next iteration
              session.tokenUsage = updatedUsage;
            }

            // Only add assistant message if there's actual content or edits
            if (fullResponse && fullResponse.trim() !== '') {
              const assistantMessage: Message = {
                role: 'assistant',
                content: fullResponse,
                timestamp: Date.now(),
                ...(edits.length > 0 && { edits }),  // Include edits if any
                // CRITICAL: Don't include tokenUsage from chunk.usage for claude-code provider
                // Token usage for claude-code comes ONLY from /context command below
                ...(tokenUsage && session.provider !== 'claude-code' && { tokenUsage })
              };
              await this.svc.sessionManager.addMessage(assistantMessage, session.id);
            } else if (edits.length > 0) {
              // If there were edits but no text response
              const assistantMessage: Message = {
                role: 'assistant',
                content: '',  // Empty content since the action was just edits
                timestamp: Date.now(),
                edits,
                // CRITICAL: Don't include tokenUsage from chunk.usage for claude-code provider
                // Token usage for claude-code comes ONLY from /context command below
                ...(tokenUsage && session.provider !== 'claude-code' && { tokenUsage })
              };
              await this.svc.sessionManager.addMessage(assistantMessage, session.id);
            } else if (hasStreamingContent) {
              // If we used streamContent, add a message to track it
              const assistantMessage: Message = {
                role: 'assistant',
                content: '',  // Content was streamed directly to editor
                timestamp: Date.now(),
                isStreamingStatus: true,
                streamingData: {
                  position: 'document',
                  mode: 'after',
                  content: '[Content streamed to editor]',
                  isActive: false
                },
                // CRITICAL: Don't include tokenUsage from chunk.usage for claude-code provider
                // Token usage for claude-code comes ONLY from /context command below
                ...(tokenUsage && session.provider !== 'claude-code' && { tokenUsage })
              };
              await this.svc.sessionManager.addMessage(assistantMessage, session.id);
            } else if (toolCalls.length > 0) {
              // If there were only other tool calls and no text
              const assistantMessage: Message = {
                role: 'assistant',
                content: '[Tool calls executed]',
                timestamp: Date.now(),
                // CRITICAL: Don't include tokenUsage from chunk.usage for claude-code provider
                // Token usage for claude-code comes ONLY from /context command below
                ...(tokenUsage && session.provider !== 'claude-code' && { tokenUsage })
              };
              await this.svc.sessionManager.addMessage(assistantMessage, session.id);
            }

            // Update provider session data if available (redundant safety net)
            // NOTE: providerSessionId is now saved immediately when received via session:providerSessionReceived event
            // This completion-time save is kept as a fallback in case the early save was missed
            if (provider.getProviderSessionData) {
              const providerData = provider.getProviderSessionData(session.id);
              const providerSessionId =
                providerData?.providerSessionId ||
                providerData?.claudeSessionId ||
                providerData?.codexThreadId;
              if (providerSessionId) {
                await this.svc.sessionManager.updateProviderSessionData(session.id, providerSessionId);
              }
            }

            // Track Claude Code session initialization if this is the first message
            if (session.provider === 'claude-code' && session.messages.length === 0) {
              const initData = (provider as any).getInitData?.();
              if (initData) {
                const configuredProvider = detectConfiguredAIProvider();
                this.svc.analytics.sendEvent('claude_code_session_started', {
                  mcpServerCount: initData.mcpServerCount,
                  slashCommandCount: initData.slashCommandCount,
                  agentCount: initData.agentCount,
                  skillCount: initData.skillCount,
                  pluginCount: initData.pluginCount,
                  toolCount: initData.toolCount,
                  helperMethod: initData.helperMethod,
                  ...(configuredProvider && { configuredProvider })
                });
              }
            }

            // Track Codex session initialization if this is the first message
            if (session.provider === 'openai-codex' && session.messages.length === 0) {
              const initData = (provider as any).getInitData?.();
              if (initData) {
                this.svc.analytics.sendEvent('codex_session_started', {
                  model: initData.model,
                  mcpServerCount: initData.mcpServerCount,
                  isResumedThread: initData.isResumedThread,
                  ...(initData.permissionMode && { permissionMode: initData.permissionMode })
                });
              }
            }

            // Send complete response
            safeSend(event, 'ai:streamResponse', {
              sessionId: session.id,
              content: fullResponse,
              lastTextSection: lastTextSection.trim() || prevTextSection,
              isComplete: true,
              autoContextPending: session.provider === 'claude-code'
            });

            // Mark session as complete so UI shows agent is ready.
            // Skip if teammates are still active OR if the lead will resume
            // after this query completes (e.g., pending teammate messages).
            // NOTE: Use willResumeAfterCompletion() here, NOT isLeadBusy().
            // isLeadBusy() checks leadQuery which is still set at this point
            // (we're inside the generator's for-await, before the finally block
            // clears it). willResumeAfterCompletion() only checks the pending
            // re-trigger flag.
            const hasTeammates = session.provider === 'claude-code'
              && typeof (provider as any).hasActiveTeammates === 'function'
              && (provider as any).hasActiveTeammates();
            const willResume = session.provider === 'claude-code'
              && typeof (provider as any).willResumeAfterCompletion === 'function'
              && (provider as any).willResumeAfterCompletion();
            const queuedChainAlreadyActive = this.svc.sessionsProcessingQueue.has(session.id);
            let queuedContinuationScheduled = false;
            if (!hasTeammates && !willResume && !queuedChainAlreadyActive) {
              queuedContinuationScheduled = await this.svc.tryDispatchNextQueuedPrompt(
                session.id,
                workspacePath,
                BrowserWindow.fromWebContents(event.sender),
                'completion-handler queue',
              );
            }
            if (hasTeammates || willResume || queuedChainAlreadyActive || queuedContinuationScheduled) {
              const reason = hasTeammates
                ? 'teammates still active'
                : willResume
                ? 'lead resuming'
                : queuedChainAlreadyActive
                ? 'queued continuation already active'
                : 'queued continuation scheduled';
              // logger.main.info(`[AIService] Deferring endSession for ${session.id} - ${reason}`);
            } else {
              await stateManager.endSession(session.id);
              // Stop file watcher after a brief delay to let pending
              // watcher events drain through WorkspaceFileEditAttributionService.
              // The manager cancels the scheduled stop if a new turn starts
              // before the timer fires.
              this.svc.hooklessWatcher.scheduleStop(session.id, 500);

              // Play completion sound if enabled
              const soundService = SoundNotificationService.getInstance();
              soundService.playCompletionSound(workspacePath);

              // Show OS notification if enabled and window not focused
              // Use lastTextSection (text after last tool call) for more relevant notification content
              const notificationText = lastTextSection.trim() || prevTextSection || fullResponse;
              const notificationBody = notificationText.length > 0
                ? notificationText.substring(0, 100) + (notificationText.length > 100 ? '...' : '')
                : 'Response complete';
              const sessionLabel = session.title || session.provider;

              // logger.ai.info('[AIService] Notification content', {
              //   sessionId: session.id,
              //   lastTextPreview: previewForLog(lastTextSection.trim()),
              //   prevTextPreview: previewForLog(prevTextSection),
              //   fullResponsePreview: previewForLog(fullResponse),
              //   selectedSource: lastTextSection.trim()
              //     ? 'lastTextSection'
              //     : prevTextSection
              //     ? 'prevTextSection'
              //     : 'fullResponse',
              // });

              await notificationService.showNotification({
                title: `${sessionLabel} -- Response Ready`,
                body: notificationBody,
                sessionId: session.id,
                workspacePath: workspacePath,
                provider: session.provider
              });

              // Request mobile push notification for agent completion.
              // Only send when user has truly left their computer (screen locked or idle
              // past threshold). When the window is merely unfocused (user in another app),
              // the Electron notification above already covers it -- sending a mobile push
              // too causes duplicates via iPhone Mirroring / Continuity.
              if (syncProvider && isDesktopTrulyAway()) {
                syncProvider.requestMobilePush?.(
                  session.id,
                  session.title || 'AI Session',
                  notificationBody
                );
              }

              // Track session completion in feature usage system
              FeatureUsageService.getInstance().recordUsage(FEATURES.SESSION_COMPLETED);
              if (!hadError && toolCallCount > 0) {
                FeatureUsageService.getInstance().recordUsage(FEATURES.SESSION_COMPLETED_WITH_TOOLS);
              }

              // Show community popup after 3 completed sessions that used tools.
              if (!hadError && toolCallCount > 0) {
                const count = incrementCompletedSessionsWithTools();
                if (count === 3 && shouldShowCommunityPopup() && !wasCommunityPopupShownThisLaunch()) {
                  const senderWindow = BrowserWindow.fromWebContents(event.sender);
                  if (senderWindow && !senderWindow.isDestroyed()) {
                    setTimeout(() => {
                      if (senderWindow.isDestroyed() || wasCommunityPopupShownThisLaunch()) {
                        return;
                      }
                      senderWindow.webContents.send('show-discord-invitation');
                      markCommunityPopupShown();
                    }, 2000);
                  }
                }
              }

              // AUTO-FETCH CONTEXT USAGE: Previously used /context command to get token usage.
              // Now context window data comes from modelUsage in the result chunk (set above),
              // so /context is no longer needed. The SDK's /context command no longer returns
              // parseable output as of agent-sdk 0.2.x.
              // Kept as commented code for reference in case /context is restored in a future SDK version.
              // if (session.provider === 'claude-code' && !hadError) {
              //   autoContextPromise = this.svc.runAutoContextCommand(session, effectiveWorkspacePath, event);
              // }
            }

            // Match file edits to tool calls now that all messages are flushed.
            // Cancel any pending incremental match timer - we'll do a final pass now.
            const pendingMatchTimer = this.svc.matchDebounceTimers.get(session.id);
            if (pendingMatchTimer) {
              clearTimeout(pendingMatchTimer);
              this.svc.matchDebounceTimers.delete(session.id);
            }
            // Delay briefly to let non-blocking message writes complete.
            if (effectiveWorkspacePath) {
              const matchSessionId = session.id;
              setTimeout(() => {
                toolCallMatcher.matchSession(matchSessionId).then(count => {
                  if (count > 0) {
                    safeSend(event, 'session-files:updated', matchSessionId);
                  }
                }).catch(err =>
                  logger.main.error(`[AIService] Tool call matching failed for session ${matchSessionId}:`, err)
                );
              }, 2000);
            }

            break;
        }
      }

      // Flush any Bash commands that only emitted one observable tool event
      // so they still get pending-review tags and tool-call-linked diffs.
      for (const [commandItemId, command] of pendingBashCommands.entries()) {
        if (processedBashCommandItemIds.has(commandItemId)) continue;
        try {
          const tracked = await this.svc.hooklessWatcher.trackBashEditsFromCommand(
            session,
            workspacePath,
            command,
            commandItemId
          );
          if (tracked) {
            processedBashCommandItemIds.add(commandItemId);
            // Ensure renderer updates immediately when bash fallback tracking
            // adds late session_files rows (single-event command_execution cases).
            safeSend(event, 'session-files:updated', session.id);
          }
        } catch (bashFallbackError) {
          logger.main.error('[AIService] Failed to flush Bash fallback edits:', bashFallbackError);
        }
      }

      // Clear executing and pending prompt flags for mobile sync
      if (syncProvider && !this.svc.sessionsProcessingQueue.has(session.id)) {
        syncProvider.pushChange(session.id, {
          type: 'metadata_updated',
          metadata: { isExecuting: false, hasPendingPrompt: false, updatedAt: Date.now() },
        });
      }

      // Clean up queued prompt tracking
      if (queuedPromptId) {
        this.svc.processingQueuedPromptIds.delete(queuedPromptId);
        // logger.main.info(`[AIService] Cleared prompt tracking for ${queuedPromptId}`);
      }

      return { content: fullResponse };
    } catch (error) {
      const errorTime = Date.now() - startTime;
      const isClaudeCode = session?.provider === 'claude-code';
      const logPrefix = isClaudeCode ? '[CLAUDE-CODE-SERVICE]' : '[AIService]';

      if (isClaudeCode) {
        console.error('[CLAUDE-CODE-SERVICE] ====== CRITICAL ERROR ======');
        console.error('[CLAUDE-CODE-SERVICE] Error caught in stream handler:', error);
        console.error('[CLAUDE-CODE-SERVICE] Error type:', error instanceof Error ? error.constructor.name : typeof error);
        console.error('[CLAUDE-CODE-SERVICE] Error message:', error instanceof Error ? error.message : String(error));
        console.error('[CLAUDE-CODE-SERVICE] Error stack:', error instanceof Error ? error.stack : 'No stack');
        console.error('[CLAUDE-CODE-SERVICE] Context:', {
          errorTime
        });
      }

      console.error(`${logPrefix} Error after ${errorTime}ms:`, error);

      // Track AI request failure (only if we have session info)
      if (session) {
        this.svc.analytics.sendEvent('ai_request_failed', {
          provider: session.provider,
          errorType: categorizeAIError(error),
          retryAttempt: 0  // We don't currently track retry attempts
        });

        // Track ai_response_received with error
        this.svc.analytics.sendEvent('ai_response_received', {
          provider: session.provider,
          responseType: 'error',
          toolsUsed: [],
          usedChartTool: false,
          responseTime: bucketResponseTime(errorTime)
        });
      }

      // Mark session as error and end it
      if (session?.id) {
        await stateManager.updateActivity({
          sessionId: session.id,
          status: 'error'
        });

        // End the session to remove it from active sessions.
        // Skip if teammates are still active or lead is resuming - deferred to teammates:allCompleted.
        // NOTE: Use willResumeAfterCompletion() not isLeadBusy() — we're inside the
        // generator's for-await so leadQuery is still set (same issue as 'complete' handler).
        const hasTeammatesOnError = session.provider === 'claude-code'
          && typeof (provider as any).hasActiveTeammates === 'function'
          && (provider as any).hasActiveTeammates();
        const willResumeOnError = session.provider === 'claude-code'
          && typeof (provider as any).willResumeAfterCompletion === 'function'
          && (provider as any).willResumeAfterCompletion();
        const queuedChainAlreadyActiveOnError = this.svc.sessionsProcessingQueue.has(session.id);
        let queuedContinuationScheduledOnError = false;
        if (!hasTeammatesOnError && !willResumeOnError && !queuedChainAlreadyActiveOnError) {
          queuedContinuationScheduledOnError = await this.svc.tryDispatchNextQueuedPrompt(
            session.id,
            workspacePath,
            BrowserWindow.fromWebContents(event.sender),
            'error-handler queue',
          );
        }
        if (hasTeammatesOnError || willResumeOnError || queuedChainAlreadyActiveOnError || queuedContinuationScheduledOnError) {
          const reason = hasTeammatesOnError
            ? 'teammates still active'
            : willResumeOnError
            ? 'lead resuming'
            : queuedChainAlreadyActiveOnError
            ? 'queued continuation already active'
            : 'queued continuation scheduled';
          logger.main.info(`[AIService] Deferring endSession for ${session.id} on error - ${reason}`);
        } else {
          await stateManager.endSession(session.id);
          // Stop file watcher - session ended on error
          await this.svc.hooklessWatcher.stopForSession(session.id);
          codexEditWindowRegistry.clearSession(session.id);
        }

        // Clear executing and pending prompt flags for mobile sync on error
        if (syncProvider && !this.svc.sessionsProcessingQueue.has(session.id)) {
          syncProvider.pushChange(session.id, {
            type: 'metadata_updated',
            metadata: { isExecuting: false, hasPendingPrompt: false, updatedAt: Date.now() },
          });

          // Request mobile push notification for agent error (only when truly away)
          if (isDesktopTrulyAway()) {
            syncProvider.requestMobilePush?.(
              session.id,
              session.title || 'AI Session',
              'Error occurred'
            );
          }
        }
      }

      // Send error metrics
      if (event && event.sender) {
        safeSend(event, 'ai:performanceMetrics', {
          phase: 'error',
          errorTime,
          error: error instanceof Error ? error.message : 'Unknown error'
        });

        // Send error to renderer
        safeSend(event, 'ai:error', {
          sessionId: session?.id,
          message: error instanceof Error ? error.message : 'Unknown error occurred'
        });
      }

      // Clean up queued prompt tracking on error
      if (queuedPromptId) {
        this.svc.processingQueuedPromptIds.delete(queuedPromptId);
        logger.main.info(`[AIService] Cleared prompt tracking for ${queuedPromptId} (error path)`);
      }

      throw error;
    }
  };

  private async disableParentNotificationsAfterDirectTakeover(session: SessionData): Promise<void> {
    await disableParentNotificationsAfterDirectTakeover(session);
  }
}
