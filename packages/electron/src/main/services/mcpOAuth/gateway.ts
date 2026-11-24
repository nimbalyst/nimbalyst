/**
 * Loopback gateway between agent CLIs and remote MCP servers.
 *
 * Served by the internal MCP HTTP server at `/mcp-remote/<routeKey>`, behind
 * the same per-launch bearer that gates every first-party endpoint. Callers
 * always speak Streamable HTTP to it. The gateway attaches the remote access
 * token (or the server's configured static headers) itself, so the remote
 * credential never appears in a CLI's config, argv, env or protocol stream.
 *
 * Upstream:
 *   - Streamable HTTP: forwarded request by request. Session ids and
 *     resumability belong to the remote server and the CLI.
 *   - Legacy SSE: adapted at the message level with SDK transports, because
 *     SSE's `endpoint` event names a separate POST URL that cannot be passed
 *     through to a caller. One upstream SSE connection per caller session.
 *
 * What the gateway refuses:
 *   - redirects that leave the server's origin or change its scheme;
 *   - an SSE `endpoint` on another origin, or on plain http under https;
 *   - answering a missing credential with 401 + WWW-Authenticate, which would
 *     make Claude Code or Codex start their own OAuth against 127.0.0.1 and
 *     cache the failure. It answers 503 with a JSON-RPC error instead.
 */
import { createHash, randomUUID } from 'crypto';
import type { IncomingMessage, ServerResponse } from 'http';
import { Readable } from 'stream';
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import type { JSONRPCMessage } from '@modelcontextprotocol/sdk/types.js';
import type { MCPRemoteConfigDescriptor } from '../MCPRemoteOAuth';
import type { McpOAuthManager } from './McpOAuthManager';
import { assertNoDowngrade, sameOrigin } from './urlPolicy';
import type { FetchLike, McpOAuthErrorType } from './types';

export const GATEWAY_PATH_PREFIX = '/mcp-remote/';
const MAX_BODY_BYTES = 16 * 1024 * 1024;
const MAX_REDIRECTS = 3;
const FORWARDED_REQUEST_HEADERS = ['content-type', 'accept', 'mcp-session-id', 'mcp-protocol-version', 'last-event-id'];
const FORWARDED_RESPONSE_HEADERS = ['content-type', 'cache-control', 'mcp-session-id', 'mcp-protocol-version'];

export interface GatewayRoute {
  /** Route path segment. Equals `bindingKey` unless the config carries its own Authorization header. */
  key: string;
  /** Credential binding key in the OAuth store. */
  bindingKey: string;
  /**
   * The config sends its own Authorization header and declares no OAuth: that
   * header is the credential, and no stored OAuth binding is ever used.
   */
  staticAuthorization: boolean;
  descriptor: MCPRemoteConfigDescriptor;
  /** Upstream transport: decided by config and, for `http-first`, by the server's answer. */
  mode: 'http' | 'sse';
  /** May fall back from HTTP to SSE on a 404/405 to the first POST. */
  allowSseFallback: boolean;
  /** The config declares OAuth: without a credential the gateway refuses instead of passing through. */
  requiresOAuth: boolean;
  /** `sse-first` already switched this route to Streamable HTTP once. */
  sseFirstFellBack?: boolean;
}

interface SseSession {
  server: StreamableHTTPServerTransport;
  client: SSEClientTransport;
}

type GatewayLog = (level: 'info' | 'warn', message: string, meta?: Record<string, unknown>) => void;

export class McpRemoteGateway {
  private readonly routes = new Map<string, GatewayRoute>();
  private readonly sseSessions = new Map<string, SseSession>();
  private readonly fetchFn: FetchLike;
  private readonly log: GatewayLog;

  constructor(
    private readonly manager: McpOAuthManager,
    options: { fetchFn?: FetchLike; log?: GatewayLog } = {},
  ) {
    this.fetchFn = options.fetchFn ?? ((input, init) => fetch(input, init));
    this.log = options.log ?? (() => undefined);
  }

  /**
   * Register (or refresh) the route for a server and return its key. The key
   * is the credential binding key, so a route and its tokens always agree.
   */
  registerRoute(descriptor: MCPRemoteConfigDescriptor, transportType: 'http' | 'sse'): string {
    const bindingKey = this.manager.bindingKeyFor(descriptor);
    // The binding key leaves the Authorization header out, so two configs for
    // one server with different static keys would share a route and one would
    // run as the other's account. Their routes are kept apart by a hash of the
    // header value.
    const authorization = Object.entries(descriptor.headers ?? {})
      .find(([name]) => name.toLowerCase() === 'authorization')?.[1];
    const key = authorization
      ? createHash('sha256').update(`${bindingKey}\0${authorization}`).digest('hex').slice(0, 40)
      : bindingKey;
    const strategy = descriptor.transportStrategy ?? 'http-first';
    const existing = this.routes.get(key);
    const mode: 'http' | 'sse' = transportType === 'sse' || strategy === 'sse-only' || strategy === 'sse-first'
      ? 'sse'
      : existing?.mode ?? 'http';
    this.routes.set(key, {
      key,
      bindingKey,
      staticAuthorization: Boolean(authorization) && !descriptor.requiresOAuth,
      descriptor,
      mode,
      allowSseFallback: transportType === 'http' && strategy === 'http-first',
      requiresOAuth: descriptor.requiresOAuth,
    });
    return key;
  }

  hasRoute(key: string): boolean {
    return this.routes.has(key);
  }

  async closeAll(): Promise<void> {
    const sessions = Array.from(this.sseSessions.values());
    this.sseSessions.clear();
    await Promise.all(sessions.map(async ({ server, client }) => {
      await server.close().catch(() => undefined);
      await client.close().catch(() => undefined);
    }));
  }

  /** Handle a request whose path starts with GATEWAY_PATH_PREFIX. The caller has checked the launch bearer. */
  async handle(req: IncomingMessage, res: ServerResponse, pathname: string): Promise<void> {
    const key = pathname.slice(GATEWAY_PATH_PREFIX.length).replace(/\/+$/, '');
    const route = this.routes.get(key);
    if (!route) {
      res.writeHead(404).end('Unknown MCP server');
      return;
    }

    let body: Buffer | undefined;
    if (req.method === 'POST') {
      try {
        body = await readBody(req);
      } catch {
        res.writeHead(413).end('Request too large');
        return;
      }
    }

    const sessionId = headerValue(req, 'mcp-session-id');
    const sseSession = sessionId ? this.sseSessions.get(sessionId) : undefined;
    if (sseSession) {
      await this.handleSseRequest(sseSession, req, res, body);
      return;
    }

    if (route.mode === 'sse') {
      await this.startSseSession(route, req, res, body);
      return;
    }

    await this.forwardHttp(route, req, res, body);
  }

  private async forwardHttp(route: GatewayRoute, req: IncomingMessage, res: ServerResponse, body: Buffer | undefined): Promise<void> {
    const serverUrl = route.descriptor.serverUrl;
    const controller = new AbortController();
    res.on('close', () => controller.abort());

    let credential = await this.credentialFor(route);
    if (!credential.ok) {
      sendUnavailable(res, body, credential.errorType);
      return;
    }

    let response: Response;
    try {
      response = await this.fetchUpstream(route, serverUrl, {
        method: req.method ?? 'GET',
        headers: this.upstreamHeaders(req, route, credential.accessToken),
        body,
        signal: controller.signal,
      });
    } catch (error) {
      sendUpstreamError(res, body, error);
      return;
    }

    if (response.status === 401 && credential.accessToken !== undefined) {
      await response.body?.cancel().catch(() => undefined);
      const retry = await this.manager.getAccessToken(route.bindingKey, { rejectedToken: credential.accessToken });
      if (!retry.ok) {
        sendUnavailable(res, body, retry.errorType);
        return;
      }
      credential = { ok: true, accessToken: retry.accessToken };
      try {
        response = await this.fetchUpstream(route, serverUrl, {
          method: req.method ?? 'GET',
          headers: this.upstreamHeaders(req, route, retry.accessToken),
          body,
          signal: controller.signal,
        });
      } catch (error) {
        sendUpstreamError(res, body, error);
        return;
      }
      if (response.status === 401) {
        await response.body?.cancel().catch(() => undefined);
        await this.manager.reportPersistentUnauthorized(route.bindingKey, response.headers.get('www-authenticate'), retry.accessToken);
        sendUnavailable(res, body, 'token_exchange');
        return;
      }
    } else if (response.status === 401) {
      await response.body?.cancel().catch(() => undefined);
      sendUnavailable(res, body, 'unauthorized');
      return;
    }

    if (
      route.allowSseFallback
      && req.method === 'POST'
      && !headerValue(req, 'mcp-session-id')
      && isInitializeRequest(body)
      && (response.status === 404 || response.status === 405)
    ) {
      await response.body?.cancel().catch(() => undefined);
      this.log('info', '[MCP gateway] Server did not accept Streamable HTTP; trying legacy SSE');
      // The route switches to SSE only once an SSE session actually started,
      // so one bad answer from a Streamable HTTP server does not stick.
      if (await this.startSseSession(route, req, res, body)) {
        route.mode = 'sse';
      }
      return;
    }

    const headers: Record<string, string> = {};
    for (const name of FORWARDED_RESPONSE_HEADERS) {
      const value = response.headers.get(name);
      if (value !== null) headers[name] = value;
    }
    if (response.status >= 400 && response.body && req.method !== 'HEAD') {
      // Error bodies are read whole and scrubbed: a server that echoes the
      // request's credential in an error must not hand it to the CLI.
      const text = await readLimited(response, MAX_ERROR_BODY_BYTES);
      delete headers['content-length'];
      res.writeHead(response.status, headers);
      res.end(redactSecrets(text, this.secretsFor(route, credential.accessToken)));
      return;
    }
    res.writeHead(response.status, headers);
    if (!response.body || req.method === 'HEAD') {
      res.end();
      return;
    }
    const stream = Readable.fromWeb(response.body as never);
    stream.on('error', () => res.destroy());
    stream.pipe(res);
  }

  /** Values that must never appear in what the CLI receives. */
  private secretsFor(route: GatewayRoute, accessToken: string | undefined): string[] {
    const secrets: string[] = [];
    for (const value of Object.values(route.descriptor.headers ?? {})) {
      secrets.push(value);
      // Also the bare credential after an auth scheme ("Bearer <key>").
      const credential = /^\s*\S+\s+(\S+)\s*$/.exec(value)?.[1];
      if (credential) secrets.push(credential);
    }
    if (accessToken) secrets.push(accessToken);
    // Short values (a header like `X-Team: a1`) would redact ordinary text.
    return secrets.filter((secret) => secret.length >= 8);
  }

  /**
   * Fetch the upstream without following redirects automatically. A redirect
   * is followed only within the server's origin (same scheme, host and port)
   * and only for GET or 307/308, whether or not it carries a credential.
   */
  private async fetchUpstream(
    route: GatewayRoute,
    target: string,
    init: { method: string; headers: Record<string, string>; body?: Buffer; signal: AbortSignal },
  ): Promise<Response> {
    let url = new URL(target);
    for (let hop = 0; hop <= MAX_REDIRECTS; hop += 1) {
      const response = await this.fetchFn(url, {
        method: init.method,
        headers: init.headers,
        body: init.body as never,
        signal: init.signal,
        redirect: 'manual',
      });
      if (response.status < 300 || response.status >= 400 || response.status === 304) {
        return response;
      }
      const location = response.headers.get('location');
      await response.body?.cancel().catch(() => undefined);
      if (!location) {
        throw new GatewayError('The MCP server answered with a redirect without a location.');
      }
      const next = new URL(location, url);
      const keepsMethod = response.status === 307 || response.status === 308 || init.method === 'GET';
      // The token's audience is this server; a redirect may move within its
      // origin (e.g. `/mcp` to `/mcp/`), never off it, and never to plain http.
      if (!keepsMethod || !sameOrigin(next, route.descriptor.serverUrl) || next.username || next.password) {
        throw new GatewayError('The MCP server redirected somewhere Nimbalyst does not send credentials.');
      }
      url = next;
    }
    throw new GatewayError('The MCP server redirected too many times.');
  }

  private upstreamHeaders(req: IncomingMessage, route: GatewayRoute, accessToken: string | undefined): Record<string, string> {
    const headers: Record<string, string> = {};
    for (const [name, value] of Object.entries(route.descriptor.headers ?? {})) {
      headers[name] = value;
    }
    for (const name of FORWARDED_REQUEST_HEADERS) {
      const value = headerValue(req, name);
      if (value !== undefined) headers[name] = value;
    }
    if (accessToken !== undefined) {
      for (const name of Object.keys(headers)) {
        if (name.toLowerCase() === 'authorization') delete headers[name];
      }
      headers.Authorization = `Bearer ${accessToken}`;
    }
    return headers;
  }

  /**
   * `accessToken` is undefined for a pass-through server (no OAuth; its
   * static headers are the credential).
   */
  private async credentialFor(route: GatewayRoute): Promise<
    { ok: true; accessToken?: string } | { ok: false; errorType: McpOAuthErrorType | 'unauthorized' }
  > {
    if (route.staticAuthorization) {
      return { ok: true };
    }
    let token = await this.manager.getAccessToken(route.bindingKey);
    if (!token.ok && token.errorType === 'unauthorized') {
      // No record yet: run the one-time import from mcp-remote's store here
      // too, not only from the session-start status check, which a server
      // that did not answer the OAuth probe in time never reaches.
      await this.manager.getStatus(route.descriptor);
      token = await this.manager.getAccessToken(route.bindingKey);
    }
    if (token.ok) {
      return { ok: true, accessToken: token.accessToken };
    }
    if (token.errorType === 'unauthorized' && !route.requiresOAuth) {
      return { ok: true };
    }
    return token;
  }

  /** Returns true when an SSE session was started for this request. */
  private async startSseSession(route: GatewayRoute, req: IncomingMessage, res: ServerResponse, body: Buffer | undefined): Promise<boolean> {
    if (req.method !== 'POST') {
      res.writeHead(405).end();
      return false;
    }
    const credential = await this.credentialFor(route);
    if (!credential.ok) {
      sendUnavailable(res, body, credential.errorType);
      return false;
    }
    const serverUrl = route.descriptor.serverUrl;
    const client = new SSEClientTransport(new URL(serverUrl), {
      fetch: (input, init) => this.sseFetch(route, input, init),
    });
    const server = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => randomUUID(),
      onsessioninitialized: (sessionId) => {
        this.sseSessions.set(sessionId, { server, client });
      },
    });
    let closing = false;
    const closeBoth = () => {
      // Each transport's close fires the other's onclose; close once.
      if (closing) return;
      closing = true;
      const sessionId = server.sessionId;
      if (sessionId) this.sseSessions.delete(sessionId);
      void client.close().catch(() => undefined);
      void server.close().catch(() => undefined);
    };
    server.onmessage = (message: JSONRPCMessage) => {
      client.send(message).catch((error) => {
        this.log('warn', '[MCP gateway] Upstream SSE send failed', { reason: error instanceof Error ? error.name : 'unknown' });
        if ('id' in message && 'method' in message) {
          void server.send({
            jsonrpc: '2.0',
            id: message.id,
            error: { code: -32001, message: 'The remote MCP server could not be reached through Nimbalyst.' },
          } as JSONRPCMessage).catch(() => undefined);
        }
      });
    };
    client.onmessage = (message: JSONRPCMessage) => {
      void server.send(message).catch(() => undefined);
    };
    client.onclose = closeBoth;
    server.onclose = closeBoth;
    client.onerror = () => undefined;

    try {
      await client.start();
    } catch (error) {
      void server.close().catch(() => undefined);
      // `sse-first` means try SSE, then Streamable HTTP, as mcp-remote does.
      if (route.descriptor.transportStrategy === 'sse-first' && !route.sseFirstFellBack) {
        route.sseFirstFellBack = true;
        route.mode = 'http';
        this.log('info', '[MCP gateway] SSE unavailable; using Streamable HTTP');
        await this.forwardHttp(route, req, res, body);
        return false;
      }
      sendUpstreamError(res, body, error);
      return false;
    }
    await this.handleSseRequest({ server, client }, req, res, body);
    return true;
  }

  private async handleSseRequest(session: SseSession, req: IncomingMessage, res: ServerResponse, body: Buffer | undefined): Promise<void> {
    req.headers.accept = ensureAccept(req.headers.accept);
    let parsed: unknown;
    if (body) {
      try {
        parsed = JSON.parse(body.toString('utf8'));
      } catch {
        res.writeHead(400).end('Invalid JSON');
        return;
      }
    }
    try {
      await session.server.handleRequest(req as never, res, parsed);
    } catch {
      if (!res.headersSent) {
        res.writeHead(500).end();
      }
    }
  }

  /**
   * Every request the SSE client makes (the GET stream and each POST to the
   * endpoint) goes through here: same origin as the configured server, no
   * downgrade, token attached, one refresh-and-retry on 401.
   */
  private async sseFetch(route: GatewayRoute, input: string | URL, init?: RequestInit): Promise<Response> {
    const url = new URL(typeof input === 'string' ? input : input.href);
    const serverUrl = route.descriptor.serverUrl;
    if (!sameOrigin(url, serverUrl)) {
      throw new GatewayError('The SSE server named an endpoint on another origin.');
    }
    assertNoDowngrade(url, serverUrl, 'SSE endpoint');

    const credential = await this.credentialFor(route);
    if (!credential.ok) {
      throw new GatewayError('The remote MCP server needs to be authorized again in Settings.');
    }
    const send = (accessToken: string | undefined) => {
      const headers = new Headers(init?.headers);
      for (const [name, value] of Object.entries(route.descriptor.headers ?? {})) {
        if (!headers.has(name)) headers.set(name, value);
      }
      if (accessToken !== undefined) {
        headers.set('Authorization', `Bearer ${accessToken}`);
      }
      return this.fetchFn(url, { ...init, headers, redirect: 'manual' });
    };
    let response = await send(credential.accessToken);
    if (response.status === 401 && credential.accessToken !== undefined) {
      await response.body?.cancel().catch(() => undefined);
      const retry = await this.manager.getAccessToken(route.bindingKey, { rejectedToken: credential.accessToken });
      if (!retry.ok) {
        throw new GatewayError('The remote MCP server needs to be authorized again in Settings.');
      }
      response = await send(retry.accessToken);
      if (response.status === 401) {
        await this.manager.reportPersistentUnauthorized(route.bindingKey, response.headers.get('www-authenticate'), retry.accessToken);
      }
    }
    return response;
  }
}

class GatewayError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'GatewayError';
  }
}

const UNAVAILABLE_MESSAGES: Partial<Record<McpOAuthErrorType | 'unauthorized', string>> = {
  unauthorized: 'This MCP server needs authorization. Authorize it in Nimbalyst Settings > MCP Servers.',
  authorization_server_changed: 'This MCP server now uses a different sign-in provider. Authorize it again in Nimbalyst Settings > MCP Servers.',
  token_exchange: 'This MCP server sign-in expired. Authorize it again in Nimbalyst Settings > MCP Servers.',
  credential_storage_unavailable: 'Nimbalyst could not read the saved sign-in for this MCP server.',
  network: 'The MCP server sign-in could not be refreshed right now. Try again shortly.',
};

/**
 * 503 with a JSON-RPC error, never 401: a 401 with WWW-Authenticate would make
 * the CLI start its own OAuth flow against the loopback gateway.
 */
function sendUnavailable(res: ServerResponse, body: Buffer | undefined, reason: McpOAuthErrorType | 'unauthorized'): void {
  const message = UNAVAILABLE_MESSAGES[reason] ?? 'This MCP server needs to be authorized again in Nimbalyst Settings > MCP Servers.';
  sendJsonRpcError(res, body, 503, message);
}

function sendUpstreamError(res: ServerResponse, body: Buffer | undefined, error: unknown): void {
  if (res.headersSent) {
    res.destroy();
    return;
  }
  const message = error instanceof GatewayError
    ? error.message
    : 'The remote MCP server could not be reached.';
  sendJsonRpcError(res, body, 502, message);
}

function sendJsonRpcError(res: ServerResponse, body: Buffer | undefined, status: number, message: string): void {
  if (res.headersSent) {
    res.destroy();
    return;
  }
  let id: unknown = null;
  if (body) {
    try {
      const parsed = JSON.parse(body.toString('utf8'));
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed) && 'id' in parsed) {
        id = parsed.id;
      }
    } catch {
      // Not JSON: keep a null id.
    }
  }
  res.writeHead(status, { 'Content-Type': 'application/json' })
    .end(JSON.stringify({ jsonrpc: '2.0', id, error: { code: -32001, message } }));
}

const MAX_ERROR_BODY_BYTES = 64 * 1024;

async function readLimited(response: Response, limit: number): Promise<string> {
  const reader = response.body!.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (size < limit) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
      size += value.length;
    }
  } finally {
    await reader.cancel().catch(() => undefined);
  }
  return Buffer.concat(chunks).subarray(0, limit).toString('utf8');
}

function redactSecrets(text: string, secrets: string[]): string {
  let result = text;
  for (const secret of secrets) {
    result = result.split(secret).join('[redacted]');
  }
  return result;
}

function isInitializeRequest(body: Buffer | undefined): boolean {
  if (!body) return false;
  try {
    const parsed = JSON.parse(body.toString('utf8'));
    return Boolean(parsed && typeof parsed === 'object' && !Array.isArray(parsed) && parsed.method === 'initialize');
  } catch {
    return false;
  }
}

async function readBody(req: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const buffer = chunk as Buffer;
    size += buffer.length;
    if (size > MAX_BODY_BYTES) {
      throw new Error('too large');
    }
    chunks.push(buffer);
  }
  return Buffer.concat(chunks);
}

function headerValue(req: IncomingMessage, name: string): string | undefined {
  const value = req.headers[name];
  if (Array.isArray(value)) return value[0];
  return value ?? undefined;
}

function ensureAccept(accept: string | undefined): string {
  const parts = new Set((accept ?? '').split(',').map((part) => part.trim()).filter(Boolean));
  parts.add('application/json');
  parts.add('text/event-stream');
  return Array.from(parts).join(', ');
}
