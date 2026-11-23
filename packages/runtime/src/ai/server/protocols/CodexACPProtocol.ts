/**
 * CodexACPProtocol -- AgentProtocol adapter for the Codex CLI's ACP transport.
 *
 * Spawns a subprocess running an ACP-compatible Codex agent (typically the
 * `@zed-industries/codex-acp` binary) and speaks the ACP protocol over stdio
 * via JSON-RPC framing.
 *
 * ACP gives Nimbalyst native pre/post file-edit hooks (via the writeTextFile
 * client method), so we can capture pre-edit baselines for diff rendering and
 * attribute edits to the producing session deterministically -- something the
 * @openai/codex-sdk transport doesn't expose.
 *
 * Ported from commit d38c58c72 with adjustments for the current AgentProtocol
 * interface and the @agentclientprotocol/sdk v0.20 API:
 *   - removed `unstable_resumeSession` (no longer in SDK; we use `loadSession`
 *     and fall back to a fresh `newSession`)
 *   - removed the "fall back to most recent active session" mapping in
 *     permission/file-write callbacks (session correlation must be
 *     deterministic -- see plan section "Removal of latest-session fallback")
 *
 * Reference: CopilotACPProtocol.ts is the other ACP-over-stdio adapter in the
 * codebase.
 */

import { spawn, type ChildProcessWithoutNullStreams } from 'child_process';
import { existsSync, promises as fs } from 'fs';
import path from 'path';
import { createRequire } from 'module';
import { Readable, Writable } from 'stream';
import {
  ClientSideConnection,
  PROTOCOL_VERSION,
  ndJsonStream,
} from '@agentclientprotocol/sdk';
import type {
  CancelNotification,
  McpServer,
  PermissionOption,
  PromptResponse,
  ReadTextFileRequest,
  ReadTextFileResponse,
  RequestPermissionRequest,
  RequestPermissionResponse,
  SessionConfigOption,
  SessionModelState,
  SessionNotification,
  SessionUpdate,
  ToolCallContent,
  ToolCallLocation,
  ToolCallUpdate,
  Usage,
  UsageUpdate,
  WriteTextFileRequest,
  WriteTextFileResponse,
} from '@agentclientprotocol/sdk';
import {
  AgentProtocol,
  MCPServerConfig,
  ProtocolEvent,
  ProtocolMessage,
  ProtocolSession,
  SessionOptions,
  ToolResult,
} from './ProtocolInterface';
import { scrubProviderApiKeys } from '../providerApiKeyScrub';
import { buildDocumentAttachmentPromptText } from '../providers/codex/documentAttachmentPrompt';
import type { ToolPermissionScope } from '../providers/ProviderPermissionMixin';

export interface ACPToolPermissionRequest {
  requestId: string;
  sessionId: string;
  toolName: string;
  toolTitle: string;
  toolKind?: string | null;
  toolInput?: unknown;
  toolCall: ToolCallUpdate;
  options: PermissionOption[];
}

/**
 * Callback invoked before the ACP agent writes a file.
 * Used to capture pre-edit baselines for diff rendering.
 */
export type OnBeforeFileWrite = (filePath: string, sessionId: string | undefined) => Promise<void>;

/**
 * Callback invoked after a turn completes with the set of files edited during the turn.
 * Used to create turn-end snapshots for local history.
 */
export type OnTurnFilesEdited = (filePaths: Set<string>, sessionId: string | undefined) => Promise<void>;

export interface CodexACPProtocolDeps {
  spawnProcess?: typeof spawn;
  /** Protocol platform identifier (defaults to `'codex-acp'`). */
  platform?: string;
  /** Human-readable agent label for error messages (defaults to `'Codex ACP'`). */
  agentLabel?: string;
  /** Prefix for console log/warn lines (defaults to `'CodexACPProtocol'`). */
  logPrefix?: string;
  /**
   * Environment variable name to inject `apiKey` into after scrubbing ambient
   * keys. Defaults to `'OPENAI_API_KEY'`. Pass `null` for providers that
   * authenticate exclusively via their own CLI login and never take an API key.
   */
  apiKeyEnvVar?: string | null;
  command?: string;
  /** Lazy command resolver invoked when spawning the subprocess (overrides default binary lookup). */
  commandResolver?: () => string;
  args?: string[];
  /** Optional dynamic argument resolver invoked each time the subprocess spawns (overrides `args`). */
  argsResolver?: () => string[];
  env?: Record<string, string>;
  /** Optional dynamic environment loader merged before API-key scrubbing. */
  envLoader?: () => Record<string, string>;
  /** Optional callback invoked when the spawned subprocess exits or is destroyed. */
  onProcessExit?: () => void;
  /**
   * Map Nimbalyst workspace permission modes (`'ask'`, `'allow-all'`, `'bypass-all'`)
   * to the agent's ACP mode id. Defaults to Codex ACP's `'full-access'` / `'auto'`.
   */
  mapPermissionMode?: (permissionMode: string) => string;
  /**
   * Apply `options.model` (and `options.raw.effortLevel`) to the ACP session via
   * `session/set_config_option` (`model` + `thought_level`) or `session/set_model`.
   * Defaults to `false` to preserve legacy Codex ACP behavior.
   */
  applyModel?: boolean;
  onPermissionRequest?: (
    request: ACPToolPermissionRequest
  ) => Promise<{ decision: 'allow' | 'deny'; scope: ToolPermissionScope }>;
  onBeforeFileWrite?: OnBeforeFileWrite;
  onTurnFilesEdited?: OnTurnFilesEdited;
}

interface SessionConfigState {
  deliveredMcpServerCount: number;
  models: SessionModelState | null;
  configOptions: SessionConfigOption[] | null;
}

const EFFORT_RANK_ORDER: Record<string, number> = {
  low: 0,
  medium: 1,
  high: 2,
  xhigh: 3,
  max: 4,
  ultra: 5,
};

const INLINE_EFFORT_SUFFIX_RE = /^(.+)-(low|medium|high|xhigh)$/i;

interface ActiveTurnState {
  /** ACP session id (used for activeTurns keying and ACP-side correlation). */
  sessionId: string;
  /**
   * Nimbalyst session id (passed via ProtocolMessage.sessionId). Hooks like
   * onBeforeFileWrite/onTurnFilesEdited operate on Nimbalyst sessions
   * (session_files, document_history), so this is what they get.
   */
  nimbalystSessionId?: string;
  queue: AsyncEventQueue<ProtocolEvent>;
  latestUsage?: Usage;
  latestContext?: UsageUpdate;
  filesEditedThisTurn: Set<string>;
}

interface SessionToolState {
  name: string;
  title: string;
  kind?: string | null;
  rawInput?: unknown;
  locations?: ToolCallLocation[] | null;
}

type ACPClientConnection = InstanceType<typeof ClientSideConnection>;

/**
 * Cap on retained stderr bytes. Codex CLI streams `tracing-subscriber` output
 * to stderr; over a multi-hour session this can exceed hundreds of MB if
 * retained whole. 64 KB is enough to keep recent error context for the
 * exit-reason message (issue #119).
 */
const STDERR_TAIL_LIMIT_BYTES = 64 * 1024;

/**
 * Append `chunk` to `existing`, retaining only the last `maxBytes` of the
 * combined data. Returns a new Buffer; does not mutate inputs.
 *
 * Used to bound stderr capture from long-lived child processes so the
 * exit-reason message can still include recent context without leaking the
 * full process stderr stream into main-process memory.
 */
export function appendBoundedTail(
  existing: Buffer,
  chunk: Buffer,
  maxBytes: number,
): Buffer {
  if (maxBytes <= 0) {
    return Buffer.alloc(0);
  }
  if (chunk.length >= maxBytes) {
    return Buffer.from(chunk.subarray(chunk.length - maxBytes));
  }
  if (existing.length + chunk.length <= maxBytes) {
    return Buffer.concat([existing, chunk]);
  }
  const keepFromExisting = maxBytes - chunk.length;
  return Buffer.concat([
    existing.subarray(existing.length - keepFromExisting),
    chunk,
  ]);
}

class AsyncEventQueue<T> {
  private readonly items: T[] = [];
  private readonly waiters: Array<(result: IteratorResult<T>) => void> = [];
  private done = false;

  push(item: T): void {
    if (this.done) {
      return;
    }
    const waiter = this.waiters.shift();
    if (waiter) {
      waiter({ value: item, done: false });
      return;
    }
    this.items.push(item);
  }

  finish(): void {
    if (this.done) {
      return;
    }
    this.done = true;
    while (this.waiters.length > 0) {
      const waiter = this.waiters.shift();
      waiter?.({ value: undefined as T, done: true });
    }
  }

  async next(): Promise<IteratorResult<T>> {
    if (this.items.length > 0) {
      return { value: this.items.shift() as T, done: false };
    }
    if (this.done) {
      return { value: undefined as T, done: true };
    }
    return await new Promise<IteratorResult<T>>((resolve) => {
      this.waiters.push(resolve);
    });
  }
}

export class CodexACPProtocol implements AgentProtocol {
  readonly platform: string;

  private apiKey: string;
  private readonly spawnProcess;
  private readonly agentLabel: string;
  private readonly logPrefix: string;
  private readonly apiKeyEnvVar: string | null;
  private readonly explicitCommand?: string;
  private readonly commandResolver?: () => string;
  private readonly args: string[];
  private readonly argsResolver?: () => string[];
  private readonly extraEnv: Record<string, string>;
  private readonly envLoader?: () => Record<string, string>;
  private readonly onProcessExit?: () => void;
  private readonly mapPermissionMode: (permissionMode: string) => string;
  private readonly applyModel: boolean;
  private readonly onPermissionRequest?: CodexACPProtocolDeps['onPermissionRequest'];
  private readonly onBeforeFileWrite?: OnBeforeFileWrite;
  private readonly onTurnFilesEdited?: OnTurnFilesEdited;

  private childProcess: ChildProcessWithoutNullStreams | null = null;
  private connection: ACPClientConnection | null = null;
  private initializationPromise: Promise<void> | null = null;
  private readonly activeTurns = new Map<string, ActiveTurnState>();
  private readonly sessionTools = new Map<string, Map<string, SessionToolState>>();
  private readonly sessionConfigs = new Map<string, SessionConfigState>();
  private readonly knownSessionIds = new Set<string>();
  private processExitError: Error | null = null;

  constructor(apiKey: string, deps?: CodexACPProtocolDeps) {
    this.apiKey = apiKey;
    this.platform = deps?.platform ?? 'codex-acp';
    this.agentLabel = deps?.agentLabel ?? 'Codex ACP';
    this.logPrefix = deps?.logPrefix ?? 'CodexACPProtocol';
    this.apiKeyEnvVar = deps?.apiKeyEnvVar === undefined ? 'OPENAI_API_KEY' : deps.apiKeyEnvVar;
    this.spawnProcess = deps?.spawnProcess ?? spawn;
    this.commandResolver = deps?.commandResolver;
    this.explicitCommand = deps?.command;
    const isDefaultCodex = this.platform === 'codex-acp';
    this.args = deps?.args ?? (isDefaultCodex ? CodexACPProtocol.parseArgs(process.env.NIMBALYST_CODEX_ACP_ARGS) : []);
    this.argsResolver = deps?.argsResolver;
    this.extraEnv = deps?.env ?? {};
    this.envLoader = deps?.envLoader;
    this.onProcessExit = deps?.onProcessExit;
    this.mapPermissionMode = deps?.mapPermissionMode ?? CodexACPProtocol.defaultCodexPermissionMode;
    this.applyModel = deps?.applyModel ?? false;
    this.onPermissionRequest = deps?.onPermissionRequest;
    this.onBeforeFileWrite = deps?.onBeforeFileWrite;
    this.onTurnFilesEdited = deps?.onTurnFilesEdited;
  }

  private static defaultCodexPermissionMode(permissionMode: string): string {
    if (permissionMode === 'allow-all' || permissionMode === 'bypass-all') {
      return 'full-access';
    }
    return 'auto';
  }

  setApiKey(apiKey: string): void {
    this.apiKey = apiKey;
  }

  /** Useful for diagnostics: returns the binary path the protocol will spawn. */
  getResolvedCommand(): string {
    if (this.explicitCommand) {
      return this.explicitCommand;
    }
    if (this.commandResolver) {
      return this.commandResolver();
    }
    if (this.platform === 'codex-acp') {
      return process.env.NIMBALYST_CODEX_ACP_COMMAND || CodexACPProtocol.resolveCodexAcpBinary() || 'codex-acp';
    }
    return 'codex-acp';
  }

  async createSession(options: SessionOptions): Promise<ProtocolSession> {
    const connection = await this.getConnection();
    const convertedMcpServers = this.convertMcpServers(options.mcpServers);
    let result;
    try {
      result = await connection.newSession({
        cwd: options.workspacePath,
        mcpServers: convertedMcpServers,
      });
    } catch (error) {
      const detail = this.formatError(error);
      console.error(`[${this.logPrefix}] newSession failed:`, detail);
      throw new Error(`Failed to create ACP session: ${detail}`);
    }

    const configState: SessionConfigState = {
      deliveredMcpServerCount: convertedMcpServers.length,
      models: result.models ?? null,
      configOptions: result.configOptions ?? null,
    };
    this.sessionConfigs.set(result.sessionId, configState);

    if (options.permissionMode) {
      await this.setSessionModeIfNeeded(connection, result.sessionId, options.permissionMode);
    }

    const appliedModel = this.applyModel
      ? await this.applySessionModelAndEffort(
          connection,
          result.sessionId,
          options.model,
          this.extractEffortLevel(options),
          configState,
        )
      : undefined;

    this.knownSessionIds.add(result.sessionId);
    this.sessionTools.set(result.sessionId, new Map());

    return {
      id: result.sessionId,
      platform: this.platform,
      deliveredMcpServerCount: configState.deliveredMcpServerCount,
      ...(appliedModel ? { appliedModel } : {}),
      raw: {
        workspacePath: options.workspacePath,
        options,
        ...(configState.models ? { models: configState.models } : {}),
      },
    };
  }

  async resumeSession(sessionId: string, options: SessionOptions): Promise<ProtocolSession> {
    const connection = await this.getConnection();

    if (!this.knownSessionIds.has(sessionId)) {
      let resumed = false;
      const convertedMcpServers = this.convertMcpServers(options.mcpServers);
      try {
        const loadResult = await connection.loadSession({
          sessionId,
          cwd: options.workspacePath,
          mcpServers: convertedMcpServers,
        });
        this.sessionConfigs.set(sessionId, {
          deliveredMcpServerCount: convertedMcpServers.length,
          models: loadResult?.models ?? null,
          configOptions: loadResult?.configOptions ?? null,
        });
        resumed = true;
      } catch {
        resumed = false;
      }

      if (!resumed) {
        return this.createSession(options);
      }
    }

    if (options.permissionMode) {
      await this.setSessionModeIfNeeded(connection, sessionId, options.permissionMode);
    }

    const configState = this.sessionConfigs.get(sessionId) ?? {
      deliveredMcpServerCount: this.convertMcpServers(options.mcpServers).length,
      models: null,
      configOptions: null,
    };
    this.sessionConfigs.set(sessionId, configState);

    const appliedModel = this.applyModel
      ? await this.applySessionModelAndEffort(
          connection,
          sessionId,
          options.model,
          this.extractEffortLevel(options),
          configState,
        )
      : undefined;

    this.knownSessionIds.add(sessionId);
    if (!this.sessionTools.has(sessionId)) {
      this.sessionTools.set(sessionId, new Map());
    }

    return {
      id: sessionId,
      platform: this.platform,
      deliveredMcpServerCount: configState.deliveredMcpServerCount,
      ...(appliedModel ? { appliedModel } : {}),
      raw: {
        workspacePath: options.workspacePath,
        options,
        ...(configState.models ? { models: configState.models } : {}),
      },
    };
  }

  async forkSession(_sessionId: string, options: SessionOptions): Promise<ProtocolSession> {
    return this.createSession(options);
  }

  async *sendMessage(
    session: ProtocolSession,
    message: ProtocolMessage
  ): AsyncIterable<ProtocolEvent> {
    const connection = await this.getConnection();
    const queue = new AsyncEventQueue<ProtocolEvent>();
    const turnState: ActiveTurnState = {
      sessionId: session.id,
      nimbalystSessionId: message.sessionId,
      queue,
      filesEditedThisTurn: new Set(),
    };

    this.activeTurns.set(session.id, turnState);
    if (!this.sessionTools.has(session.id)) {
      this.sessionTools.set(session.id, new Map());
    }

    const abortSignal = message.abortSignal
      ?? (session.raw?.options && typeof session.raw.options === 'object'
        ? (session.raw.options as { abortSignal?: AbortSignal }).abortSignal
        : undefined);

    const abortHandler = () => {
      void this.cancelPrompt(session.id);
    };
    abortSignal?.addEventListener('abort', abortHandler, { once: true });

    const promptTask = (async () => {
      try {
        const promptBlocks = await this.buildPromptBlocks(message);
        const response = await connection.prompt({
          sessionId: session.id,
          prompt: promptBlocks,
        });

        const usage = this.normalizeUsage(response, turnState.latestUsage);
        queue.push({
          type: 'complete',
          content: '',
          ...(usage ? { usage } : {}),
          ...(turnState.latestContext ? {
            contextFillTokens: turnState.latestContext.used,
            contextWindow: turnState.latestContext.size,
          } : {}),
        });
      } catch (error) {
        queue.push({
          type: 'error',
          error: this.formatError(error),
        });
      } finally {
        if (turnState.filesEditedThisTurn.size > 0 && this.onTurnFilesEdited) {
          try {
            await this.onTurnFilesEdited(turnState.filesEditedThisTurn, message.sessionId);
          } catch {
            // Best-effort snapshot creation
          }
        }
        abortSignal?.removeEventListener('abort', abortHandler);
        this.activeTurns.delete(session.id);
        queue.finish();
      }
    })();

    try {
      while (true) {
        const next = await queue.next();
        if (next.done) {
          break;
        }
        yield next.value;
      }
    } finally {
      await promptTask;
    }
  }

  abortSession(session: ProtocolSession): void {
    void this.cancelPrompt(session.id);
  }

  cleanupSession(session: ProtocolSession): void {
    this.activeTurns.delete(session.id);
    this.sessionTools.delete(session.id);
    this.sessionConfigs.delete(session.id);
    this.knownSessionIds.delete(session.id);
  }

  destroy(): void {
    for (const turn of this.activeTurns.values()) {
      turn.queue.finish();
    }
    this.activeTurns.clear();
    this.sessionTools.clear();
    this.sessionConfigs.clear();
    this.knownSessionIds.clear();

    const hadChild = this.childProcess !== null;
    this.childProcess?.kill();
    this.childProcess = null;
    this.connection = null;
    this.initializationPromise = null;
    if (hadChild) {
      this.onProcessExit?.();
    }
  }

  private async getConnection(): Promise<ACPClientConnection> {
    if (this.connection) {
      return this.connection;
    }

    if (!this.initializationPromise) {
      this.initializationPromise = this.initializeConnection();
    }
    await this.initializationPromise;

    if (!this.connection) {
      throw new Error(`Failed to initialize ${this.agentLabel} connection`);
    }

    return this.connection;
  }

  private async initializeConnection(): Promise<void> {
    this.processExitError = null;
    const command = this.getResolvedCommand();
    const spawnArgs = this.argsResolver ? this.argsResolver() : this.args;
    const dynamicEnv = this.envLoader?.() ?? {};
    // Scrub after the final merge, never before: a key deleted upstream is
    // merely absent, and absence cannot mask the `...process.env` spread above.
    const env = scrubProviderApiKeys({ ...process.env, ...dynamicEnv, ...this.extraEnv });
    // Re-apply an explicitly configured provider API key after scrubbing ambient
    // shell keys. Providers that rely solely on CLI login pass `apiKeyEnvVar: null`.
    if (this.apiKey && this.apiKeyEnvVar) {
      env[this.apiKeyEnvVar] = this.apiKey;
    }

    const child = this.spawnProcess(command, spawnArgs, {
      stdio: ['pipe', 'pipe', 'pipe'],
      env,
      cwd: process.cwd(),
      windowsHide: true,
    });

    this.childProcess = child;

    // Bounded rolling buffer of recent stderr. The previous unbounded
    // `Buffer[]` accumulated for the lifetime of the child process,
    // which leaked hundreds of MB over long sessions and crashed the main
    // process with a V8 fatal abort (issue #119).
    let stderrTail: Buffer = Buffer.alloc(0);
    child.stderr.on('data', (chunk: Buffer) => {
      stderrTail = appendBoundedTail(stderrTail, chunk, STDERR_TAIL_LIMIT_BYTES);
      const text = chunk.toString('utf-8').trim();
      if (text) {
        console.log(`[${this.logPrefix}:stderr] ${text}`);
      }
    });

    child.once('error', (error) => {
      this.processExitError = error;
    });
    child.once('exit', (code, signal) => {
      const stderr = stderrTail.toString('utf-8').trim();
      const exitReason =
        code !== null
          ? `${this.agentLabel} process exited with code ${code}`
          : `${this.agentLabel} process exited with signal ${signal ?? 'unknown'}`;
      const message = stderr ? `${exitReason}\nstderr: ${stderr}` : exitReason;
      this.processExitError = new Error(message);
      this.childProcess = null;
      this.connection = null;
      this.initializationPromise = null;
      this.onProcessExit?.();
    });

    const stream = ndJsonStream(
      Writable.toWeb(child.stdin) as WritableStream<Uint8Array>,
      Readable.toWeb(child.stdout) as ReadableStream<Uint8Array>,
    );

    const connection = new ClientSideConnection(
      () => ({
        requestPermission: (params: RequestPermissionRequest) =>
          this.handlePermissionRequest(params),
        sessionUpdate: (params: SessionNotification) => {
          this.handleSessionUpdate(params);
          return Promise.resolve();
        },
        readTextFile: (params: ReadTextFileRequest) => this.handleReadTextFile(params),
        writeTextFile: (params: WriteTextFileRequest) => this.handleWriteTextFile(params),
      }),
      stream,
    );

    this.connection = connection;

    try {
      await connection.initialize({
        protocolVersion: PROTOCOL_VERSION,
        clientInfo: {
          name: 'nimbalyst',
          version: '1.0.0',
        },
        clientCapabilities: {
          fs: {
            readTextFile: true,
            writeTextFile: true,
          },
        },
      });
    } catch (error) {
      this.destroy();
      throw new Error(
        `Failed to initialize ${this.agentLabel} agent "${command}": ${this.formatError(
          this.processExitError ?? error,
        )}`,
      );
    }
  }

  private handleSessionUpdate(params: SessionNotification): void {
    if (params.update.sessionUpdate === 'config_option_update') {
      const cfg = this.sessionConfigs.get(params.sessionId);
      if (cfg && Array.isArray(params.update.configOptions)) {
        cfg.configOptions = params.update.configOptions;
      }
    }

    const turn = this.activeTurns.get(params.sessionId);
    if (!turn) {
      return;
    }

    turn.queue.push({
      type: 'raw_event',
      metadata: {
        rawEvent: {
          type: 'session/update',
          sessionId: params.sessionId,
          update: params.update,
        },
      },
    });

    if (params.update.sessionUpdate === 'usage_update') {
      turn.latestContext = params.update;
      return;
    }

    const mapped = this.mapSessionUpdate(params.sessionId, params.update);
    for (const event of mapped) {
      turn.queue.push(event);
    }
  }

  private async handlePermissionRequest(
    params: RequestPermissionRequest
  ): Promise<RequestPermissionResponse> {
    const turn = this.activeTurns.get(params.sessionId);
    const toolName = this.deriveToolName(params.toolCall.title ?? 'Tool call', params.toolCall.kind);
    const requestId = params.toolCall.toolCallId;

    turn?.queue.push({
      type: 'raw_event',
      metadata: {
        rawEvent: {
          type: 'session/request_permission',
          sessionId: params.sessionId,
          request: params,
        },
      },
    });

    const toolState = this.createOrUpdateToolState(params.sessionId, requestId, {
      name: toolName,
      title: params.toolCall.title ?? toolName,
      kind: params.toolCall.kind,
      rawInput: params.toolCall.rawInput,
      locations: params.toolCall.locations,
    });

    turn?.queue.push({
      type: 'tool_call',
      toolCall: {
        id: requestId,
        name: toolState.name,
        arguments: this.mergeLocationPath(
          this.normalizeArguments(params.toolCall.rawInput),
          toolState.locations,
        ),
      },
      metadata: {
        rawEvent: {
          type: 'session/request_permission_preview',
          sessionId: params.sessionId,
          toolCall: params.toolCall,
        },
      },
    });

    const decision = this.onPermissionRequest
      ? await this.onPermissionRequest({
          requestId,
          sessionId: params.sessionId,
          toolName,
          toolTitle: params.toolCall.title ?? toolName,
          toolKind: params.toolCall.kind,
          toolInput: params.toolCall.rawInput,
          toolCall: params.toolCall,
          options: params.options,
        })
      : { decision: 'allow' as const, scope: 'once' as const };

    const selectedOption = this.selectPermissionOption(params.options, decision);

    return {
      outcome: {
        outcome: 'selected',
        optionId: selectedOption.optionId,
      },
    };
  }

  private async handleReadTextFile(
    params: ReadTextFileRequest
  ): Promise<ReadTextFileResponse> {
    const content = await fs.readFile(params.path, 'utf-8');
    const lines = content.split('\n');
    const start = Math.max(0, (params.line ?? 1) - 1);
    const end =
      typeof params.limit === 'number' && params.limit > 0
        ? start + params.limit
        : lines.length;

    return {
      content: lines.slice(start, end).join('\n'),
    };
  }

  private async handleWriteTextFile(
    params: WriteTextFileRequest
  ): Promise<WriteTextFileResponse> {
    // Pre-edit hook: capture baseline before writing.
    // sessionId comes from the active turn -- we never fall back to a "latest"
    // session, since concurrent ACP sessions could attribute the edit to the
    // wrong session.
    if (this.onBeforeFileWrite) {
      const activeTurn = this.getActiveTurn();
      if (activeTurn) {
        try {
          await this.onBeforeFileWrite(params.path, activeTurn.nimbalystSessionId);
        } catch {
          // Don't block the write if tagging fails
        }
      }
    }

    await fs.mkdir(path.dirname(params.path), { recursive: true });
    await fs.writeFile(params.path, params.content, 'utf-8');

    const activeTurn = this.getActiveTurn();
    if (activeTurn) {
      activeTurn.filesEditedThisTurn.add(params.path);
    }

    return {};
  }

  /**
   * Get the currently active turn. Returns undefined if there are 0 or >1
   * active turns -- we never guess. The plan's session-correlation guarantee
   * relies on this.
   */
  private getActiveTurn(): ActiveTurnState | undefined {
    if (this.activeTurns.size === 1) {
      return this.activeTurns.values().next().value;
    }
    return undefined;
  }

  private mapSessionUpdate(
    sessionId: string,
    update: SessionUpdate
  ): ProtocolEvent[] {
    switch (update.sessionUpdate) {
      case 'agent_message_chunk':
        return this.mapContentChunk('text', update.content);
      case 'agent_thought_chunk':
        return this.mapContentChunk('reasoning', update.content);
      case 'tool_call': {
        const rawName = (update as { name?: unknown }).name;
        const toolName = this.deriveToolName(
          update.title,
          update.kind,
          typeof rawName === 'string' ? rawName : undefined,
        );
        const toolState = this.createOrUpdateToolState(sessionId, update.toolCallId, {
          name: toolName,
          title: update.title,
          kind: update.kind,
          rawInput: update.rawInput,
          locations: update.locations,
        });

        return [{
          type: 'tool_call',
          toolCall: {
            id: update.toolCallId,
            name: toolName,
            arguments: this.mergeLocationPath(
              this.normalizeArguments(update.rawInput),
              toolState.locations,
            ),
          },
        }];
      }
      case 'tool_call_update': {
        const toolState = this.createOrUpdateToolState(sessionId, update.toolCallId, {
          name: this.deriveToolName(update.title ?? 'Tool call', update.kind),
          title: update.title ?? 'Tool call',
          kind: update.kind,
          rawInput: update.rawInput,
          locations: update.locations,
        });
        const result = this.buildToolResult(update);

        return [{
          type: 'tool_call',
          toolCall: {
            id: update.toolCallId,
            name: toolState.name,
            arguments: this.mergeLocationPath(
              this.normalizeArguments(update.rawInput ?? toolState.rawInput),
              toolState.locations,
            ),
            ...(result !== undefined ? { result } : {}),
          },
        }];
      }
      default:
        return [];
    }
  }

  private mapContentChunk(
    eventType: 'text' | 'reasoning',
    block: Extract<SessionUpdate, { sessionUpdate: 'agent_message_chunk' | 'agent_thought_chunk' }>['content']
  ): ProtocolEvent[] {
    if (block.type === 'text') {
      return [{
        type: eventType,
        content: block.text,
      }];
    }

    if (block.type === 'resource_link') {
      return [{
        type: eventType,
        content: block.uri,
      }];
    }

    return [];
  }

  private buildToolResult(update: ToolCallUpdate): ToolResult | string | undefined {
    const status = update.status ?? undefined;
    const normalizedContent = this.normalizeToolContent(update.content);
    const errorText =
      status === 'failed'
        ? this.extractFailureText(update.rawOutput) || this.extractFailureText(normalizedContent)
        : undefined;

    if (
      status === undefined &&
      update.rawOutput === undefined &&
      normalizedContent === undefined
    ) {
      return undefined;
    }

    return {
      success: status !== 'failed',
      ...(status ? { status } : {}),
      ...(errorText ? { error: errorText } : {}),
      ...(update.rawOutput !== undefined ? { output: update.rawOutput } : {}),
      ...(normalizedContent !== undefined ? { result: normalizedContent } : {}),
    };
  }

  private normalizeToolContent(content: ToolCallContent[] | null | undefined): unknown {
    if (!content || content.length === 0) {
      return undefined;
    }

    return content.map((entry) => {
      if (entry.type === 'content') {
        if (entry.content.type === 'text') {
          return entry.content.text;
        }
        if (entry.content.type === 'resource_link') {
          return entry.content.uri;
        }
        if (entry.content.type === 'image') {
          return {
            type: 'image',
            mimeType: entry.content.mimeType,
            uri: entry.content.uri,
          };
        }
        return entry.content;
      }

      if (entry.type === 'diff') {
        return {
          type: 'diff',
          path: entry.path,
          oldText: entry.oldText ?? null,
          newText: entry.newText,
        };
      }

      if (entry.type === 'terminal') {
        return {
          type: 'terminal',
          terminalId: entry.terminalId,
        };
      }

      return entry;
    });
  }

  private extractFailureText(value: unknown): string | undefined {
    if (!value) {
      return undefined;
    }
    if (typeof value === 'string') {
      return value;
    }
    if (Array.isArray(value)) {
      for (const item of value) {
        const nested = this.extractFailureText(item);
        if (nested) {
          return nested;
        }
      }
      return undefined;
    }
    if (typeof value === 'object') {
      const record = value as Record<string, unknown>;
      if (typeof record.error === 'string' && record.error.trim()) {
        return record.error;
      }
      if (typeof record.message === 'string' && record.message.trim()) {
        return record.message;
      }
      if (typeof record.result === 'string' && record.result.trim()) {
        return record.result;
      }
    }
    return undefined;
  }

  private createOrUpdateToolState(
    sessionId: string,
    toolCallId: string,
    state: SessionToolState
  ): SessionToolState {
    const sessionState = this.sessionTools.get(sessionId) ?? new Map<string, SessionToolState>();
    this.sessionTools.set(sessionId, sessionState);

    const existing = sessionState.get(toolCallId);
    const nextState = {
      name: state.name || existing?.name || 'Tool call',
      title: state.title || existing?.title || state.name,
      kind: state.kind ?? existing?.kind,
      rawInput: state.rawInput ?? existing?.rawInput,
      locations: state.locations ?? existing?.locations,
    };

    sessionState.set(toolCallId, nextState);
    return nextState;
  }

  private deriveToolName(title: string, kind?: string | null, rawName?: string): string {
    const normalizedRaw = rawName?.trim().toLowerCase();
    if (normalizedRaw === 'search_web' || normalizedRaw === 'web_search') {
      return 'WebSearch';
    }

    const cleaned = title.trim().replace(/^Tool:\s*/i, '');

    const match = /^([A-Za-z0-9_-]+)[./]([A-Za-z0-9_-]+)/.exec(cleaned);
    if (match) {
      const [, serverName, toolName] = match;
      if (serverName === 'acp_fs') {
        switch (toolName) {
          case 'read_text_file':
            return 'Read';
          case 'write_text_file':
            return 'Write';
          case 'edit_text_file':
          case 'multi_edit_text_file':
            return 'Edit';
          default:
            return toolName;
        }
      }
      return `mcp__${serverName}__${toolName}`;
    }

    if (kind === 'search' && /\bon Web$/i.test(cleaned)) {
      return 'WebSearch';
    }

    switch (kind) {
      case 'read':
        return 'Read';
      case 'search':
        return 'Grep';
      case 'execute':
        return 'Bash';
      case 'fetch':
        return 'WebFetch';
      case 'edit':
      case 'delete':
      case 'move':
        return 'ApplyPatch';
      default:
        return title || 'Tool call';
    }
  }

  private normalizeArguments(rawInput: unknown): Record<string, unknown> | undefined {
    if (!rawInput) {
      return undefined;
    }
    if (typeof rawInput === 'object' && !Array.isArray(rawInput)) {
      return CodexACPProtocol.unwrapMcpArguments(rawInput as Record<string, unknown>);
    }
    return { value: rawInput };
  }

  /**
   * Codex's `apply_patch` tool calls don't put a file path in `rawInput` --
   * the path lives in the ACP `locations[]` field. SessionFileTracker /
   * extractFilePath only look at args, so without this merge edits go
   * unattributed in the FilesEditedSidebar.
   *
   * Only fills `path` when no path-shaped key exists already, so we never
   * clobber a real argument.
   */
  private mergeLocationPath(
    args: Record<string, unknown> | undefined,
    locations: ToolCallLocation[] | null | undefined,
  ): Record<string, unknown> | undefined {
    const firstPath = locations?.find((loc) => typeof loc?.path === 'string' && loc.path.length > 0)?.path;
    if (!firstPath) return args;

    const base = args ?? {};
    if (
      typeof base.path === 'string' ||
      typeof base.file_path === 'string' ||
      typeof base.filePath === 'string'
    ) {
      return base;
    }
    return { ...base, path: firstPath };
  }

  /**
   * ACP wraps MCP tool calls as `{ server, tool, arguments }`. Custom widgets
   * key off the inner `arguments` object (e.g. AskUserQuestionWidget reads
   * `args.questions`), so unwrap before handing the args downstream.
   */
  static unwrapMcpArguments(rawInput: Record<string, unknown>): Record<string, unknown> {
    if (
      typeof rawInput.server === 'string' &&
      typeof rawInput.tool === 'string' &&
      rawInput.arguments &&
      typeof rawInput.arguments === 'object' &&
      !Array.isArray(rawInput.arguments)
    ) {
      return rawInput.arguments as Record<string, unknown>;
    }
    return rawInput;
  }

  private normalizeUsage(
    response: PromptResponse,
    latestUsage?: Usage
  ): ProtocolEvent['usage'] | undefined {
    const usage = (response as PromptResponse & { usage?: Usage }).usage ?? latestUsage;
    if (!usage) {
      return undefined;
    }
    return {
      input_tokens: usage.inputTokens,
      output_tokens: usage.outputTokens,
      total_tokens: usage.totalTokens,
      ...(typeof usage.cachedReadTokens === 'number'
        ? { cache_read_input_tokens: usage.cachedReadTokens }
        : {}),
      ...(typeof usage.cachedWriteTokens === 'number'
        ? { cache_creation_input_tokens: usage.cachedWriteTokens }
        : {}),
    };
  }

  private async buildPromptBlocks(message: ProtocolMessage) {
    const blocks: Array<
      | { type: 'text'; text: string }
      | { type: 'image'; data: string; mimeType: string; uri?: string }
      | { type: 'resource'; resource: { uri: string; text: string; mimeType: string } }
    > = [];

    // ACP doesn't have a separate system prompt field; the OpenAICodexACPProvider
    // packages the system prompt into the message body. Optional resource block
    // here lets future callers override that.
    const systemPrompt = (message as ProtocolMessage & { systemPrompt?: string }).systemPrompt;
    if (systemPrompt) {
      blocks.push({
        type: 'resource',
        resource: {
          uri: 'nimbalyst://system-instructions',
          text: systemPrompt,
          mimeType: 'text/plain',
        },
      });
    }

    blocks.push({
      type: 'text',
      text: message.content,
    });

    for (const attachment of message.attachments ?? []) {
      if (attachment.type === 'document' && attachment.filepath) {
        blocks.push({
          type: 'text',
          text: await buildDocumentAttachmentPromptText(attachment),
        });
        continue;
      }

      if (attachment.type !== 'image' || !attachment.filepath) {
        continue;
      }
      const data = await fs.readFile(attachment.filepath);
      blocks.push({
        type: 'image',
        data: data.toString('base64'),
        mimeType: attachment.mimeType ?? 'application/octet-stream',
        uri: `file://${attachment.filepath}`,
      });
    }

    return blocks;
  }

  private async cancelPrompt(sessionId: string): Promise<void> {
    const connection = this.connection;
    if (!connection) {
      return;
    }
    const payload: CancelNotification = { sessionId };
    try {
      await connection.cancel(payload);
    } catch {
      // Best-effort cancellation only.
    }
  }

  private async setSessionModeIfNeeded(
    connection: ACPClientConnection,
    sessionId: string,
    permissionMode: string
  ): Promise<void> {
    const modeValue = this.mapPermissionMode(permissionMode);

    try {
      const response = await connection.setSessionConfigOption({
        sessionId,
        configId: 'mode',
        value: modeValue,
      });
      const cfg = this.sessionConfigs.get(sessionId);
      if (cfg && Array.isArray(response?.configOptions)) {
        cfg.configOptions = response.configOptions;
      }
    } catch (configError) {
      console.warn(`[${this.logPrefix}] setSessionConfigOption failed, trying setSessionMode:`, configError);
      try {
        await connection.setSessionMode({
          sessionId,
          modeId: modeValue,
        });
      } catch (modeError) {
        console.warn(`[${this.logPrefix}] Failed to set session mode:`, modeError);
      }
    }
  }

  private extractEffortLevel(options: SessionOptions): string | undefined {
    const raw = options.raw as { effortLevel?: unknown } | undefined;
    return typeof raw?.effortLevel === 'string' && raw.effortLevel.trim()
      ? raw.effortLevel.trim().toLowerCase()
      : undefined;
  }

  private readSelectOptionValues(option: SessionConfigOption | undefined): string[] {
    if (!option || option.type !== 'select' || !Array.isArray(option.options)) {
      return [];
    }
    const values: string[] = [];
    for (const entry of option.options) {
      if ('value' in entry && typeof entry.value === 'string') {
        values.push(entry.value);
      } else if ('options' in entry && Array.isArray(entry.options)) {
        for (const nested of entry.options) {
          if (typeof nested.value === 'string') {
            values.push(nested.value);
          }
        }
      }
    }
    return values;
  }

  private pickAllowedEffort(requested: string, allowed: string[]): string | undefined {
    if (allowed.length === 0) return undefined;
    if (allowed.includes(requested)) return requested;
    const requestedRank = EFFORT_RANK_ORDER[requested];
    if (requestedRank === undefined) return undefined;
    // Pick the highest allowed effort at or below the requested rank; if every
    // offered level is higher, pick the lowest offered level.
    const ranked = allowed
      .filter((value) => value in EFFORT_RANK_ORDER)
      .sort((a, b) => EFFORT_RANK_ORDER[a] - EFFORT_RANK_ORDER[b]);
    if (ranked.length === 0) return undefined;
    const atOrBelow = ranked.filter((value) => EFFORT_RANK_ORDER[value] <= requestedRank);
    return atOrBelow.length > 0 ? atOrBelow[atOrBelow.length - 1] : ranked[0];
  }

  /**
   * Apply the requested model and reasoning effort onto an ACP session.
   *
   * Prefers ACP `configOptions` (`model` + `thought_level`, used by `agy acp`)
   * so base models pair cleanly with Nimbalyst's effort selector and unsupported
   * thinking levels clamp to the highest level the selected model actually
   * offers. Falls back to `session/set_model` when `configOptions` does not
   * advertise a `model` selector. Never aborts a turn on an unknown/retired
   * model id; instead reports the live model.
   */
  private async applySessionModelAndEffort(
    connection: ACPClientConnection,
    sessionId: string,
    requestedModel: string | undefined,
    requestedEffort: string | undefined,
    state: SessionConfigState,
  ): Promise<string | undefined> {
    const current = state.models?.currentModelId ?? undefined;
    const wanted = requestedModel?.trim();
    if (!wanted && !requestedEffort) {
      return current;
    }

    const findConfig = (id: string) =>
      state.configOptions?.find((opt) => opt.id === id && opt.type === 'select');

    const modelConfig = findConfig('model');
    if (modelConfig && modelConfig.type === 'select') {
      const allowedModels = this.readSelectOptionValues(modelConfig);
      let baseModel = wanted;
      let inlineEffort: string | undefined;

      if (wanted && !allowedModels.includes(wanted)) {
        const suffixMatch = INLINE_EFFORT_SUFFIX_RE.exec(wanted);
        if (suffixMatch && allowedModels.includes(suffixMatch[1])) {
          baseModel = suffixMatch[1];
          inlineEffort = suffixMatch[2].toLowerCase();
        }
      }

      if (baseModel && allowedModels.includes(baseModel)) {
        if (modelConfig.currentValue !== baseModel) {
          try {
            const updated = await connection.setSessionConfigOption({
              sessionId,
              configId: 'model',
              value: baseModel,
            });
            if (Array.isArray(updated?.configOptions)) {
              state.configOptions = updated.configOptions;
            }
          } catch (error) {
            console.warn(`[${this.logPrefix}] Failed to set model config option "${baseModel}":`, error);
            return current;
          }
        }

        const effectiveEffort = inlineEffort ?? requestedEffort;
        const thoughtConfig = findConfig('thought_level');
        if (effectiveEffort && thoughtConfig && thoughtConfig.type === 'select') {
          const allowedEfforts = this.readSelectOptionValues(thoughtConfig);
          const clamped = this.pickAllowedEffort(effectiveEffort, allowedEfforts);
          if (clamped && thoughtConfig.currentValue !== clamped) {
            try {
              const updated = await connection.setSessionConfigOption({
                sessionId,
                configId: 'thought_level',
                value: clamped,
              });
              if (Array.isArray(updated?.configOptions)) {
                state.configOptions = updated.configOptions;
              }
            } catch (error) {
              console.warn(`[${this.logPrefix}] Failed to set thought_level "${clamped}":`, error);
            }
          }
          if (clamped) {
            const combined = `${baseModel}-${clamped}`;
            if (state.models) state.models.currentModelId = combined;
            return combined;
          }
        }

        if (state.models) state.models.currentModelId = baseModel;
        return baseModel;
      }
    }

    // Fallback: `session/set_model` against `models.availableModels`.
    const available = state.models?.availableModels ?? [];
    if (!wanted || available.length === 0) {
      return current;
    }

    let targetModelId: string | undefined;
    if (requestedEffort) {
      const matchingEfforts = available
        .map((m) => {
          const match = INLINE_EFFORT_SUFFIX_RE.exec(m.modelId);
          return match && match[1] === wanted ? match[2].toLowerCase() : null;
        })
        .filter((e): e is string => e !== null);
      const clamped = this.pickAllowedEffort(requestedEffort, matchingEfforts);
      if (clamped) {
        targetModelId = `${wanted}-${clamped}`;
      }
    }
    if (!targetModelId && available.some((m) => m.modelId === wanted)) {
      targetModelId = wanted;
    }
    if (!targetModelId || targetModelId === current) {
      return current;
    }

    try {
      await connection.unstable_setSessionModel({ sessionId, modelId: targetModelId });
      if (state.models) state.models.currentModelId = targetModelId;
      return targetModelId;
    } catch (error) {
      console.warn(`[${this.logPrefix}] Failed to set session model "${targetModelId}":`, error);
      return current;
    }
  }

  private convertMcpServers(
    mcpServers?: Record<string, MCPServerConfig>
  ): McpServer[] {
    if (!mcpServers) {
      return [];
    }

    const servers: McpServer[] = [];
    for (const [name, config] of Object.entries(mcpServers)) {
      const cfg = config as Record<string, unknown>;
      if (cfg.url && typeof cfg.url === 'string') {
        const url = cfg.url as string;
        const headers = Object.entries(((cfg.headers ?? cfg.http_headers ?? {}) as Record<string, string>));

        // Codex ACP only supports stdio MCP servers natively for the most
        // reliable case. Bridge SSE/HTTP servers via mcp-remote spawned as
        // a stdio process.
        //
        // process.execPath inside Electron is the Electron binary itself --
        // spawning it without ELECTRON_RUN_AS_NODE=1 would launch a fresh
        // GUI app per MCP server (one bouncing dock icon each). The env var
        // makes Electron run as a headless Node process.
        const mcpRemotePath = CodexACPProtocol.resolveMcpRemoteProxy();
        if (mcpRemotePath) {
          const args = [mcpRemotePath, url, '--allow-http'];
          for (const [headerName, value] of headers) {
            args.push('--header', `${headerName}: ${value}`);
          }
          servers.push({
            name,
            command: process.execPath,
            args,
            env: [{ name: 'ELECTRON_RUN_AS_NODE', value: '1' }],
          } as McpServer);
        } else {
          // Fallback: pass as SSE/HTTP and hope the agent supports it
          const transport = ((cfg.type ?? cfg.transport ?? '')).toString().toLowerCase();
          const headerArray = headers.map(([headerName, value]) => ({
            name: headerName,
            value,
          }));
          if (transport === 'sse') {
            servers.push({ type: 'sse', name, url, headers: headerArray } as McpServer);
          } else {
            servers.push({ type: 'http', name, url, headers: headerArray } as McpServer);
          }
        }
        continue;
      }

      servers.push({
        name,
        command: config.command,
        args: config.args ?? [],
        env: Object.entries(config.env ?? {})
          .filter(([, value]) => typeof value === 'string')
          .map(([envName, value]) => ({
            name: envName,
            value,
          })),
      } as McpServer);
    }

    return servers;
  }

  /**
   * Resolve the mcp-remote proxy script, which bridges SSE/HTTP MCP servers
   * to stdio for agents that only support stdio transport (like Codex ACP).
   */
  private static resolveMcpRemoteProxy(): string | undefined {
    try {
      const require = createRequire(import.meta.url);
      return require.resolve('mcp-remote/dist/proxy.js');
    } catch {
      return undefined;
    }
  }

  private selectPermissionOption(
    options: PermissionOption[],
    decision: { decision: 'allow' | 'deny'; scope: ToolPermissionScope }
  ): PermissionOption {
    if (decision.decision === 'deny') {
      return (
        options.find((option) =>
          option.optionId.toLowerCase().includes('abort') ||
          option.kind === 'reject_once'
        ) ??
        options[0]
      );
    }

    if (decision.scope === 'once') {
      return (
        options.find((option) =>
          option.optionId.toLowerCase() === 'approved' ||
          option.kind === 'allow_once'
        ) ??
        options[0]
      );
    }

    return (
      options.find((option) =>
        option.optionId.toLowerCase().includes('session') ||
        option.kind === 'allow_always'
      ) ??
      options.find((option) => option.kind === 'allow_once') ??
      options[0]
    );
  }

  private formatError(error: unknown): string {
    if (error instanceof Error) {
      const data = (error as { data?: unknown }).data;
      const detail = this.extractErrorDataDetail(data);
      return detail ? `${error.message}: ${detail}` : error.message;
    }
    if (typeof error === 'string') {
      return error;
    }
    if (error && typeof error === 'object') {
      const record = error as { message?: unknown; data?: unknown };
      if (typeof record.message === 'string') {
        const detail = this.extractErrorDataDetail(record.data);
        return detail ? `${record.message}: ${detail}` : record.message;
      }
    }
    try {
      return JSON.stringify(error);
    } catch {
      return String(error);
    }
  }

  private extractErrorDataDetail(data: unknown): string | undefined {
    if (!data) return undefined;
    if (typeof data === 'string') return data.trim() || undefined;
    if (typeof data === 'object') {
      const record = data as Record<string, unknown>;
      for (const key of ['details', 'message', 'error'] as const) {
        if (typeof record[key] === 'string' && record[key].trim()) {
          return record[key].trim();
        }
      }
      try {
        return JSON.stringify(data);
      } catch {
        return undefined;
      }
    }
    return undefined;
  }

  /**
   * Resolve the native codex-acp binary from the @zed-industries/codex-acp
   * package's platform-specific subpackage.
   *
   * The npm wrapper script uses spawnSync with stdio: "inherit", which doesn't
   * work when we need piped stdio. Resolve the platform-specific binary
   * directly to bypass the wrapper.
   */
  static resolveCodexAcpBinary(): string | undefined {
    const platformMap: Record<string, Record<string, string>> = {
      darwin: { arm64: 'codex-acp-darwin-arm64', x64: 'codex-acp-darwin-x64' },
      linux: { arm64: 'codex-acp-linux-arm64', x64: 'codex-acp-linux-x64' },
      win32: { arm64: 'codex-acp-win32-arm64', x64: 'codex-acp-win32-x64' },
    };

    const packages = platformMap[process.platform];
    if (!packages) return undefined;

    const packageName = packages[process.arch];
    if (!packageName) return undefined;

    const binaryName = process.platform === 'win32' ? 'codex-acp.exe' : 'codex-acp';

    try {
      const require = createRequire(import.meta.url);
      const packageJsonPath = require.resolve(`@zed-industries/${packageName}/package.json`);
      // In packaged Electron builds, require.resolve returns a path inside
      // app.asar (a regular file on disk that Electron's fs reads through
      // virtually). spawn() goes through the native execve, which walks
      // path components and fails with ENOTDIR when it hits app.asar. The
      // real binary lives in app.asar.unpacked, so rewrite the path before
      // returning.
      const rewritten = packageJsonPath.replace(/app\.asar(?=[/\\])/, 'app.asar.unpacked');
      const candidate = path.join(path.dirname(rewritten), 'bin', binaryName);
      if (existsSync(candidate)) {
        return candidate;
      }
    } catch {
      // Package not installed
    }

    return undefined;
  }

  private static parseArgs(rawArgs: string | undefined): string[] {
    if (!rawArgs) {
      return [];
    }

    try {
      const parsed = JSON.parse(rawArgs);
      if (Array.isArray(parsed) && parsed.every((entry) => typeof entry === 'string')) {
        return parsed;
      }
    } catch {
      // Fall back to shell-like splitting below.
    }

    return rawArgs
      .split(/\s+/)
      .map((arg) => arg.trim())
      .filter(Boolean);
  }
}
