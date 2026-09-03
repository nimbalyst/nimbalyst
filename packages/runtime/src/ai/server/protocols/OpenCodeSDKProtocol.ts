/**
 * OpenCode SDK Protocol Adapter
 *
 * Wraps the @opencode-ai/sdk to provide a normalized protocol interface
 * for the OpenCodeProvider.
 *
 * OpenCode uses a client/server architecture:
 * - The server runs as a subprocess (HTTP + SSE)
 * - The SDK provides a type-safe client
 * - Events are streamed via Server-Sent Events
 *
 * This adapter handles:
 * - Server subprocess lifecycle (spawn, reference counting, shutdown)
 * - Session creation/resumption via the SDK
 * - SSE event parsing and conversion to protocol events
 * - Custom Nimbalyst plugin integration for file edit tracking
 */

import { ChildProcess, spawn } from 'child_process';
import { promises as fs } from 'fs';
import type { Command } from '@opencode-ai/sdk';
import type { ChatAttachment } from '../types';
import { loadOpenCodeSdkClientModule } from '../providers/openCode/OpenCodeSdkClient';
import {
  AgentProtocol,
  ProtocolSession,
  SessionOptions,
  ProtocolMessage,
  ProtocolEvent,
  ToolResult,
} from './ProtocolInterface';

/**
 * Minimal interface for the OpenCode SDK client.
 * Matches the actual @opencode-ai/sdk API surface.
 */
export interface OpenCodeClientLike {
  session: {
    create: (options?: Record<string, unknown>) => Promise<{ data: { id: string; [key: string]: unknown } }>;
    list: (options?: Record<string, unknown>) => Promise<{ data: Array<{ id: string; [key: string]: unknown }> }>;
    prompt: (options: Record<string, unknown>) => Promise<unknown>;
    abort: (options: Record<string, unknown>) => Promise<unknown>;
    summarize: (options: {
      path: { id: string };
      query?: { directory?: string };
      body: { providerID: string; modelID: string };
    }) => Promise<{ data?: boolean; error?: unknown }>;
  };
  command: {
    list: (options?: {
      query?: { directory?: string };
    }) => Promise<{ data?: Command[]; error?: unknown }>;
  };
  global: {
    event: (options?: Record<string, unknown>) => Promise<{
      stream: AsyncIterable<OpenCodeSSEEvent>;
    }>;
  };
  event: {
    subscribe: (options?: Record<string, unknown>) => Promise<{
      stream: AsyncIterable<OpenCodeSSEEvent>;
    }>;
  };
  mcp: {
    add: (options?: Record<string, unknown>) => Promise<unknown>;
    status?: (options?: Record<string, unknown>) => Promise<unknown>;
    disconnect?: (options?: Record<string, unknown>) => Promise<unknown>;
  };
}

/**
 * SSE event from the OpenCode server.
 * The real SDK wraps events in a GlobalEvent: { directory, payload: Event }
 * but we normalize to just the event for simplicity.
 */
export interface OpenCodeSSEEvent {
  type: string;
  properties?: Record<string, unknown>;
}

interface OpenCodeUsageSnapshot {
  usage: NonNullable<ProtocolEvent['usage']>;
  contextFillTokens: number;
  messageId?: string;
  modelId?: string;
}

/**
 * Factory function type for creating OpenCode SDK clients.
 * Allows dependency injection for testing.
 */
export type OpenCodeClientFactory = (options: { baseUrl: string }) => OpenCodeClientLike;

/** Module-level guard so process-exit cleanup is only registered once. */
let processCleanupRegistered = false;

/** Default startup deadline; overridable per-user for slow cold boots. */
const DEFAULT_STARTUP_TIMEOUT_MS = 30000;

/**
 * Per-request budget for one health probe. Far below the startup deadline so a
 * request that hangs on an open connection is abandoned and retried (#1428).
 */
const HEALTH_PROBE_TIMEOUT_MS = 2000;

/** True when a fetch rejected because its AbortSignal fired (timeout), not a network error. */
function isAbortError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  return error.name === 'AbortError' || error.name === 'TimeoutError';
}

/**
 * Singleton manager for the OpenCode server subprocess.
 * Reference-counted: starts on first session, stops when last session ends.
 */
export class OpenCodeServerManager {
  private static instance: OpenCodeServerManager | null = null;

  /**
   * Test hook: overrides the startup health-check deadline (ms). Leave null in
   * production so the env var / default is used.
   */
  static startupTimeoutOverrideMs: number | null = null;

  private serverProcess: ChildProcess | null = null;
  private port: number = 0;
  private sessionCount = 0;
  /**
   * Bumped every time a server process is spawned. Callers that cache
   * server-derived data (the slash-command catalog) key off this so a restart
   * always re-fetches (#574).
   */
  private generation = 0;
  private ready = false;
  private readyPromise: Promise<void> | null = null;
  private workspacePath: string = '';
  /** Last spawn error (e.g. ENOENT) so we can surface it instead of a 30s timeout. */
  private lastSpawnError: Error | null = null;
  /** Rolling tail of server stderr lines, included in startup failure messages. */
  private stderrTail: string[] = [];

  private constructor() {
    // Kill any spawned server when the host process exits so `opencode serve`
    // doesn't outlive the app and accumulate as a zombie. Registered once.
    if (!processCleanupRegistered) {
      processCleanupRegistered = true;
      process.once('exit', () => {
        const proc = OpenCodeServerManager.instance?.serverProcess;
        if (proc) {
          try {
            proc.kill('SIGKILL');
          } catch {
            // best-effort; process is exiting anyway
          }
        }
      });
    }
  }

  static getInstance(): OpenCodeServerManager {
    if (!OpenCodeServerManager.instance) {
      OpenCodeServerManager.instance = new OpenCodeServerManager();
    }
    return OpenCodeServerManager.instance;
  }

  /** Test-only: tear down and drop the singleton so each test starts clean. */
  static resetForTests(): void {
    OpenCodeServerManager.instance?.killServerProcess();
    OpenCodeServerManager.instance = null;
  }

  private getStartupTimeoutMs(): number {
    if (OpenCodeServerManager.startupTimeoutOverrideMs != null) {
      return OpenCodeServerManager.startupTimeoutOverrideMs;
    }
    const raw = process.env.NIMBALYST_OPENCODE_STARTUP_TIMEOUT_MS;
    const parsed = raw ? parseInt(raw, 10) : NaN;
    if (Number.isFinite(parsed) && parsed > 0) return parsed;
    return DEFAULT_STARTUP_TIMEOUT_MS;
  }

  get baseUrl(): string {
    return `http://127.0.0.1:${this.port}`;
  }

  /** Identity of the currently running server process, for cache keys. */
  get serverGeneration(): number {
    return this.generation;
  }

  get isRunning(): boolean {
    return this.serverProcess !== null && this.ready;
  }

  /**
   * Ensure the server is running. Spawns it if not already started.
   * Returns when the server is ready to accept connections.
   */
  async ensureRunning(workspacePath: string, env?: Record<string, string>): Promise<void> {
    this.sessionCount++;

    if (this.ready && this.serverProcess) {
      return;
    }

    if (this.readyPromise) {
      return this.readyPromise;
    }

    this.workspacePath = workspacePath;
    this.readyPromise = this.startServer(env);
    return this.readyPromise;
  }

  /**
   * Release a session's reference. Shuts down the server when
   * all sessions have been released.
   */
  release(): void {
    this.sessionCount = Math.max(0, this.sessionCount - 1);
    if (this.sessionCount === 0) {
      this.stopServer();
    }
  }

  private async startServer(env?: Record<string, string>): Promise<void> {
    this.generation++;

    // Find an available port
    this.port = await this.findAvailablePort();

    console.log(`[OPENCODE-PROTOCOL] Starting OpenCode server on port ${this.port}`);

    const serverEnv: Record<string, string> = {
      ...process.env as Record<string, string>,
      ...(env || {}),
    };

    this.lastSpawnError = null;
    this.stderrTail = [];

    this.serverProcess = spawn('opencode', [
      'serve',
      '--port', String(this.port),
      '--hostname', '127.0.0.1',
    ], {
      cwd: this.workspacePath,
      env: serverEnv,
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    this.serverProcess.on('error', (error) => {
      console.error('[OPENCODE-PROTOCOL] Server process error:', error.message);
      // Record the spawn error so waitForReady bails out immediately (e.g. a
      // missing CLI surfaces as ENOENT instead of a full startup timeout).
      this.lastSpawnError = error;
      this.ready = false;
      this.readyPromise = null;
    });

    this.serverProcess.on('exit', (code, signal) => {
      console.log(`[OPENCODE-PROTOCOL] Server exited: code=${code}, signal=${signal}`);
      this.serverProcess = null;
      this.ready = false;
      this.readyPromise = null;
    });

    // Capture stderr so startup failures can report the real reason.
    this.serverProcess.stderr?.on('data', (data: Buffer) => {
      this.recordStderr(data.toString());
    });

    // Wait for the server to be ready by polling the health endpoint.
    try {
      await this.waitForReady();
      this.ready = true;
      this.readyPromise = null;
    } catch (startError) {
      // The server may have finished booting right at/after the deadline;
      // adopt the healthy process instead of orphaning it.
      if (this.serverProcess && (await this.probeHealthOnce())) {
        console.log(`[OPENCODE-PROTOCOL] Adopting late-ready OpenCode server on port ${this.port}`);
        this.ready = true;
        this.readyPromise = null;
        return;
      }
      // Otherwise kill the still-booting child and clear all state so the next
      // message retries cleanly rather than re-failing on a cached rejection.
      const failure = this.buildStartupError(startError);
      this.killServerProcess();
      throw failure;
    }
  }

  private async waitForReady(timeoutMs = this.getStartupTimeoutMs()): Promise<void> {
    const startTime = Date.now();
    const pollIntervalMs = 200;
    // Log each failure kind once per state change, not per 200ms tick, so a
    // hung probe and a refused connection are distinguishable in the log.
    let lastFailure: 'timeout' | 'unreachable' | null = null;

    while (Date.now() - startTime < timeoutMs) {
      // A spawn error (e.g. ENOENT) means the process will never become healthy;
      // fail fast instead of polling a dead port until the deadline.
      if (this.lastSpawnError) {
        throw this.lastSpawnError;
      }
      try {
        const response = await this.fetchHealth();
        if (response.ok) {
          console.log(`[OPENCODE-PROTOCOL] Server ready on port ${this.port}`);
          return;
        }
      } catch (error) {
        const failure = isAbortError(error) ? 'timeout' : 'unreachable';
        if (failure !== lastFailure) {
          lastFailure = failure;
          if (failure === 'timeout') {
            console.warn(`[OPENCODE-PROTOCOL] Health probe on port ${this.port} hung for ${HEALTH_PROBE_TIMEOUT_MS}ms; abandoning it and retrying on a fresh connection`);
          } else {
            console.log(`[OPENCODE-PROTOCOL] Health endpoint on port ${this.port} not reachable yet (${error instanceof Error ? error.message : String(error)}); waiting for server`);
          }
        }
      }
      await new Promise(resolve => setTimeout(resolve, pollIntervalMs));
    }

    throw new Error(`OpenCode server failed to start within ${timeoutMs}ms`);
  }

  /**
   * Health probe with a per-request budget. A connection that is accepted but
   * never answered (#1428) must be abandoned so the next poll tick opens a
   * fresh one, rather than pinning the loop in a single await until the
   * startup deadline. Uses an explicit timer, not AbortSignal.timeout, so the
   * budget is driven by the same clock as the poll loop.
   */
  private async fetchHealth(): Promise<Response> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), HEALTH_PROBE_TIMEOUT_MS);
    try {
      return await fetch(`${this.baseUrl}/global/health`, { signal: controller.signal });
    } finally {
      clearTimeout(timer);
    }
  }

  private stopServer(): void {
    this.killServerProcess();
  }

  /**
   * Kill the spawned server (SIGTERM, then SIGKILL after a grace period) and
   * clear all manager state. Safe to call when no server is running.
   */
  private killServerProcess(): void {
    const proc = this.serverProcess;
    this.serverProcess = null;
    this.ready = false;
    this.readyPromise = null;
    if (!proc) return;

    console.log('[OPENCODE-PROTOCOL] Stopping OpenCode server');
    try {
      proc.kill('SIGTERM');
    } catch {
      // already gone
    }

    // Force kill after 5 seconds if still running.
    const forceKillTimeout = setTimeout(() => {
      try {
        proc.kill('SIGKILL');
      } catch {
        // already gone
      }
    }, 5000);
    proc.once('exit', () => clearTimeout(forceKillTimeout));
    if (typeof forceKillTimeout.unref === 'function') forceKillTimeout.unref();
  }

  /** Record a stderr line into the rolling tail (last 20 lines). */
  private recordStderr(text: string): void {
    const trimmed = text.trim();
    if (!trimmed) return;
    this.stderrTail.push(trimmed);
    if (this.stderrTail.length > 20) this.stderrTail.shift();
  }

  /** Single health probe; true only when the server answers with an ok response. */
  private async probeHealthOnce(): Promise<boolean> {
    try {
      const response = await this.fetchHealth();
      return !!response.ok;
    } catch {
      return false;
    }
  }

  /**
   * Build a useful startup-failure error: an ENOENT spawn error becomes a
   * "CLI not found" message, and the last few stderr lines are appended so the
   * real reason is visible instead of a bare "failed to start within 30000ms".
   */
  private buildStartupError(cause: unknown): Error {
    let message = cause instanceof Error ? cause.message : String(cause);

    const spawnError = this.lastSpawnError as NodeJS.ErrnoException | null;
    if (spawnError?.code === 'ENOENT') {
      message = `OpenCode CLI not found ("opencode"). Ensure it is installed and on PATH (PATH=${process.env.PATH ?? ''}).`;
    }

    const tail = this.stderrTail.slice(-5).join('\n');
    if (tail) {
      message += `\nLast OpenCode server output:\n${tail}`;
    }
    return new Error(message);
  }

  private async findAvailablePort(): Promise<number> {
    // Use Node.js net module to find a free port
    const { createServer } = await import('net');
    return new Promise((resolve, reject) => {
      const server = createServer();
      server.listen(0, '127.0.0.1', () => {
        const address = server.address();
        if (address && typeof address !== 'string') {
          const port = address.port;
          server.close(() => resolve(port));
        } else {
          server.close(() => reject(new Error('Failed to get port')));
        }
      });
      server.on('error', reject);
    });
  }
}

/**
 * Convert a Nimbalyst-style OpenCode model id (e.g. `opencode:anthropic/claude-sonnet-4-5`
 * or just `anthropic/claude-sonnet-4-5`) into the `{ providerID, modelID }` shape
 * the OpenCode SDK expects in the prompt body. Returns null only for an absent
 * model or the explicit `default` sentinel and throws for malformed ids.
 */
export function parseOpenCodeModelId(
  rawModel: string | undefined
): { providerID: string; modelID: string } | null {
  if (!rawModel) return null;
  const stripped = rawModel.startsWith('opencode:') ? rawModel.slice('opencode:'.length) : rawModel;
  if (stripped === 'default') return null;
  const slashIdx = stripped.indexOf('/');
  if (slashIdx <= 0 || slashIdx === stripped.length - 1) {
    throw new Error(
      `Invalid OpenCode model id "${rawModel}". Expected "provider/model" or "opencode:provider/model".`
    );
  }
  return {
    providerID: stripped.slice(0, slashIdx),
    modelID: stripped.slice(slashIdx + 1),
  };
}

/**
 * Read the OpenCode agent role the host configured for this session.
 *
 * Carried through `SessionOptions.raw` because the role is an OpenCode concept
 * with no equivalent on the cross-provider protocol contract. An absent, blank
 * or non-string value means "no role" -- OpenCode then uses its own default
 * primary agent, which is the same behavior as before the picker existed.
 */
export function readAgentRole(options: SessionOptions | undefined): string | null {
  const raw = (options?.raw as { openCodeAgent?: unknown } | undefined)?.openCodeAgent;
  if (typeof raw !== 'string') return null;
  const trimmed = raw.trim();
  return trimmed.length > 0 ? trimmed : null;
}

/**
 * Build the `parts` array for an OpenCode prompt body from the user's message
 * text plus any Nimbalyst attachments (paste-as-file, drag/drop, etc).
 *
 * Attachments live on disk in app userData (outside the workspace), so they
 * cannot be reached by OpenCode's filesystem tools. We have to inline the
 * content into the prompt instead:
 *  - documents: read as UTF-8 and append a text part wrapped with the original
 *    filename so the agent can connect it to the `@filename` reference the
 *    renderer already inserted into the message text.
 *  - images / pdfs: read as a base64 `data:` URL and append as a `file` part.
 *
 * If a file can't be read we surface a short note in the prompt so the agent
 * sees a real explanation instead of hunting for the missing file on disk.
 */
export async function buildPromptParts(
  content: string,
  attachments?: ChatAttachment[]
): Promise<Array<{ type: 'text'; text: string } | { type: 'file'; mime: string; filename?: string; url: string }>> {
  const parts: Array<{ type: 'text'; text: string } | { type: 'file'; mime: string; filename?: string; url: string }> =
    [{ type: 'text', text: content }];

  if (!attachments || attachments.length === 0) {
    return parts;
  }

  for (const attachment of attachments) {
    if (!attachment.filepath) continue;

    if (attachment.type === 'document') {
      try {
        const text = await fs.readFile(attachment.filepath, 'utf-8');
        parts.push({
          type: 'text',
          text: `<file name="${attachment.filename}">\n${text}\n</file>`,
        });
      } catch (error) {
        const errMsg = error instanceof Error ? error.message : String(error);
        parts.push({
          type: 'text',
          text: `<file name="${attachment.filename}" error="failed to read attachment: ${errMsg}" />`,
        });
      }
      continue;
    }

    if (attachment.type === 'image' || attachment.type === 'pdf') {
      try {
        const data = await fs.readFile(attachment.filepath);
        const base64 = data.toString('base64');
        const mime = attachment.mimeType || (attachment.type === 'pdf' ? 'application/pdf' : 'application/octet-stream');
        parts.push({
          type: 'file',
          mime,
          filename: attachment.filename,
          url: `data:${mime};base64,${base64}`,
        });
      } catch (error) {
        const errMsg = error instanceof Error ? error.message : String(error);
        parts.push({
          type: 'text',
          text: `<file name="${attachment.filename}" error="failed to read attachment: ${errMsg}" />`,
        });
      }
    }
  }

  return parts;
}

/**
 * OpenCode SDK Protocol Adapter
 *
 * Provides a normalized interface to the OpenCode SDK, handling:
 * - Server subprocess lifecycle (singleton, reference-counted)
 * - Session creation and resumption
 * - SSE event streaming and parsing
 * - Custom plugin integration for file edit tracking
 *
 * Note: OpenCode does not support session forking. Calling forkSession
 * will create a new session instead.
 */
export class OpenCodeSDKProtocol implements AgentProtocol {
  readonly platform = 'opencode-sdk';

  private client: OpenCodeClientLike | null = null;
  private clientBaseUrl: string | null = null;
  private aborted = new Set<string>();
  private readonly loadSdkModule: () => Promise<{ createOpencodeClient: OpenCodeClientFactory }>;
  /**
   * Protocol sessions holding a server reference. `createSession`/`resumeSession`
   * run once per turn and each call bumps the manager's reference count, so
   * only the first one per session is kept -- otherwise the count could never
   * fall back to zero and the `opencode serve` child outlived the app's use of
   * it (#574).
   */
  private readonly serverRefsBySessionId = new Set<string>();
  private readonly resolvedModelBySessionId = new Map<
    string,
    { providerID: string; modelID: string }
  >();
  /**
   * Memoized `command.list` result. The catalog belongs to the running server,
   * so a fetch stays valid until that server process is replaced; keyed by
   * generation + directory so a restart or a different workspace re-fetches
   * (#574). Previously this ran on every turn.
   */
  private slashCommandCache: { key: string; commands: Promise<string[]> } | null = null;

  /**
   * @param loadSdkModule - Optional SDK loader for testing
   */
  constructor(
    loadSdkModule?: () => Promise<{ createOpencodeClient: OpenCodeClientFactory }>
  ) {
    this.loadSdkModule = loadSdkModule || (async () => {
      const sdk = await loadOpenCodeSdkClientModule();
      return {
        createOpencodeClient: sdk.createOpencodeClient as unknown as OpenCodeClientFactory,
      };
    });
  }

  /**
   * Create a new session
   */
  async createSession(options: SessionOptions): Promise<ProtocolSession> {
    const serverManager = OpenCodeServerManager.getInstance();
    let acquisitionOutstanding = true;
    try {
      await serverManager.ensureRunning(options.workspacePath, options.env);

      const client = await this.getClient(serverManager.baseUrl);
      await this.registerMcpServers(client, options);
      const result = await client.session.create({
        body: {},
        query: { directory: options.workspacePath },
      });

      const sessionId = result.data?.id ?? (result as any).id;
      console.log('[OPENCODE-PROTOCOL] Session created:', sessionId);
      this.retainServerReference(sessionId);
      acquisitionOutstanding = false;

      return {
        id: sessionId,
        platform: this.platform,
        raw: {
          options,
          baseUrl: serverManager.baseUrl,
        },
      };
    } finally {
      if (acquisitionOutstanding) serverManager.release();
    }
  }

  /**
   * Resume an existing session
   */
  async resumeSession(sessionId: string, options: SessionOptions): Promise<ProtocolSession> {
    const serverManager = OpenCodeServerManager.getInstance();
    let acquisitionOutstanding = true;
    try {
      await serverManager.ensureRunning(options.workspacePath, options.env);

      const client = await this.getClient(serverManager.baseUrl);
      await this.registerMcpServers(client, options);

      console.log('[OPENCODE-PROTOCOL] Resuming session:', sessionId);
      this.retainServerReference(sessionId);
      acquisitionOutstanding = false;

      return {
        id: sessionId,
        platform: this.platform,
        raw: {
          options,
          baseUrl: serverManager.baseUrl,
          resume: true,
        },
      };
    } finally {
      if (acquisitionOutstanding) serverManager.release();
    }
  }

  /**
   * List provider-native slash commands for this workspace (#574).
   *
   * Served from `slashCommandCache` for the lifetime of the server process the
   * session is talking to. The catalog is loaded by that server from the
   * workspace and user config, so a command the user adds is picked up when the
   * server is next started -- which happens on app launch and whenever the last
   * OpenCode session releases the previous one.
   */
  async listSlashCommands(session: ProtocolSession): Promise<string[]> {
    const directory = (session.raw?.options as SessionOptions | undefined)?.workspacePath;
    const key = `${OpenCodeServerManager.getInstance().serverGeneration}:${directory ?? ''}`;

    const cached = this.slashCommandCache;
    if (cached?.key === key) {
      return cached.commands;
    }

    const commands = this.fetchSlashCommands(session, directory).catch((error) => {
      // A failed fetch must not be cached: the next turn retries.
      if (this.slashCommandCache?.key === key) {
        this.slashCommandCache = null;
      }
      throw error;
    });
    this.slashCommandCache = { key, commands };
    return commands;
  }

  private async fetchSlashCommands(session: ProtocolSession, directory: string | undefined): Promise<string[]> {
    const client = await this.getActiveSessionClient(session);
    const result = await client.command.list({ query: { directory } });
    if (!Array.isArray(result.data)) {
      throw new Error('[OpenCode] command.list did not return a command catalog.');
    }
    return result.data.map((command) => command.name);
  }

  /** Compact this session through OpenCode's native summarize RPC. */
  async compactSession(session: ProtocolSession): Promise<void> {
    const options = session.raw?.options as SessionOptions | undefined;
    const model =
      parseOpenCodeModelId(options?.model) ??
      this.resolvedModelBySessionId.get(session.id);
    if (!model) {
      throw new Error(
        'Cannot compact this OpenCode session before an assistant message reports its provider/model.'
      );
    }
    const client = await this.getActiveSessionClient(session);
    const result = await client.session.summarize({
      path: { id: session.id },
      query: { directory: options?.workspacePath },
      body: model,
    });
    if (result.data !== true) {
      throw new Error('[OpenCode] session.summarize did not compact the session.');
    }
  }

  /**
   * Keep exactly one server reference per protocol session. `ensureRunning`
   * has already incremented the count for this call; a session that already
   * holds a reference hands the surplus one straight back.
   */
  private retainServerReference(sessionId: string): void {
    if (this.serverRefsBySessionId.has(sessionId)) {
      OpenCodeServerManager.getInstance().release();
      return;
    }
    this.serverRefsBySessionId.add(sessionId);
  }

  private async getActiveSessionClient(session: ProtocolSession): Promise<OpenCodeClientLike> {
    const baseUrl = session.raw?.baseUrl as string | undefined;
    if (!baseUrl) {
      throw new Error('Invalid session: missing baseUrl');
    }
    if (!OpenCodeServerManager.getInstance().isRunning) {
      throw new Error('Cannot use OpenCode session RPCs: the server is not running.');
    }
    return this.getClient(baseUrl);
  }

  // Pushes MCP servers from SessionOptions into the OpenCode server's
  // dynamic registration via POST /mcp. Without this, OpenCode never sees
  // any of Nimbalyst's internal MCP tools (AskUserQuestion, tracker_*,
  // capture_editor_screenshot, etc.) because the SDK has no per-session
  // MCP config -- registration is workspace-scoped at the server level.
  //
  // Nimbalyst hands us configs in SSE shape ({ type: 'sse', url, headers? }).
  // OpenCode wants HTTP/remote shape ({ type: 'remote', url, headers? }),
  // so we translate. Idempotent calls -- if the server is already
  // registered with the same name, the add is a no-op or replaces in place.
  private async registerMcpServers(client: OpenCodeClientLike, options: SessionOptions): Promise<void> {
    if (!options.mcpServers) return;

    for (const [name, rawConfig] of Object.entries(options.mcpServers)) {
      const config = this.toOpenCodeMcpConfig(rawConfig as Record<string, unknown>);
      if (!config) continue;

      try {
        await client.mcp.add({
          body: { name, config },
          query: { directory: options.workspacePath },
        });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        // Treat already-registered as a no-op; everything else is logged but
        // non-fatal so a single bad server doesn't kill the whole session.
        if (/already|exists|conflict/i.test(msg)) continue;
        console.warn(`[OPENCODE-PROTOCOL] Failed to register MCP server "${name}":`, msg);
      }
    }
  }

  private toOpenCodeMcpConfig(raw: Record<string, unknown> | undefined): Record<string, unknown> | null {
    if (!raw) return null;

    const transport = (raw.transport as string | undefined) || (raw.type as string | undefined);
    const url = raw.url as string | undefined;
    const command = raw.command as string | string[] | undefined;
    const args = raw.args as string[] | undefined;

    if ((transport === 'sse' || transport === 'http' || transport === 'remote') && url) {
      const remote: Record<string, unknown> = { type: 'remote', url };
      if (raw.headers) remote.headers = raw.headers;
      return remote;
    }

    if (command) {
      const commandArray = Array.isArray(command)
        ? command
        : [command, ...(args ?? [])];
      const local: Record<string, unknown> = { type: 'local', command: commandArray };
      if (raw.env) local.environment = raw.env;
      return local;
    }

    return null;
  }

  /**
   * Fork an existing session
   *
   * OpenCode does not support session forking.
   * Creates a new session instead.
   */
  async forkSession(sessionId: string, options: SessionOptions): Promise<ProtocolSession> {
    console.warn('[OPENCODE-PROTOCOL] OpenCode does not support session forking. Creating new session instead.');
    return this.createSession(options);
  }

  /**
   * Send a message and receive streaming events
   *
   * This method:
   * 1. Subscribes to SSE events
   * 2. Sends the prompt via the SDK
   * 3. Parses SSE events into protocol events
   * 4. Yields events as they arrive
   * 5. Completes when the session goes idle
   */
  async *sendMessage(
    session: ProtocolSession,
    message: ProtocolMessage
  ): AsyncIterable<ProtocolEvent> {
    const baseUrl = session.raw?.baseUrl as string;
    if (!baseUrl) {
      throw new Error('Invalid session: missing baseUrl');
    }

    const client = await this.getClient(baseUrl);
    const sessionId = session.id;

    // Subscribe to SSE events
    const subscription = await client.event.subscribe({
      query: { directory: (session.raw?.options as SessionOptions)?.workspacePath },
    });

    let fullText = '';
    const usageByMessageId = new Map<string, OpenCodeUsageSnapshot>();
    let latestUsage: OpenCodeUsageSnapshot | undefined;

    try {
      const sessionOptions = session.raw?.options as SessionOptions | undefined;
      const modelSelector = parseOpenCodeModelId(sessionOptions?.model);

      // Send the prompt (non-blocking -- events arrive via SSE). Omit `model`
      // only for an explicit default signal; malformed ids must not silently
      // fall back to OpenCode's config default (#730).
      const parts = await buildPromptParts(message.content, message.attachments);
      const promptBody: Record<string, unknown> = {
        parts,
      };
      if (modelSelector) {
        promptBody.model = modelSelector;
      }
      // The session role belongs on the prompt body, not on session creation:
      // `POST /session` accepts only parentID/title, while every prompt carries
      // its own `agent`. Sending it here is also what lets the user change role
      // mid-conversation.
      const agentRole = readAgentRole(sessionOptions);
      if (agentRole) {
        promptBody.agent = agentRole;
      }
      const promptPromise = client.session.prompt({
        path: { id: sessionId },
        query: { directory: sessionOptions?.workspacePath },
        body: promptBody,
      });

      // Process SSE events
      for await (const rawEvent of subscription.stream) {
        // The SDK may wrap events in a GlobalEvent: { directory, payload }
        const event: OpenCodeSSEEvent = (rawEvent as any).payload ?? rawEvent;

        // Check abort
        if (this.aborted.has(sessionId)) {
          this.aborted.delete(sessionId);
          throw new Error('Operation cancelled');
        }

        // The OpenCode SDK's SSE stream is server-wide -- it emits events
        // for every active session on the local server. Skip anything that
        // belongs to a different session so we don't bleed cross-session
        // events into this session's raw log. Events without a session ID
        // (e.g. server.connected) are treated as session-agnostic and kept.
        const eventSessionId = extractEventSessionId(event);
        if (eventSessionId && eventSessionId !== sessionId) {
          continue;
        }

        // Emit raw event for persistence
        yield {
          type: 'raw_event',
          metadata: { rawEvent: event },
        };

        // Parse and yield protocol events
        const protocolEvents = this.parseSSEEvent(event, sessionId);
        for (const protocolEvent of protocolEvents) {
          if (protocolEvent.type === 'text' && protocolEvent.content) {
            fullText += protocolEvent.content;
          }
          if (protocolEvent.type === 'usage' && protocolEvent.usage) {
            const snapshot: OpenCodeUsageSnapshot = {
              usage: protocolEvent.usage,
              contextFillTokens: protocolEvent.contextFillTokens ?? protocolEvent.usage.input_tokens,
              ...(typeof protocolEvent.metadata?.openCodeMessageId === 'string'
                ? { messageId: protocolEvent.metadata.openCodeMessageId }
                : {}),
              ...(typeof protocolEvent.metadata?.openCodeModelId === 'string'
                ? { modelId: protocolEvent.metadata.openCodeModelId }
                : {}),
            };
            latestUsage = snapshot;
            if (snapshot.messageId) {
              // message.updated can repeat for the same assistant message as
              // OpenCode fills in its final token counts. Latest wins so a
              // streaming update is never counted twice.
              usageByMessageId.set(snapshot.messageId, snapshot);
            }
          }

          // Session idle means the agent is done
          if (protocolEvent.type === 'complete') {
            const snapshots = usageByMessageId.size > 0
              ? [...usageByMessageId.values()]
              : (latestUsage ? [latestUsage] : []);
            const normalizedUsage = aggregateOpenCodeUsage(snapshots);
            yield {
              ...protocolEvent,
              content: fullText,
              ...(normalizedUsage ? { usage: normalizedUsage } : {}),
              ...(latestUsage
                ? {
                    contextFillTokens: latestUsage.contextFillTokens,
                    metadata: {
                      ...protocolEvent.metadata,
                      ...(latestUsage.modelId ? { openCodeModelId: latestUsage.modelId } : {}),
                    },
                  }
                : {}),
            };
            return;
          }

          yield protocolEvent;
        }
      }

      // Wait for prompt to complete if it hasn't already
      await promptPromise;

      // Emit completion event
      const snapshots = usageByMessageId.size > 0
        ? [...usageByMessageId.values()]
        : (latestUsage ? [latestUsage] : []);
      const normalizedUsage = aggregateOpenCodeUsage(snapshots);
      yield {
        type: 'complete',
        content: fullText,
        ...(normalizedUsage ? { usage: normalizedUsage } : {}),
        ...(latestUsage
          ? {
              contextFillTokens: latestUsage.contextFillTokens,
              metadata: latestUsage.modelId
                ? { openCodeModelId: latestUsage.modelId }
                : undefined,
            }
          : {}),
      };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      const isAbort = this.aborted.has(sessionId) || /abort|cancel/i.test(errorMessage);

      if (!isAbort) {
        yield {
          type: 'error',
          error: errorMessage,
        };
      }
    }
  }

  /**
   * Abort an active session
   */
  abortSession(session: ProtocolSession): void {
    this.aborted.add(session.id);
    // Also call the server abort endpoint
    this.getClientIfReady()?.session.abort({
      path: { id: session.id },
      query: { directory: (session.raw?.options as SessionOptions)?.workspacePath },
    }).catch(() => {});
  }

  /**
   * Clean up session resources. Releasing the last reference stops the
   * `opencode serve` child.
   */
  cleanupSession(session: ProtocolSession): void {
    this.aborted.delete(session.id);
    this.resolvedModelBySessionId.delete(session.id);
    if (this.serverRefsBySessionId.delete(session.id)) {
      OpenCodeServerManager.getInstance().release();
    }
  }

  /**
   * Parse an OpenCode SSE event into protocol events.
   * Filters events to only the target session.
   */
  private parseSSEEvent(event: OpenCodeSSEEvent, targetSessionId: string): ProtocolEvent[] {
    const events: ProtocolEvent[] = [];
    const props = event.properties || {};

    // Defense in depth: the streaming loop already filters cross-session
    // events before this is called, but if a new caller forgets, we still
    // bail out here.
    const eventSessionId = extractEventSessionId(event);
    if (eventSessionId && eventSessionId !== targetSessionId) {
      return events;
    }

    switch (event.type) {
      // Text/reasoning content updates
      case 'message.part.updated': {
        const part = props.part as Record<string, unknown> | undefined;
        const delta = props.delta as string | undefined;
        if (!part) break;

        const partType = part.type as string;

        if (partType === 'text') {
          // Use delta for incremental text, fall back to full text
          const content = delta ?? (part.text as string);
          if (content) {
            events.push({ type: 'text', content });
          }
        } else if (partType === 'reasoning') {
          const content = delta ?? (part.text as string);
          if (content) {
            events.push({ type: 'reasoning', content });
          }
        } else if (partType === 'tool') {
          // Tool part -- represents a tool call with state transitions
          // Real SDK uses `status` field: pending -> running -> completed | error
          const toolName = part.tool as string || 'unknown';
          const callId = part.callID as string || part.id as string;
          const state = part.state as Record<string, unknown> | undefined;
          const stateStatus = (state?.status as string) || (state?.type as string);

          if (stateStatus === 'running') {
            // Emit tool_call -- this is the pre-edit signal.
            // The provider/file tracker should snapshot the target file NOW
            // before the tool modifies it.
            events.push({
              type: 'tool_call',
              toolCall: {
                ...(callId ? { id: callId } : {}),
                name: toolName,
                arguments: (state as any)?.input as Record<string, unknown> || {},
              },
              metadata: {
                preEdit: true,
              },
            });
          } else if (stateStatus === 'completed' || stateStatus === 'error') {
            const result: ToolResult = {
              success: stateStatus === 'completed',
              result: (state as any)?.output,
              ...(stateStatus === 'error' ? { error: (state as any)?.error || 'Tool execution failed' } : {}),
            };
            events.push({
              type: 'tool_result',
              toolResult: {
                ...(callId ? { id: callId } : {}),
                name: toolName,
                result,
              },
              metadata: {
                postEdit: true,
              },
            });
          }
        }
        break;
      }

      // Incremental text/reasoning updates (delta streaming)
      case 'message.part.delta': {
        const delta = props.delta as string | undefined;
        const field = props.field as string | undefined;
        if (delta && field === 'text') {
          // Could be text or reasoning -- we need the part type to know.
          // Default to text since that's most common; reasoning parts are
          // typically delivered through message.part.updated with full text.
          events.push({ type: 'text', content: delta });
        }
        break;
      }

      // OpenCode reports one usage snapshot per assistant message. Input plus
      // cache reads/writes is the current context fill; output is generated
      // after that prompt and therefore is not part of this snapshot.
      case 'message.updated': {
        const info = props.info as Record<string, unknown> | undefined;
        if (!info || info.role !== 'assistant') break;
        const providerId =
          typeof info.providerID === 'string' ? info.providerID.trim() : '';
        const modelId =
          typeof info.modelID === 'string' ? info.modelID.trim() : '';
        if (providerId && modelId) {
          this.resolvedModelBySessionId.set(targetSessionId, {
            providerID: providerId,
            modelID: modelId,
          });
        }
        const tokens = info.tokens as Record<string, unknown> | undefined;
        if (!tokens) break;
        const cache = tokens.cache as Record<string, unknown> | undefined;
        const inputTokens = toTokenCount(tokens.input);
        const outputTokens = toTokenCount(tokens.output);
        const contextFillTokens = inputTokens
          + toTokenCount(cache?.read)
          + toTokenCount(cache?.write);
        const reportedTotal = toOptionalTokenCount(tokens.total);

        events.push({
          type: 'usage',
          usage: {
            input_tokens: inputTokens,
            output_tokens: outputTokens,
            total_tokens: reportedTotal ?? inputTokens + outputTokens,
          },
          contextFillTokens,
          metadata: {
            ...(typeof info.id === 'string' ? { openCodeMessageId: info.id } : {}),
            ...(providerId && modelId
              ? { openCodeModelId: `opencode:${providerId}/${modelId}` }
              : {}),
          },
        });
        break;
      }

      // File edited notification
      case 'file.edited': {
        const filePath = props.file as string;
        if (filePath) {
          events.push({
            type: 'tool_call',
            toolCall: {
              name: 'file_edit',
              arguments: { file_path: filePath },
            },
            metadata: {
              isFileEditNotification: true,
            },
          });
        }
        break;
      }

      // Session completed/idle
      case 'session.idle': {
        events.push({
          type: 'complete',
          content: '',
        });
        break;
      }

      // Session error.
      // OpenCode shapes errors as `{ name: 'UnknownError' | ..., data: { message } }`
      // for runtime errors bubbled up from the model provider, plus simpler
      // shapes for SDK-level errors. Try the most specific path first so the
      // user actually sees what went wrong (context-too-small, auth, etc.)
      // instead of a generic "Unknown error".
      case 'session.error': {
        const errorObj = props.error as Record<string, unknown> | string | undefined;
        let errorMsg: string;
        if (typeof errorObj === 'string') {
          errorMsg = errorObj;
        } else if (errorObj && typeof errorObj === 'object') {
          const data = (errorObj as any).data;
          const dataMessage = typeof data === 'object' && data !== null
            ? (data.message as string | undefined)
            : (typeof data === 'string' ? data : undefined);
          errorMsg = dataMessage
            || (errorObj as any).message
            || (errorObj as any).name
            || (errorObj as any).type
            || 'Unknown error';
          // Strip wrapping quotes that some providers (e.g. llama.cpp via LM Studio)
          // include when forwarding raw model-server messages.
          if (typeof errorMsg === 'string') {
            errorMsg = errorMsg.replace(/^"|"$/g, '');
          }
        } else {
          errorMsg = 'Unknown error';
        }
        events.push({
          type: 'error',
          error: errorMsg,
        });
        break;
      }

      // Permission request
      case 'permission.updated': {
        // Permission requests are handled by the provider layer
        // Pass through as raw event
        break;
      }

      // Session status transitions
      case 'session.status': {
        const status = props.status as Record<string, unknown> | string | undefined;
        const statusType = typeof status === 'object' ? (status?.type as string) : status;
        if (statusType === 'busy') {
          // Session is actively processing -- could emit planning_mode_entered
          // but OpenCode doesn't distinguish planning vs execution
        }
        break;
      }

      // Todo/planning updates
      case 'todo.updated': {
        // Pass through as raw event - the provider layer can use this
        break;
      }

      default:
        // Unknown event types are captured via the raw_event yield above
        break;
    }

    return events;
  }

  /**
   * Get or create the SDK client
   */
  private async getClient(baseUrl: string): Promise<OpenCodeClientLike> {
    if (this.client && this.clientBaseUrl === baseUrl) {
      return this.client;
    }

    const sdkModule = await this.loadSdkModule();
    this.client = sdkModule.createOpencodeClient({ baseUrl });
    this.clientBaseUrl = baseUrl;
    return this.client;
  }

  /**
   * Get the client if already initialized (non-async, for abort)
   */
  private getClientIfReady(): OpenCodeClientLike | null {
    return this.client;
  }
}

function toTokenCount(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0
    ? value
    : 0;
}

function toOptionalTokenCount(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0
    ? value
    : undefined;
}

function aggregateOpenCodeUsage(
  snapshots: OpenCodeUsageSnapshot[]
): ProtocolEvent['usage'] | undefined {
  if (snapshots.length === 0) return undefined;
  return snapshots.reduce<NonNullable<ProtocolEvent['usage']>>(
    (total, snapshot) => ({
      input_tokens: total.input_tokens + snapshot.usage.input_tokens,
      output_tokens: total.output_tokens + snapshot.usage.output_tokens,
      total_tokens: total.total_tokens + snapshot.usage.total_tokens,
    }),
    { input_tokens: 0, output_tokens: 0, total_tokens: 0 },
  );
}

// Pulls the OpenCode session ID out of an SSE event so we can route events to
// the right session. The ID lives in different places depending on the event
// type:
//   - Most events:                        properties.sessionID
//   - message.part.* events:              properties.part.sessionID
//   - message.updated:                    properties.info.sessionID
//   - session.updated:                    properties.info.id (the session itself)
// Returns undefined for session-agnostic events like server.connected.
function extractEventSessionId(event: OpenCodeSSEEvent): string | undefined {
  const props = event.properties;
  if (!props) return undefined;

  if (typeof props.sessionID === 'string') return props.sessionID;

  const part = props.part as Record<string, unknown> | undefined;
  if (part && typeof part.sessionID === 'string') return part.sessionID;

  const info = props.info as Record<string, unknown> | undefined;
  if (info) {
    if (typeof info.sessionID === 'string') return info.sessionID;
    if (event.type === 'session.updated' && typeof info.id === 'string') {
      return info.id;
    }
  }

  return undefined;
}
