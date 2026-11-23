/**
 * Gemini agent provider (`antigravity-gemini-agent`), backed by the Antigravity
 * CLI's ACP stdio server (`agy acp`).
 *
 * Reuses the shared `CodexACPProtocol` stdio ACP client (parameterized with
 * `agy` command/args, platform id, permission-mode mapping, and model/effort
 * application) instead of maintaining a separate ACP transport or the legacy
 * Connect-RPC tool loop.
 *
 * Provider id `antigravity-gemini-agent` is kept unchanged so existing sessions,
 * settings, and icons continue working without migration.
 */

import { randomUUID } from 'crypto';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { BaseAgentProvider } from './BaseAgentProvider';
import { buildUserMessageAddition } from './documentContextUtils';
import { describeUnusableWorkspacePath } from './workspacePreconditions';
import { buildClaudeCodeSystemPrompt, buildMetaAgentSystemPrompt, type MetaAgentWorkflowPreset } from '../../prompt';
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
import { CodexACPProtocol, type ACPToolPermissionRequest } from '../protocols/CodexACPProtocol';
import { ProtocolEvent } from '../protocols/ProtocolInterface';
import { ToolPermissionService } from '../permissions/ToolPermissionService';
import { generateToolPattern } from '../permissions/toolPermissionHelpers';
import { handleToolPermissionFallback } from './claudeCode/toolAuthorization';
import {
  PermissionMode,
  TrustChecker,
  PermissionPatternSaver,
  PermissionPatternChecker,
  SecurityLogger,
} from './ProviderPermissionMixin';
import { McpConfigService } from '../services/McpConfigService';
import { MCP_CORE, MCP_HOST, MCP_TRACKERS, MCP_SITUATIONAL } from '../services/mcpTopology';
import {
  getMcpConfigService,
  isInternalMcpServerEnabled,
  areTrackerToolsEnabled,
  resolveTrackersWorkspacePath,
} from '../services/mcpServerConfig';
import { MCPServerConfig } from '../../../types/MCPServerConfig';
import { safeJSONSerialize } from '../../../utils/serialization';
import { AgentProtocolTranscriptAdapter } from './agentProtocol/AgentProtocolTranscriptAdapter';
import { TranscriptMigrationRepository } from '../../../storage/repositories/TranscriptMigrationRepository';
import {
  DEFAULT_GEMINI_MODEL_KEY,
  bareGeminiModelKey,
  discoverAgyModels,
  resolveAgyBinaryPath,
} from './geminiAntigravity/geminiAntigravityModels';
import {
  AntigravityServerManager,
  readAgyHttpsPortFromLogFile,
} from './geminiAntigravity/AntigravityServerManager';

export const GEMINI_ANTIGRAVITY_PROVIDER: AIProviderType = 'antigravity-gemini-agent';

// agy loads MCP tool schemas only up to a fixed token budget (~57KB of tool
// JSON on our PC) and silently drops the largest tools past it, so pass only
// the Nimbalyst tools Gemini needs. Keep the total <= 45KB. The budget is
// shared with skills, plugins and workspace rules, so the share left for MCP
// differs per environment (some users get cut off near 16KB), and ACP
// mcpServers are forced eager (can't be made lazy or disabled):
// https://github.com/google-antigravity/antigravity-cli/issues/1530
export const AGY_MCP_TOOL_ALLOWLIST: Record<string, readonly string[]> = {
  [MCP_CORE]: [
    'PromptForUserInput',
    'developer_git_commit_proposal',
    'display_to_user',
    'update_session_meta',
    'AskUserQuestion',
    'capture_editor_screenshot',
    'get_session_edited_files',
  ],
  [MCP_HOST]: [
    'spawn_session',
    'send_prompt',
    'update_session_board',
    'list_spawned_sessions',
    'get_session_status',
    'get_session_result',
    'get_session_summary',
    'get_workstream_overview',
    'list_recent_sessions',
    'schedule_wakeup',
    'notify_user',
    'respond_to_prompt',
    'list_queued_prompts',
    'consume_session_inbox',
    'get_workstream_edited_files',
    'list_worktrees',
  ],
  [MCP_TRACKERS]: [
    'tracker_list',
    'tracker_get',
    'tracker_create',
    'tracker_update',
    'tracker_add_comment',
    'tracker_link_session',
    'tracker_list_types',
    'work_radar',
    'tracker_get_by_urn',
    'tracker_link_file',
  ],
  [MCP_SITUATIONAL]: ['searchPages', 'readCollabDoc'],
};

const AGY_FILE_TOOLS = new Set(['Edit', 'Write', 'ApplyPatch', 'Read', 'Glob', 'Grep', 'LS', 'NotebookEdit', 'WebSearch', 'WebFetch']);

/**
 * Map Nimbalyst workspace permission modes to Antigravity ACP (`agy acp`)
 * session modes (`default`, `accept-edits`, `auto`, `plan`).
 */
export function mapAgyPermissionMode(permissionMode: string): string {
  if (permissionMode === 'bypass-all') {
    return 'auto';
  }
  if (permissionMode === 'allow-all') {
    return 'accept-edits';
  }
  return 'default';
}

interface GeminiAntigravityProviderDeps {
  protocol?: CodexACPProtocol;
  permissionService?: ToolPermissionService;
  acpLogFilePath?: string;
}

export class GeminiAntigravityProvider extends BaseAgentProvider {
  static readonly DEFAULT_MODEL = `${GEMINI_ANTIGRAVITY_PROVIDER}:${DEFAULT_GEMINI_MODEL_KEY}`;

  static readonly NOT_INSTALLED_MESSAGE =
    'The Antigravity CLI (`agy`) is not installed. Install it from https://antigravity.google, '
    + 'run `agy acp --login` to sign in, then try again — Nimbalyst uses that login and stores no key of its own.';

  static readonly NOT_SIGNED_IN_MESSAGE =
    'Antigravity CLI (`agy`) is installed but not signed in. Run `agy acp --login` '
    + 'in your terminal to sign in to your Google account, then try again.';

  private readonly protocol: CodexACPProtocol;
  private readonly permissionService: ToolPermissionService | null;
  private readonly mcpConfigService: McpConfigService;

  private _initData: {
    model: string;
    mcpServerCount: number;
    isResumedSession: boolean;
    permissionMode: string | null;
  } | null = null;

  private readonly activeTurnContext = new Map<string, {
    nimbalystSessionId?: string;
    workspacePath: string;
    permissionsPath: string;
    signal: AbortSignal;
  }>();
  private acpLogFilePath: string | null = null;
  private registeredEndpointPort: number | null = null;

  private static mcpConfigLoader: ((workspacePath?: string) => Promise<Record<string, MCPServerConfig>>) | null = null;
  private static claudeSettingsEnvLoader: (() => Promise<Record<string, string>>) | null = null;
  private static shellEnvironmentLoader: (() => Record<string, string> | null) | null = null;
  private static enhancedPathLoader: (() => string) | null = null;
  private static agyPathLoader: (() => string | null) | null = null;
  private static onBeforeFileWrite: ((filePath: string, sessionId: string | undefined) => Promise<void>) | null = null;
  private static onTurnFilesEdited: ((filePaths: Set<string>, sessionId: string | undefined) => Promise<void>) | null = null;

  constructor(deps?: GeminiAntigravityProviderDeps) {
    super();

    if (deps?.protocol) {
      this.protocol = deps.protocol;
      this.acpLogFilePath = deps.acpLogFilePath ?? null;
    } else {
      this.protocol = new CodexACPProtocol('', {
        platform: 'antigravity-gemini-acp',
        agentLabel: 'Antigravity ACP',
        logPrefix: 'GeminiACPProtocol',
        apiKeyEnvVar: null,
        commandResolver: () => GeminiAntigravityProvider.resolveCommand(),
        args: ['acp'],
        argsResolver: () => this.prepareAcpArgs(),
        envLoader: () => GeminiAntigravityProvider.buildChildEnv(),
        mapPermissionMode: mapAgyPermissionMode,
        applyModel: true,
        onBeforeFileWrite: GeminiAntigravityProvider.onBeforeFileWrite ?? undefined,
        onTurnFilesEdited: GeminiAntigravityProvider.onTurnFilesEdited ?? undefined,
        onPermissionRequest: (request) => this.handleProtocolPermissionRequest(request),
        onProcessExit: () => this.clearAcpEndpointAndLog(),
      });
    }

    if (deps?.permissionService) {
      this.permissionService = deps.permissionService;
    } else if (
      BaseAgentProvider.trustChecker
      && BaseAgentProvider.permissionPatternSaver
      && BaseAgentProvider.permissionPatternChecker
    ) {
      this.permissionService = new ToolPermissionService({
        trustChecker: BaseAgentProvider.trustChecker as TrustChecker,
        patternSaver: BaseAgentProvider.permissionPatternSaver as PermissionPatternSaver,
        patternChecker: BaseAgentProvider.permissionPatternChecker as PermissionPatternChecker,
        securityLogger: BaseAgentProvider.securityLogger ?? undefined,
        emit: this.emit.bind(this),
      });
    } else {
      this.permissionService = null;
    }

    this.mcpConfigService = getMcpConfigService({
      mcpConfigLoader: GeminiAntigravityProvider.mcpConfigLoader,
      claudeSettingsEnvLoader: GeminiAntigravityProvider.claudeSettingsEnvLoader,
      shellEnvironmentLoader: GeminiAntigravityProvider.shellEnvironmentLoader,
    });
  }

  getProviderName(): AIProviderType {
    return GEMINI_ANTIGRAVITY_PROVIDER;
  }

  getName(): string {
    return GEMINI_ANTIGRAVITY_PROVIDER;
  }

  getDisplayName(): string {
    return 'Gemini';
  }

  getDescription(): string {
    return 'Google Gemini agent over the Antigravity CLI ACP server';
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

  getProviderSessionData(sessionId: string): {
    providerSessionId?: string;
    geminiAcpSessionId?: string;
  } {
    const { providerSessionId } = this.sessions.getProviderSessionData(sessionId);
    return {
      providerSessionId,
      geminiAcpSessionId: providerSessionId,
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
  public static setMCPConfigLoader(loader: ((workspacePath?: string) => Promise<Record<string, MCPServerConfig>>) | null): void {
    GeminiAntigravityProvider.mcpConfigLoader = loader;
  }
  public static setClaudeSettingsEnvLoader(loader: (() => Promise<Record<string, string>>) | null): void {
    GeminiAntigravityProvider.claudeSettingsEnvLoader = loader;
  }
  public static setShellEnvironmentLoader(loader: (() => Record<string, string> | null) | null): void {
    GeminiAntigravityProvider.shellEnvironmentLoader = loader;
  }
  public static setEnhancedPathLoader(loader: (() => string) | null): void {
    GeminiAntigravityProvider.enhancedPathLoader = loader;
  }
  public static setAgyPathLoader(loader: (() => string | null) | null): void {
    GeminiAntigravityProvider.agyPathLoader = loader;
  }
  public static setOnBeforeFileWrite(handler: ((filePath: string, sessionId: string | undefined) => Promise<void>) | null): void {
    GeminiAntigravityProvider.onBeforeFileWrite = handler;
  }
  public static setOnTurnFilesEdited(handler: ((filePaths: Set<string>, sessionId: string | undefined) => Promise<void>) | null): void {
    GeminiAntigravityProvider.onTurnFilesEdited = handler;
  }

  async initialize(config: ProviderConfig): Promise<void> {
    this.config = config;
  }

  /** True when the Antigravity CLI (`agy`) binary is present. */
  static isInstalled(): boolean {
    return GeminiAntigravityProvider.installPath() !== null;
  }

  /** Resolved path to the `agy` binary, or null if not found. */
  static installPath(): string | null {
    const explicit = GeminiAntigravityProvider.agyPathLoader?.();
    if (explicit) return explicit;
    return resolveAgyBinaryPath({
      enhancedPath: GeminiAntigravityProvider.safeLoadEnhancedPath(),
    });
  }

  static getDefaultModel(): string {
    return GeminiAntigravityProvider.DEFAULT_MODEL;
  }

  static async getModels(): Promise<AIModel[]> {
    const models = await discoverAgyModels({
      command: GeminiAntigravityProvider.installPath(),
      env: GeminiAntigravityProvider.buildChildEnv(),
    });
    return models.map((m) => ({
      id: ModelIdentifier.create(GEMINI_ANTIGRAVITY_PROVIDER, m.key).combined,
      name: m.displayName,
      provider: GEMINI_ANTIGRAVITY_PROVIDER,
    }));
  }

  async handleToolCall(
    toolCall: AIToolCall,
    _options?: { sessionId?: string; workingDirectory?: string },
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
        result: (error as { toolResult?: unknown })?.toolResult,
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
    _messages?: unknown[],
    workspacePath?: string,
    attachments?: ChatAttachment[],
  ): AsyncIterableIterator<StreamChunk> {
    const unusableWorkspace = describeUnusableWorkspacePath(workspacePath);
    if (unusableWorkspace || !workspacePath) {
      yield { type: 'error', error: unusableWorkspace ?? 'No project folder is set for this session.' };
      return;
    }

    const agentRole = await this.getAgentRole(sessionId);
    const isMetaAgent = agentRole === 'meta-agent';
    const workflowPreset = isMetaAgent ? await this.getWorkflowPreset(sessionId) : 'default';
    const sessionDirective = await this.getSessionDirective(sessionId);
    const systemPrompt = this.buildSystemPrompt(
      documentContext,
      isMetaAgent,
      workflowPreset,
      sessionDirective,
      this.isNamedOutOfBand(sessionId, documentContext),
    );
    const { userMessageAddition, messageWithContext } = buildUserMessageAddition(message, documentContext);
    const unsupportedAttachmentHints = attachments?.filter(
      (attachment) => attachment.type !== 'image' && attachment.type !== 'document',
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
      const metadataToLog: Record<string, unknown> = this.withPromptProvenanceMetadata(documentContext);
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

    let trackedAcpSessionId: string | null = null;

    try {
      const permissionDecision = await this.requestTurnPermission(
        workspacePath,
        permissionsPath,
      );

      if (permissionDecision.decision !== 'allow') {
        yield {
          type: 'error',
          error: permissionDecision.reason || 'Gemini turn denied',
        };
        return;
      }

      const existingSessionId = this.sessions.getSessionId(sessionId || '');
      const mcpServers = await this.mcpConfigService.getMcpServersConfig({
        sessionId,
        workspacePath: mcpConfigWorkspacePath,
        profile: isMetaAgent ? 'meta-agent' : 'standard',
        toolAllowlist: AGY_MCP_TOOL_ALLOWLIST,
      });

      const resolvedModel = this.getConfiguredModel();
      const effortLevel = this.config?.effortLevel;

      const sessionOptions = {
        workspacePath,
        model: resolvedModel,
        ...(permissionDecision.permissionMode ? { permissionMode: permissionDecision.permissionMode } : {}),
        mcpServers,
        ...(isMetaAgent ? { allowedTools: BaseAgentProvider.META_AGENT_ALLOWED_TOOLS } : {}),
        raw: {
          systemPrompt,
          abortSignal: abortController.signal,
          ...(effortLevel ? { effortLevel } : {}),
        },
      };

      const isResumedSession = !!existingSessionId;
      const session = isResumedSession
        ? await this.protocol.resumeSession(existingSessionId, sessionOptions)
        : await this.protocol.createSession(sessionOptions);

      // `agy acp` starts its embedded HTTPS language server during session
      // creation and logs its random port to `--cli_log_file`. Register it so
      // `GeminiUsageService` can poll GetUserStatus without spawning a hub.
      await this.syncAgyLanguageServerEndpoint();

      trackedAcpSessionId = session.id;
      this.activeTurnContext.set(session.id, {
        nimbalystSessionId: sessionId,
        workspacePath,
        permissionsPath,
        signal: abortController.signal,
      });

      this._initData = {
        model: session.appliedModel ?? resolvedModel,
        mcpServerCount: session.deliveredMcpServerCount ?? Object.keys(mcpServers).length,
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
        abortSignal: abortController.signal,
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
          await this.processTranscriptMessages(sessionId);
        }

        for (const item of transcriptAdapter.processEvent(event)) {
          switch (item.kind) {
            case 'text':
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
                ...(item.event.contextFillTokens !== undefined
                  ? { contextFillTokens: item.event.contextFillTokens }
                  : {}),
                ...(item.event.contextWindow !== undefined
                  ? { contextWindow: item.event.contextWindow }
                  : {}),
              };
              break;
            case 'error':
              yield this.classifyErrorChunk(item.message);
              break;
            case 'raw_event':
            case 'reasoning':
            case 'unknown':
              break;
          }
        }
      }

      if (this.registeredEndpointPort === null) {
        await this.syncAgyLanguageServerEndpoint();
      }

      if (sessionId && session.id && session.id !== existingSessionId) {
        this.sessions.captureSessionId(sessionId, session.id);
      }
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      const isAbort = abortController.signal.aborted || /abort|cancel/i.test(errorMessage);
      if (!isAbort) {
        yield this.classifyErrorChunk(errorMessage);
      }
    } finally {
      if (trackedAcpSessionId) {
        this.activeTurnContext.delete(trackedAcpSessionId);
      }
      if (this.abortController === abortController) {
        this.abortController = null;
      }
    }
  }

  resolveToolPermission(
    requestId: string,
    response: { decision: 'allow' | 'deny'; scope: 'once' | 'session' | 'always' | 'always-all' },
    sessionId?: string,
    respondedBy: 'desktop' | 'mobile' = 'desktop',
  ): void {
    this.permissionService?.resolvePermission(requestId, response);
    super.resolveToolPermission(requestId, response, sessionId, respondedBy);
  }

  abort(): void {
    this.permissionService?.rejectAllPending();
    super.abort();
  }

  cleanupSession(sessionId: string): void {
    this.sessions.deleteSession(sessionId);
  }

  destroy(): void {
    this.permissionService?.clearSessionCache();
    this.activeTurnContext.clear();
    this.protocol.destroy();
    this.clearAcpEndpointAndLog();
    super.destroy();
  }

  private prepareAcpArgs(): string[] {
    this.clearAcpEndpointAndLog();
    const logPath = path.join(os.tmpdir(), `nimbalyst-agy-acp-${process.pid}-${randomUUID()}.log`);
    this.acpLogFilePath = logPath;
    return ['acp', '--cli_log_file', logPath];
  }

  private async syncAgyLanguageServerEndpoint(): Promise<void> {
    if (!this.acpLogFilePath) {
      return;
    }
    const port = await readAgyHttpsPortFromLogFile(this.acpLogFilePath);
    if (port !== null && port !== this.registeredEndpointPort) {
      this.registeredEndpointPort = port;
      AntigravityServerManager.shared().registerExternalEndpoint({
        httpsPort: port,
        csrf: '',
      });
    }
  }

  private clearAcpEndpointAndLog(): void {
    if (this.registeredEndpointPort !== null) {
      AntigravityServerManager.shared().clearExternalEndpoint(this.registeredEndpointPort);
      this.registeredEndpointPort = null;
    }
    const logPath = this.acpLogFilePath;
    this.acpLogFilePath = null;
    if (logPath) {
      fs.unlink(logPath, () => {
        /* best-effort cleanup of temp agy acp log */
      });
    }
  }

  protected buildSystemPrompt(
    documentContext?: DocumentContext,
    isMetaAgent: boolean = false,
    workflowPreset: MetaAgentWorkflowPreset = 'default',
    sessionDirective?: string,
    hasOutOfBandNaming: boolean = false,
  ): string {
    if (isMetaAgent) {
      return buildMetaAgentSystemPrompt('codex', workflowPreset, {
        provider: GEMINI_ANTIGRAVITY_PROVIDER,
        model: this.config?.model ?? undefined,
        sessionDirective,
      });
    }

    const hasSessionNaming = isInternalMcpServerEnabled();
    const worktreePath = documentContext?.worktreePath;
    const isVoiceMode = (documentContext as any)?.isVoiceMode;
    const voiceModeCodingAgentPrompt = (documentContext as any)?.voiceModeCodingAgentPrompt;

    return buildClaudeCodeSystemPrompt({
      hasSessionNaming,
      hasOutOfBandNaming,
      toolReferenceStyle: 'codex',
      worktreePath,
      sessionDirective,
      isVoiceMode,
      voiceModeCodingAgentPrompt,
      enableAgentTeams: false,
      trackersEnabled: areTrackerToolsEnabled(resolveTrackersWorkspacePath(documentContext)),
    });
  }

  private getConfiguredModel(): string {
    return bareGeminiModelKey(this.config?.model);
  }

  private classifyErrorChunk(errorMessage: string): StreamChunk {
    if (/ENOENT|not found|not recognized|spawn agy/i.test(errorMessage)) {
      return { type: 'error', error: GeminiAntigravityProvider.NOT_INSTALLED_MESSAGE };
    }
    if (/not logged in|not authenticated|not signed in|unauthenticated|unauthorized|forbidden|auth.*required|HTTP 401|HTTP 403/i.test(errorMessage)) {
      return {
        type: 'error',
        error: GeminiAntigravityProvider.NOT_SIGNED_IN_MESSAGE,
        isAuthError: true,
      };
    }
    return { type: 'error', error: errorMessage };
  }

  private appendAttachmentHints(message: string, attachments?: ChatAttachment[]): string {
    if (!attachments || attachments.length === 0) {
      return message;
    }
    const attachmentList = attachments
      .map((attachment) => {
        const displayName =
          attachment.filename
          || (attachment.filepath ? path.basename(attachment.filepath) : attachment.id || 'attachment');
        return `- ${displayName}${attachment.filepath ? ` (${attachment.filepath})` : ''}`;
      })
      .join('\n');

    return `${message}\n\nAttached files:\n${attachmentList}`;
  }

  private async requestTurnPermission(
    workspacePath: string,
    permissionsPath: string,
  ): Promise<{ decision: 'allow' | 'deny'; reason?: string; permissionMode?: PermissionMode }> {
    const pathForTrust = permissionsPath || workspacePath;
    if (pathForTrust && BaseAgentProvider.trustChecker) {
      const trustStatus = BaseAgentProvider.trustChecker(pathForTrust);
      if (!trustStatus.trusted) {
        this.logSecurity('[GeminiAntigravityProvider] Workspace not trusted, denying Gemini turn', {
          workspacePath: pathForTrust,
        });
        return {
          decision: 'deny',
          reason: 'Workspace is not trusted. Please trust this workspace to use Gemini.',
        };
      }
      return { decision: 'allow', permissionMode: trustStatus.mode };
    }
    return { decision: 'allow' };
  }

  private async handleProtocolPermissionRequest(
    request: ACPToolPermissionRequest,
  ): Promise<{ decision: 'allow' | 'deny'; scope: 'once' | 'session' | 'always' | 'always-all' }> {
    const ctx = this.activeTurnContext.get(request.sessionId);
    const permissionsPath = ctx?.permissionsPath || ctx?.workspacePath;
    const trust = permissionsPath ? BaseAgentProvider.trustChecker?.(permissionsPath) : null;

    if (!trust) {
      return { decision: 'allow', scope: 'once' };
    }
    if (!trust.trusted) {
      return { decision: 'deny', scope: 'once' };
    }
    if (trust.mode === 'bypass-all') {
      return { decision: 'allow', scope: 'once' };
    }
    if (trust.mode === 'allow-all' && AGY_FILE_TOOLS.has(request.toolName)) {
      return { decision: 'allow', scope: 'once' };
    }

    const input = (
      request.toolInput && typeof request.toolInput === 'object' && !Array.isArray(request.toolInput)
        ? request.toolInput
        : {}
    ) as Record<string, unknown>;

    if (permissionsPath) {
      const pattern = generateToolPattern(request.toolName, input);
      if (
        BaseAgentProvider.permissionPatternChecker
        && await BaseAgentProvider.permissionPatternChecker(permissionsPath, pattern)
      ) {
        this.permissions.sessionApprovedPatterns.add(pattern);
        return { decision: 'allow', scope: 'always' };
      }
    }

    if (!ctx?.nimbalystSessionId) {
      return { decision: 'allow', scope: 'once' };
    }

    const authorization = await handleToolPermissionFallback(
      {
        permissions: this.permissions,
        logSecurity: (msg, data) => this.logSecurity(msg, data),
        logAgentMessage: (sid, content) =>
          this.logAgentMessage(sid, this.getProviderName(), 'output', content),
        emit: (event, payload) => this.emit(event, payload),
        pollForPermissionResponse: (sid, reqId, signal) =>
          this.pollForPermissionResponse(sid, reqId, signal),
        savePattern: BaseAgentProvider.permissionPatternSaver ?? undefined,
        logError: (msg, error) => console.error(msg, error),
      },
      {
        toolName: request.toolName,
        input,
        options: { signal: ctx.signal, toolUseID: request.requestId },
        sessionId: ctx.nimbalystSessionId,
        workspacePath: permissionsPath,
      },
    );

    return {
      decision: authorization.behavior === 'allow' ? 'allow' : 'deny',
      scope: 'once',
    };
  }

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
        geminiAcpProvider: true,
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
      // Best effort -- next chunk or end-of-turn ensureUpToDate catches up.
    }
  }

  private static resolveCommand(): string {
    return GeminiAntigravityProvider.installPath() ?? (process.platform === 'win32' ? 'agy.exe' : 'agy');
  }

  private static safeLoadEnhancedPath(): string | undefined {
    try {
      return GeminiAntigravityProvider.enhancedPathLoader?.() || undefined;
    } catch {
      return undefined;
    }
  }

  private static buildChildEnv(): Record<string, string> {
    const shellEnv = GeminiAntigravityProvider.shellEnvironmentLoader?.() ?? {};
    const enhancedPath = GeminiAntigravityProvider.safeLoadEnhancedPath();
    return {
      ...shellEnv,
      ...(enhancedPath ? { PATH: enhancedPath } : {}),
    };
  }
}
