import { TrayManager } from '../../../tray/TrayManager';
import { safeHandle } from '../../../utils/ipcRegistry';
import { logger } from '../../../utils/logger';
import { getDefaultEffortLevel, getDefaultThinkingMode } from '../../../utils/store';
import { FEATURES, FeatureUsageService } from '../../FeatureUsageService.ts';
import { getSyncProvider } from '../../SyncManager';
import { trackCreateAiSession } from '../../analytics/sessionLaunchAnalytics';
import { captureTutorialMilestone } from '../../tutorial/tutorialAnalytics';
import { bucketAgeInDays, bucketCount, extractModelForProvider } from '.././aiServiceUtils';
import { resolveProviderAuthRequirement } from '.././providerAuthRequirement';
import { isExtensionAgentProvider, resolveExtensionAgentRef } from '.././providerResolution';
import { getLocalHostDeviceId, stampSessionHost } from '.././sessionHostAttribution';
import { type AIServiceContext } from './AIServiceContext';
import { ModelRegistry, ProviderFactory } from '@nimbalyst/runtime/ai/server';
import { resolveEffortLevel, resolveThinkingMode } from '@nimbalyst/runtime/ai/server/effortLevels';
import { type AIProviderType, type DocumentContext, type Message, type SessionType } from '@nimbalyst/runtime/ai/server/types';
import * as fs from 'fs';
import { remoteSessions } from '../remoteSessions';
import { registerRemoteSessionHandlers } from './registerRemoteSessionHandlers';

/**
 * Session CRUD and the send-message entry point.
 *
 * `ai:sendMessage` is registered from `ctx.sendMessageHandler`, which AIService
 * assigns from the streaming handler before the registrars run.
 */
export function registerSessionHandlers(ctx: AIServiceContext): void {
  registerRemoteSessionHandlers();
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
      const { getDatabase } = await import('../../../database/initialize');
      const { createWorktreeStore } = await import('../../WorktreeStore');
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
    if (!ctx.isProviderEnabledForWorkspace(provider, workspacePath)) {
      throw new Error(`Provider ${provider} is not enabled for this workspace`);
    }

    // Get API key using project-aware helper (considers project overrides)
    let apiKey = ctx.getApiKeyForProvider(provider, workspacePath);

    // Validate API key requirement based on provider.
    // Extension-agent providers defer auth to the extension itself, so they
    // skip this switch entirely (no apiKey requirement on the host side).
    if (!isExtensionAgentProvider(provider)) {
      // Shared with the send path in MessageStreamingHandler — see
      // providerAuthRequirement.ts for why this is not an inline switch.
      const authRequirement = resolveProviderAuthRequirement(provider as AIProviderType);
      if (!authRequirement) {
        throw new Error(`Unknown provider: ${provider}`);
      }
      if (authRequirement.requiresApiKey && !apiKey) {
        throw new Error(authRequirement.missingKeyMessage);
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
      maxTokens: ctx.getProviderSetting(provider, 'maxTokens'),
      temperature: ctx.getProviderSetting(provider, 'temperature')
    };

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
      const settingsModel = ctx.getProviderSetting(provider, 'model');
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
    const session = await ctx.sessionManager.createSession(
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
    await stampSessionHost(session.id, getLocalHostDeviceId());

    // Track session creation in feature usage system
    FeatureUsageService.getInstance().recordUsage(FEATURES.SESSION_CREATED);

    // Track AI chat feature first use
    const { FeatureTrackingService } = await import('../../analytics/FeatureTrackingService');
    const { AnalyticsService } = await import('../../analytics/AnalyticsService');
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
      const lmstudioSettings = ctx.getSettingsStore().get('providerSettings.lmstudio', {}) as any;
      initConfig.baseUrl = lmstudioSettings.baseUrl || ctx.getSettingsStore().get('apiKeys.lmstudio_url', '') || 'http://127.0.0.1:8234';
    }

    // Pass through allowedTools and effort level settings for Claude Code
    if (provider === 'claude-code') {
      const providerSettings = ctx.getSettingsStore().get('providerSettings', {}) as any;
      if (providerSettings?.['claude-code']?.allowedTools) {
        initConfig.allowedTools = providerSettings['claude-code'].allowedTools;
      }
      // Effort level: explicit session value, else the app-wide default the
      // selector displays (Opus 4.6 adaptive reasoning).
      const effortLevel = resolveEffortLevel((session.metadata as any)?.effortLevel, getDefaultEffortLevel());
      if (effortLevel) {
        initConfig.effortLevel = effortLevel;
      }
      initConfig.thinkingMode = resolveThinkingMode((session.metadata as any)?.thinkingMode, getDefaultThinkingMode());
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
    const toolHandler = ctx.createToolHandler(event.sender, documentContext, session.id, workspacePath);
    providerInstance.registerToolHandler(toolHandler);

    // NOTE: No longer tracking provider per-window - ProviderFactory handles per-session tracking
    // This allows multiple concurrent sessions in the same window

    // NOTE: Mobile message handling is done via startIndexListener() which watches
    // the index for pendingExecution flags. We do NOT call watchSession() here because
    // it creates a WebSocket connection per session, causing performance issues.

    // Was a second, drifted copy of the SessionHandlers emitter -- it omitted
    // `is_meta_agent_session`, so meta-agent sessions created through this
    // path were counted as ordinary ones. Both now go through one function.
    trackCreateAiSession({
      provider,
      worktreeId: session.worktreeId,
      parentSessionId: session.parentSessionId,
      agentRole: (session as { agentRole?: string }).agentRole,
      launchSource: (session as { launchSource?: string }).launchSource,
    });
    return session;
  });

  safeHandle('ai:sendMessage', async (...args: Parameters<NonNullable<typeof ctx.sendMessageHandler>>) => {
    if (args[3]) await remoteSessions.assertLocalExecution(args[3]);
    return ctx.sendMessageHandler!(...args);
  });

  // Get session history (full session data with messages - slow)
  safeHandle('ai:getSessions', async (event, workspacePath?: string) => {
    return await ctx.sessionManager.getSessions(workspacePath);
  });

  // Get session list (lightweight - just metadata, no messages)
  safeHandle('ai:getSessionList', async (event, workspacePath?: string) => {
    const local = await ctx.sessionManager.getSessionList(workspacePath);
    return workspacePath ? remoteSessions.list(workspacePath, local) : local;
  });

  // Load a session
  // trackAsResume: only pass true when user intentionally opens a session from history
  // (not for tab restoration, lazy loading, or session reloading)
  // Deduplicate: if a load is already in-flight for the same sessionId, reuse the promise
  // to avoid queuing redundant heavy DB queries in PGLite's single-threaded worker
  const loadSessionInFlight = new Map<string, Promise<any>>();
  safeHandle('ai:loadSession', async (event, sessionId: string, workspacePath?: string, trackAsResume?: boolean) => {
    if (workspacePath && remoteSessions.isRemote(sessionId)) {
      const remote = await remoteSessions.get(sessionId, workspacePath);
      if (remote) return remote;
    }
    const existing = loadSessionInFlight.get(sessionId);
    if (existing && !trackAsResume) {
      return existing;
    }

    const loadPromise = (async () => {
    const loadStart = performance.now();
    const session = await ctx.sessionManager.loadSession(sessionId, workspacePath)
      ?? (workspacePath ? await remoteSessions.get(sessionId, workspacePath) : null);
    const loadTime = performance.now() - loadStart;
    if (!session) {
      console.log(`[SESSION] Session not found: ${sessionId} (this is normal if the session was deleted)`);
      return null;
    }

    // Restore document context state from persisted data (if available)
    // This enables transition detection across app restarts
    if (session.lastDocumentState) {
      ctx.documentContextService.loadPersistedState(sessionId, session.lastDocumentState);
    }

    // Track ai_session_resumed only when user intentionally opens a session from history
    // Skip for: app startup tab restoration, tab switching (lazy load), session reloading
    if (trackAsResume && session.messages && session.messages.length > 0) {
      const messageCount = session.messages.length;
      const createdAt = session.createdAt || Date.now();

      ctx.analytics.sendEvent('ai_session_resumed', {
        provider: session.provider,
        messageCount: bucketCount(messageCount),
        ageInDays: bucketAgeInDays(createdAt)
      });

      // Separates "opened the tutorial" from "actually used it". No-ops for
      // every other workspace.
      void captureTutorialMilestone(
        session.workspacePath || workspacePath,
        'session_opened'
      );
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
    ctx.sessionManager.clearCurrentSession();

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
    const success = await ctx.sessionManager.updateSessionMessages(sessionId, messages, workspacePath);
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

    // Same reason: the tray's cached `phase` gates the running bucket, and this
    // is the renderer's half of the metadata write path.
    if (typeof metadata.metadata?.phase === 'string') {
      TrayManager.getInstance().onSessionPhaseChanged(sessionId, metadata.metadata.phase);
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

  // Save draft input
  safeHandle('ai:saveDraftInput', async (
    event,
    sessionId: string,
    draftInput: string,
    workspacePath?: string
  ) => {
    const success = await ctx.sessionManager.saveDraftInput(sessionId, draftInput, workspacePath);
    return { success };
  });

  // Clean up empty messages from all sessions
  safeHandle('ai:cleanupEmptyMessages', async () => {
    const cleaned = ctx.sessionManager.cleanupAllSessions();
    console.log(`[AIService] Manual cleanup: removed ${cleaned} empty messages`);
    return { success: true, cleaned };
  });

  // Delete session
  safeHandle('ai:deleteSession', async (event, sessionId: string, workspacePath?: string) => {
    const success = await ctx.sessionManager.deleteSession(sessionId, workspacePath);

    // Clean up provider if it exists
    if (success) {
      ProviderFactory.destroyProvider(sessionId);
      // Clean up document state tracking
      ctx.documentContextService.clearSessionState(sessionId);
      // Clean up the agent file watcher if one was active.
      await ctx.hooklessWatcher.stopForSession(sessionId);
    }

    return { success };
  });

  // Advance the FileSnapshotCache baseline after diff acceptance/rejection
  safeHandle('ai:advance-diff-baseline', async (_event, sessionId: string, filePath: string, content: string) => {
    ctx.advanceDiffBaseline(sessionId, filePath, content);
  });
}
