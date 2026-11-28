/**
 * In-process fake OAuth authorization servers and an MCP resource server on
 * loopback, for asserting what each endpoint did and did NOT receive.
 */
import * as http from 'http';
import { createHash, randomBytes } from 'crypto';
import type { AddressInfo } from 'net';

export interface RecordedRequest {
  method: string;
  path: string;
  headers: http.IncomingHttpHeaders;
  body: string;
  params: URLSearchParams;
}

interface IssuedCode {
  clientId: string;
  redirectUri: string;
  challenge: string;
  resource?: string;
}

export interface FakeAuthorizationServer {
  base: string;
  requests: RecordedRequest[];
  /** Mutable metadata overrides applied to the discovery document. */
  metadata: Record<string, unknown>;
  /** Behaviour switches. */
  options: {
    issueRefreshTokens: boolean;
    expiresIn: number;
    /** Send `iss` on the authorization redirect. */
    sendIss: boolean | string;
    tokenEndpointRedirect?: string;
    refreshError?: string;
    /** Hold an accepted refresh's response until this resolves. */
    refreshHold?: Promise<void>;
    /** Hold each revocation request that arrives while this is set, until it resolves. */
    revokeHold?: Promise<void>;
    registrationError?: string;
    clientSecret?: string;
  };
  validAccessTokens: Set<string>;
  refreshTokens: Set<string>;
  revoked: string[];
  close(): Promise<void>;
  tokenRequests(): RecordedRequest[];
}

export interface FakeResourceServer {
  base: string;
  mcpUrl: string;
  requests: RecordedRequest[];
  /** Authorization servers the PRM document advertises. */
  authorizationServers: string[];
  prmResource?: string;
  /** Tokens this server accepts. */
  acceptedTokens: () => Set<string>;
  /** Optional override for POST /mcp. */
  onMcp?: (req: RecordedRequest, res: http.ServerResponse) => boolean;
  close(): Promise<void>;
}

async function readBody(req: http.IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString('utf8');
}

function listen(server: http.Server): Promise<string> {
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const address = server.address() as AddressInfo;
      resolve(`http://127.0.0.1:${address.port}`);
    });
  });
}

function closeServer(server: http.Server): Promise<void> {
  return new Promise((resolve) => {
    server.closeAllConnections?.();
    server.close(() => resolve());
  });
}

export async function startFakeAuthorizationServer(): Promise<FakeAuthorizationServer> {
  const requests: RecordedRequest[] = [];
  const codes = new Map<string, IssuedCode>();
  const validAccessTokens = new Set<string>();
  const refreshTokens = new Set<string>();
  const revoked: string[] = [];
  let counter = 0;
  const fake: FakeAuthorizationServer = {
    base: '',
    requests,
    metadata: {},
    options: { issueRefreshTokens: true, expiresIn: 3600, sendIss: false },
    validAccessTokens,
    refreshTokens,
    revoked,
    close: async () => undefined,
    tokenRequests: () => requests.filter((r) => r.path === '/token'),
  };

  const issueTokens = () => {
    counter += 1;
    const access = `at-${counter}-${randomBytes(4).toString('hex')}`;
    validAccessTokens.add(access);
    const body: Record<string, unknown> = { access_token: access, token_type: 'Bearer', expires_in: fake.options.expiresIn };
    if (fake.options.issueRefreshTokens) {
      const refresh = `rt-${counter}-${randomBytes(4).toString('hex')}`;
      refreshTokens.add(refresh);
      body.refresh_token = refresh;
    }
    return body;
  };

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', fake.base);
    const body = await readBody(req);
    const params = req.headers['content-type']?.includes('application/x-www-form-urlencoded')
      ? new URLSearchParams(body)
      : url.searchParams;
    requests.push({ method: req.method ?? 'GET', path: url.pathname, headers: req.headers, body, params });

    const json = (status: number, value: unknown) => {
      res.writeHead(status, { 'Content-Type': 'application/json' }).end(JSON.stringify(value));
    };

    if (url.pathname.startsWith('/.well-known/oauth-authorization-server') || url.pathname.startsWith('/.well-known/openid-configuration')) {
      json(200, {
        issuer: fake.base,
        authorization_endpoint: `${fake.base}/authorize`,
        token_endpoint: `${fake.base}/token`,
        registration_endpoint: `${fake.base}/register`,
        revocation_endpoint: `${fake.base}/revoke`,
        response_types_supported: ['code'],
        code_challenge_methods_supported: ['S256'],
        token_endpoint_auth_methods_supported: ['none', 'client_secret_post', 'client_secret_basic'],
        ...fake.metadata,
      });
      return;
    }
    if (url.pathname === '/register' && req.method === 'POST') {
      if (fake.options.registrationError) {
        json(400, { error: fake.options.registrationError });
        return;
      }
      const metadata = JSON.parse(body || '{}');
      counter += 1;
      json(201, {
        ...metadata,
        client_id: `client-${counter}`,
        ...(fake.options.clientSecret ? { client_secret: fake.options.clientSecret } : {}),
      });
      return;
    }
    if (url.pathname === '/authorize' && req.method === 'GET') {
      const code = `code-${randomBytes(6).toString('hex')}`;
      codes.set(code, {
        clientId: url.searchParams.get('client_id') ?? '',
        redirectUri: url.searchParams.get('redirect_uri') ?? '',
        challenge: url.searchParams.get('code_challenge') ?? '',
        resource: url.searchParams.get('resource') ?? undefined,
      });
      const redirect = new URL(url.searchParams.get('redirect_uri') ?? '');
      redirect.searchParams.set('code', code);
      const state = url.searchParams.get('state');
      if (state) redirect.searchParams.set('state', state);
      if (fake.options.sendIss) {
        redirect.searchParams.set('iss', typeof fake.options.sendIss === 'string' ? fake.options.sendIss : fake.base);
      }
      res.writeHead(302, { Location: redirect.href }).end();
      return;
    }
    if (url.pathname === '/token' && req.method === 'POST') {
      if (fake.options.tokenEndpointRedirect) {
        res.writeHead(307, { Location: fake.options.tokenEndpointRedirect }).end();
        return;
      }
      const grant = params.get('grant_type');
      if (grant === 'authorization_code') {
        const issued = codes.get(params.get('code') ?? '');
        codes.delete(params.get('code') ?? '');
        const verifier = params.get('code_verifier') ?? '';
        const challenge = createHash('sha256').update(verifier).digest('base64url');
        if (!issued || issued.redirectUri !== params.get('redirect_uri') || issued.challenge !== challenge) {
          json(400, { error: 'invalid_grant' });
          return;
        }
        json(200, issueTokens());
        return;
      }
      if (grant === 'refresh_token') {
        if (fake.options.refreshError) {
          json(400, { error: fake.options.refreshError });
          return;
        }
        const token = params.get('refresh_token') ?? '';
        if (!refreshTokens.has(token)) {
          json(400, { error: 'invalid_grant' });
          return;
        }
        refreshTokens.delete(token);
        // Validated before the hold: models a refresh the server has already
        // accepted when a revoke arrives.
        if (fake.options.refreshHold) {
          await fake.options.refreshHold;
        }
        json(200, issueTokens());
        return;
      }
      json(400, { error: 'unsupported_grant_type' });
      return;
    }
    if (url.pathname === '/revoke' && req.method === 'POST') {
      // Read in the turn that records the request, so clearing the option
      // once the request is seen does not release it.
      const hold = fake.options.revokeHold;
      if (hold) {
        await hold;
      }
      const token = params.get('token');
      if (token) {
        revoked.push(token);
        validAccessTokens.delete(token);
        refreshTokens.delete(token);
      }
      res.writeHead(200).end();
      return;
    }
    res.writeHead(404).end();
  });
  fake.base = await listen(server);
  fake.close = () => closeServer(server);
  return fake;
}

export async function startFakeResourceServer(authorizationServers: string[]): Promise<FakeResourceServer> {
  const requests: RecordedRequest[] = [];
  const fake: FakeResourceServer = {
    base: '',
    mcpUrl: '',
    requests,
    authorizationServers,
    acceptedTokens: () => new Set<string>(),
    close: async () => undefined,
  };
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', fake.base);
    const body = await readBody(req);
    const record = { method: req.method ?? 'GET', path: url.pathname, headers: req.headers, body, params: url.searchParams };
    requests.push(record);
    if (url.pathname.startsWith('/.well-known/oauth-protected-resource')) {
      res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({
        resource: fake.prmResource ?? fake.mcpUrl,
        authorization_servers: fake.authorizationServers,
      }));
      return;
    }
    if (url.pathname === '/mcp') {
      if (fake.onMcp?.(record, res)) {
        return;
      }
      const auth = req.headers.authorization ?? '';
      const token = auth.replace(/^Bearer\s+/i, '');
      if (!fake.acceptedTokens().has(token)) {
        res.writeHead(401, {
          'WWW-Authenticate': `Bearer resource_metadata="${fake.base}/.well-known/oauth-protected-resource/mcp"`,
        }).end();
        return;
      }
      if (req.method === 'POST') {
        const message = JSON.parse(body || '{}');
        if (message.id === undefined) {
          res.writeHead(202).end();
          return;
        }
        const result = message.method === 'initialize'
          ? { protocolVersion: '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'fake', version: '1.0.0' } }
          : message.method === 'tools/list'
            ? { tools: [{ name: 'echo', inputSchema: { type: 'object' } }] }
            : {};
        res.writeHead(200, { 'Content-Type': 'application/json', 'mcp-session-id': 'upstream-session' })
          .end(JSON.stringify({ jsonrpc: '2.0', id: message.id, result }));
        return;
      }
      if (req.method === 'GET') {
        res.writeHead(405).end();
        return;
      }
      if (req.method === 'DELETE') {
        res.writeHead(200).end();
        return;
      }
    }
    res.writeHead(404).end();
  });
  fake.base = await listen(server);
  fake.mcpUrl = `${fake.base}/mcp`;
  fake.close = () => closeServer(server);
  return fake;
}

/** A browser that follows the authorization server's redirect to the callback. */
export function fakeBrowser(): { openExternal: (url: string) => Promise<void>; opened: string[] } {
  const opened: string[] = [];
  return {
    opened,
    openExternal: async (authorizationUrl: string) => {
      opened.push(authorizationUrl);
      // Fire and forget, like a real browser.
      void (async () => {
        const first = await fetch(authorizationUrl, { redirect: 'manual' });
        const location = first.headers.get('location');
        if (location) {
          await fetch(location).catch(() => undefined);
        }
      })().catch(() => undefined);
    },
  };
}
