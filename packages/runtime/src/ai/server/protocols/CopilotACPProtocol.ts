/**
 * GitHub Copilot ACP Protocol Adapter
 *
 * Wraps `copilot --acp --stdio` to provide a normalized protocol interface
 * for the CopilotCLIProvider.
 *
 * This adapter isolates all ACP-specific details:
 * - Process spawning and stdio transport
 * - JSON-RPC message framing
 * - Session create/resume lifecycle
 * - Event parsing and conversion to ProtocolEvent
 *
 * ACP is in public preview; this adapter should absorb any protocol churn
 * so the provider layer stays stable.
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

/**
 * GitHub Copilot ACP Protocol Adapter
 *
 * Spawns `copilot --acp --stdio` and communicates via JSON-RPC over stdin/stdout.
 * Normalizes ACP events into Nimbalyst ProtocolEvent objects.
 */
export class CopilotACPProtocol implements AgentProtocol {
  readonly platform = 'copilot-acp';

  private process: ChildProcess | null = null;
  private readline: ReadlineInterface | null = null;
  private nextRequestId = 1;
  private pendingRequests = new Map<number, PendingRequest>();
  private notificationHandlers: Array<(notification: ACPNotification) => void> = [];
  private command: string;
  private baseArgs: string[];
  private processEnv: Record<string, string> | undefined;
  private initialized = false;

  constructor(copilotPath?: string) {
    this.command = copilotPath || 'copilot';
    this.baseArgs = ['--acp', '--stdio'];
  }

  setCopilotPath(path: string): void {
    this.command = path;
    this.baseArgs = ['--acp', '--stdio'];
  }

  setCommand(command: string, args: string[]): void {
    this.command = command;
    this.baseArgs = args;
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

    proc.stderr?.on('data', (data: Buffer) => {
      console.warn('[COPILOT-ACP] stderr:', data.toString());
    });

    proc.on('exit', (code, signal) => {
      console.log(`[COPILOT-ACP] Process exited: code=${code}, signal=${signal}`);
      this.rejectAllPending(new Error(`Copilot process exited (code=${code})`));
      this.process = null;
      this.readline = null;
    });

    return proc;
  }

  private handleLine(line: string): void {
    if (!line.trim()) return;

    let parsed: ACPResponse | ACPNotification;
    try {
      parsed = JSON.parse(line);
    } catch {
      console.warn('[COPILOT-ACP] Unparseable line:', line.slice(0, 200));
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
        capabilities: {},
      });
      this.initialized = true;
      console.log('[COPILOT-ACP] Protocol initialized');
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      if (/auth|login|token|unauthorized|forbidden/i.test(msg)) {
        throw new Error(
          'GitHub Copilot is not logged in. Run `copilot` in your terminal and use the /login command to authenticate.'
        );
      }
      throw error;
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
      const sessionId = (result?.sessionId as string) || `copilot-${Date.now()}`;
      console.log('[COPILOT-ACP] Session created:', sessionId);

      return {
        id: sessionId,
        platform: this.platform,
        raw: { result },
      };
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      if (/auth|login|token|unauthorized|forbidden/i.test(msg)) {
        throw new Error(
          'GitHub Copilot is not logged in. Run `copilot` in your terminal and use the /login command to authenticate.'
        );
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
      console.log('[COPILOT-ACP] Session resumed:', sessionId);

      return {
        id: sessionId,
        platform: this.platform,
        raw: { result },
      };
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);

      // The Copilot ACP server keeps sessions live in-process. When the session
      // was created earlier in this same process, `session/load` fails with
      // "Session <id> is already loaded". That is not a real failure -- the
      // session is ready for `session/prompt`. Falling back to createSession
      // here would discard all conversation context, breaking multi-turn chat.
      if (/already loaded/i.test(msg)) {
        console.log('[COPILOT-ACP] Session already loaded, reusing:', sessionId);
        return {
          id: sessionId,
          platform: this.platform,
          raw: { alreadyLoaded: true },
        };
      }

      console.warn('[COPILOT-ACP] Resume failed, creating new session:', error);
      return this.createSession(options);
    }
  }

  async forkSession(_sessionId: string, options: SessionOptions): Promise<ProtocolSession> {
    console.warn('[COPILOT-ACP] ACP does not support session forking. Creating new session.');
    return this.createSession(options);
  }

  async *sendMessage(
    session: ProtocolSession,
    message: ProtocolMessage
  ): AsyncIterable<ProtocolEvent> {
    this.ensureProcess();

    let fullText = '';
    let usage: { input_tokens: number; output_tokens: number; total_tokens: number } | undefined;

    const notificationQueue: ACPNotification[] = [];
    let notificationResolve: (() => void) | null = null;
    let streamComplete = false;

    const onNotification = (notification: ACPNotification) => {
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
        yield { type: 'error', error: (sendError as Error).message };
      } else {
        yield {
          type: 'complete',
          content: fullText,
          usage: usage ?? { input_tokens: 0, output_tokens: 0, total_tokens: 0 },
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

  abortSession(_session: ProtocolSession): void {
    this.sendNotification('session/cancel', { sessionId: _session.id });
  }

  cleanupSession(_session: ProtocolSession): void {
    // No-op; ACP process stays alive for reuse
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
    const method = notification.method;
    const params = notification.params || {};

    switch (method) {
      // ACP session/update: params.update.sessionUpdate is the type discriminator,
      // params.update.content carries the payload.
      // Example: {"update":{"sessionUpdate":"agent_message_chunk","content":{"type":"text","text":"Hello"}}}
      case 'session/update': {
        const update = params.update as Record<string, unknown> | undefined;
        if (!update) break;

        const updateType = update.sessionUpdate as string | undefined;
        const content = update.content as Record<string, unknown> | undefined;

        if (updateType === 'agent_message_chunk' && content) {
          const contentType = content.type as string | undefined;
          switch (contentType) {
            case 'text': {
              const text = typeof content.text === 'string' ? content.text : '';
              if (text) events.push({ type: 'text', content: text });
              break;
            }
            case 'thinking':
            case 'reasoning': {
              const text = typeof content.text === 'string' ? content.text : '';
              if (text) events.push({ type: 'reasoning', content: text });
              break;
            }
            default:
              break;
          }
        } else if (updateType === 'tool_call' || updateType === 'tool_use') {
          events.push({
            type: 'tool_call',
            toolCall: {
              id: typeof update.id === 'string' ? update.id : (typeof content?.id === 'string' ? content.id : undefined),
              name: typeof update.name === 'string' ? update.name : (typeof content?.name === 'string' ? content.name : 'unknown'),
              arguments: (update.arguments ?? update.input ?? content?.arguments ?? content?.input) as Record<string, unknown> | undefined,
            },
          });
        } else if (updateType === 'tool_result') {
          events.push({
            type: 'tool_result',
            toolResult: {
              id: typeof update.id === 'string' ? update.id : (typeof content?.id === 'string' ? content.id : undefined),
              name: typeof update.name === 'string' ? update.name : (typeof content?.name === 'string' ? content.name : 'unknown'),
              result: (update.output ?? content?.output) as ToolResult | string | undefined,
            },
          });
        } else if (updateType === 'error') {
          const errorMsg = typeof update.message === 'string' ? update.message :
                           typeof content?.message === 'string' ? content.message : 'Unknown error';
          events.push({ type: 'error', error: errorMsg });
        } else if (updateType === 'request_permission') {
          // Permission requests will be handled in a future phase
        }
        break;
      }

      // Also handle flat notification formats as fallbacks
      case 'stream/text':
      case 'message/text': {
        const content = typeof params.content === 'string' ? params.content : '';
        if (content) events.push({ type: 'text', content });
        break;
      }

      case 'stream/reasoning':
      case 'message/reasoning': {
        const content = typeof params.content === 'string' ? params.content : '';
        if (content) events.push({ type: 'reasoning', content });
        break;
      }

      case 'tool/call':
      case 'stream/toolCall': {
        events.push({
          type: 'tool_call',
          toolCall: {
            id: typeof params.id === 'string' ? params.id : undefined,
            name: typeof params.name === 'string' ? params.name : 'unknown',
            arguments: (params.arguments as Record<string, unknown>) ?? undefined,
          },
        });
        break;
      }

      case 'tool/result':
      case 'stream/toolResult': {
        events.push({
          type: 'tool_result',
          toolResult: {
            id: typeof params.id === 'string' ? params.id : undefined,
            name: typeof params.name === 'string' ? params.name : 'unknown',
            result: params.result as ToolResult | string | undefined,
          },
        });
        break;
      }

      case 'stream/error':
      case 'message/error': {
        const errorMsg = typeof params.message === 'string' ? params.message : 'Unknown error';
        events.push({ type: 'error', error: errorMsg });
        break;
      }

      default:
        break;
    }

    return events;
  }
}
