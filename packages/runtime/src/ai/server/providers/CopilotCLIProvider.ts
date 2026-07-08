/**
 * GitHub Copilot CLI Agent Provider
 *
 * Integrates GitHub Copilot's ACP (Agent Communication Protocol) server mode
 * into Nimbalyst. Copilot runs as `copilot --acp --stdio` and communicates
 * via JSON-RPC over stdin/stdout.
 *
 * Key features:
 * - ACP protocol transport (not PTY scraping)
 * - Session create/resume via protocol session IDs
 * - MCP server passthrough to Copilot's ACP session
 * - Nimbalyst permission prompts for tool/file actions
 * - Canonical transcript storage via raw event logging
 */

import { execFileSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { BaseAgentProvider } from './BaseAgentProvider';
import { buildUserMessageAddition } from './documentContextUtils';
import { buildClaudeCodeSystemPrompt } from '../../prompt';
import { DEFAULT_MODELS } from '../../modelConstants';
import {
  ProviderConfig,
  DocumentContext,
  StreamChunk,
  AIModel,
  AIProviderType,
  ChatAttachment,
} from '../types';
import { CopilotACPProtocol } from '../protocols/CopilotACPProtocol';
import { ProtocolEvent, ProtocolSession } from '../protocols/ProtocolInterface';
import { McpConfigService } from '../services/McpConfigService';
import { getMcpConfigService, isInternalMcpServerEnabled, areTrackerToolsEnabled, resolveTrackersWorkspacePath } from '../services/mcpServerConfig';
import { MCPServerConfig } from '../../../types/MCPServerConfig';
import { safeJSONSerialize } from '../../../utils/serialization';
import { AgentProtocolTranscriptAdapter } from './agentProtocol/AgentProtocolTranscriptAdapter';
import { TrustChecker, PermissionMode } from './ProviderPermissionMixin';
import { TranscriptMigrationRepository } from '../../../storage/repositories/TranscriptMigrationRepository';

interface CopilotCLIProviderDeps {
  protocol?: CopilotACPProtocol;
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

function getSystemCopilotExecutableCandidates(pathValue?: string): string[] {
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
    addCandidate(path.win32.join(appData, 'npm', 'copilot.cmd'));
    addCandidate(path.win32.join(homeDir, 'AppData', 'Roaming', 'npm', 'copilot.cmd'));
    addCandidate(findExecutableInPathEntries(['copilot.cmd', 'copilot.exe'], pathValue ?? process.env.PATH));
    addCandidate('copilot');
    return candidates;
  }

  addCandidate(path.join(homeDir, '.local', 'bin', 'copilot'));
  addCandidate(path.join(homeDir, '.npm-global', 'bin', 'copilot'));
  addCandidate('/usr/local/bin/copilot');
  addCandidate('/opt/homebrew/bin/copilot');
  addCandidate(findExecutableInPathEntries(['copilot'], pathValue ?? process.env.PATH));
  addCandidate('copilot');
  return candidates;
}

export class CopilotCLIProvider extends BaseAgentProvider {
  static readonly DEFAULT_MODEL = DEFAULT_MODELS['copilot-cli'];

  private readonly protocol: CopilotACPProtocol;
  private readonly mcpConfigService: McpConfigService;

  private _initData: {
    model: string;
    mcpServerCount: number;
    isResumedSession: boolean;
  } | null = null;

  // Internal MCP-server enablement (ports, kill-switches, extension/tracker
  // loaders, auth token) lives in the shared `mcpServerConfig` registry now.
  private static mcpConfigLoader: ((workspacePath?: string) => Promise<Record<string, MCPServerConfig>>) | null = null;
  private static shellEnvironmentLoader: (() => Record<string, string> | null) | null = null;
  private static enhancedPathLoader: (() => string) | null = null;
  private static copilotPathLoader: (() => string | null) | null = null;

  constructor(deps?: CopilotCLIProviderDeps) {
    super();

    this.protocol = deps?.protocol || new CopilotACPProtocol();

    this.mcpConfigService = getMcpConfigService({
      mcpConfigLoader: CopilotCLIProvider.mcpConfigLoader,
      claudeSettingsEnvLoader: null,
      shellEnvironmentLoader: CopilotCLIProvider.shellEnvironmentLoader,
    });
  }

  async initialize(config: ProviderConfig): Promise<void> {
    this.config = config;
  }

  getProviderName(): string {
    return 'copilot-cli';
  }

  // --- Static injection setters (called from electron main process at startup) ---
  // Internal MCP-server ports / kill-switches / loaders / auth token are
  // configured once via `configureMcpServers` (shared registry).

  public static setMCPConfigLoader(loader: ((workspacePath?: string) => Promise<Record<string, MCPServerConfig>>) | null): void {
    CopilotCLIProvider.mcpConfigLoader = loader;
  }

  public static setShellEnvironmentLoader(loader: (() => Record<string, string> | null) | null): void {
    CopilotCLIProvider.shellEnvironmentLoader = loader;
  }

  public static setEnhancedPathLoader(loader: (() => string) | null): void {
    CopilotCLIProvider.enhancedPathLoader = loader;
  }

  public static setCopilotPathLoader(loader: (() => string | null) | null): void {
    CopilotCLIProvider.copilotPathLoader = loader;
  }

  private static resolveCopilotExecutableForRuntime(pathValue?: string): string | undefined {
    if (CopilotCLIProvider.copilotPathLoader) {
      const customPath = CopilotCLIProvider.copilotPathLoader();
      if (customPath) {
        return customPath;
      }
    }

    for (const candidate of getSystemCopilotExecutableCandidates(pathValue)) {
      if (candidate === 'copilot' || fs.existsSync(candidate)) {
        return candidate;
      }
    }

    return undefined;
  }

  // --- Model discovery ---

  static async getModels(): Promise<AIModel[]> {
    return [
      {
        id: 'copilot-cli:default',
        name: 'Copilot (default)',
        provider: 'copilot-cli' as AIProviderType,
      },
    ];
  }

  static getDefaultModel(): string {
    return DEFAULT_MODELS['copilot-cli'];
  }

  getName(): string {
    return 'copilot-cli';
  }

  getDisplayName(): string {
    return 'GitHub Copilot';
  }

  getDescription(): string {
    return 'GitHub Copilot CLI agent provider via ACP protocol';
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
      yield { type: 'error', error: '[CopilotCLIProvider] workspacePath is required but was not provided' };
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
      const metadataToLog: Record<string, unknown> = {};
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
      const permissionResult = await this.requestCopilotTurnPermission(workspacePath, documentContext?.permissionsPath);
      if (permissionResult.decision !== 'allow') {
        yield { type: 'error', error: permissionResult.reason || 'Copilot turn denied' };
        return;
      }

      const existingSessionId = this.sessions.getSessionId(sessionId || '');

      const mcpServers = await this.mcpConfigService.getMcpServersConfig({
        sessionId,
        workspacePath: mcpConfigWorkspacePath,
        profile: 'standard',
      });

      this.configureProtocol();

      const copilotAvailable = CopilotCLIProvider.isCopilotInstalled();
      if (!copilotAvailable) {
        yield {
          type: 'error',
          error: 'GitHub Copilot CLI is not installed. Install it with one of:\n\n' +
            '  npm install -g @github/copilot\n' +
            '  brew install copilot-cli\n' +
            '  curl -fsSL https://gh.io/copilot-install | bash\n\n' +
            'Then run `copilot` and use /login to authenticate.',
        };
        return;
      }

      const resolvedModel = this.config?.model || CopilotCLIProvider.DEFAULT_MODEL;
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
        model: resolvedModel,
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
              // Store the complete assistant response so the CopilotRawParser
              // can create a canonical assistant_message event from it.
              if (sessionId && fullText) {
                await this.storeAssistantResponse(sessionId, fullText);
                // Process the new raw message through the transformer NOW,
                // before yielding `complete`. The parser skips per-chunk ACP
                // events and only produces canonical events from the
                // item.completed message we just stored. Without this call,
                // the transformer might not run again before the session
                // reload (watermark already advanced past chunk events).
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
        if (/process exited|ENOENT|spawn.*copilot/i.test(errorMessage)) {
          yield {
            type: 'error',
            error: 'GitHub Copilot CLI is not installed or failed to start. Install it with:\n\n' +
              '  npm install -g @github/copilot\n\n' +
              'Then run `copilot` and use /login to authenticate.',
          };
        } else if (/auth|login|token|unauthorized|forbidden/i.test(errorMessage)) {
          yield {
            type: 'error',
            error: 'GitHub Copilot is not logged in. Run `copilot` in your terminal and use the /login command to authenticate.',
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
    if ((this.protocol as any).destroy) {
      (this.protocol as any).destroy();
    }
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

  private static isCopilotInstalled(): boolean {
    const command = CopilotCLIProvider.resolveCopilotExecutableForRuntime(
      CopilotCLIProvider.enhancedPathLoader?.() || process.env.PATH
    ) || 'copilot';
    // Use the enhanced PATH (Homebrew, npm-global, etc.) so the runtime
    // check matches what the settings panel sees. A packaged macOS app
    // launched from Finder/Dock has only /usr/bin:/bin:/usr/sbin:/sbin in
    // process.env.PATH, which misses every place copilot is typically
    // installed -- so without this the panel reports "Installed" while
    // the provider says "not installed", or the provider fails after the
    // user installs successfully.
    let env: NodeJS.ProcessEnv | undefined;
    if (CopilotCLIProvider.enhancedPathLoader) {
      try {
        env = { ...process.env, PATH: CopilotCLIProvider.enhancedPathLoader() };
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
    const resolvedPath = CopilotCLIProvider.resolveCopilotExecutableForRuntime(
      CopilotCLIProvider.enhancedPathLoader?.() || process.env.PATH
    );
    if (resolvedPath) {
      this.protocol.setCopilotPath(resolvedPath);
    }
    // Default: `copilot --acp --stdio` (from @github/copilot npm package)

    const env = CopilotCLIProvider.buildCopilotEnvironment();
    if (env) {
      this.protocol.setProcessEnv(env);
    }
  }

  private static buildCopilotEnvironment(): Record<string, string> | null {
    let shellEnv: Record<string, string> | null = null;
    let enhancedPath: string | null = null;

    if (CopilotCLIProvider.shellEnvironmentLoader) {
      try {
        shellEnv = CopilotCLIProvider.shellEnvironmentLoader();
      } catch {
        // continue without shell env
      }
    }

    if (CopilotCLIProvider.enhancedPathLoader) {
      try {
        enhancedPath = CopilotCLIProvider.enhancedPathLoader();
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

    // Scrub API keys per CLAUDE.md policy
    delete env.ANTHROPIC_API_KEY;
    delete env.OPENAI_API_KEY;
    // Do NOT scrub GH_TOKEN/GITHUB_TOKEN here -- per plan, we don't read them
    // as implicit auth, but Copilot CLI itself may legitimately need them from
    // the user's shell. The plan's guardrail applies to Nimbalyst code, not to
    // what the child process inherits from the shell.

    return env;
  }

  private async requestCopilotTurnPermission(
    workspacePath: string,
    permissionsPath?: string
  ): Promise<{ decision: 'allow' | 'deny'; reason?: string; permissionMode?: PermissionMode }> {
    const pathForTrust = permissionsPath || workspacePath;

    if (pathForTrust && BaseAgentProvider.trustChecker) {
      const trustStatus = BaseAgentProvider.trustChecker(pathForTrust);

      if (!trustStatus.trusted) {
        return {
          decision: 'deny',
          reason: 'Workspace is not trusted. Please trust this workspace to use GitHub Copilot.',
        };
      }

      // Like Codex, Copilot requires allow-all or bypass-all since ACP does not
      // expose per-tool permission callbacks in the initial integration.
      if (trustStatus.mode === 'bypass-all' || trustStatus.mode === 'allow-all') {
        return { decision: 'allow', permissionMode: trustStatus.mode };
      }

      return {
        decision: 'deny',
        reason: 'GitHub Copilot requires "Allow Edits" permission mode. Please change the permission mode in workspace settings.',
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
        { eventType: 'item.completed', copilotProvider: true },
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
        copilotProvider: true,
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
