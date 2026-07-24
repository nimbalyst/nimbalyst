/**
 * Minimal MCP StreamableHTTP client over the app's loopback `/mcp` endpoint.
 *
 * It speaks just enough of the protocol for read-only tool calls:
 *   1. POST `initialize` (Accept: application/json, text/event-stream) and pick
 *      up the `mcp-session-id` response header.
 *   2. POST the `notifications/initialized` notification.
 *   3. POST `tools/call` and read the JSON-RPC result (JSON or SSE body).
 *
 * Auth is a bearer token from the endpoint descriptor; the server binds to
 * 127.0.0.1 only.
 */
import { connectionError } from '../cli/exitCodes.js';

interface JsonRpcResponse {
  jsonrpc: '2.0';
  id: number | string;
  result?: any;
  error?: { code: number; message: string; data?: unknown };
}

export interface McpToolResult {
  structured?: any;
  summary?: string;
  isError?: boolean;
  raw: any;
}

export class McpHttpClient {
  private baseUrl: string;
  private token: string;
  private sessionId: string | null = null;
  private nextId = 1;
  private initialized = false;

  constructor(opts: { port: number; token: string; host?: string }) {
    this.baseUrl = `http://${opts.host ?? '127.0.0.1'}:${opts.port}/mcp`;
    this.token = opts.token;
  }

  private headers(extra?: Record<string, string>): Record<string, string> {
    const h: Record<string, string> = {
      Authorization: `Bearer ${this.token}`,
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
      ...extra,
    };
    if (this.sessionId) h['mcp-session-id'] = this.sessionId;
    return h;
  }

  private async post(body: unknown): Promise<{ res: Response; text: string }> {
    let res: Response;
    try {
      res = await fetch(this.baseUrl, {
        method: 'POST',
        headers: this.headers(),
        body: JSON.stringify(body),
      });
    } catch (err: any) {
      throw connectionError(`Could not reach Nimbalyst MCP server at ${this.baseUrl}: ${err?.message ?? err}`);
    }
    if (res.status === 401 || res.status === 403) {
      throw connectionError('MCP server rejected the bearer token (stale endpoint descriptor?). Try --offline.');
    }
    const text = await res.text();
    return { res, text };
  }

  private async ensureInitialized(workspacePath: string): Promise<void> {
    if (this.initialized) return;

    const initUrl = new URL(this.baseUrl);
    initUrl.searchParams.set('workspacePath', workspacePath);
    let res: Response;
    let text: string;
    try {
      res = await fetch(initUrl.toString(), {
        method: 'POST',
        headers: this.headers(),
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: this.nextId++,
          method: 'initialize',
          params: {
            protocolVersion: '2024-11-05',
            capabilities: {},
            clientInfo: { name: 'nim-cli', version: '0.1.0' },
          },
        }),
      });
      text = await res.text();
    } catch (err: any) {
      throw connectionError(`MCP initialize failed: ${err?.message ?? err}`);
    }
    const sid = res.headers.get('mcp-session-id');
    if (sid) this.sessionId = sid;
    extractJsonRpc(res, text); // surface init errors

    // Notify initialized (best-effort; ignore failures).
    try {
      await fetch(this.baseUrl, {
        method: 'POST',
        headers: this.headers(),
        body: JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }),
      });
    } catch {
      /* non-fatal */
    }
    this.initialized = true;
  }

  async callTool(workspacePath: string, name: string, args: Record<string, unknown>): Promise<McpToolResult> {
    await this.ensureInitialized(workspacePath);
    const { res, text } = await this.post({
      jsonrpc: '2.0',
      id: this.nextId++,
      method: 'tools/call',
      params: { name, arguments: { ...args, workspacePath } },
    });
    const rpc = extractJsonRpc(res, text);
    if (rpc.error) {
      throw connectionError(`MCP tool ${name} failed: ${rpc.error.message}`);
    }
    return normalizeToolResult(rpc.result);
  }
}

/** Extract a JSON-RPC response from either a JSON body or an SSE body. */
function extractJsonRpc(res: Response, text: string): JsonRpcResponse {
  const ctype = res.headers.get('content-type') ?? '';
  if (ctype.includes('text/event-stream')) {
    // Concatenate `data:` lines; the last complete JSON object is the response.
    const dataLines = text
      .split(/\r?\n/)
      .filter((l) => l.startsWith('data:'))
      .map((l) => l.slice(5).trim())
      .filter(Boolean);
    for (let i = dataLines.length - 1; i >= 0; i--) {
      try {
        const obj = JSON.parse(dataLines[i]);
        if (obj && typeof obj === 'object' && 'id' in obj) return obj as JsonRpcResponse;
      } catch {
        /* keep scanning */
      }
    }
    throw connectionError('Could not parse SSE response from MCP server');
  }
  try {
    return JSON.parse(text) as JsonRpcResponse;
  } catch {
    throw connectionError(`Unexpected MCP response (status ${res.status}): ${text.slice(0, 200)}`);
  }
}

/** Tracker tools return { content: [{ type:'text', text: JSON.stringify({structured, summary}) }] }. */
function normalizeToolResult(result: any): McpToolResult {
  const block = result?.content?.find?.((c: any) => c?.type === 'text');
  let structured: any;
  let summary: string | undefined;
  if (block?.text) {
    try {
      const parsed = JSON.parse(block.text);
      structured = parsed.structured ?? parsed;
      summary = parsed.summary;
    } catch {
      summary = block.text;
    }
  }
  return { structured, summary, isError: result?.isError === true, raw: result };
}
