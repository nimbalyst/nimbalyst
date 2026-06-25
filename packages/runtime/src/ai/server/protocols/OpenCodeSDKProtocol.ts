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
import type { ChatAttachment } from '../types';
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
  postSessionIdPermissionsPermissionId?: (options: Record<string, unknown>) => Promise<unknown>;
  session: {
    create: (options?: Record<string, unknown>) => Promise<{ data: { id: string; [key: string]: unknown } }>;
    list: (options?: Record<string, unknown>) => Promise<{ data: Array<{ id: string; [key: string]: unknown }> }>;
    prompt: (options: Record<string, unknown>) => Promise<unknown>;
    abort: (options: Record<string, unknown>) => Promise<unknown>;
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

interface OpenCodeStreamState {
  assistantMessageIds: Set<string>;
  userMessageIds: Set<string>;
  partTextSnapshots: Map<string, string>;
  partTypes: Map<string, string>;
  latestUsage?: ProtocolEvent['usage'];
  latestContextFillTokens?: number;
  latestContextWindow?: number;
}

/**
 * Factory function type for creating OpenCode SDK clients.
 * Allows dependency injection for testing.
 */
export type OpenCodeClientFactory = (options: { baseUrl: string }) => OpenCodeClientLike;

/**
 * Singleton manager for the OpenCode server subprocess.
 * Reference-counted: starts on first session, stops when last session ends.
 */
class OpenCodeServerManager {
  private static instance: OpenCodeServerManager | null = null;

  private serverProcess: ChildProcess | null = null;
  private port: number = 0;
  private sessionCount = 0;
  private ready = false;
  private readyPromise: Promise<void> | null = null;
  private workspacePath: string = '';

  static getInstance(): OpenCodeServerManager {
    if (!OpenCodeServerManager.instance) {
      OpenCodeServerManager.instance = new OpenCodeServerManager();
    }
    return OpenCodeServerManager.instance;
  }

  get baseUrl(): string {
    return `http://127.0.0.1:${this.port}`;
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
    // Find an available port
    this.port = await this.findAvailablePort();

    console.log(`[OPENCODE-PROTOCOL] Starting OpenCode server on port ${this.port}`);

    const serverEnv: Record<string, string> = {
      ...process.env as Record<string, string>,
      ...(env || {}),
    };

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
      this.ready = false;
      this.readyPromise = null;
    });

    this.serverProcess.on('exit', (code, signal) => {
      console.log(`[OPENCODE-PROTOCOL] Server exited: code=${code}, signal=${signal}`);
      this.serverProcess = null;
      this.ready = false;
      this.readyPromise = null;
    });

    // Capture stderr for debugging
    this.serverProcess.stderr?.on('data', (data: Buffer) => {
      const text = data.toString().trim();
      if (text) {
        // console.log('[OPENCODE-PROTOCOL] Server stderr:', text);
      }
    });

    // Wait for the server to be ready by polling the health endpoint
    await this.waitForReady();
    this.ready = true;
    this.readyPromise = null;
  }

  private async waitForReady(timeoutMs = 30000): Promise<void> {
    const startTime = Date.now();
    const pollIntervalMs = 200;

    while (Date.now() - startTime < timeoutMs) {
      try {
        const response = await fetch(`${this.baseUrl}/global/health`);
        if (response.ok) {
          console.log(`[OPENCODE-PROTOCOL] Server ready on port ${this.port}`);
          return;
        }
      } catch {
        // Server not ready yet
      }
      await new Promise(resolve => setTimeout(resolve, pollIntervalMs));
    }

    throw new Error(`OpenCode server failed to start within ${timeoutMs}ms`);
  }

  private stopServer(): void {
    if (this.serverProcess) {
      console.log('[OPENCODE-PROTOCOL] Stopping OpenCode server');
      this.serverProcess.kill('SIGTERM');

      // Force kill after 5 seconds if still running
      const forceKillTimeout = setTimeout(() => {
        if (this.serverProcess) {
          this.serverProcess.kill('SIGKILL');
        }
      }, 5000);

      this.serverProcess.on('exit', () => {
        clearTimeout(forceKillTimeout);
      });

      this.serverProcess = null;
      this.ready = false;
    }
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
 * Load the @opencode-ai/sdk module dynamically.
 */
async function loadOpenCodeSdkModule(): Promise<{ createOpencodeClient: OpenCodeClientFactory }> {
  try {
    // Dynamic import -- the SDK is ESM-only so we use the /client subpath
    const moduleName = '@opencode-ai/sdk/client';
    const sdkModule = await import(/* webpackIgnore: true */ moduleName);
    return sdkModule;
  } catch (error) {
    throw new Error(
      'Failed to load @opencode-ai/sdk. Install it with: npm install @opencode-ai/sdk\n' +
      `Error: ${error instanceof Error ? error.message : String(error)}`
    );
  }
}

/**
 * Convert a Nimbalyst-style OpenCode model id (e.g. `opencode:anthropic/claude-sonnet-4-5`
 * or just `anthropic/claude-sonnet-4-5`) into the `{ providerID, modelID }` shape
 * the OpenCode SDK expects in the prompt body. Returns null when the id can't be
 * parsed -- callers should omit the field so OpenCode picks its config default.
 */
export function parseOpenCodeModelId(
  rawModel: string | undefined
): { providerID: string; modelID: string } | null {
  if (!rawModel) return null;
  const stripped = rawModel.startsWith('opencode:') ? rawModel.slice('opencode:'.length) : rawModel;
  if (!stripped || stripped === 'default') return null;
  const slashIdx = stripped.indexOf('/');
  if (slashIdx <= 0 || slashIdx === stripped.length - 1) return null;
  return {
    providerID: stripped.slice(0, slashIdx),
    modelID: stripped.slice(slashIdx + 1),
  };
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
  private aborted = new Set<string>();
  private readonly loadSdkModule: () => Promise<{ createOpencodeClient: OpenCodeClientFactory }>;

  /**
   * @param loadSdkModule - Optional SDK loader for testing
   */
  constructor(
    loadSdkModule?: () => Promise<{ createOpencodeClient: OpenCodeClientFactory }>
  ) {
    this.loadSdkModule = loadSdkModule || loadOpenCodeSdkModule;
  }

  /**
   * Create a new session
   */
  async createSession(options: SessionOptions): Promise<ProtocolSession> {
    const serverManager = OpenCodeServerManager.getInstance();
    await serverManager.ensureRunning(options.workspacePath, options.env);

    const client = await this.getClient(serverManager.baseUrl);
    await this.registerMcpServers(client, options);
    const result = await client.session.create({
      body: {},
      query: { directory: options.workspacePath },
    });

    const sessionId = result.data?.id ?? (result as any).id;
    console.log('[OPENCODE-PROTOCOL] Session created:', sessionId);

    return {
      id: sessionId,
      platform: this.platform,
      raw: {
        options,
        baseUrl: serverManager.baseUrl,
      },
    };
  }

  /**
   * Resume an existing session
   */
  async resumeSession(sessionId: string, options: SessionOptions): Promise<ProtocolSession> {
    const serverManager = OpenCodeServerManager.getInstance();
    await serverManager.ensureRunning(options.workspacePath, options.env);

    const client = await this.getClient(serverManager.baseUrl);
    await this.registerMcpServers(client, options);

    console.log('[OPENCODE-PROTOCOL] Resuming session:', sessionId);

    return {
      id: sessionId,
      platform: this.platform,
      raw: {
        options,
        baseUrl: serverManager.baseUrl,
        resume: true,
      },
    };
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
    let usage: { input_tokens: number; output_tokens: number; total_tokens: number } | undefined;
    const streamState = createOpenCodeStreamState();

    try {
      const sessionOptions = session.raw?.options as SessionOptions | undefined;
      const modelSelector = parseOpenCodeModelId(sessionOptions?.model);

      // Send the prompt (non-blocking -- events arrive via SSE).
      // The `model` field is optional -- when omitted, OpenCode falls back to
      // the default model from its config file (~/.config/opencode/opencode.json).
      const parts = await buildPromptParts(message.content, message.attachments);
      const promptBody: Record<string, unknown> = {
        parts,
      };
      if (modelSelector) {
        promptBody.model = modelSelector;
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
        const protocolEvents = this.parseSSEEvent(event, sessionId, streamState);
        for (const protocolEvent of protocolEvents) {
          if (protocolEvent.type === 'text' && protocolEvent.content) {
            fullText += protocolEvent.content;
          }
          if (protocolEvent.usage) {
            usage = protocolEvent.usage;
          }
          yield protocolEvent;

          // Session idle means the agent is done
          if (protocolEvent.type === 'complete') {
            return;
          }
        }
      }

      // Wait for prompt to complete if it hasn't already
      await promptPromise;

      // Emit completion event
      yield {
        type: 'complete',
        content: fullText,
        usage: usage ?? streamState.latestUsage ?? { input_tokens: 0, output_tokens: 0, total_tokens: 0 },
        ...(streamState.latestContextFillTokens !== undefined ? { contextFillTokens: streamState.latestContextFillTokens } : {}),
        ...(streamState.latestContextWindow !== undefined ? { contextWindow: streamState.latestContextWindow } : {}),
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

  async respondToPermission(
    session: ProtocolSession,
    permissionId: string,
    response: 'once' | 'always' | 'reject',
  ): Promise<void> {
    const baseUrl = session.raw?.baseUrl as string;
    if (!baseUrl) {
      throw new Error('Invalid session: missing baseUrl');
    }

    const client = await this.getClient(baseUrl);
    if (typeof client.postSessionIdPermissionsPermissionId !== 'function') {
      throw new Error('OpenCode SDK client does not expose the permission response endpoint');
    }

    await client.postSessionIdPermissionsPermissionId({
      path: { id: session.id, permissionID: permissionId },
      query: { directory: (session.raw?.options as SessionOptions | undefined)?.workspacePath },
      body: { response },
    });
  }

  /**
   * Clean up session resources
   */
  cleanupSession(session: ProtocolSession): void {
    this.aborted.delete(session.id);
    // Release server reference
    OpenCodeServerManager.getInstance().release();
  }

  /**
   * Parse an OpenCode SSE event into protocol events.
   * Filters events to only the target session.
   */
  private parseSSEEvent(
    event: OpenCodeSSEEvent,
    targetSessionId: string,
    streamState: OpenCodeStreamState,
  ): ProtocolEvent[] {
    const events: ProtocolEvent[] = [];
    const props = event.properties || {};

    // Defense in depth: the streaming loop already filters cross-session
    // events before this is called, but if a new caller forgets, we still
    // bail out here.
    const eventSessionId = extractEventSessionId(event);
    if (eventSessionId && eventSessionId !== targetSessionId) {
      return events;
    }

    rememberOpenCodeUsage(event, props, streamState);

    const eventType = normalizeOpenCodeEventType(event.type);

    switch (eventType) {
      case 'message.updated': {
        recordMessageRole(props, streamState);
        break;
      }

      // Text/reasoning content updates
      case 'message.part.updated': {
        const part = props.part as Record<string, unknown> | undefined;
        if (!part) break;

        const partType = part.type as string;
        rememberPartType(part, props, targetSessionId, streamState, partType);

        const messageID = stringField(part.messageID) ?? stringField(props.messageID);
        if (messageID && streamState.userMessageIds.has(messageID)) {
          break;
        }

        if (partType === 'text') {
          const content = derivePartTextChunk(part, props, targetSessionId, streamState, partType);
          if (content) {
            events.push({ type: 'text', content });
          }
        } else if (partType === 'reasoning') {
          const content = derivePartTextChunk(part, props, targetSessionId, streamState, partType);
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
          const messageID = stringField(props.messageID);
          if (messageID && streamState.userMessageIds.has(messageID)) {
            break;
          }

          const partIdentityKey = openCodePartIdentityKeyFromProps(props, targetSessionId);
          const partType = streamState.partTypes.get(partIdentityKey) ?? 'text';
          rememberPartDelta(props, targetSessionId, streamState, partType, delta);

          if (partType === 'reasoning') {
            events.push({ type: 'reasoning', content: delta });
          } else {
            events.push({ type: 'text', content: delta });
          }
        }
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
        const completeEvent: ProtocolEvent = {
          type: 'complete',
          content: '',
          ...(streamState.latestUsage ? { usage: streamState.latestUsage } : {}),
          ...(streamState.latestContextFillTokens !== undefined ? { contextFillTokens: streamState.latestContextFillTokens } : {}),
          ...(streamState.latestContextWindow !== undefined ? { contextWindow: streamState.latestContextWindow } : {}),
        };
        events.push(completeEvent);
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
      case 'permission.updated':
      case 'permission.asked': {
        const permissionId = stringField(props.id) ?? stringField(props.requestID);
        if (!permissionId) break;
        events.push({
          type: 'tool_call',
          toolCall: {
            id: permissionId,
            name: 'ToolPermission',
            arguments: buildOpenCodePermissionToolArgs(props),
          },
          metadata: {
            openCodePermissionRequest: true,
            permissionId,
          },
        });
        break;
      }

      case 'permission.replied': {
        const permissionId = stringField(props.permissionID)
          ?? stringField(props.requestID)
          ?? stringField(props.id);
        if (!permissionId) break;
        const response = stringField(props.response) ?? stringField(props.reply) ?? '';
        events.push({
          type: 'tool_result',
          toolResult: {
            id: permissionId,
            name: 'ToolPermission',
            result: {
              success: response !== 'reject',
              result: JSON.stringify(openCodePermissionResponseToNimbalyst(response)),
            },
          },
        });
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
    if (this.client) {
      return this.client;
    }

    const sdkModule = await this.loadSdkModule();
    this.client = sdkModule.createOpencodeClient({ baseUrl });
    return this.client;
  }

  /**
   * Get the client if already initialized (non-async, for abort)
   */
  private getClientIfReady(): OpenCodeClientLike | null {
    return this.client;
  }
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
    if (normalizeOpenCodeEventType(event.type) === 'session.updated' && typeof info.id === 'string') {
      return info.id;
    }
  }

  return undefined;
}

function normalizeOpenCodeEventType(type: string): string {
  return type.replace(/\.\d+$/, '');
}

function createOpenCodeStreamState(): OpenCodeStreamState {
  return {
    assistantMessageIds: new Set(),
    userMessageIds: new Set(),
    partTextSnapshots: new Map(),
    partTypes: new Map(),
    latestUsage: undefined,
    latestContextFillTokens: undefined,
    latestContextWindow: undefined,
  };
}

function rememberOpenCodeUsage(
  event: OpenCodeSSEEvent,
  props: Record<string, unknown>,
  streamState: OpenCodeStreamState,
): void {
  const usage = extractOpenCodeUsage(event, props);
  if (usage) {
    streamState.latestUsage = usage;
    if (streamState.latestContextFillTokens === undefined && usage.total_tokens > 0) {
      streamState.latestContextFillTokens = usage.total_tokens;
    }
  }

  const contextWindow = extractNumberFromCandidates([
    props,
    props.info,
    props.message,
    props.part,
    (props.info as Record<string, unknown> | undefined)?.model,
    (props.message as Record<string, unknown> | undefined)?.model,
  ], ['contextWindow', 'context_window', 'model_context_window', 'context_length', 'contextLength']);
  if (contextWindow !== undefined && contextWindow > 0) {
    streamState.latestContextWindow = contextWindow;
  }

  const contextFillTokens = extractNumberFromCandidates([
    props,
    props.info,
    props.message,
    props.part,
  ], ['contextFillTokens', 'context_fill_tokens', 'context_tokens', 'contextTokens']);
  if (contextFillTokens !== undefined && contextFillTokens >= 0) {
    streamState.latestContextFillTokens = contextFillTokens;
  }
}

function extractOpenCodeUsage(
  event: OpenCodeSSEEvent,
  props: Record<string, unknown>,
): ProtocolEvent['usage'] | undefined {
  const candidates = [
    (event as unknown as Record<string, unknown>).usage,
    props.usage,
    (props.info as Record<string, unknown> | undefined)?.usage,
    (props.message as Record<string, unknown> | undefined)?.usage,
    (props.part as Record<string, unknown> | undefined)?.usage,
  ];

  for (const candidate of candidates) {
    const usage = normalizeOpenCodeUsage(candidate);
    if (usage) return usage;
  }

  return undefined;
}

function normalizeOpenCodeUsage(value: unknown): ProtocolEvent['usage'] | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const obj = value as Record<string, unknown>;
  const input =
    readNumericField(obj, ['input_tokens', 'inputTokens', 'prompt_tokens', 'promptTokens']) ??
    readNumericField(obj, ['input', 'prompt']);
  const output =
    readNumericField(obj, ['output_tokens', 'outputTokens', 'completion_tokens', 'completionTokens']) ??
    readNumericField(obj, ['output', 'completion']);
  const total =
    readNumericField(obj, ['total_tokens', 'totalTokens']) ??
    ((input !== undefined || output !== undefined) ? (input ?? 0) + (output ?? 0) : undefined);

  if (input === undefined && output === undefined && total === undefined) {
    return undefined;
  }

  return {
    input_tokens: Math.max(0, Math.trunc(input ?? 0)),
    output_tokens: Math.max(0, Math.trunc(output ?? 0)),
    total_tokens: Math.max(0, Math.trunc(total ?? 0)),
  };
}

function extractNumberFromCandidates(
  candidates: unknown[],
  keys: string[],
): number | undefined {
  for (const candidate of candidates) {
    if (!candidate || typeof candidate !== 'object') continue;
    const value = readNumericField(candidate as Record<string, unknown>, keys);
    if (value !== undefined) return value;
  }
  return undefined;
}

function readNumericField(obj: Record<string, unknown>, keys: string[]): number | undefined {
  for (const key of keys) {
    const value = obj[key];
    if (typeof value === 'number' && Number.isFinite(value)) return value;
    if (typeof value === 'string') {
      const parsed = Number(value);
      if (Number.isFinite(parsed)) return parsed;
    }
  }
  return undefined;
}

function recordMessageRole(
  props: Record<string, unknown>,
  streamState: OpenCodeStreamState,
): void {
  const info = props.info as Record<string, unknown> | undefined;
  const messageID = stringField(info?.id) ?? stringField(props.messageID);
  if (!messageID) return;

  const role = info?.role;
  if (role === 'user') {
    streamState.userMessageIds.add(messageID);
    streamState.assistantMessageIds.delete(messageID);
    return;
  }

  if (role === 'assistant') {
    streamState.assistantMessageIds.add(messageID);
    streamState.userMessageIds.delete(messageID);
  }
}

function rememberPartType(
  part: Record<string, unknown>,
  props: Record<string, unknown>,
  targetSessionId: string,
  streamState: OpenCodeStreamState,
  partType: string,
): void {
  const identityKey = openCodePartIdentityKey(part, props, targetSessionId);
  streamState.partTypes.set(identityKey, partType);
}

function derivePartTextChunk(
  part: Record<string, unknown>,
  props: Record<string, unknown>,
  targetSessionId: string,
  streamState: OpenCodeStreamState,
  partType: string,
): string | undefined {
  const delta = stringField(props.delta);
  const key = openCodePartTextKey(part, props, targetSessionId, partType);

  if (delta !== undefined) {
    const fullSnapshot = stringField(part.text);
    if (fullSnapshot !== undefined) {
      streamState.partTextSnapshots.set(key, fullSnapshot);
    } else {
      streamState.partTextSnapshots.set(key, `${streamState.partTextSnapshots.get(key) ?? ''}${delta}`);
    }
    return delta || undefined;
  }

  const fullText = stringField(part.text);
  if (fullText === undefined) return undefined;

  const previous = streamState.partTextSnapshots.get(key);
  streamState.partTextSnapshots.set(key, fullText);

  // Empty terminal snapshots must not erase or replace streamed content.
  if (!fullText) return undefined;

  if (previous === undefined) {
    return fullText;
  }

  if (fullText.startsWith(previous)) {
    const suffix = fullText.slice(previous.length);
    return suffix || undefined;
  }

  // OpenCode sends append-only text for normal assistant output. If a provider
  // rewrites a part snapshot, the protocol has no replacement event type, so
  // emitting the full text would duplicate visible content. Preserve the text
  // already shown and wait for later append-only deltas/snapshots.
  return undefined;
}

function rememberPartDelta(
  props: Record<string, unknown>,
  targetSessionId: string,
  streamState: OpenCodeStreamState,
  partType: string,
  delta: string,
): void {
  const key = openCodePartTextKeyFromProps(props, targetSessionId, partType);
  streamState.partTextSnapshots.set(key, `${streamState.partTextSnapshots.get(key) ?? ''}${delta}`);
}

function openCodePartIdentityKey(
  part: Record<string, unknown>,
  props: Record<string, unknown>,
  targetSessionId: string,
): string {
  const sessionID = stringField(part.sessionID) ?? stringField(props.sessionID) ?? targetSessionId;
  const messageID = stringField(part.messageID) ?? stringField(props.messageID) ?? 'unknown-message';
  const partID = stringField(part.id) ?? stringField(props.partID) ?? 'unknown-part';
  return `${sessionID}:${messageID}:${partID}`;
}

function openCodePartIdentityKeyFromProps(
  props: Record<string, unknown>,
  targetSessionId: string,
): string {
  const sessionID = stringField(props.sessionID) ?? targetSessionId;
  const messageID = stringField(props.messageID) ?? 'unknown-message';
  const partID = stringField(props.partID) ?? 'unknown-part';
  return `${sessionID}:${messageID}:${partID}`;
}

function openCodePartTextKey(
  part: Record<string, unknown>,
  props: Record<string, unknown>,
  targetSessionId: string,
  partType: string,
): string {
  return `${openCodePartIdentityKey(part, props, targetSessionId)}:${partType}`;
}

function openCodePartTextKeyFromProps(
  props: Record<string, unknown>,
  targetSessionId: string,
  partType: string,
): string {
  return `${openCodePartIdentityKeyFromProps(props, targetSessionId)}:${partType}`;
}

function stringField(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function buildOpenCodePermissionToolArgs(props: Record<string, unknown>): Record<string, unknown> {
  const permissionId = stringField(props.id) ?? stringField(props.requestID) ?? '';
  const permissionType = stringField(props.type) ?? stringField(props.permission) ?? 'permission';
  const title = stringField(props.title) ?? `OpenCode ${permissionType} permission`;
  const patterns = normalizeOpenCodePermissionPattern(props.pattern ?? props.patterns);
  const patternText = patterns.join(', ') || permissionType;
  const rawCommand = `${title}${patternText ? `\n${patternText}` : ''}`;

  return {
    requestId: permissionId,
    toolName: 'OpenCode',
    rawCommand,
    pattern: `OpenCodePermission(${permissionType}:${patternText})`,
    patternDisplayName: title,
    isDestructive: permissionType !== 'read',
    warnings: [
      `OpenCode is requesting ${permissionType} permission.`,
      ...(patterns.length > 0 ? [`Requested path/pattern: ${patternText}`] : []),
    ],
    workspacePath: stringField((props.metadata as Record<string, unknown> | undefined)?.workspacePath) ?? '',
    openCodePermissionType: permissionType,
    openCodePermissionPattern: patterns,
    openCodePermissionTitle: title,
  };
}

function normalizeOpenCodePermissionPattern(pattern: unknown): string[] {
  if (typeof pattern === 'string' && pattern) return [pattern];
  if (Array.isArray(pattern)) {
    return pattern.filter((value): value is string => typeof value === 'string' && value.length > 0);
  }
  return [];
}

function openCodePermissionResponseToNimbalyst(response: string): {
  decision: 'allow' | 'deny';
  scope: 'once' | 'session' | 'always';
} {
  if (response === 'reject') {
    return { decision: 'deny', scope: 'once' };
  }
  if (response === 'always') {
    return { decision: 'allow', scope: 'always' };
  }
  return { decision: 'allow', scope: 'once' };
}
