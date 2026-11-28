// @vitest-environment node
import * as fs from 'fs';
import * as http from 'http';
import * as os from 'os';
import * as path from 'path';
import type { AddressInfo } from 'net';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { SSEServerTransport } from '@modelcontextprotocol/sdk/server/sse.js';
import { ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import type { MCPRemoteConfigDescriptor } from '../../MCPRemoteOAuth';
import { setMcpAuthTokenForTest } from '../../../mcp/mcpAuth';
import { McpOAuthCredentialStore, type SecretCodec } from '../credentialStore';
import { McpOAuthManager } from '../McpOAuthManager';
import { McpRemoteGateway, GATEWAY_PATH_PREFIX } from '../gateway';
import { gatewayRouteToken, handleGatewayRequest, isGatewayPath } from '../gatewayRoute';
import {
  fakeBrowser,
  startFakeAuthorizationServer,
  startFakeResourceServer,
  type FakeAuthorizationServer,
  type FakeResourceServer,
  type RecordedRequest,
} from './fakeOAuthServers';

const LAUNCH_TOKEN = 'launch-token-for-tests';
const codec: SecretCodec = {
  isEncryptionAvailable: () => true,
  encryptString: (plain) => Buffer.from(plain),
  decryptString: (encrypted) => encrypted.toString(),
};

let tempRoot: string;
let as1: FakeAuthorizationServer;
let rs: FakeResourceServer;
let manager: McpOAuthManager;
let gateway: McpRemoteGateway;
let gatewayServer: http.Server;
let gatewayBase: string;

function descriptorFor(serverUrl: string, extra: Partial<MCPRemoteConfigDescriptor> = {}): MCPRemoteConfigDescriptor {
  return { serverUrl, headers: {}, requiresOAuth: true, callbackPort: 0, ...extra };
}

async function startHttp(handler: http.RequestListener): Promise<{ server: http.Server; base: string }> {
  const server = http.createServer(handler);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return { server, base: `http://127.0.0.1:${(server.address() as AddressInfo).port}` };
}

async function stopHttp(server: http.Server): Promise<void> {
  server.closeAllConnections?.();
  await new Promise<void>((resolve) => server.close(() => resolve()));
}

/** The bearer a generated entry for this route carries. */
const tokenFor = (routeKey: string) => gatewayRouteToken(LAUNCH_TOKEN, routeKey);

async function connectClient(routeKey: string, token = tokenFor(routeKey)): Promise<Client> {
  const client = new Client({ name: 'test-cli', version: '1.0.0' });
  const transport = new StreamableHTTPClientTransport(new URL(`${gatewayBase}${GATEWAY_PATH_PREFIX}${routeKey}`), {
    requestInit: { headers: { Authorization: `Bearer ${token}` } },
  });
  await client.connect(transport);
  return client;
}

function bearerTokens(requests: RecordedRequest[]): string[] {
  return requests.map((r) => r.headers.authorization ?? '').filter(Boolean);
}

beforeEach(async () => {
  tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'nim-mcp-gateway-'));
  as1 = await startFakeAuthorizationServer();
  rs = await startFakeResourceServer([as1.base]);
  rs.acceptedTokens = () => as1.validAccessTokens;
  manager = new McpOAuthManager({
    store: new McpOAuthCredentialStore(path.join(tempRoot, 'store'), codec),
    openExternal: fakeBrowser().openExternal,
    legacyAuthDir: () => path.join(tempRoot, 'mcp-auth'),
    platform: 'darwin',
  });
  gateway = new McpRemoteGateway(manager);
  setMcpAuthTokenForTest(LAUNCH_TOKEN);
  const started = await startHttp((req, res) => {
    const pathname = new URL(req.url ?? '/', 'http://x').pathname;
    if (isGatewayPath(pathname)) {
      void handleGatewayRequest(gateway, req, res, pathname);
      return;
    }
    res.writeHead(404).end();
  });
  gatewayServer = started.server;
  gatewayBase = started.base;
});

afterEach(async () => {
  await gateway.closeAll();
  await stopHttp(gatewayServer);
  await rs.close();
  await as1.close();
  setMcpAuthTokenForTest(null);
  fs.rmSync(tempRoot, { recursive: true, force: true });
});

describe('McpRemoteGateway', () => {
  it('lets an MCP client list tools through the gateway with the remote token attached upstream', async () => {
    const descriptor = descriptorFor(rs.mcpUrl);
    expect(await manager.authorize(descriptor, { timeoutMs: 5000 })).toEqual({ ok: true });
    // Sign-in probes the server once without credentials; count from here.
    const sinceSignIn = rs.requests.length;
    const key = gateway.registerRoute(descriptor, 'http');

    const client = await connectClient(key);
    const tools = await client.listTools();
    await client.close();

    expect(tools.tools.map((tool) => tool.name)).toEqual(['echo']);
    const upstream = rs.requests.slice(sinceSignIn).filter((r) => r.path === '/mcp' && r.method === 'POST');
    expect(upstream.length).toBeGreaterThan(0);
    for (const request of upstream) {
      expect(as1.validAccessTokens.has((request.headers.authorization ?? '').replace('Bearer ', ''))).toBe(true);
      expect(request.headers.authorization).not.toContain(LAUNCH_TOKEN);
    }
  });
});

/**
 * Legacy SSE MCP server built from the SDK: GET <ssePath> opens the stream and
 * announces `endpoint`; POST /messages carries client messages. POST to
 * <ssePath> answers 405, as an SSE-only server does to Streamable HTTP.
 */
async function startSseServer(options: {
  ssePath: string;
  authorizationServer: string;
  acceptedTokens: () => Set<string>;
  endpointOverride?: string;
}) {
  const requests: RecordedRequest[] = [];
  const transports = new Map<string, SSEServerTransport>();
  let base = '';
  const started = await startHttp(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://x');
    requests.push({ method: req.method ?? 'GET', path: url.pathname, headers: req.headers, body: '', params: url.searchParams });
    if (url.pathname.startsWith('/.well-known/oauth-protected-resource')) {
      res.writeHead(200, { 'Content-Type': 'application/json' })
        .end(JSON.stringify({ resource: `${base}${options.ssePath}`, authorization_servers: [options.authorizationServer] }));
      return;
    }
    const token = (req.headers.authorization ?? '').replace(/^Bearer\s+/i, '');
    if (!options.acceptedTokens().has(token)) {
      res.writeHead(401).end();
      return;
    }
    if (url.pathname === options.ssePath && req.method === 'GET') {
      if (options.endpointOverride) {
        res.writeHead(200, { 'Content-Type': 'text/event-stream' });
        res.write(`event: endpoint\ndata: ${options.endpointOverride}\n\n`);
        return;
      }
      const transport = new SSEServerTransport('/messages', res);
      transports.set(transport.sessionId, transport);
      const server = new Server({ name: 'legacy-sse', version: '1.0.0' }, { capabilities: { tools: {} } });
      server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: [{ name: 'legacy-echo', inputSchema: { type: 'object' } }] }));
      await server.connect(transport);
      return;
    }
    if (url.pathname === '/messages' && req.method === 'POST') {
      const transport = transports.get(url.searchParams.get('sessionId') ?? '');
      if (!transport) {
        res.writeHead(404).end();
        return;
      }
      await transport.handlePostMessage(req, res);
      return;
    }
    if (url.pathname === options.ssePath && req.method === 'POST') {
      res.writeHead(405).end();
      return;
    }
    res.writeHead(404).end();
  });
  base = started.base;
  return { ...started, requests, url: `${started.base}${options.ssePath}` };
}

describe('McpRemoteGateway security', () => {
  it('keeps two configs for one server with different static keys on separate routes', async () => {
    rs.acceptedTokens = () => new Set(['key-for-alice-0001', 'key-for-bob-00002']);
    const alice = descriptorFor(rs.mcpUrl, { requiresOAuth: false, headers: { Authorization: 'Bearer key-for-alice-0001' } });
    const bob = descriptorFor(rs.mcpUrl, { requiresOAuth: false, headers: { Authorization: 'Bearer key-for-bob-00002' } });
    const aliceKey = gateway.registerRoute(alice, 'http');
    const bobKey = gateway.registerRoute(bob, 'http');
    expect(aliceKey).not.toBe(bobKey);

    const before = rs.requests.length;
    const client = await connectClient(aliceKey);
    await client.listTools();
    await client.close();

    const sent = bearerTokens(rs.requests.slice(before).filter((r) => r.path === '/mcp'));
    expect(sent.length).toBeGreaterThan(0);
    expect(sent.every((value) => value === 'Bearer key-for-alice-0001')).toBe(true);
  });

  it('scrubs the credential from an upstream error body that echoes it', async () => {
    const descriptor = descriptorFor(rs.mcpUrl);
    expect(await manager.authorize(descriptor, { timeoutMs: 5000 })).toEqual({ ok: true });
    rs.onMcp = (req, res) => {
      if (!req.headers.authorization) return false;
      res.writeHead(403, { 'Content-Type': 'application/json' })
        .end(JSON.stringify({ jsonrpc: '2.0', id: 1, error: { code: -32000, message: `forbidden for ${req.headers.authorization}` } }));
      return true;
    };
    const key = gateway.registerRoute(descriptor, 'http');
    const token = await manager.getAccessToken(manager.bindingKeyFor(descriptor));
    if (!token.ok) throw new Error('expected token');

    const response = await fetch(`${gatewayBase}${GATEWAY_PATH_PREFIX}${key}`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${tokenFor(key)}`, 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
    });
    const text = await response.text();

    expect(response.status).toBe(403);
    expect(text).not.toContain(token.accessToken);
    expect(text).toContain('[redacted]');
  });

  it('falls back from sse-first to Streamable HTTP when the server has no SSE stream', async () => {
    const descriptor = descriptorFor(rs.mcpUrl, { transportStrategy: 'sse-first' });
    expect(await manager.authorize(descriptor, { timeoutMs: 5000 })).toEqual({ ok: true });
    const key = gateway.registerRoute(descriptor, 'http');

    const client = await connectClient(key);
    const tools = await client.listTools();
    await client.close();

    expect(tools.tools.map((tool) => tool.name)).toEqual(['echo']);
  });

  it('N10: a request without this route\'s bearer is refused before any upstream request', async () => {
    const descriptor = descriptorFor(rs.mcpUrl);
    expect(await manager.authorize(descriptor, { timeoutMs: 5000 })).toEqual({ ok: true });
    const key = gateway.registerRoute(descriptor, 'http');
    const before = rs.requests.length;
    const post = (authorization?: string) => fetch(`${gatewayBase}${GATEWAY_PATH_PREFIX}${key}`, {
      method: 'POST', body: '{}', headers: authorization ? { Authorization: authorization } : {},
    });

    const statuses = [
      (await post()).status,
      (await post('Bearer stale-launch-token')).status,
      // The launch token itself opens the first-party servers, not gateway routes.
      (await post(`Bearer ${LAUNCH_TOKEN}`)).status,
      // Another route's token does not open this one.
      (await post(`Bearer ${tokenFor('0'.repeat(40))}`)).status,
      // Nor does a route token from a previous launch.
      (await post(`Bearer ${gatewayRouteToken('previous-launch', key)}`)).status,
    ];

    expect(statuses).toEqual([401, 401, 401, 401, 401]);
    expect(rs.requests.length).toBe(before);
  });

  it('answers a server that needs sign-in with 503 and no WWW-Authenticate, so CLIs do not start their own OAuth', async () => {
    const key = gateway.registerRoute(descriptorFor(rs.mcpUrl), 'http');

    const response = await fetch(`${gatewayBase}${GATEWAY_PATH_PREFIX}${key}`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${tokenFor(key)}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 7, method: 'initialize', params: {} }),
    });

    expect(response.status).toBe(503);
    expect(response.headers.get('www-authenticate')).toBeNull();
    expect(await response.json()).toMatchObject({ id: 7, error: { code: -32001 } });
    expect(rs.requests.filter((r) => r.path === '/mcp')).toHaveLength(0);
  });

  it('N6: a cross-origin redirect from the MCP server never receives the remote token', async () => {
    const descriptor = descriptorFor(rs.mcpUrl);
    expect(await manager.authorize(descriptor, { timeoutMs: 5000 })).toEqual({ ok: true });
    const targetRequests: string[] = [];
    const target = await startHttp((req, res) => {
      targetRequests.push(req.headers.authorization ?? '');
      res.writeHead(200).end('{}');
    });
    rs.onMcp = (_req, res) => {
      res.writeHead(307, { Location: `${target.base}/mcp` }).end();
      return true;
    };
    const key = gateway.registerRoute(descriptor, 'http');

    const response = await fetch(`${gatewayBase}${GATEWAY_PATH_PREFIX}${key}`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${tokenFor(key)}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
    });
    await stopHttp(target.server);

    expect(response.status).toBe(502);
    expect(targetRequests).toHaveLength(0);
  });

  it('refreshes once at the pinned endpoint when 20 concurrent calls all hit an expired token', async () => {
    const descriptor = descriptorFor(rs.mcpUrl);
    expect(await manager.authorize(descriptor, { timeoutMs: 5000 })).toEqual({ ok: true });
    const key = gateway.registerRoute(descriptor, 'http');
    const client = await connectClient(key);
    // The server stops accepting the current token, as on expiry.
    as1.validAccessTokens.clear();

    const results = await Promise.all(Array.from({ length: 20 }, () => client.listTools()));
    await client.close();

    expect(results.every((result) => result.tools.length === 1)).toBe(true);
    expect(as1.tokenRequests().filter((r) => r.params.get('grant_type') === 'refresh_token')).toHaveLength(1);
  });

  it('passes a non-OAuth server through with its configured static headers, kept out of the caller', async () => {
    const descriptor = descriptorFor(rs.mcpUrl, { requiresOAuth: false, headers: { Authorization: 'Bearer static-api-key', 'X-Tenant': 'acme' } });
    rs.acceptedTokens = () => new Set(['static-api-key']);
    const key = gateway.registerRoute(descriptor, 'http');

    const client = await connectClient(key);
    await client.listTools();
    await client.close();

    const upstream = rs.requests.filter((r) => r.path === '/mcp' && r.method === 'POST');
    expect(bearerTokens(upstream).every((value) => value === 'Bearer static-api-key')).toBe(true);
    expect(upstream.every((r) => r.headers['x-tenant'] === 'acme')).toBe(true);
    expect(as1.requests).toHaveLength(0);
  });

  it('adapts a legacy SSE server: GET stream, endpoint event, POST to the advertised path, token on every request', async () => {
    const sse = await startSseServer({ ssePath: '/sse', authorizationServer: as1.base, acceptedTokens: () => as1.validAccessTokens });
    try {
      const descriptor = descriptorFor(sse.url);
      expect(await manager.authorize(descriptor, { timeoutMs: 5000 })).toEqual({ ok: true });
      const sinceSignIn = sse.requests.length;
      const key = gateway.registerRoute(descriptor, 'sse');

      const client = await connectClient(key);
      const tools = await client.listTools();
      await client.close();

      expect(tools.tools.map((tool) => tool.name)).toEqual(['legacy-echo']);
      const upstream = sse.requests.slice(sinceSignIn).filter((r) => r.path === '/sse' || r.path === '/messages');
      expect(upstream.some((r) => r.path === '/sse' && r.method === 'GET')).toBe(true);
      expect(upstream.some((r) => r.path === '/messages' && r.method === 'POST')).toBe(true);
      for (const request of upstream) {
        expect(as1.validAccessTokens.has((request.headers.authorization ?? '').replace('Bearer ', ''))).toBe(true);
      }
    } finally {
      await stopHttp(sse.server);
    }
  });

  it('falls back from Streamable HTTP to legacy SSE when the first POST gets 405 (http-first)', async () => {
    const sse = await startSseServer({ ssePath: '/sse', authorizationServer: as1.base, acceptedTokens: () => as1.validAccessTokens });
    try {
      const descriptor = descriptorFor(sse.url);
      expect(await manager.authorize(descriptor, { timeoutMs: 5000 })).toEqual({ ok: true });
      const key = gateway.registerRoute(descriptor, 'http');

      const client = await connectClient(key);
      const tools = await client.listTools();
      await client.close();

      expect(tools.tools.map((tool) => tool.name)).toEqual(['legacy-echo']);
      expect(sse.requests.some((r) => r.path === '/sse' && r.method === 'POST')).toBe(true);
    } finally {
      await stopHttp(sse.server);
    }
  });

  it('N16: an SSE endpoint event naming another origin fails the session and the target receives nothing', async () => {
    const otherRequests: RecordedRequest[] = [];
    const other = await startHttp((req, res) => {
      otherRequests.push({ method: req.method ?? 'GET', path: req.url ?? '', headers: req.headers, body: '', params: new URLSearchParams() });
      res.writeHead(200).end();
    });
    const sse = await startSseServer({
      ssePath: '/sse',
      authorizationServer: as1.base,
      acceptedTokens: () => as1.validAccessTokens,
      endpointOverride: `${other.base}/messages`,
    });
    try {
      const descriptor = descriptorFor(sse.url);
      expect(await manager.authorize(descriptor, { timeoutMs: 5000 })).toEqual({ ok: true });
      const key = gateway.registerRoute(descriptor, 'sse');

      await expect(connectClient(key)).rejects.toThrow();
      expect(otherRequests).toHaveLength(0);
    } finally {
      await stopHttp(sse.server);
      await stopHttp(other.server);
    }
  });
});

describe('mcp-gateway-stdio.mjs', () => {
  it('bridges a stdio MCP session to the gateway with only the loopback token, passed in env', async () => {
    const { spawn } = await import('child_process');
    const descriptor = descriptorFor(rs.mcpUrl);
    expect(await manager.authorize(descriptor, { timeoutMs: 5000 })).toEqual({ ok: true });
    const sinceSignIn = rs.requests.length;
    const key = gateway.registerRoute(descriptor, 'http');
    const shim = path.resolve(__dirname, '../../../../../resources/mcp-gateway-stdio.mjs');
    const args = [shim, `${gatewayBase}${GATEWAY_PATH_PREFIX}${key}`];
    // The response deadlines start once the helper's first request reaches the
    // server, so its start-up time on a loaded machine does not count.
    let helperUp: () => void = () => undefined;
    const helperReady = new Promise<void>((resolve) => { helperUp = resolve; });
    rs.onMcp = () => {
      helperUp();
      return false;
    };

    const child = spawn(process.execPath, args, {
      env: { PATH: '', NIMBALYST_MCP_GATEWAY_TOKEN: tokenFor(key) },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    const lines: string[] = [];
    let buffered = '';
    const responseFor = (id: number) => new Promise<Record<string, unknown>>((resolve, reject) => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      let found = false;
      void helperReady.then(() => {
        if (!found) timer = setTimeout(() => reject(new Error(`no response for ${id}`)), 5000);
      });
      const check = () => {
        for (const line of lines) {
          const message = JSON.parse(line);
          if (message.id === id) {
            found = true;
            clearTimeout(timer);
            resolve(message);
            return true;
          }
        }
        return false;
      };
      if (!check()) child.stdout.on('data', () => check());
      // A helper that dies before it is up fails at once, not at the test timeout.
      child.once('exit', (code) => reject(new Error(`no response for ${id}: the helper exited with ${code}`)));
    });
    child.stdout.on('data', (chunk: Buffer) => {
      buffered += chunk.toString();
      let newline;
      while ((newline = buffered.indexOf('\n')) !== -1) {
        lines.push(buffered.slice(0, newline));
        buffered = buffered.slice(newline + 1);
      }
    });
    const send = (message: unknown) => child.stdin.write(`${JSON.stringify(message)}\n`);

    send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'cli', version: '1' } } });
    const initialized = await responseFor(1);
    send({ jsonrpc: '2.0', method: 'notifications/initialized' });
    send({ jsonrpc: '2.0', id: 2, method: 'tools/list' });
    const listed = await responseFor(2);
    // Server-initiated messages need the GET stream, opened after
    // `notifications/initialized` (which the server answers 202).
    const deadline = Date.now() + 3000;
    while (!rs.requests.slice(sinceSignIn).some((r) => r.path === '/mcp' && r.method === 'GET') && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    expect(rs.requests.slice(sinceSignIn).some((r) => r.path === '/mcp' && r.method === 'GET')).toBe(true);
    const exited = new Promise<number | null>((resolve) => child.on('exit', resolve));
    child.stdin.end();

    expect(initialized).toMatchObject({ result: { serverInfo: { name: 'fake' } } });
    expect(listed).toMatchObject({ result: { tools: [{ name: 'echo' }] } });
    expect(await exited).toBe(0);
    expect(args.join(' ')).not.toContain(tokenFor(key));
    const upstream = rs.requests.slice(sinceSignIn).filter((r) => r.path === '/mcp' && r.method === 'POST');
    expect(upstream.length).toBeGreaterThanOrEqual(2);
    expect(upstream.every((r) => as1.validAccessTokens.has((r.headers.authorization ?? '').replace('Bearer ', '')))).toBe(true);
  });

  it('sends later requests once the initialize response arrives, even if its stream stays open', async () => {
    const { spawn } = await import('child_process');
    const descriptor = descriptorFor(rs.mcpUrl);
    expect(await manager.authorize(descriptor, { timeoutMs: 5000 })).toEqual({ ok: true });
    const open: http.ServerResponse[] = [];
    let startDeadline: () => void = () => undefined;
    rs.onMcp = (req, res) => {
      if (req.method !== 'POST' || !JSON.parse(req.body || '{}').method?.startsWith('initialize')) {
        return false;
      }
      const id = JSON.parse(req.body).id;
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'mcp-session-id': 'upstream-session' });
      res.write(`event: message\ndata: ${JSON.stringify({ jsonrpc: '2.0', id, result: { protocolVersion: '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'fake', version: '1.0.0' } } })}\n\n`);
      // The stream is left open, as a server may do.
      open.push(res);
      // The helper is up and has its answer: the deadline starts only now, so
      // its start-up time on a loaded machine does not count.
      startDeadline();
      return true;
    };
    const key = gateway.registerRoute(descriptor, 'http');
    const shim = path.resolve(__dirname, '../../../../../resources/mcp-gateway-stdio.mjs');
    const child = spawn(process.execPath, [shim, `${gatewayBase}${GATEWAY_PATH_PREFIX}${key}`], {
      env: { PATH: '', NIMBALYST_MCP_GATEWAY_TOKEN: tokenFor(key) },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    try {
      let output = '';
      const listed = new Promise<boolean>((resolve) => {
        let timer: ReturnType<typeof setTimeout> | undefined;
        startDeadline = () => { timer = setTimeout(() => resolve(false), 3000); };
        child.once('exit', () => resolve(false));
        child.stdout.on('data', (chunk: Buffer) => {
          output += chunk.toString();
          if (output.split('\n').some((line) => line.includes('"id":2'))) {
            clearTimeout(timer);
            resolve(true);
          }
        });
      });
      const send = (message: unknown) => child.stdin.write(`${JSON.stringify(message)}\n`);
      send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'cli', version: '1' } } });
      send({ jsonrpc: '2.0', method: 'notifications/initialized' });
      send({ jsonrpc: '2.0', id: 2, method: 'tools/list' });

      expect(await listed).toBe(true);
    } finally {
      child.kill();
      for (const res of open) res.end();
    }
  });
});

describe('Test connection', () => {
  it('tests an authorized HTTP server through the gateway in process, with no helper spawned', async () => {
    const { MCPConfigService } = await import('../../MCPConfigService');
    const { setMcpOAuthForTest } = await import('..');
    const descriptor = descriptorFor(rs.mcpUrl);
    expect(await manager.authorize(descriptor, { timeoutMs: 5000 })).toEqual({ ok: true });
    setMcpOAuthForTest({
      manager,
      gateway,
      endpoint: { port: Number(new URL(gatewayBase).port), getToken: () => LAUNCH_TOKEN },
    });
    try {
      const service = new MCPConfigService();
      const authorized = await service.testServerConnection({ type: 'http', url: rs.mcpUrl, oauth: { authTimeoutSeconds: 60 } });
      as1.validAccessTokens.clear();
      as1.options.refreshError = 'invalid_grant';
      const expired = await service.testServerConnection({ type: 'http', url: rs.mcpUrl, oauth: { authTimeoutSeconds: 60 } });

      expect(authorized).toEqual({ success: true });
      expect(expired.success).toBe(false);
      expect(expired.error).toMatch(/Authorize it again/);
    } finally {
      setMcpOAuthForTest({ manager: null, gateway: null, endpoint: null });
    }
  });
});
