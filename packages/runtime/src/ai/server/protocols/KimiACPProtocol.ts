/**
 * Kimi Code ACP Protocol Adapter
 *
 * Wraps `kimi acp` (Agent Client Protocol, JSON-RPC over stdio) to provide a
 * normalized protocol interface for the KimiCodeProvider.
 *
 * This adapter isolates all ACP-specific details:
 * - Process spawning and stdio transport
 * - JSON-RPC message framing (newline-delimited)
 * - Session create/load lifecycle
 * - Model selection via `session/set_config_option`
 * - Event parsing and conversion to ProtocolEvent
 *
 * Kimi Code CLI implements the standard ACP schema (@agentclientprotocol/sdk):
 * `session/update` notifications carry `update.sessionUpdate` discriminators
 * (`agent_message_chunk`, `agent_thought_chunk`, `tool_call`,
 * `tool_call_update`, `usage_update`, ...).
 */

import { spawn, ChildProcess } from 'child_process';
import { createInterface, Interface as ReadlineInterface } from 'readline';
import {
  AgentProtocol,
  ProtocolSession,
  SessionOptions,
  ProtocolMessage,
  ProtocolEvent,
  ToolResult,
} from './ProtocolInterface';

interface ACPRequest {
  jsonrpc: '2.0';
  id: number;
  method: string;
  params?: Record<string, unknown>;
}

interface ACPNotification {
  jsonrpc: '2.0';
  method: string;
  params?: Record<string, unknown>;
}

interface ACPResponse {
  jsonrpc: '2.0';
  id: number;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

interface PendingRequest {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
}

const AUTH_ERROR_MESSAGE =
  'Kimi Code is not logged in. Run `kimi login` in your terminal to authenticate ' +
  '(or `kimi` and use /login).';

function isAuthError(message: string): boolean {
  return /auth|login|token|unauthorized|forbidden/i.test(message);
}

/**
 * Kimi Code ACP Protocol Adapter
 *
 * Spawns `kimi acp` and communicates via JSON-RPC over stdin/stdout.
 * Normalizes ACP events into Nimbalyst ProtocolEvent objects.
 */
export class KimiACPProtocol implements AgentProtocol {
  readonly platform = 'kimi-acp';

  private process: ChildProcess | null = null;
  private readline: ReadlineInterface | null = null;
  private nextRequestId = 1;
  private pendingRequests = new Map<number, PendingRequest>();
  private notificationHandlers: Array<(notification: ACPNotification) => void> = [];
  private command: string;
  private baseArgs: string[];
  private processEnv: Record<string, string> | undefined;
  private initialized = false;

  constructor(kimiPath?: string) {
    this.command = kimiPath || 'kimi';
    this.baseArgs = ['acp'];
  }

  setKimiPath(path: string): void {
    this.command = path;
    this.baseArgs = ['acp'];
  }

  setProcessEnv(env: Record<string, string> | undefined): void {
    this.processEnv = env;
  }

  private ensureProcess(): ChildProcess {
    if (this.process && !this.process.killed) {
      return this.process;
    }

    const proc = spawn(this.command, this.baseArgs, {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: this.processEnv ?? process.env,
    });

    this.process = proc;

    const rl = createInterface({ input: proc.stdout! });
    this.readline = rl;

    rl.on('line', (line) => {
      this.handleLine(line);
    });

    // `kimi acp` keeps the ACP channel clean on stdout; diagnostics go to stderr.
    proc.stderr?.on('data', (data: Buffer) => {
      console.warn('[KIMI-ACP] stderr:', data.toString());
    });

    proc.on('exit', (code, signal) => {
      console.log(`[KIMI-ACP] Process exited: code=${code}, signal=${signal}`);
      this.rejectAllPending(new Error(`Kimi process exited (code=${code})`));
      this.process = null;
      this.readline = null;
      this.initialized = false;
    });

    return proc;
  }

  private handleLine(line: string): void {
    if (!line.trim()) return;

    let parsed: ACPResponse | ACPNotification;
    try {
      parsed = JSON.parse(line);
    } catch {
      console.warn('[KIMI-ACP] Unparseable line:', line.slice(0, 200));
      return;
    }

    if ('id' in parsed && typeof parsed.id === 'number') {
      const pending = this.pendingRequests.get(parsed.id);
      if (pending) {
        this.pendingRequests.delete(parsed.id);
        const response = parsed as ACPResponse;
        if (response.error) {
          const detail = response.error.data ? ` (${JSON.stringify(response.error.data)})` : '';
          pending.reject(new Error(`${response.error.message}${detail}`));
        } else {
          pending.resolve(response.result);
        }
      }
      // Requests FROM the agent (fs/*, session/request_permission) also carry
      // an id; they fall through here. We do not advertise fs capabilities in
      // initialize, so the agent should not send them.
    } else if ('method' in parsed) {
      for (const handler of this.notificationHandlers) {
        handler(parsed as ACPNotification);
      }
    }
  }

  private sendRequest(method: string, params?: Record<string, unknown>): Promise<unknown> {
    const proc = this.ensureProcess();
    const id = this.nextRequestId++;
    const request: ACPRequest = { jsonrpc: '2.0', id, method, params };

    return new Promise((resolve, reject) => {
      this.pendingRequests.set(id, { resolve, reject });
      proc.stdin!.write(JSON.stringify(request) + '\n');
    });
  }

  private sendNotification(method: string, params?: Record<string, unknown>): void {
    const proc = this.ensureProcess();
    const notification: ACPNotification = { jsonrpc: '2.0', method, params };
    proc.stdin!.write(JSON.stringify(notification) + '\n');
  }

  private rejectAllPending(error: Error): void {
    for (const [, pending] of this.pendingRequests) {
      pending.reject(error);
    }
    this.pendingRequests.clear();
  }

  private async ensureInitialized(): Promise<void> {
    if (this.initialized) return;
    this.ensureProcess();

    try {
      await this.sendRequest('initialize', {
        protocolVersion: 1,
        clientInfo: { name: 'nimbalyst', version: '1.0.0' },
        clientCapabilities: {
          fs: { readTextFile: false, writeTextFile: false },
        },
      });
      this.initialized = true;
      console.log('[KIMI-ACP] Protocol initialized');
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      if (isAuthError(msg)) {
        throw new Error(AUTH_ERROR_MESSAGE);
      }
      throw error;
    }
  }

  /**
   * Select the model for a session via the ACP generic config picker.
   * Best-effort: an unknown model id must not kill the session -- the CLI
   * keeps its default model and we log the rejection.
   */
  private async trySetModel(sessionId: string, model: string | undefined): Promise<void> {
    if (!model || model === 'default') return;
    try {
      await this.sendRequest('session/set_config_option', {
        sessionId,
        configId: 'model',
        value: model,
      });
      console.log('[KIMI-ACP] Model set:', model);
    } catch (error) {
      console.warn('[KIMI-ACP] Could not set model, using CLI default:', error);
    }
  }

  async createSession(options: SessionOptions): Promise<ProtocolSession> {
    await this.ensureInitialized();

    const params: Record<string, unknown> = {
      cwd: options.workspacePath || process.cwd(),
      mcpServers: options.mcpServers ? this.formatMcpServers(options.mcpServers) : [],
    };

    try {
      const result = await this.sendRequest('session/new', params) as Record<string, unknown>;
      const sessionId = (result?.sessionId as string) || `kimi-${Date.now()}`;
      console.log('[KIMI-ACP] Session created:', sessionId);

      await this.trySetModel(sessionId, options.model);

      return {
        id: sessionId,
        platform: this.platform,
        raw: { result },
      };
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      if (isAuthError(msg)) {
        throw new Error(AUTH_ERROR_MESSAGE);
      }
      throw error;
    }
  }

  async resumeSession(sessionId: string, options: SessionOptions): Promise<ProtocolSession> {
    await this.ensureInitialized();

    try {
      const result = await this.sendRequest('session/load', {
        sessionId,
        cwd: options.workspacePath || process.cwd(),
        mcpServers: options.mcpServers ? this.formatMcpServers(options.mcpServers) : [],
      }) as Record<string, unknown>;
      console.log('[KIMI-ACP] Session resumed:', sessionId);

      await this.trySetModel(sessionId, options.model);

      return {
        id: sessionId,
        platform: this.platform,
        raw: { result },
      };
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);

      if (isAuthError(msg)) {
        throw new Error(AUTH_ERROR_MESSAGE);
      }

      // The session may already be live in this process from an earlier turn.
      // Reuse it rather than discarding the conversation context.
      if (/already loaded|already exists/i.test(msg)) {
        console.log('[KIMI-ACP] Session already loaded, reusing:', sessionId);
        return {
          id: sessionId,
          platform: this.platform,
          raw: { alreadyLoaded: true },
        };
      }

      console.warn('[KIMI-ACP] Resume failed, creating new session:', error);
      return this.createSession(options);
    }
  }

  async forkSession(sessionId: string, options: SessionOptions): Promise<ProtocolSession> {
    await this.ensureInitialized();

    // Kimi Code advertises `session/fork` in its session capabilities.
    try {
      const result = await this.sendRequest('session/fork', {
        sessionId,
        cwd: options.workspacePath || process.cwd(),
      }) as Record<string, unknown>;
      const newSessionId = result?.sessionId as string | undefined;
      if (newSessionId) {
        console.log('[KIMI-ACP] Session forked:', sessionId, '->', newSessionId);
        return {
          id: newSessionId,
          platform: this.platform,
          raw: { result },
        };
      }
    } catch (error) {
      console.warn('[KIMI-ACP] Fork failed, creating new session:', error);
    }
    return this.createSession(options);
  }

  async *sendMessage(
    session: ProtocolSession,
    message: ProtocolMessage
  ): AsyncIterable<ProtocolEvent> {
    this.ensureProcess();

    let fullText = '';
    let usage: { input_tokens: number; output_tokens: number; total_tokens: number } | undefined;
    let contextFillTokens: number | undefined;
    let contextWindow: number | undefined;

    const notificationQueue: ACPNotification[] = [];
    let notificationResolve: (() => void) | null = null;
    let streamComplete = false;

    const onNotification = (notification: ACPNotification) => {
      // Only queue updates for this session; a shared process can host
      // several ACP sessions.
      const params = notification.params as Record<string, unknown> | undefined;
      if (params?.sessionId && params.sessionId !== session.id) return;
      notificationQueue.push(notification);
      if (notificationResolve) {
        notificationResolve();
        notificationResolve = null;
      }
    };

    this.notificationHandlers.push(onNotification);

    try {
      let sendError: Error | null = null;

      const sendPromise = this.sendRequest('session/prompt', {
        sessionId: session.id,
        prompt: [
          { type: 'text', text: message.content },
        ],
      });

      sendPromise.then(() => {
        streamComplete = true;
        if (notificationResolve) {
          notificationResolve();
          notificationResolve = null;
        }
      }).catch((err) => {
        sendError = err instanceof Error ? err : new Error(String(err));
        streamComplete = true;
        if (notificationResolve) {
          notificationResolve();
          notificationResolve = null;
        }
      });

      while (true) {
        while (notificationQueue.length > 0) {
          const notification = notificationQueue.shift()!;

          yield {
            type: 'raw_event',
            metadata: { rawEvent: notification },
          };

          const events = this.parseNotification(notification);
          for (const event of events) {
            if (event.type === 'text' && event.content) {
              fullText += event.content;
            }
            if (event.usage) {
              usage = event.usage;
            }
            if (event.contextFillTokens !== undefined) {
              contextFillTokens = event.contextFillTokens;
              contextWindow = event.contextWindow;
              continue; // usage_update snapshot; folded into `complete`
            }
            yield event;
          }
        }

        if (streamComplete && notificationQueue.length === 0) {
          break;
        }

        await new Promise<void>((resolve) => {
          notificationResolve = resolve;
        });
      }

      if (sendError && !fullText) {
        const msg = (sendError as Error).message;
        yield { type: 'error', error: isAuthError(msg) ? AUTH_ERROR_MESSAGE : msg };
      } else {
        yield {
          type: 'complete',
          content: fullText,
          usage: usage ?? { input_tokens: 0, output_tokens: 0, total_tokens: 0 },
          contextFillTokens,
          contextWindow,
        };
      }
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      yield {
        type: 'error',
        error: errorMessage,
      };
    } finally {
      const idx = this.notificationHandlers.indexOf(onNotification);
      if (idx >= 0) {
        this.notificationHandlers.splice(idx, 1);
      }
    }
  }

  abortSession(session: ProtocolSession): void {
    this.sendNotification('session/cancel', { sessionId: session.id });
  }

  cleanupSession(_session: ProtocolSession): void {
    // No-op; the ACP process stays alive for reuse across sessions
  }

  destroy(): void {
    if (this.process && !this.process.killed) {
      this.process.kill();
    }
    this.process = null;
    this.readline = null;
    this.initialized = false;
    this.rejectAllPending(new Error('Protocol destroyed'));
    this.notificationHandlers = [];
  }

  private formatMcpServers(mcpServers: Record<string, unknown>): unknown[] {
    const servers: unknown[] = [];
    for (const [name, config] of Object.entries(mcpServers)) {
      if (!config || typeof config !== 'object') continue;
      const sc = config as Record<string, unknown>;
      const converted = this.convertToACPMcpServer(name, sc);
      if (converted) servers.push(converted);
    }
    return servers;
  }

  private convertToACPMcpServer(name: string, sc: Record<string, unknown>): Record<string, unknown> | null {
    const type = typeof sc.type === 'string' ? sc.type : (typeof sc.url === 'string' ? 'sse' : 'stdio');

    if (type === 'http' || type === 'sse') {
      if (typeof sc.url !== 'string') return null;
      return {
        name,
        type,
        url: sc.url,
        headers: this.toKeyValueArray(sc.headers ?? sc.http_headers),
      };
    }

    if (typeof sc.command !== 'string') return null;
    return {
      name,
      type: 'stdio',
      command: sc.command,
      args: Array.isArray(sc.args) ? sc.args : [],
      env: this.toKeyValueArray(sc.env),
    };
  }

  private toKeyValueArray(obj: unknown): Array<{ name: string; value: string }> {
    if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return [];
    return Object.entries(obj as Record<string, unknown>)
      .filter(([, v]) => typeof v === 'string')
      .map(([k, v]) => ({ name: k, value: v as string }));
  }

  private parseNotification(notification: ACPNotification): ProtocolEvent[] {
    const events: ProtocolEvent[] = [];
    if (notification.method !== 'session/update') return events;

    const params = notification.params || {};
    const update = params.update as Record<string, unknown> | undefined;
    if (!update) return events;

    const updateType = update.sessionUpdate as string | undefined;
    const content = update.content as Record<string, unknown> | undefined;

    switch (updateType) {
      case 'agent_message_chunk': {
        const text = typeof content?.text === 'string' ? content.text : '';
        if (text) events.push({ type: 'text', content: text });
        break;
      }

      case 'agent_thought_chunk': {
        const text = typeof content?.text === 'string' ? content.text : '';
        if (text) events.push({ type: 'reasoning', content: text });
        break;
      }

      case 'tool_call': {
        events.push({
          type: 'tool_call',
          toolCall: {
            id: typeof update.toolCallId === 'string' ? update.toolCallId : undefined,
            name: typeof update.title === 'string' ? update.title : 'unknown',
            arguments: (update.rawInput ?? undefined) as Record<string, unknown> | undefined,
          },
        });
        break;
      }

      case 'tool_call_update': {
        const status = update.status as string | undefined;
        if (status !== 'completed' && status !== 'failed') break;
        events.push({
          type: 'tool_result',
          toolResult: {
            id: typeof update.toolCallId === 'string' ? update.toolCallId : undefined,
            name: typeof update.title === 'string' ? update.title : 'unknown',
            result: (update.rawOutput ?? this.extractToolContentText(update.content)) as ToolResult | string | undefined,
          },
        });
        break;
      }

      // Context-window snapshot: `used` is the current fill, `size` the
      // model's window. Folded into the `complete` event by sendMessage.
      case 'usage_update': {
        const used = typeof update.used === 'number' ? update.used : undefined;
        const size = typeof update.size === 'number' ? update.size : undefined;
        if (used !== undefined) {
          events.push({
            type: 'usage',
            contextFillTokens: used,
            contextWindow: size,
          });
        }
        break;
      }

      default:
        break;
    }

    return events;
  }

  private extractToolContentText(content: unknown): string | undefined {
    if (!Array.isArray(content)) return undefined;
    const parts: string[] = [];
    for (const item of content) {
      if (item && typeof item === 'object') {
        const c = (item as Record<string, unknown>).content as Record<string, unknown> | undefined;
        if (c && c.type === 'text' && typeof c.text === 'string') {
          parts.push(c.text);
        }
      }
    }
    return parts.length > 0 ? parts.join('\n') : undefined;
  }
}
