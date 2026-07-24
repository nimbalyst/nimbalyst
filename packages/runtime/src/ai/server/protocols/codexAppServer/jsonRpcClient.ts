// Minimal JSON-RPC v2 client over a Node child process's stdio.
//
// Designed for the codex app-server's framing: newline-delimited JSON, one
// JSON object per line. Supports:
//   - request/response correlation by id
//   - notification routing (server -> client, no id)
//   - server-initiated requests (server -> client, has id + method); host
//     provides per-method responders
//
// All write operations are awaitable. Read operations route through registered
// handlers. The client never throws on malformed lines from the server -- it
// logs and continues.

import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import readline from 'node:readline';
import type {
  RpcId,
  RpcRequest,
  RpcResponseErr,
  RpcResponseOk,
} from './types';

export type NotificationHandler = (method: string, params: unknown) => void;

export type ServerRequestHandler = (
  params: unknown,
) => Promise<unknown> | unknown;

export interface JsonRpcClientOptions {
  /** Default per-request timeout (ms). Defaults to 5 minutes. */
  defaultTimeoutMs?: number;
  /** Optional logger override (defaults to console). */
  logger?: { log?: (msg: string, ...args: unknown[]) => void; warn?: (msg: string, ...args: unknown[]) => void };
}

interface Pending {
  resolve: (value: unknown) => void;
  reject: (err: Error) => void;
  timer: NodeJS.Timeout | null;
}

export class JsonRpcClient {
  private nextId = 1;
  private readonly pending = new Map<RpcId, Pending>();
  private readonly notificationHandlers = new Set<NotificationHandler>();
  private readonly serverRequestHandlers = new Map<string, ServerRequestHandler>();
  private readonly defaultTimeoutMs: number;
  private readonly logger: { log: (msg: string, ...args: unknown[]) => void; warn: (msg: string, ...args: unknown[]) => void };
  private closed = false;

  constructor(
    private readonly child: ChildProcessWithoutNullStreams,
    options: JsonRpcClientOptions = {},
  ) {
    this.defaultTimeoutMs = options.defaultTimeoutMs ?? 5 * 60_000;
    this.logger = {
      log: options.logger?.log ?? ((m, ...a) => console.log(m, ...a)),
      warn: options.logger?.warn ?? ((m, ...a) => console.warn(m, ...a)),
    };
    if (!this.child.stdout || !this.child.stdin) {
      throw new Error('[CodexAppServer] child process must have stdio piped');
    }
    const rl = readline.createInterface({ input: this.child.stdout, crlfDelay: Infinity });
    rl.on('line', (line) => this.handleLine(line));
    this.child.once('exit', () => this.handleExit());
  }

  /**
   * Register a notification handler. Returns an unsubscribe function the caller
   * MUST invoke when its lifecycle ends (e.g. after a single turn) to prevent
   * the same notification firing through stale handlers on later turns.
   */
  onNotification(handler: NotificationHandler): () => void {
    this.notificationHandlers.add(handler);
    return () => {
      this.notificationHandlers.delete(handler);
    };
  }

  setServerRequestHandler(method: string, handler: ServerRequestHandler): void {
    this.serverRequestHandlers.set(method, handler);
  }

  /**
   * Send a request and await its response.
   */
  async request<R = unknown>(method: string, params: unknown, timeoutMs?: number): Promise<R> {
    if (this.closed) throw new Error('[CodexAppServer] client is closed');
    const id = this.nextId++;
    const promise = new Promise<R>((resolve, reject) => {
      const timer = timeoutMs === 0
        ? null
        : setTimeout(() => {
            if (this.pending.delete(id)) {
              reject(new Error(`[CodexAppServer] request timeout: ${method} id=${id}`));
            }
          }, timeoutMs ?? this.defaultTimeoutMs);
      this.pending.set(id, { resolve: resolve as (v: unknown) => void, reject, timer });
    });
    const payload: RpcRequest = { jsonrpc: '2.0', id, method, params };
    this.writeLine(JSON.stringify(payload));
    return promise;
  }

  /**
   * Send a notification (no id, no response expected).
   */
  notify(method: string, params: unknown): void {
    if (this.closed) throw new Error('[CodexAppServer] client is closed');
    this.writeLine(JSON.stringify({ jsonrpc: '2.0', method, params }));
  }

  /**
   * Close the client; reject any pending requests. Does not kill the child --
   * caller owns the process lifecycle.
   */
  close(reason?: string): void {
    if (this.closed) return;
    this.closed = true;
    const error = new Error(reason ?? '[CodexAppServer] client closed');
    for (const [id, p] of this.pending) {
      if (p.timer) clearTimeout(p.timer);
      p.reject(error);
      this.pending.delete(id);
    }
  }

  private writeLine(line: string): void {
    if (!this.child.stdin || this.child.stdin.destroyed) {
      throw new Error('[CodexAppServer] child stdin is unavailable');
    }
    this.child.stdin.write(line + '\n');
  }

  private handleLine(line: string): void {
    if (this.closed) return;
    const trimmed = line.trim();
    if (!trimmed) return;
    let msg: unknown;
    try { msg = JSON.parse(trimmed); }
    catch (e) {
      this.logger.warn('[CodexAppServer] non-JSON line:', trimmed.slice(0, 200));
      return;
    }
    if (!msg || typeof msg !== 'object') return;
    const obj = msg as Record<string, unknown>;
    const id = obj.id as RpcId | undefined;
    const method = obj.method as string | undefined;
    const hasResult = 'result' in obj;
    const hasError = 'error' in obj;

    if (id !== undefined && (hasResult || hasError)) {
      const pending = this.pending.get(id);
      if (!pending) {
        this.logger.warn('[CodexAppServer] response with no pending request:', trimmed.slice(0, 200));
        return;
      }
      this.pending.delete(id);
      if (pending.timer) clearTimeout(pending.timer);
      if (hasError) {
        const errObj = (obj as unknown as RpcResponseErr).error;
        pending.reject(new Error(`[CodexAppServer] RPC error ${errObj.code}: ${errObj.message}`));
      } else {
        pending.resolve((obj as unknown as RpcResponseOk).result);
      }
      return;
    }

    if (id !== undefined && method) {
      // Server-initiated request.
      const handler = this.serverRequestHandlers.get(method);
      if (!handler) {
        this.respondError(id, -32601, `method not handled: ${method}`);
        return;
      }
      Promise.resolve()
        .then(() => handler(obj.params))
        .then((result) => this.writeLine(JSON.stringify({ jsonrpc: '2.0', id, result })))
        .catch((err) => this.respondError(id, -32000, err?.message ?? String(err)));
      return;
    }

    if (method && id === undefined) {
      for (const h of this.notificationHandlers) {
        try { h(method, obj.params); }
        catch (err) {
          this.logger.warn('[CodexAppServer] notification handler threw:', err);
        }
      }
      return;
    }

    this.logger.warn('[CodexAppServer] unrecognized message:', trimmed.slice(0, 200));
  }

  private respondError(id: RpcId, code: number, message: string): void {
    try {
      this.writeLine(JSON.stringify({ jsonrpc: '2.0', id, error: { code, message } }));
    } catch (err) {
      this.logger.warn('[CodexAppServer] failed to send error response:', err);
    }
  }

  private handleExit(): void {
    this.close('[CodexAppServer] child process exited');
  }
}
