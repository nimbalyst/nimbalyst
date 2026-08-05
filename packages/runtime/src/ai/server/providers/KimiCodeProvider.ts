/**
 * Kimi Code Agent Provider
 *
 * Integrates the Kimi Code CLI's ACP (Agent Client Protocol) server mode
 * into Nimbalyst. Kimi runs as `kimi acp` and communicates via JSON-RPC
 * over stdin/stdout.
 *
 * Key features:
 * - ACP protocol transport (standard @agentclientprotocol schema)
 * - Session create/resume via protocol session IDs
 * - Model selection via `session/set_config_option` (K3 and siblings)
 * - MCP server passthrough to Kimi's ACP session
 * - Canonical transcript storage via raw event logging
 */

import { execFileSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { BaseAgentProvider } from './BaseAgentProvider';
import { buildUserMessageAddition } from './documentContextUtils';
import { buildClaudeCodeSystemPrompt } from '../../prompt';
import { DEFAULT_MODELS, KIMI_CODE_PRESET_MODELS } from '../../modelConstants';
import {
  ProviderConfig,
  DocumentContext,
  StreamChunk,
  AIModel,
  AIProviderType,
  ChatAttachment,
} from '../types';
import { KimiACPProtocol } from '../protocols/KimiACPProtocol';
import { ProtocolEvent } from '../protocols/ProtocolInterface';
import { McpConfigService } from '../services/McpConfigService';
import { getMcpConfigService, isInternalMcpServerEnabled, areTrackerToolsEnabled, resolveTrackersWorkspacePath } from '../services/mcpServerConfig';
import { MCPServerConfig } from '../../../types/MCPServerConfig';
import { safeJSONSerialize } from '../../../utils/serialization';
import { AgentProtocolTranscriptAdapter } from './agentProtocol/AgentProtocolTranscriptAdapter';
import { PermissionMode } from './ProviderPermissionMixin';
import { TranscriptMigrationRepository } from '../../../storage/repositories/TranscriptMigrationRepository';

interface KimiCodeProviderDeps {
  protocol?: KimiACPProtocol;
}

function splitPathEntries(pathValue: string | undefined): string[] {
  if (!pathValue) return [];
  return pathValue
    .split(path.delimiter)
    .map((entry) => entry.trim().replace(/^"(.*)"$/, '$1'))
    .filter(Boolean);
}

function findExecutableInPathEntries(
  executableNames: string[],
  pathValue: string | undefined
): string | undefined {
  for (const entry of splitPathEntries(pathValue)) {
    for (const executableName of executableNames) {
      const candidate = path.join(entry, executableName);
      if (fs.existsSync(candidate)) {
        return candidate;
      }
    }
  }
  return undefined;
}

/**
 * Candidate locations for the `kimi` executable, in priority order.
 *
 * A packaged macOS app launched from Finder/Dock has only
 * /usr/bin:/bin:/usr/sbin:/sbin in PATH, which misses every place kimi is
 * typically installed -- so absolute candidates come first and the PATH
 * lookup is a fallback. KIMI_BIN (checked by the caller) overrides all.
 */
function getSystemKimiExecutableCandidates(pathValue?: string): string[] {
  const platform = process.platform;
  const homeDir = os.homedir();
  const pathModule = platform === 'win32' ? path.win32 : path;
  const seen = new Set<string>();
  const candidates: string[] = [];
  const addCandidate = (candidate: string | undefined) => {
    if (!candidate) return;
    const normalized = pathModule.normalize(candidate);
    if (seen.has(normalized)) return;
    seen.add(normalized);
    candidates.push(candidate);
  };

  if (platform === 'win32') {
    const appData = process.env.APPDATA || path.win32.join(homeDir, 'AppData', 'Roaming');
    addCandidate(path.win32.join(appData, 'npm', 'kimi.cmd'));
    addCandidate(path.win32.join(homeDir, 'AppData', 'Roaming', 'npm', 'kimi.cmd'));
    addCandidate(findExecutableInPathEntries(['kimi.cmd', 'kimi.exe'], pathValue ?? process.env.PATH));
    addCandidate('kimi');
    return candidates;
  }

  addCandidate(path.join(homeDir, '.local', 'bin', 'kimi'));
  addCandidate(path.join(homeDir, '.npm-global', 'bin', 'kimi'));
  addCandidate('/usr/local/bin/kimi');
  addCandidate('/opt/homebrew/bin/kimi');
  addCandidate(findExecutableInPathEntries(['kimi'], pathValue ?? process.env.PATH));
  addCandidate('kimi');
  return candidates;
}

export class KimiCodeProvider extends BaseAgentProvider {
  static readonly DEFAULT_MODEL = DEFAULT_MODELS['kimi-code'];

  private readonly protocol: KimiACPProtocol;
  private readonly mcpConfigService: McpConfigService;

  private _initData: {
    model: string;
    mcpServerCount: number;
    isResumedSession: boolean;
  } | null = null;

  private static mcpConfigLoader: ((workspacePath?: string) => Promise<Record<string, MCPServerConfig>>) | null = null;
  private static shellEnvironmentLoader: (() => Record<string, string> | null) | null = null;
  private static enhancedPathLoader: (() => string) | null = null;
  private static kimiPathLoader: (() => string | null) | null = null;

  constructor(deps?: KimiCodeProviderDeps) {
    super();

    this.protocol = deps?.protocol || new KimiACPProtocol();

    this.mcpConfigService = getMcpConfigService({
      mcpConfigLoader: KimiCodeProvider.mcpConfigLoader,
      claudeSettingsEnvLoader: null,
      shellEnvironmentLoader: KimiCodeProvider.shellEnvironmentLoader,
    });
  }

  async initialize(config: ProviderConfig): Promise<void> {
    this.config = config;
  }

  getProviderName(): string {
    return 'kimi-code';
  }

  // --- Static injection setters (called from electron main process at startup) ---

  public static setMCPConfigLoader(loader: ((workspacePath?: string) => Promise<Record<string, MCPServerConfig>>) | null): void {
    KimiCodeProvider.mcpConfigLoader = loader;
  }

  public static setShellEnvironmentLoader(loader: (() => Record<string, string> | null) | null): void {
    KimiCodeProvider.shellEnvironmentLoader = loader;
  }

  public static setEnhancedPathLoader(loader: (() => string) | null): void {
    KimiCodeProvider.enhancedPathLoader = loader;
  }

  public static setKimiPathLoader(loader: (() => string | null) | null): void {
    KimiCodeProvider.kimiPathLoader = loader;
  }

  private static resolveKimiExecutableForRuntime(pathValue?: string): string | undefined {
    // Explicit override wins: settings-injected path loader, then KIMI_BIN.
    if (KimiCodeProvider.kimiPathLoader) {
      const customPath = KimiCodeProvider.kimiPathLoader();
      if (customPath) {
        return customPath;
      }
    }

    const envOverride = process.env.KIMI_BIN?.trim();
    if (envOverride && fs.existsSync(envOverride)) {
      return envOverride;
    }

    for (const candidate of getSystemKimiExecutableCandidates(pathValue)) {
      if (candidate === 'kimi' || fs.existsSync(candidate)) {
        return candidate;
      }
    }

    return undefined;
  }

  // --- Model discovery ---

  static async getModels(): Promise<AIModel[]> {
    return KIMI_CODE_PRESET_MODELS.map((preset) => ({
      id: preset.id,
      name: preset.name,
      provider: 'kimi-code' as AIProviderType,
      contextWindow: preset.contextWindow,
    }));
  }

  static getDefaultModel(): string {
    return DEFAULT_MODELS['kimi-code'];
  }

  getName(): string {
    return 'kimi-code';
  }

  getDisplayName(): string {
    return 'Kimi Code';
  }

  getDescription(): string {
    return 'Kimi Code CLI agent provider via ACP protocol';
  }

  getProviderSessionData(sessionId: string): any {
    const { providerSessionId } = this.sessions.getProviderSessionData(sessionId);
    return { providerSessionId };
  }

  getInitData(): {
    model: string;
    mcpServerCount: number;
    isResumedSession: boolean;
  } | null {
    return this._initData;
  }

  async cancelStream(_sessionId?: string): Promise<void> {
    this.abort();
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
      yield { type: 'error', error: '[KimiCodeProvider] workspacePath is required but was not provided' };
      return;
    }

    const systemPrompt = this.buildSystemPrompt(documentContext);
    const { userMessageAddition, messageWithContext } = buildUserMessageAddition(message, documentContext);

    if (sessionId && (systemPrompt || userMessageAddition)) {
      this.emit('promptAdditions', {
        sessionId,
        systemPromptAddition: systemPrompt || null,
        userMessageAddition,
        attachments: [],
        timestamp: Date.now(),
      });
    }

    const prompt = messageWithContext;

    if (sessionId) {
      const metadataToLog: Record<string, unknown> = this.withPromptProvenanceMetadata(documentContext);
      if (documentContext?.mode) {
        metadataToLog.mode = documentContext.mode;
      }
      await this.logAgentMessageBestEffort(
        sessionId,
        'input',
        prompt,
        Object.keys(metadataToLog).length > 0 ? { metadata: metadataToLog } : undefined
      );
    }

    const mcpConfigWorkspacePath = documentContext?.mcpConfigWorkspacePath || workspacePath;
    const abortController = new AbortController();
    this.abortController = abortController;

    let fullText = '';

    try {
      const permissionResult = await this.requestKimiTurnPermission(workspacePath, documentContext?.permissionsPath);
      if (permissionResult.decision !== 'allow') {
        yield { type: 'error', error: permissionResult.reason || 'Kimi Code turn denied' };
        return;
      }

      const existingSessionId = this.sessions.getSessionId(sessionId || '');

      const mcpServers = await this.mcpConfigService.getMcpServersConfig({
        sessionId,
        workspacePath: mcpConfigWorkspacePath,
        profile: 'standard',
      });

      this.configureProtocol();

      const kimiAvailable = KimiCodeProvider.isKimiInstalled();
      if (!kimiAvailable) {
        yield {
          type: 'error',
          error: 'Kimi Code CLI is not installed. Install it with:\n\n' +
            '  npm install -g @moonshot-ai/kimi-code\n\n' +
            'Then run `kimi login` to authenticate.',
        };
        return;
      }

      const configuredModel = this.config?.model || KimiCodeProvider.DEFAULT_MODEL;
      // Map the registry id to the ACP wire id (`kimi-code:k3` -> `kimi-code/k3`);
      // unknown ids fall back to the bare variant so user-typed wire ids pass through.
      const preset = KIMI_CODE_PRESET_MODELS.find((p) => p.id === configuredModel);
      const resolvedModel = preset ? preset.acpModelId : configuredModel.replace(/^kimi-code:/, '');
      const isResumedSession = !!existingSessionId;

      const sessionOptions = {
        workspacePath,
        model: resolvedModel,
        systemPrompt,
        mcpServers,
      };

      const session = isResumedSession
        ? await this.protocol.resumeSession(existingSessionId, sessionOptions)
        : await this.protocol.createSession(sessionOptions);

      this._initData = {
        model: configuredModel,
        mcpServerCount: Object.keys(mcpServers).length,
        isResumedSession,
      };

      const transcriptAdapter = new AgentProtocolTranscriptAdapter(null, sessionId ?? '');
      transcriptAdapter.userMessage(
        prompt,
        documentContext?.mode === 'planning' ? 'planning' : 'agent',
        attachments as any,
      );

      for await (const event of this.protocol.sendMessage(session, {
        content: prompt,
        attachments,
        sessionId,
        mode: documentContext?.mode || 'agent',
      })) {
        if (abortController.signal.aborted) {
          throw new Error('Operation cancelled');
        }

        if (sessionId) {
          try {
            await this.storeRawEventIfPresent(event, sessionId);
          } catch {
            // DB not available -- non-critical
          }
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
              // Store the complete assistant response so the raw parser can
              // create a canonical assistant_message event from it.
              if (sessionId && fullText) {
                await this.storeAssistantResponse(sessionId, fullText);
                await this.processTranscriptMessages(sessionId);
              }
              yield {
                type: 'complete',
                content: item.event.content,
                isComplete: true,
                usage: item.event.usage,
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

      if (sessionId && session.id && session.id !== existingSessionId) {
        this.sessions.captureSessionId(sessionId, session.id);
      }
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      const isAbort = abortController.signal.aborted || /abort|cancel/i.test(errorMessage);
      if (!isAbort) {
        if (/process exited|ENOENT|spawn.*kimi/i.test(errorMessage)) {
          yield {
            type: 'error',
            error: 'Kimi Code CLI is not installed or failed to start. Install it with:\n\n' +
              '  npm install -g @moonshot-ai/kimi-code\n\n' +
              'Then run `kimi login` to authenticate.',
          };
        } else if (/auth|login|token|unauthorized|forbidden/i.test(errorMessage)) {
          yield {
            type: 'error',
            error: 'Kimi Code is not logged in. Run `kimi login` in your terminal to authenticate.',
            isAuthError: true,
          };
        } else {
          yield { type: 'error', error: errorMessage };
        }
      }
    } finally {
      if (this.abortController === abortController) {
        this.abortController = null;
      }
    }
  }

  cleanupSession(sessionId: string): void {
    this.sessions.deleteSession(sessionId);
  }

  destroy(): void {
    this.protocol.destroy();
    super.destroy();
  }

  protected buildSystemPrompt(documentContext?: DocumentContext): string {
    const hasSessionNaming = isInternalMcpServerEnabled();
    const worktreePath = documentContext?.worktreePath;

    return buildClaudeCodeSystemPrompt({
      hasSessionNaming,
      toolReferenceStyle: 'codex',
      worktreePath,
      isVoiceMode: false,
      enableAgentTeams: false,
      trackersEnabled: areTrackerToolsEnabled(resolveTrackersWorkspacePath(documentContext)),
    });
  }

  private static isKimiInstalled(): boolean {
    const command = KimiCodeProvider.resolveKimiExecutableForRuntime(
      KimiCodeProvider.enhancedPathLoader?.() || process.env.PATH
    ) || 'kimi';
    // Use the enhanced PATH (Homebrew, npm-global, etc.) so the runtime check
    // matches what the settings panel sees -- a packaged macOS app launched
    // from Finder/Dock has only /usr/bin:/bin:/usr/sbin:/sbin in PATH.
    let env: NodeJS.ProcessEnv | undefined;
    if (KimiCodeProvider.enhancedPathLoader) {
      try {
        env = { ...process.env, PATH: KimiCodeProvider.enhancedPathLoader() };
      } catch {
        // fall through to default env
      }
    }
    try {
      execFileSync(command, ['--version'], { stdio: 'pipe', timeout: 5000, env });
      return true;
    } catch {
      return false;
    }
  }

  private configureProtocol(): void {
    const resolvedPath = KimiCodeProvider.resolveKimiExecutableForRuntime(
      KimiCodeProvider.enhancedPathLoader?.() || process.env.PATH
    );
    if (resolvedPath) {
      this.protocol.setKimiPath(resolvedPath);
    }

    const env = KimiCodeProvider.buildKimiEnvironment();
    if (env) {
      this.protocol.setProcessEnv(env);
    }
  }

  private static buildKimiEnvironment(): Record<string, string> | null {
    let shellEnv: Record<string, string> | null = null;
    let enhancedPath: string | null = null;

    if (KimiCodeProvider.shellEnvironmentLoader) {
      try {
        shellEnv = KimiCodeProvider.shellEnvironmentLoader();
      } catch {
        // continue without shell env
      }
    }

    if (KimiCodeProvider.enhancedPathLoader) {
      try {
        enhancedPath = KimiCodeProvider.enhancedPathLoader();
      } catch {
        // continue without enhanced PATH
      }
    }

    if (!shellEnv && !enhancedPath) {
      return null;
    }

    const env: Record<string, string> = {};
    for (const [key, value] of Object.entries(process.env)) {
      if (value !== undefined) {
        env[key] = value;
      }
    }
    if (shellEnv) {
      Object.assign(env, shellEnv);
    }
    if (enhancedPath) {
      env.PATH = enhancedPath;
    }

    // Scrub API keys per CLAUDE.md policy. Kimi Code manages its own auth
    // (device-code OAuth via `kimi login`, stored in its own config).
    delete env.ANTHROPIC_API_KEY;
    delete env.OPENAI_API_KEY;

    return env;
  }

  private async requestKimiTurnPermission(
    workspacePath: string,
    permissionsPath?: string
  ): Promise<{ decision: 'allow' | 'deny'; reason?: string; permissionMode?: PermissionMode }> {
    const pathForTrust = permissionsPath || workspacePath;

    if (pathForTrust && BaseAgentProvider.trustChecker) {
      const trustStatus = BaseAgentProvider.trustChecker(pathForTrust);

      if (!trustStatus.trusted) {
        return {
          decision: 'deny',
          reason: 'Workspace is not trusted. Please trust this workspace to use Kimi Code.',
        };
      }

      // Like Codex and Copilot, Kimi requires allow-all or bypass-all since
      // the initial integration does not surface ACP per-tool permission
      // callbacks (`session/request_permission`) as Nimbalyst prompts yet.
      if (trustStatus.mode === 'bypass-all' || trustStatus.mode === 'allow-all') {
        return { decision: 'allow', permissionMode: trustStatus.mode };
      }

      return {
        decision: 'deny',
        reason: 'Kimi Code requires "Allow Edits" permission mode. Please change the permission mode in workspace settings.',
      };
    }

    return { decision: 'allow' };
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
      // Best effort -- the session reload will catch up via ensureUpToDate
    }
  }

  private async storeAssistantResponse(sessionId: string, text: string): Promise<void> {
    const codexCompatibleEvent = {
      type: 'item.completed',
      item: {
        type: 'message',
        role: 'assistant',
        content: [{ type: 'output_text', text }],
      },
    };
    try {
      await this.logAgentMessage(
        sessionId,
        this.getProviderName(),
        'output',
        JSON.stringify(codexCompatibleEvent),
        { eventType: 'item.completed', kimiProvider: true },
        false,
        undefined,
        true
      );
    } catch {
      // Best effort
    }
  }

  private async storeRawEventIfPresent(event: ProtocolEvent, sessionId: string): Promise<void> {
    if (event.type !== 'raw_event' || !event.metadata?.rawEvent) {
      return;
    }

    const { content, usedFallback } = safeJSONSerialize(event.metadata.rawEvent);
    const rawEventType = this.getRawEventType(event.metadata.rawEvent);

    await this.logAgentMessage(
      sessionId,
      this.getProviderName(),
      'output',
      usedFallback
        ? JSON.stringify({ type: rawEventType, valueType: typeof event.metadata.rawEvent, fallback: true })
        : content,
      {
        eventType: rawEventType,
        kimiProvider: true,
        rawEventSerializationFallback: usedFallback,
      },
      false,
      undefined,
      false
    );
  }

  private getRawEventType(rawEvent: unknown): string {
    if (rawEvent && typeof rawEvent === 'object') {
      const method = (rawEvent as Record<string, unknown>).method;
      if (typeof method === 'string' && method.trim().length > 0) {
        return method;
      }
      const type = (rawEvent as Record<string, unknown>).type;
      if (typeof type === 'string' && type.trim().length > 0) {
        return type;
      }
    }
    return 'unknown';
  }
}
