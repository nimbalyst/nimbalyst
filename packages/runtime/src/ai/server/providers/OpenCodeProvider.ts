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
import { buildClaudeCodeSystemPrompt } from '../../prompt';
import { DEFAULT_MODELS, OPENCODE_PRESET_MODELS } from '../../modelConstants';
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
import { McpConfigService } from '../services/McpConfigService';
import { MCPServerConfig } from '../../../types/MCPServerConfig';
import { safeJSONSerialize } from '../../../utils/serialization';
import { AgentProtocolTranscriptAdapter } from './agentProtocol/AgentProtocolTranscriptAdapter';
import { TranscriptMigrationRepository } from '../../../storage/repositories/TranscriptMigrationRepository';

interface OpenCodeProviderDeps {
  protocol?: OpenCodeSDKProtocol;
}

/**
 * Subset of OpenCode's `opencode.json` schema we care about for surfacing
 * configured providers/models to the picker. OpenCode accepts many more
 * fields -- we only read what we need and pass everything else through
 * untouched on writes.
 */
export interface OpenCodeFileProviderModel {
  name?: string;
}

export interface OpenCodeFileProvider {
  name?: string;
  npm?: string;
  options?: Record<string, unknown>;
  models?: Record<string, OpenCodeFileProviderModel>;
}

export interface OpenCodeFileConfig {
  $schema?: string;
  model?: string;
  autoupdate?: boolean;
  share?: 'manual' | 'auto' | 'disabled';
  provider?: Record<string, OpenCodeFileProvider>;
  [key: string]: unknown;
}

export class OpenCodeProvider extends BaseAgentProvider {
  static readonly DEFAULT_MODEL = DEFAULT_MODELS['opencode'];

  private readonly protocol: OpenCodeSDKProtocol;
  private readonly mcpConfigService: McpConfigService;

  // Analytics initialization data, captured during first sendMessage call
  private _initData: {
    model: string;
    mcpServerCount: number;
    isResumedSession: boolean;
  } | null = null;

  // Shared MCP server ports (injected from electron main process)
  private static mcpServerPort: number | null = null;
  private static sessionNamingServerPort: number | null = null;
  private static extensionDevServerPort: number | null = null;
  private static superLoopProgressServerPort: number | null = null;
  private static sessionContextServerPort: number | null = null;
  private static settingsServerPort: number | null = null;
  private static settingsAgentToolsDisabledLoader: (() => boolean) | null = null;
  // Per-launch bearer token for the internal Nimbalyst MCP HTTP servers (Issue #146)
  private static mcpAuthToken: string | null = null;

  // MCP config loader (injected from electron main process)
  private static mcpConfigLoader: ((workspacePath?: string) => Promise<Record<string, MCPServerConfig>>) | null = null;

  // OpenCode config loader (injected from electron main process). Returns the
  // parsed opencode.json so we can surface user-configured providers/models in
  // the picker. Optional -- if missing we just return the preset list.
  private static configLoader: (() => Promise<OpenCodeFileConfig | null>) | null = null;

  // Shell environment loader (injected from electron main process)
  private static shellEnvironmentLoader: (() => Record<string, string> | null) | null = null;

  // Enhanced PATH loader (injected from electron main process)
  private static enhancedPathLoader: (() => string) | null = null;

  constructor(deps?: OpenCodeProviderDeps) {
    super();

    // Initialize protocol (or use injected for testing)
    this.protocol = deps?.protocol || new OpenCodeSDKProtocol();

    // Initialize MCP config service
    this.mcpConfigService = new McpConfigService({
      mcpServerPort: OpenCodeProvider.mcpServerPort,
      sessionNamingServerPort: OpenCodeProvider.sessionNamingServerPort,
      extensionDevServerPort: OpenCodeProvider.extensionDevServerPort,
      superLoopProgressServerPort: OpenCodeProvider.superLoopProgressServerPort,
      sessionContextServerPort: OpenCodeProvider.sessionContextServerPort,
      settingsServerPort: OpenCodeProvider.settingsServerPort,
      settingsAgentToolsDisabledLoader: OpenCodeProvider.settingsAgentToolsDisabledLoader,
      mcpAuthToken: OpenCodeProvider.mcpAuthToken,
      mcpConfigLoader: OpenCodeProvider.mcpConfigLoader,
      claudeSettingsEnvLoader: null,
      shellEnvironmentLoader: OpenCodeProvider.shellEnvironmentLoader,
    });
  }

  async initialize(config: ProviderConfig): Promise<void> {
    this.config = config;
  }

  getProviderName(): string {
    return 'opencode';
  }

  // Static injection setters (called from electron main process at startup)
  public static setMcpServerPort(port: number | null): void {
    OpenCodeProvider.mcpServerPort = port;
  }

  public static setSessionNamingServerPort(port: number | null): void {
    OpenCodeProvider.sessionNamingServerPort = port;
  }

  public static setExtensionDevServerPort(port: number | null): void {
    OpenCodeProvider.extensionDevServerPort = port;
  }

  public static setSuperLoopProgressServerPort(port: number | null): void {
    OpenCodeProvider.superLoopProgressServerPort = port;
  }

  public static setSessionContextServerPort(port: number | null): void {
    OpenCodeProvider.sessionContextServerPort = port;
  }

  public static setSettingsServerPort(port: number | null): void {
    OpenCodeProvider.settingsServerPort = port;
  }

  public static setSettingsAgentToolsDisabledLoader(loader: (() => boolean) | null): void {
    OpenCodeProvider.settingsAgentToolsDisabledLoader = loader;
  }

  public static setMcpAuthToken(token: string | null): void {
    OpenCodeProvider.mcpAuthToken = token;
  }

  public static setMcpConfigLoader(loader: ((workspacePath?: string) => Promise<Record<string, MCPServerConfig>>) | null): void {
    OpenCodeProvider.mcpConfigLoader = loader;
  }

  public static setShellEnvironmentLoader(loader: (() => Record<string, string> | null) | null): void {
    OpenCodeProvider.shellEnvironmentLoader = loader;
  }

  public static setEnhancedPathLoader(loader: (() => string) | null): void {
    OpenCodeProvider.enhancedPathLoader = loader;
  }

  public static setConfigLoader(loader: (() => Promise<OpenCodeFileConfig | null>) | null): void {
    OpenCodeProvider.configLoader = loader;
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

  /**
   * Get available models from OpenCode.
   *
   * Returns the curated preset list (Claude/GPT/Gemini) plus any models the
   * user has wired up in their `opencode.json` -- e.g. an LM Studio bridge.
   * Configured models are deduplicated against the presets by id.
   */
  static async getModels(): Promise<AIModel[]> {
    const provider = 'opencode' as AIProviderType;
    const presets: AIModel[] = OPENCODE_PRESET_MODELS.map((m) => ({
      id: m.id,
      name: m.name,
      provider,
    }));

    const config = await OpenCodeProvider.configLoader?.().catch(() => null);
    if (!config) {
      // No file found or unreadable. Surface this in the log so the user can
      // tell the difference between "I have no providers configured" and
      // "Nimbalyst can't find the file you wrote". See #284.
      if (OpenCodeProvider.configLoader) {
        // eslint-disable-next-line no-console -- runtime package logger is renderer-only
        console.warn(
          '[OpenCode] configLoader returned null. opencode.json was not found or could not be parsed. Configured providers will not appear in the model picker.'
        );
      }
      return presets;
    }
    if (!config.provider) {
      return presets;
    }

    const seen = new Set(presets.map((m) => m.id));
    const configured: AIModel[] = [];

    for (const [providerID, providerEntry] of Object.entries(config.provider)) {
      const providerLabel = providerEntry.name || providerID;
      const models = providerEntry.models;
      if (!models) continue;
      for (const [modelID, modelEntry] of Object.entries(models)) {
        const id = `opencode:${providerID}/${modelID}`;
        if (seen.has(id)) continue;
        seen.add(id);
        configured.push({
          id,
          name: modelEntry?.name ? `${modelEntry.name} (${providerLabel})` : `${modelID} (${providerLabel})`,
          provider,
        });
      }
    }

    return [...presets, ...configured];
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
  protected buildSystemPrompt(_documentContext?: DocumentContext): string {
    return buildClaudeCodeSystemPrompt({
      hasSessionNaming: !!OpenCodeProvider.sessionNamingServerPort,
      toolReferenceStyle: 'opencode' as any,
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
    if (!workspacePath) {
      yield { type: 'error', error: '[OpenCodeProvider] workspacePath is required but was not provided' };
      return;
    }

    const systemPrompt = this.buildSystemPrompt(documentContext);
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
      await this.logAgentMessageBestEffort(sessionId, 'input', messageWithContext);
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
        },
      };

      const isResumedSession = !!existingSessionId;
      const session = isResumedSession
        ? await this.protocol.resumeSession(existingSessionId, sessionOptions)
        : await this.protocol.createSession(sessionOptions);

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

        for (const item of transcriptAdapter.processEvent(event)) {
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
