/**
 * OpenAICodexACPProvider
 *
 * Codex agent provider that uses ACP (Agent Client Protocol) over stdio
 * instead of @openai/codex-sdk. ACP exposes native pre/post file-edit hooks,
 * which the Codex SDK does not, so this provider can:
 *   - capture pre-edit baselines for accurate diff rendering
 *   - attribute edits to the producing session deterministically
 *   - emit exact unified diffs in the live transcript
 *
 * Architectural peer to OpenAICodexProvider; both share BaseAgentProvider but
 * have separate protocol layers (CodexACPProtocol vs. CodexSDKProtocol) and
 * separate raw event parsers (CodexACPRawParser vs. CodexRawParser).
 *
 * See plan: nimbalyst-local/plans/codex-acp-provider-integration.md
 */

import path from 'path';
import { BaseAgentProvider } from './BaseAgentProvider';
import { buildUserMessageAddition } from './documentContextUtils';
import { buildClaudeCodeSystemPrompt, buildMetaAgentSystemPrompt, type MetaAgentWorkflowPreset } from '../../prompt';
import { DEFAULT_MODELS } from '../../modelConstants';
import { AIToolCall, AIToolResult } from '../../types';
import {
  ProviderConfig,
  DocumentContext,
  StreamChunk,
  ProviderCapabilities,
  AIModel,
  AIProviderType,
  ModelIdentifier,
  ChatAttachment,
} from '../types';
import { CodexACPProtocol } from '../protocols/CodexACPProtocol';
import { ProtocolEvent, ProtocolSession } from '../protocols/ProtocolInterface';
import { ToolPermissionService } from '../permissions/ToolPermissionService';
import { PermissionMode, TrustChecker, PermissionPatternSaver, PermissionPatternChecker, SecurityLogger } from './ProviderPermissionMixin';
import { McpConfigService } from '../services/McpConfigService';
import { getMcpConfigService, isInternalMcpServerEnabled, areTrackerToolsEnabled, resolveTrackersWorkspacePath } from '../services/mcpServerConfig';
import { MCPServerConfig } from '../../../types/MCPServerConfig';
import { safeJSONSerialize } from '../../../utils/serialization';
import { AgentProtocolTranscriptAdapter } from './agentProtocol/AgentProtocolTranscriptAdapter';
import { TranscriptMigrationRepository } from '../../../storage/repositories/TranscriptMigrationRepository';

interface OpenAICodexACPProviderDeps {
  protocol?: CodexACPProtocol;
  permissionService?: ToolPermissionService;
}

export class OpenAICodexACPProvider extends BaseAgentProvider {
  static readonly DEFAULT_MODEL = DEFAULT_MODELS['openai-codex-acp'];
  // Reuse the same fallback model catalog as the SDK provider; the underlying
  // Codex CLI accepts the same model IDs regardless of transport.
  private static readonly FALLBACK_MODELS: ReadonlyArray<{
    id: string;
    name: string;
    contextWindow: number;
    maxTokens: number;
  }> = [
    { id: 'gpt-5.6-sol', name: 'GPT-5.6 Sol', contextWindow: 372000, maxTokens: 128000 },
    { id: 'gpt-5.6-terra', name: 'GPT-5.6 Terra', contextWindow: 372000, maxTokens: 128000 },
    { id: 'gpt-5.6-luna', name: 'GPT-5.6 Luna', contextWindow: 372000, maxTokens: 128000 },
    { id: 'gpt-5.5', name: 'GPT-5.5', contextWindow: 400000, maxTokens: 128000 },
    { id: 'gpt-5.4', name: 'GPT-5.4', contextWindow: 400000, maxTokens: 128000 },
    { id: 'gpt-5.4-mini', name: 'GPT-5.4 Mini', contextWindow: 400000, maxTokens: 128000 },
  ];

  private readonly protocol: CodexACPProtocol;
  private readonly permissionService: ToolPermissionService;
  private readonly mcpConfigService: McpConfigService;

  private _initData: {
    model: string;
    mcpServerCount: number;
    isResumedSession: boolean;
    permissionMode: string | null;
  } | null = null;

  // Internal MCP-server enablement (ports, kill-switches, extension/tracker
  // loaders, auth token) lives in the shared `mcpServerConfig` registry now.
  // Only the provider-specific env/config loaders stay per-provider.
  private static mcpConfigLoader: ((workspacePath?: string) => Promise<Record<string, MCPServerConfig>>) | null = null;
  private static claudeSettingsEnvLoader: (() => Promise<Record<string, string>>) | null = null;
  private static shellEnvironmentLoader: (() => Record<string, string> | null) | null = null;
  private static enhancedPathLoader: (() => string) | null = null;

  // Optional callbacks routed into the protocol for pre/post-edit hooks.
  // The Electron main process (MessageStreamingHandler) sets these so the
  // protocol can capture pre-edit local-history baselines via HistoryManager
  // and create turn-end snapshots.
  private static onBeforeFileWrite: ((filePath: string, sessionId: string | undefined) => Promise<void>) | null = null;
  private static onTurnFilesEdited: ((filePaths: Set<string>, sessionId: string | undefined) => Promise<void>) | null = null;

  constructor(config?: { apiKey?: string }, deps?: OpenAICodexACPProviderDeps) {
    super();
    const apiKey = config?.apiKey || '';

    if (deps?.protocol) {
      this.protocol = deps.protocol;
    } else {
      this.protocol = new CodexACPProtocol(apiKey, {
        onBeforeFileWrite: OpenAICodexACPProvider.onBeforeFileWrite ?? undefined,
        onTurnFilesEdited: OpenAICodexACPProvider.onTurnFilesEdited ?? undefined,
        // TODO: bridge ACP permission requests into ToolPermissionService once
        // the request shape is finalized. For now, allow once -- the trust
        // gate in requestCodexTurnPermission already enforces workspace trust,
        // and permission mode (auto vs full-access) is set on the ACP session.
        onPermissionRequest: async () => ({ decision: 'allow', scope: 'once' }),
      });
    }

    if (deps?.permissionService) {
      this.permissionService = deps.permissionService;
    } else {
      if (!BaseAgentProvider.trustChecker) {
        throw new Error('[OpenAICodexACPProvider] trustChecker must be set via setTrustChecker() before creating provider instances');
      }
      if (!BaseAgentProvider.permissionPatternSaver) {
        throw new Error('[OpenAICodexACPProvider] permissionPatternSaver must be set via setPermissionPatternSaver() before creating provider instances');
      }
      if (!BaseAgentProvider.permissionPatternChecker) {
        throw new Error('[OpenAICodexACPProvider] permissionPatternChecker must be set via setPermissionPatternChecker() before creating provider instances');
      }
      this.permissionService = new ToolPermissionService({
        trustChecker: BaseAgentProvider.trustChecker as TrustChecker,
        patternSaver: BaseAgentProvider.permissionPatternSaver as PermissionPatternSaver,
        patternChecker: BaseAgentProvider.permissionPatternChecker as PermissionPatternChecker,
        securityLogger: BaseAgentProvider.securityLogger ?? undefined,
        emit: this.emit.bind(this),
      });
    }

    this.mcpConfigService = getMcpConfigService({
      mcpConfigLoader: OpenAICodexACPProvider.mcpConfigLoader,
      claudeSettingsEnvLoader: OpenAICodexACPProvider.claudeSettingsEnvLoader,
      shellEnvironmentLoader: OpenAICodexACPProvider.shellEnvironmentLoader,
    });
  }

  getProviderName(): string {
    return 'openai-codex-acp';
  }

  getName(): string {
    return 'openai-codex-acp';
  }

  getDisplayName(): string {
    return 'OpenAI Codex (ACP)';
  }

  getDescription(): string {
    return 'OpenAI Codex agent over the Agent Client Protocol with native file-edit hooks';
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

  getProviderSessionData(sessionId: string): any {
    const { providerSessionId } = this.sessions.getProviderSessionData(sessionId);
    return {
      providerSessionId,
      codexAcpSessionId: providerSessionId,
    };
  }

  getInitData(): typeof this._initData {
    return this._initData;
  }

  // ---- Static injection setters --------------------------------------------

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
  // Internal MCP-server ports / kill-switches / loaders / auth token are
  // configured once via `configureMcpServers` (shared registry).
  public static setMCPConfigLoader(loader: ((workspacePath?: string) => Promise<Record<string, MCPServerConfig>>) | null): void {
    OpenAICodexACPProvider.mcpConfigLoader = loader;
  }
  public static setClaudeSettingsEnvLoader(loader: (() => Promise<Record<string, string>>) | null): void {
    OpenAICodexACPProvider.claudeSettingsEnvLoader = loader;
  }
  public static setShellEnvironmentLoader(loader: (() => Record<string, string> | null) | null): void {
    OpenAICodexACPProvider.shellEnvironmentLoader = loader;
  }
  public static setEnhancedPathLoader(loader: (() => string) | null): void {
    OpenAICodexACPProvider.enhancedPathLoader = loader;
  }
  public static setOnBeforeFileWrite(handler: ((filePath: string, sessionId: string | undefined) => Promise<void>) | null): void {
    OpenAICodexACPProvider.onBeforeFileWrite = handler;
  }
  public static setOnTurnFilesEdited(handler: ((filePaths: Set<string>, sessionId: string | undefined) => Promise<void>) | null): void {
    OpenAICodexACPProvider.onTurnFilesEdited = handler;
  }

  async initialize(config: ProviderConfig): Promise<void> {
    this.config = config;
    const apiKey = config.apiKey || '';
    if (typeof (this.protocol as Partial<CodexACPProtocol>).setApiKey === 'function') {
      this.protocol.setApiKey(apiKey);
    }
  }

  static getDefaultModel(): string {
    return OpenAICodexACPProvider.DEFAULT_MODEL;
  }

  static async getModels(_apiKey?: string): Promise<AIModel[]> {
    // ACP transport uses the same Codex CLI under the hood, so the model
    // catalog is identical to OpenAICodexProvider's. Models are reported under
    // the 'openai-codex-acp' provider id so the picker shows them as a peer.
    return OpenAICodexACPProvider.FALLBACK_MODELS.map((model) => ({
      id: ModelIdentifier.create('openai-codex-acp', model.id).combined,
      name: model.name,
      provider: 'openai-codex-acp' as AIProviderType,
      contextWindow: model.contextWindow,
      maxTokens: model.maxTokens,
    }));
  }

  async handleToolCall(
    toolCall: AIToolCall,
    _options?: { sessionId?: string; workingDirectory?: string }
  ): Promise<AIToolResult> {
    if (!toolCall.name) {
      return { success: false, error: 'Tool name is required' };
    }
    try {
      const result = await this.executeToolCall(toolCall.name, toolCall.arguments ?? {});
      return { success: true, result };
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Tool execution failed';
      return {
        success: false,
        error: message,
        result: (error as any)?.toolResult,
      };
    }
  }

  async cancelStream(_sessionId?: string): Promise<void> {
    this.abort();
  }

  async *sendMessage(
    message: string,
    documentContext?: DocumentContext,
    sessionId?: string,
    _messages?: any[],
    workspacePath?: string,
    attachments?: ChatAttachment[]
  ): AsyncIterableIterator<StreamChunk> {
    if (!workspacePath) {
      yield { type: 'error', error: '[OpenAICodexACPProvider] workspacePath is required but was not provided' };
      return;
    }

    const agentRole = await this.getAgentRole(sessionId);
    const isMetaAgent = agentRole === 'meta-agent';
    const workflowPreset = isMetaAgent ? await this.getWorkflowPreset(sessionId) : 'default';
    const systemPrompt = this.buildSystemPrompt(documentContext, isMetaAgent, workflowPreset);
    const { userMessageAddition, messageWithContext } = buildUserMessageAddition(message, documentContext);
    const unsupportedAttachmentHints = attachments?.filter(
      (attachment) => attachment.type !== 'image' && attachment.type !== 'document'
    );
    const messageWithAttachmentHints = this.appendAttachmentHints(messageWithContext, unsupportedAttachmentHints);

    if (sessionId && (systemPrompt || userMessageAddition || (attachments?.length ?? 0) > 0)) {
      const attachmentSummaries =
        attachments?.map((attachment) => ({
          type: attachment.type,
          filename: attachment.filename || (attachment.filepath ? path.basename(attachment.filepath) : 'unknown'),
          mimeType: attachment.mimeType,
          filepath: attachment.filepath,
        })) ?? [];
      this.emit('promptAdditions', {
        sessionId,
        systemPromptAddition: systemPrompt || null,
        userMessageAddition,
        attachments: attachmentSummaries,
        timestamp: Date.now(),
      });
    }

    if (sessionId) {
      const metadataToLog: Record<string, unknown> = {};
      if (attachments && attachments.length > 0) {
        metadataToLog.attachments = attachments;
      }
      if (documentContext?.mode) {
        metadataToLog.mode = documentContext.mode;
      }
      await this.logAgentMessageBestEffort(
        sessionId,
        'input',
        messageWithAttachmentHints,
        Object.keys(metadataToLog).length > 0 ? { metadata: metadataToLog } : undefined,
      );
    }

    const permissionsPath = documentContext?.permissionsPath || workspacePath;
    const mcpConfigWorkspacePath = documentContext?.mcpConfigWorkspacePath || workspacePath;
    const abortController = new AbortController();
    this.abortController = abortController;

    let fullText = '';

    try {
      const permissionDecision = await this.requestCodexTurnPermission(
        sessionId,
        workspacePath,
        permissionsPath,
        abortController.signal
      );

      if (permissionDecision.decision !== 'allow') {
        yield {
          type: 'error',
          error: permissionDecision.reason || 'OpenAI Codex (ACP) turn denied',
        };
        return;
      }

      const existingSessionId = this.sessions.getSessionId(sessionId || '');
      const mcpServers = await this.mcpConfigService.getMcpServersConfig({
        sessionId,
        workspacePath: mcpConfigWorkspacePath,
        profile: isMetaAgent ? 'meta-agent' : 'standard',
      });

      const resolvedModel = await this.getConfiguredModel();

      const sessionOptions = {
        workspacePath,
        model: resolvedModel,
        ...(permissionDecision.permissionMode ? { permissionMode: permissionDecision.permissionMode } : {}),
        mcpServers,
        ...(isMetaAgent ? {
          allowedTools: BaseAgentProvider.META_AGENT_ALLOWED_TOOLS,
        } : {}),
        raw: {
          systemPrompt,
          abortSignal: abortController.signal,
        },
      };

      const isResumedSession = !!existingSessionId;
      const session = isResumedSession
        ? await this.protocol.resumeSession(existingSessionId, sessionOptions)
        : await this.protocol.createSession(sessionOptions);

      this._initData = {
        model: resolvedModel,
        mcpServerCount: Object.keys(mcpServers).length,
        isResumedSession,
        permissionMode: permissionDecision.permissionMode ?? null,
      };

      const transcriptAdapter = new AgentProtocolTranscriptAdapter(null, sessionId ?? '');

      transcriptAdapter.userMessage(
        messageWithAttachmentHints,
        documentContext?.mode === 'planning' ? 'planning' : 'agent',
        attachments as any,
      );

      for await (const event of this.protocol.sendMessage(session, {
        content: messageWithAttachmentHints,
        attachments,
        sessionId,
        mode: documentContext?.mode || 'agent',
        // System prompt rides in via raw_event handling rather than in the
        // first user turn body so canonical events stay clean.
        ...({ systemPrompt } as Record<string, unknown>),
      } as any)) {
        if (abortController.signal.aborted) {
          throw new Error('Operation cancelled');
        }

        if (sessionId) {
          try {
            await this.storeRawEventIfPresent(event, sessionId);
          } catch {
            // DB unavailable during tests
          }
          // Drive the transcript transformer incrementally so canonical events
          // appear in the UI while the ACP session is still streaming -- not
          // only after a session reload triggers ensureUpToDate. Without this,
          // each agent_message_chunk raw event sits unprocessed until the
          // throttled DB reload catches up, so the user sees no live updates.
          await this.processTranscriptMessages(sessionId);
        }

        for (const item of transcriptAdapter.processEvent(event)) {
          switch (item.kind) {
            case 'text':
              fullText += item.text;
              yield { type: 'text', content: item.text };
              break;
            case 'tool_call':
              yield { type: 'tool_call', toolCall: item.toolCall };
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
            case 'unknown':
              break;
          }
        }
      }

      if (sessionId && session.id) {
        if (session.id !== existingSessionId) {
          if (isResumedSession) {
            throw new Error(
              `[CODEX-ACP] Session resume mismatch: requested resume of "${existingSessionId}" but protocol returned session "${session.id}".`
            );
          }
          this.sessions.captureSessionId(sessionId, session.id);
        }
      }
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      const isAbort = abortController.signal.aborted || /abort|cancel/i.test(errorMessage);
      if (!isAbort) {
        yield { type: 'error', error: errorMessage };
      }
    } finally {
      if (this.abortController === abortController) {
        this.abortController = null;
      }
    }
  }

  resolveToolPermission(
    requestId: string,
    response: { decision: 'allow' | 'deny'; scope: 'once' | 'session' | 'always' | 'always-all' },
    sessionId?: string,
    respondedBy: 'desktop' | 'mobile' | 'telegram' = 'desktop'
  ): void {
    this.permissionService.resolvePermission(requestId, response);

    if (sessionId) {
      void this.logAgentMessageBestEffort(
        sessionId,
        'output',
        this.createPermissionResultMessage(requestId, response, respondedBy)
      );
    }
  }

  abort(): void {
    this.permissionService.rejectAllPending();
    super.abort();
  }

  cleanupSession(sessionId: string): void {
    this.sessions.deleteSession(sessionId);
  }

  destroy(): void {
    this.permissionService.clearSessionCache();
    this.protocol.destroy();
    super.destroy();
  }

  protected buildSystemPrompt(documentContext?: DocumentContext, isMetaAgent: boolean = false, workflowPreset: MetaAgentWorkflowPreset = 'default'): string {
    if (isMetaAgent) {
      return buildMetaAgentSystemPrompt('codex', workflowPreset, {
        provider: 'openai-codex-acp',
        model: this.config?.model ?? undefined,
      });
    }

    const hasSessionNaming = isInternalMcpServerEnabled();
    const worktreePath = documentContext?.worktreePath;
    const isVoiceMode = (documentContext as any)?.isVoiceMode;
    const voiceModeCodingAgentPrompt = (documentContext as any)?.voiceModeCodingAgentPrompt;

    return buildClaudeCodeSystemPrompt({
      hasSessionNaming,
      toolReferenceStyle: 'codex',
      worktreePath,
      isVoiceMode,
      voiceModeCodingAgentPrompt,
      enableAgentTeams: false,
      trackersEnabled: areTrackerToolsEnabled(resolveTrackersWorkspacePath(documentContext)),
    });
  }

  private async getConfiguredModel(): Promise<string> {
    const configured = this.config?.model || OpenAICodexACPProvider.DEFAULT_MODEL;
    const parsed = ModelIdentifier.tryParse(configured);
    const resolved = parsed
      ? parsed.model
      : configured
          .replace(/^openai-codex-acp:/, '')
          .replace(/^openai-codex:/, '');
    const normalized = resolved.toLowerCase();
    if (!normalized || normalized === 'default' || normalized === 'cli') {
      return 'gpt-5.6-sol';
    }
    return resolved;
  }

  private appendAttachmentHints(message: string, attachments?: ChatAttachment[]): string {
    if (!attachments || attachments.length === 0) {
      return message;
    }
    const attachmentList = attachments
      .map((attachment) => {
        const displayName =
          attachment.filename ||
          (attachment.filepath ? path.basename(attachment.filepath) : attachment.id || 'attachment');
        return `- ${displayName}${attachment.filepath ? ` (${attachment.filepath})` : ''}`;
      })
      .join('\n');

    return `${message}\n\nAttached files:\n${attachmentList}`;
  }

  /**
   * Permission gate before initiating a turn. Mirrors OpenAICodexProvider --
   * ACP supports per-tool callbacks but we still gate the whole turn at trust
   * level so ACP behaves consistently with the SDK provider.
   */
  private async requestCodexTurnPermission(
    _sessionId: string | undefined,
    workspacePath: string,
    permissionsPath: string,
    _signal: AbortSignal
  ): Promise<{ decision: 'allow' | 'deny'; reason?: string; permissionMode?: PermissionMode }> {
    const pathForTrust = permissionsPath || workspacePath;

    if (pathForTrust && BaseAgentProvider.trustChecker) {
      const trustStatus = BaseAgentProvider.trustChecker(pathForTrust);

      if (!trustStatus.trusted) {
        this.logSecurity('[OpenAICodexACPProvider] Workspace not trusted, denying Codex ACP turn', {
          workspacePath: pathForTrust,
        });
        return {
          decision: 'deny',
          reason: 'Workspace is not trusted. Please trust this workspace to use OpenAI Codex (ACP).',
        };
      }

      // ACP supports tool-level permission callbacks, so unlike the SDK
      // provider we can run in "ask" mode: the protocol fires
      // requestPermission for risky operations and we route them through
      // ToolPermissionService.
      return { decision: 'allow', permissionMode: trustStatus.mode };
    }

    return { decision: 'allow' };
  }

  /**
   * Persist raw ACP protocol events to ai_agent_messages so the
   * CodexACPRawParser can reconstruct the canonical transcript.
   */
  private async storeRawEventIfPresent(event: ProtocolEvent, sessionId: string): Promise<void> {
    if (event.type !== 'raw_event' || !event.metadata?.rawEvent) {
      return;
    }

    const { content } = safeJSONSerialize(event.metadata.rawEvent);
    const rawEventType = this.getRawEventType(event.metadata.rawEvent);

    await this.logAgentMessage(
      sessionId,
      this.getProviderName(),
      'output',
      content,
      {
        eventType: rawEventType,
        codexAcpProvider: true,
      },
      false,
      undefined,
      false,
    );
  }

  private getRawEventType(rawEvent: unknown): string {
    if (rawEvent && typeof rawEvent === 'object') {
      const eventType = (rawEvent as Record<string, unknown>).type;
      if (typeof eventType === 'string' && eventType.trim().length > 0) {
        return eventType;
      }
    }
    return 'unknown';
  }

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
