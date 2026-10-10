/**
 * OpenCode Agent Provider
 *
 * Integrates the open source OpenCode coding agent into Nimbalyst.
 * OpenCode runs as a local HTTP+SSE server, and we communicate
 * via the @opencode-ai/sdk client library.
 *
 * Key features:
 * - Server subprocess lifecycle management (via OpenCodeSDKProtocol)
 * - SSE event streaming with protocol event normalization
 * - File edit tracking via custom OpenCode plugin hooks
 * - MCP server passthrough to OpenCode's configuration
 * - Multi-model support (Claude, OpenAI, Gemini, local models)
 */

import { BaseAgentProvider } from './BaseAgentProvider';
import { buildUserMessageAddition } from './documentContextUtils';
import { describeUnusableWorkspacePath } from './workspacePreconditions';
import { buildClaudeCodeSystemPrompt } from '../../prompt';
import { DEFAULT_MODELS } from '../../modelConstants';
import {
  ProviderConfig,
  DocumentContext,
  StreamChunk,
  ProviderCapabilities,
  AIModel,
  AIProviderType,
  ChatAttachment,
} from '../types';
import { OpenCodeSDKProtocol } from '../protocols/OpenCodeSDKProtocol';
import {
  openCodePermissionDisplayName,
  openCodePermissionPattern,
  type OpenCodePermissionContext,
  type OpenCodePermissionRequest,
} from '../protocols/openCodePermissions';
import type { ProtocolSession } from '../protocols/ProtocolInterface';
import { ToolPermissionService } from '../permissions/ToolPermissionService';
import type {
  PermissionPatternChecker,
  PermissionPatternSaver,
  SecurityLogger,
  TrustChecker,
} from './ProviderPermissionMixin';
import { McpConfigService } from '../services/McpConfigService';
import { getMcpConfigService, isInternalMcpServerEnabled, areTrackerToolsEnabled, resolveTrackersWorkspacePath } from '../services/mcpServerConfig';
import { MCPServerConfig } from '../../../types/MCPServerConfig';
import { safeJSONSerialize } from '../../../utils/serialization';
import { AgentProtocolTranscriptAdapter } from './agentProtocol/AgentProtocolTranscriptAdapter';
import { TranscriptMigrationRepository } from '../../../storage/repositories/TranscriptMigrationRepository';
import {
  getOpenCodeColdModelCatalog,
  getOpenCodeModelCatalog,
} from './openCode/OpenCodeModelCatalog';

interface OpenCodeProviderDeps {
  protocol?: OpenCodeSDKProtocol;
  permissionService?: ToolPermissionService;
}

export class OpenCodeProvider extends BaseAgentProvider {
  static readonly DEFAULT_MODEL = DEFAULT_MODELS['opencode'];
  private static cachedSdkSlashCommands = new Map<string, string[]>();

  private readonly protocol: OpenCodeSDKProtocol;
  private readonly permissionService: ToolPermissionService | null;
  private readonly mcpConfigService: McpConfigService;
  private readonly liveProtocolSessions = new Map<string, ProtocolSession>();
  private readonly slashCommandsByWorkspace = new Map<string, string[]>();
  private activeWorkspacePath: string | null = null;

  // Analytics initialization data, captured during first sendMessage call
  private _initData: {
    model: string;
    mcpServerCount: number;
    isResumedSession: boolean;
  } | null = null;

  // Internal MCP-server enablement (ports, kill-switches, extension/tracker
  // loaders, auth token) lives in the shared `mcpServerConfig` registry now.

  // MCP config loader (injected from electron main process)
  private static mcpConfigLoader: ((workspacePath?: string) => Promise<Record<string, MCPServerConfig>>) | null = null;

  // Shell environment loader (injected from electron main process)
  private static shellEnvironmentLoader: (() => Record<string, string> | null) | null = null;

  // Enhanced PATH loader (injected from electron main process)
  private static enhancedPathLoader: (() => string) | null = null;

  constructor(deps?: OpenCodeProviderDeps) {
    super();

    this.permissionService = deps?.permissionService ?? this.createPermissionService();

    // Initialize protocol (or use injected for testing)
    this.protocol = deps?.protocol || new OpenCodeSDKProtocol();
    this.protocol.setPermissionHost?.({
      resolvePermission: (request, context) => this.resolveOpenCodePermission(request, context),
    });

    // Initialize MCP config service from the shared registry + provider loaders.
    this.mcpConfigService = getMcpConfigService({
      mcpConfigLoader: OpenCodeProvider.mcpConfigLoader,
      claudeSettingsEnvLoader: null,
      shellEnvironmentLoader: OpenCodeProvider.shellEnvironmentLoader,
    });
  }

  async initialize(config: ProviderConfig): Promise<void> {
    this.config = config;
  }

  getProviderName(): AIProviderType {
    return 'opencode';
  }

  // Static injection setters (called from electron main process at startup).
  // Internal MCP-server ports / kill-switches / loaders / auth token are
  // configured once via `configureMcpServers` (shared registry).
  public static setMcpConfigLoader(loader: ((workspacePath?: string) => Promise<Record<string, MCPServerConfig>>) | null): void {
    OpenCodeProvider.mcpConfigLoader = loader;
  }

  public static setShellEnvironmentLoader(loader: (() => Record<string, string> | null) | null): void {
    OpenCodeProvider.shellEnvironmentLoader = loader;
  }

  public static setEnhancedPathLoader(loader: (() => string) | null): void {
    OpenCodeProvider.enhancedPathLoader = loader;
  }

  public static setTrustChecker(checker: TrustChecker | null): void {
    BaseAgentProvider.setTrustChecker(checker);
  }

  public static setPermissionPatternSaver(saver: PermissionPatternSaver | null): void {
    BaseAgentProvider.setPermissionPatternSaver(saver);
  }

  public static setPermissionPatternChecker(checker: PermissionPatternChecker | null): void {
    BaseAgentProvider.setPermissionPatternChecker(checker);
  }

  public static setSecurityLogger(logger: SecurityLogger | null): void {
    BaseAgentProvider.setSecurityLogger(logger);
  }

  getDisplayName(): string {
    return 'OpenCode';
  }

  getDescription(): string {
    return 'OpenCode open source coding agent with multi-model support';
  }

  getProviderSessionData(sessionId: string): any {
    const { providerSessionId } = this.sessions.getProviderSessionData(sessionId);
    return {
      providerSessionId,
      openCodeSessionId: providerSessionId,
    };
  }

  /**
   * Get initialization data for analytics tracking.
   */
  getInitData(): typeof this._initData {
    return this._initData;
  }

  getCapabilities(): ProviderCapabilities {
    return {
      streaming: true,
      tools: true,
      mcpSupport: true,
      edits: true,
      resumeSession: true,
      supportsFileTools: true,
    };
  }

  /** Return commands discovered by this instance for its active workspace. */
  getSlashCommands(): string[] {
    if (!this.activeWorkspacePath) return [];
    return [...(this.slashCommandsByWorkspace.get(this.activeWorkspacePath) ?? [])];
  }

  /** Read a workspace's cached commands without borrowing another project's list. */
  static getCachedSdkSlashCommands(workspacePath?: string): string[] {
    if (!workspacePath) return [];
    return [...(OpenCodeProvider.cachedSdkSlashCommands.get(workspacePath) ?? [])];
  }

  /** Test-only: clear cross-instance command discovery. */
  static resetCachedSdkSlashCommandsForTests(): void {
    OpenCodeProvider.cachedSdkSlashCommands.clear();
  }

  /**
   * Compact an OpenCode session through its native summarize RPC.
   *
   * A live protocol session is not a precondition. The host offers Compact for
   * every OpenCode session -- including one restored after a restart, which has
   * sent nothing through this instance -- so when there is no live session we
   * resume the persisted OpenCode session first and compact that. The
   * conversation being compacted lives on the OpenCode server, not in this
   * process, so resuming is all that is missing (#574).
   */
  async compactSession(
    sessionId: string,
    options?: { workspacePath?: string; providerSessionId?: string },
  ): Promise<void> {
    const session = this.liveProtocolSessions.get(sessionId)
      ?? await this.resumeSessionForCompaction(sessionId, options);
    await this.protocol.compactSession(session);
  }

  private async resumeSessionForCompaction(
    sessionId: string,
    options?: { workspacePath?: string; providerSessionId?: string },
  ): Promise<ProtocolSession> {
    const openCodeSessionId = options?.providerSessionId
      || this.sessions.getSessionId(sessionId);
    if (!openCodeSessionId) {
      // Nothing has ever been sent to OpenCode for this session, so there is no
      // context to compact.
      throw new Error('Cannot compact: this session has no OpenCode conversation yet.');
    }
    if (!options?.workspacePath) {
      throw new Error('Cannot compact: no project folder is set for this session.');
    }

    const session = await this.protocol.resumeSession(openCodeSessionId, {
      workspacePath: options.workspacePath,
      model: this.config?.model || 'default',
      env: OpenCodeProvider.buildOpenCodeEnvironment(),
    });
    this.liveProtocolSessions.set(sessionId, session);
    return session;
  }

  /**
   * Read the cached live catalog without starting an OpenCode server.
   *
   * `workspacePath` is a required parameter that accepts `undefined` so a
   * caller with no project context has to say so rather than drift into the
   * preset list by omission (#1382).
   */
  static async getModels(workspacePath: string | undefined): Promise<AIModel[]> {
    if (!workspacePath) {
      return (await getOpenCodeColdModelCatalog()).models;
    }
    return (await getOpenCodeModelCatalog(workspacePath)).models;
  }

  /**
   * Build environment variables for the OpenCode server subprocess.
   */
  private static buildOpenCodeEnvironment(): Record<string, string> | undefined {
    const shellEnv = OpenCodeProvider.shellEnvironmentLoader?.();
    const enhancedPath = OpenCodeProvider.enhancedPathLoader?.();

    if (!shellEnv && !enhancedPath) {
      return undefined;
    }

    const env: Record<string, string> = {};

    if (shellEnv) {
      Object.assign(env, shellEnv);
    }

    if (enhancedPath) {
      env.PATH = enhancedPath;
    }

    return env;
  }

  /**
   * Build system prompt for the OpenCode session.
   */
  protected buildSystemPrompt(
    documentContext?: DocumentContext,
    sessionDirective?: string,
    hasOutOfBandNaming: boolean = false,
  ): string {
    return buildClaudeCodeSystemPrompt({
      hasSessionNaming: isInternalMcpServerEnabled(),
      hasOutOfBandNaming,
      toolReferenceStyle: 'opencode' as any,
      sessionDirective,
      trackersEnabled: areTrackerToolsEnabled(resolveTrackersWorkspacePath(documentContext)),
    });
  }

  async *sendMessage(
    message: string,
    documentContext?: DocumentContext,
    sessionId?: string,
    messages?: any[],
    workspacePath?: string,
    attachments?: ChatAttachment[]
  ): AsyncIterableIterator<StreamChunk> {
    const unusableWorkspace = describeUnusableWorkspacePath(workspacePath);
    if (unusableWorkspace || !workspacePath) {
      yield { type: 'error', error: unusableWorkspace ?? 'No project folder is set for this session.' };
      return;
    }

    const systemPrompt = this.buildSystemPrompt(
      documentContext, await this.getSessionDirective(sessionId), this.isNamedOutOfBand(sessionId, documentContext),
    );
    const { userMessageAddition, messageWithContext } = buildUserMessageAddition(message, documentContext);

    // Emit prompt additions for UI
    if (sessionId && (systemPrompt || userMessageAddition)) {
      this.emit('promptAdditions', {
        sessionId,
        systemPromptAddition: systemPrompt || null,
        userMessageAddition,
        attachments: [],
        timestamp: Date.now(),
      });
    }

    if (sessionId) {
      await this.logAgentMessageBestEffort(sessionId, 'input', messageWithContext, {
        metadata: this.withPromptProvenanceMetadata(documentContext),
      });
    }

    const mcpConfigWorkspacePath = documentContext?.mcpConfigWorkspacePath || workspacePath;
    const abortController = new AbortController();
    this.abortController = abortController;

    let fullText = '';

    try {
      // Get or create protocol session
      const existingSessionId = this.sessions.getSessionId(sessionId || '');
      console.log('[OPENCODE] Session lookup:', {
        sessionId,
        existingSessionId,
        action: existingSessionId ? 'RESUME' : 'CREATE'
      });

      const mcpServers = await this.mcpConfigService.getMcpServersConfig({ sessionId, workspacePath: mcpConfigWorkspacePath });
      const env = OpenCodeProvider.buildOpenCodeEnvironment();

      const sessionOptions = {
        workspacePath,
        model: this.config?.model || 'default',
        mcpServers,
        env,
        raw: {
          systemPrompt,
          abortSignal: abortController.signal,
          permissionsPath: documentContext?.permissionsPath || workspacePath,
          // Session role (an `app.agents` primary agent). Applied per prompt,
          // so changing it takes effect on the next turn of an existing
          // conversation rather than only at session creation.
          openCodeAgent: this.config?.agentRole,
        },
      };

      const isResumedSession = !!existingSessionId;
      const session = isResumedSession
        ? await this.protocol.resumeSession(existingSessionId, sessionOptions)
        : await this.protocol.createSession(sessionOptions);

      if (sessionId) {
        this.liveProtocolSessions.set(sessionId, session);
      }
      this.activeWorkspacePath = workspacePath;

      // Memoized in the protocol for the server process's lifetime, so this is
      // one round trip per server rather than one per turn (#574).
      try {
        const slashCommands = await this.protocol.listSlashCommands(session);
        this.slashCommandsByWorkspace.set(workspacePath, slashCommands);
        OpenCodeProvider.cachedSdkSlashCommands.set(workspacePath, slashCommands);
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        console.warn('[OPENCODE] Failed to load slash commands:', detail);
      }

      // Store initialization data for analytics
      this._initData = {
        model: this.config?.model || 'default',
        mcpServerCount: Object.keys(mcpServers).length,
        isResumedSession,
      };

      console.log('[OPENCODE] Session after create/resume:', {
        sessionId,
        protocolSessionId: session.id,
        existingSessionId
      });

      // Create transcript adapter as event parser (returns ParsedItems for the streaming loop).
      // Canonical events are written by the TranscriptTransformer from raw ai_agent_messages.
      const transcriptAdapter = new AgentProtocolTranscriptAdapter(null, sessionId ?? '');
      // Cache-backed read only: getOpenCodeModelCatalog() may query an already
      // running server, but never starts one. The assistant usage event names
      // the actual provider/model selected by OpenCode, including when the
      // session was configured as `default`.
      const modelCatalog = await getOpenCodeModelCatalog(workspacePath).catch((error) => {
        const detail = error instanceof Error ? error.message : String(error);
        console.warn('[OPENCODE] Failed to read model catalog for context usage:', detail);
        return { models: [] };
      });

      transcriptAdapter.userMessage(
        messageWithContext,
        documentContext?.mode === 'planning' ? 'planning' : 'agent',
        attachments as any,
      );

      // Send message using protocol -- adapter parses all events
      for await (const event of this.protocol.sendMessage(session, {
        content: messageWithContext,
        attachments,
        sessionId,
        mode: documentContext?.mode || 'agent',
      })) {
        if (abortController.signal.aborted) {
          throw new Error('Operation cancelled');
        }

        // Store raw OpenCode SSE events for transcript reconstruction.
        // Stored content is the bare SSE event { type, properties } -- no
        // outer wrapper -- so OpenCodeRawParser can JSON.parse it directly.
        if (sessionId && event.type === 'raw_event') {
          const rawSseEvent = (event.metadata as { rawEvent?: unknown } | undefined)?.rawEvent;
          if (rawSseEvent !== undefined) {
            const { content } = safeJSONSerialize(rawSseEvent);
            const sseEventType = typeof (rawSseEvent as { type?: unknown }).type === 'string'
              ? (rawSseEvent as { type: string }).type
              : 'unknown';
            await this.logAgentMessageBestEffort(sessionId, 'output', content, {
              metadata: { eventType: sseEventType, openCodeProvider: true },
              hidden: true,
              searchable: false,
            });
            // Drive incremental transcript transformation while the agent is
            // still streaming. Without this, canonical events (and the
            // widgets that render off them -- AskUserQuestion etc.) only
            // appear after a session reload, which may not happen until the
            // turn completes.
            await this.processTranscriptMessages(sessionId);
          }
        }

        const actualModelId = typeof event.metadata?.openCodeModelId === 'string'
          ? event.metadata.openCodeModelId
          : undefined;
        const resolvedContextWindow = actualModelId
          ? modelCatalog.models.find((model) => model.id === actualModelId)?.contextWindow
          : undefined;
        const normalizedEvent = event.type === 'complete' && resolvedContextWindow
          ? { ...event, contextWindow: resolvedContextWindow }
          : event;

        for (const item of transcriptAdapter.processEvent(normalizedEvent)) {
          switch (item.kind) {
            case 'text':
              // Content rendered from canonical events, but AIService still needs
              // text yields for OS notification body content.
              fullText += item.text;
              yield { type: 'text', content: item.text };
              break;

            case 'tool_call':
              // AIService needs tool_call yields for file tracking / worktree detection
              yield { type: 'tool_call', toolCall: item.toolCall };
              break;

            case 'tool_result':
              // AIService needs tool results for file tracking
              yield {
                type: 'tool_call',
                toolCall: {
                  id: item.toolResult.id,
                  name: item.toolResult.name,
                  result: item.toolResult.result,
                },
              };
              break;

            case 'complete':
              yield {
                type: 'complete',
                content: item.event.content,
                isComplete: true,
                usage: item.event.usage,
                ...(item.event.contextFillTokens !== undefined ? { contextFillTokens: item.event.contextFillTokens } : {}),
                ...(item.event.contextWindow !== undefined ? { contextWindow: item.event.contextWindow } : {}),
              };
              break;

            case 'error':
              yield { type: 'error', error: item.message };
              break;

            case 'raw_event':
            case 'reasoning':
            case 'planning_mode':
              break;
          }
        }
      }

      // Capture session ID after stream completes
      if (sessionId && session.id) {
        if (session.id !== existingSessionId) {
          console.log('[OPENCODE] Saving provider session ID:', {
            nimbalystSessionId: sessionId,
            openCodeSessionId: session.id,
          });
          this.sessions.setProviderSessionData(sessionId, {
            providerSessionId: session.id,
          });
        }
      }

      // No end-of-turn fullText write: canonical events derived from the
      // stored raw SSE events (via OpenCodeRawParser) are the source of truth
      // for transcript content. The fullText accumulator is kept only for
      // OS notification body content, not for persistence.

    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      const isAbort = abortController.signal.aborted || /abort|cancel/i.test(errorMessage);

      if (!isAbort) {
        console.error('[OPENCODE] Error in sendMessage:', errorMessage);
        yield { type: 'error', error: errorMessage };
      }
    } finally {
      if (this.abortController === abortController) {
        this.abortController = null;
      }
    }
  }

  /**
   * Release every protocol session this instance opened.
   *
   * `destroy()` is the hook the host actually reaches --
   * `ProviderFactory.destroyProvider` runs on session delete, archive, worktree
   * teardown and app shutdown, and provider instances are cached per session,
   * so there is no earlier point at which these entries stop being needed.
   * Without this the ProtocolSession (and the OpenCode server reference behind
   * it) was retained for the life of the process (#574).
   */
  destroy(): void {
    this.permissionService?.rejectAllPending();
    this.permissionService?.clearSessionCache();
    for (const session of this.liveProtocolSessions.values()) {
      try {
        this.protocol.cleanupSession(session);
      } catch (error) {
        console.warn('[OPENCODE] protocol.cleanupSession threw during destroy():', error);
      }
    }
    this.liveProtocolSessions.clear();
    super.destroy();
  }

  abort(): void {
    this.permissionService?.rejectAllPending();
    for (const session of this.liveProtocolSessions.values()) {
      this.protocol.abortSession(session);
    }
    super.abort();
  }

  resolveToolPermission(
    requestId: string,
    response: { decision: 'allow' | 'deny'; scope: 'once' | 'session' | 'always' | 'always-all' },
    sessionId?: string,
    respondedBy: 'desktop' | 'mobile' = 'desktop',
  ): void {
    this.permissionService?.resolvePermission(requestId, response);
    if (sessionId) {
      void this.logAgentMessageBestEffort(
        sessionId,
        'output',
        this.createPermissionResultMessage(requestId, response, respondedBy),
      );
    }
  }

  private createPermissionService(): ToolPermissionService | null {
    if (
      !BaseAgentProvider.trustChecker
      || !BaseAgentProvider.permissionPatternSaver
      || !BaseAgentProvider.permissionPatternChecker
    ) {
      return null;
    }
    return new ToolPermissionService({
      trustChecker: BaseAgentProvider.trustChecker,
      patternSaver: BaseAgentProvider.permissionPatternSaver,
      patternChecker: BaseAgentProvider.permissionPatternChecker,
      securityLogger: BaseAgentProvider.securityLogger ?? undefined,
      emit: this.emit.bind(this),
    });
  }

  private async resolveOpenCodePermission(
    request: OpenCodePermissionRequest,
    context: OpenCodePermissionContext,
  ) {
    if (!this.permissionService) {
      throw new Error('OpenCode permission handling dependencies are not configured.');
    }
    const pattern = openCodePermissionPattern(request);
    const displayName = openCodePermissionDisplayName(request);
    return this.permissionService.requestToolPermission({
      requestId: request.id,
      sessionId: context.sessionId,
      workspacePath: context.workspacePath,
      permissionsPath: context.permissionsPath,
      toolName: request.permission,
      toolInput: {
        permission: request.permission,
        patterns: request.patterns,
        always: request.always,
        metadata: request.metadata,
        ...(request.tool ? { tool: request.tool } : {}),
      },
      pattern,
      patternDisplayName: displayName,
      toolDescription: displayName,
      isDestructive: false,
      warnings: [],
      signal: context.signal,
      suppressAlwaysAllowRule: request.always.length === 0,
    });
  }

  // Drive the transcript transformer incrementally so that canonical events
  // (and the widgets that key off them, like AskUserQuestion) appear in the
  // UI while the OpenCode session is still streaming -- not only after the
  // session finishes and a reload triggers ensureUpToDate.
  private async processTranscriptMessages(sessionId: string): Promise<void> {
    try {
      if (TranscriptMigrationRepository.hasService()) {
        await TranscriptMigrationRepository.getService().processNewMessages(
          sessionId,
          this.getProviderName(),
        );
      }
    } catch {
      // Best effort -- the next call (or end-of-turn ensureUpToDate) catches up.
    }
  }
}
