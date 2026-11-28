// @vitest-environment node
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { MCPRemoteConfigDescriptor } from '../../MCPRemoteOAuth';
import { McpOAuthCredentialStore, type SecretCodec } from '../credentialStore';
import { McpOAuthManager } from '../McpOAuthManager';
import {
  fakeBrowser,
  startFakeAuthorizationServer,
  startFakeResourceServer,
  type FakeAuthorizationServer,
  type FakeResourceServer,
} from './fakeOAuthServers';

const codec: SecretCodec = {
  isEncryptionAvailable: () => true,
  encryptString: (plain) => Buffer.from(`ENC:${Buffer.from(plain).toString('base64')}`),
  decryptString: (encrypted) => Buffer.from(encrypted.toString().slice(4), 'base64').toString(),
};

let tempRoot: string;
let as1: FakeAuthorizationServer;
let rs: FakeResourceServer;

function descriptorFor(serverUrl: string, extra: Partial<MCPRemoteConfigDescriptor> = {}): MCPRemoteConfigDescriptor {
  return { serverUrl, headers: {}, requiresOAuth: true, callbackPort: 0, ...extra };
}

function createManager(overrides: { openExternal?: (url: string) => Promise<void>; now?: () => number } = {}) {
  const store = new McpOAuthCredentialStore(path.join(tempRoot, 'store'), codec);
  const browser = fakeBrowser();
  const manager = new McpOAuthManager({
    store,
    openExternal: overrides.openExternal ?? browser.openExternal,
    legacyAuthDir: () => path.join(tempRoot, 'mcp-auth'),
    platform: 'darwin',
    now: overrides.now,
  });
  return { manager, store, browser };
}

beforeEach(async () => {
  tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'nim-mcp-oauth-'));
  as1 = await startFakeAuthorizationServer();
  rs = await startFakeResourceServer([as1.base]);
  rs.acceptedTokens = () => as1.validAccessTokens;
});

afterEach(async () => {
  await rs.close();
  await as1.close();
  fs.rmSync(tempRoot, { recursive: true, force: true });
});

describe('McpOAuthManager sign-in', () => {
  it('signs in with dynamic registration and pins the issuer on everything it stores', async () => {
    const { manager, browser } = createManager();
    const descriptor = descriptorFor(rs.mcpUrl);

    const result = await manager.authorize(descriptor, { timeoutMs: 5000 });

    expect(result).toEqual({ ok: true });
    expect(browser.opened).toHaveLength(1);
    const authorizeUrl = new URL(browser.opened[0]);
    expect(authorizeUrl.searchParams.get('code_challenge_method')).toBe('S256');
    expect(new URL(authorizeUrl.searchParams.get('redirect_uri')!).pathname).toBe('/oauth/callback');

    const status = await manager.getStatus(descriptor);
    expect(status.state).toBe('authorized');
    if (status.state !== 'authorized') return;
    expect(status.binding.issuer).toBe(`${as1.base}/`);
    expect(status.binding.tokens?.issuer).toBe(status.binding.issuer);
    expect(status.binding.client.issuer).toBe(status.binding.issuer);
    expect(status.binding.asMetadata.token_endpoint).toBe(`${as1.base}/token`);

    const token = await manager.getAccessToken(manager.bindingKeyFor(descriptor));
    expect(token.ok && as1.validAccessTokens.has(token.accessToken)).toBe(true);
  });
});

async function signIn(descriptor: MCPRemoteConfigDescriptor, managerBundle = createManager()) {
  const result = await managerBundle.manager.authorize(descriptor, { timeoutMs: 5000 });
  expect(result).toEqual({ ok: true });
  return managerBundle;
}

function writeLegacy(dir: string, hash: string, tokens: Record<string, unknown>, client?: Record<string, unknown>) {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `${hash}_tokens.json`), JSON.stringify(tokens));
  if (client) {
    fs.writeFileSync(path.join(dir, `${hash}_client_info.json`), JSON.stringify(client));
  }
}

describe('McpOAuthManager negative security regressions', () => {
  let as2: FakeAuthorizationServer;

  beforeEach(async () => {
    as2 = await startFakeAuthorizationServer();
  });

  afterEach(async () => {
    await as2.close();
  });

  it('N1: a resource server that switches authorization servers never receives the refresh token at the new one', async () => {
    const descriptor = descriptorFor(rs.mcpUrl);
    const { manager } = await signIn(descriptor);
    const key = manager.bindingKeyFor(descriptor);
    const first = await manager.getAccessToken(key);
    if (!first.ok) throw new Error('expected token');

    rs.authorizationServers = [as2.base];
    const refreshed = await manager.getAccessToken(key, { rejectedToken: first.accessToken });
    expect(refreshed.ok).toBe(true);
    expect(as1.tokenRequests().filter((r) => r.params.get('grant_type') === 'refresh_token')).toHaveLength(1);

    if (!refreshed.ok) throw new Error('expected token');
    await manager.reportPersistentUnauthorized(
      key,
      `Bearer resource_metadata="${rs.base}/.well-known/oauth-protected-resource/mcp"`,
      refreshed.accessToken,
    );
    const status = await manager.getStatus(descriptor);
    expect(status).toEqual({ state: 'needs_reauthorization', reason: 'authorization_server_changed' });
    expect(as2.requests).toHaveLength(0);
  });

  it('N2: a token endpoint changed in metadata after sign-in is never used for refresh', async () => {
    const descriptor = descriptorFor(rs.mcpUrl);
    const { manager } = await signIn(descriptor);
    as1.metadata.token_endpoint = `${as2.base}/token`;
    const key = manager.bindingKeyFor(descriptor);
    const first = await manager.getAccessToken(key);
    if (!first.ok) throw new Error('expected token');

    const refreshed = await manager.getAccessToken(key, { rejectedToken: first.accessToken });

    expect(refreshed.ok).toBe(true);
    expect(as2.requests).toHaveLength(0);
  });

  it('N3: metadata naming a different issuer stops sign-in before registration', async () => {
    as1.metadata.issuer = 'https://elsewhere.example';
    const { manager, browser } = createManager();

    const result = await manager.authorize(descriptorFor(rs.mcpUrl), { timeoutMs: 5000 });

    expect(result).toMatchObject({ ok: false, errorType: 'issuer_mismatch' });
    expect(as1.requests.filter((r) => r.path === '/register')).toHaveLength(0);
    expect(browser.opened).toHaveLength(0);
  });

  it('N4: protected-resource metadata for another origin or a sibling path is refused', async () => {
    for (const resource of [`${as2.base}/mcp`, `${rs.base}/other`]) {
      rs.prmResource = resource;
      const { manager } = createManager();
      const result = await manager.authorize(descriptorFor(rs.mcpUrl), { timeoutMs: 5000 });
      expect(result).toMatchObject({ ok: false, errorType: 'resource_mismatch' });
    }
    expect(as1.requests.filter((r) => r.path === '/register' || r.path === '/token')).toHaveLength(0);
  });

  it('N5: a cross-origin 307 from the token endpoint does not carry the refresh token to the target', async () => {
    as1.options.clientSecret = 'dynamic-secret';
    const descriptor = descriptorFor(rs.mcpUrl);
    const { manager } = await signIn(descriptor);
    as1.options.tokenEndpointRedirect = `${as2.base}/token`;
    const key = manager.bindingKeyFor(descriptor);
    const first = await manager.getAccessToken(key);
    if (!first.ok) throw new Error('expected token');

    const refreshed = await manager.getAccessToken(key, { rejectedToken: first.accessToken });

    expect(refreshed.ok).toBe(false);
    expect(as2.requests).toHaveLength(0);
  });

  it('N7: stray, stateless, wrong-state, wrong-path and POST callbacks do not complete or end the flow', async () => {
    const strayStatuses: number[] = [];
    const browser = fakeBrowser();
    const { manager } = createManager({
      openExternal: async (url) => {
        const redirect = new URL(new URL(url).searchParams.get('redirect_uri')!);
        const attempt = async (target: URL, init?: RequestInit) => {
          const response = await fetch(target, init);
          strayStatuses.push(response.status);
        };
        const wrongState = new URL(redirect); wrongState.searchParams.set('code', 'x'); wrongState.searchParams.set('state', 'nope');
        const noState = new URL(redirect); noState.searchParams.set('code', 'x');
        const wrongPath = new URL(redirect); wrongPath.pathname = '/other'; wrongPath.searchParams.set('state', new URL(url).searchParams.get('state')!);
        const post = new URL(redirect); post.searchParams.set('state', new URL(url).searchParams.get('state')!); post.searchParams.set('code', 'x');
        await attempt(wrongState);
        await attempt(noState);
        await attempt(wrongPath);
        await attempt(post, { method: 'POST' });
        await browser.openExternal(url);
      },
    });

    const result = await manager.authorize(descriptorFor(rs.mcpUrl), { timeoutMs: 5000 });

    expect(result).toEqual({ ok: true });
    expect(strayStatuses).toEqual([400, 400, 404, 404]);
    expect(as1.tokenRequests()).toHaveLength(1);
  });

  it('N8: when the server advertises RFC 9207, a missing or foreign iss is rejected before any token request', async () => {
    as1.metadata.authorization_response_iss_parameter_supported = true;
    for (const sendIss of [false, as2.base]) {
      as1.options.sendIss = sendIss;
      const { manager } = createManager();
      const result = await manager.authorize(descriptorFor(rs.mcpUrl), { timeoutMs: 5000 });
      expect(result).toMatchObject({ ok: false, errorType: 'callback_validation' });
    }
    expect(as1.tokenRequests()).toHaveLength(0);

    as1.options.sendIss = true;
    const { manager } = createManager();
    expect(await manager.authorize(descriptorFor(rs.mcpUrl), { timeoutMs: 5000 })).toEqual({ ok: true });
  });

  it('N9: a second sign-in cancels the first, which never sends its verifier', async () => {
    let releaseFirst: () => void = () => undefined;
    let firstAtBrowser: () => void = () => undefined;
    const firstReachedBrowser = new Promise<void>((resolve) => { firstAtBrowser = resolve; });
    const browser = fakeBrowser();
    let calls = 0;
    const { manager } = createManager({
      openExternal: async (url) => {
        calls += 1;
        if (calls === 1) {
          // The user never finishes the first flow.
          firstAtBrowser();
          await new Promise<void>((resolve) => { releaseFirst = resolve; });
          return;
        }
        await browser.openExternal(url);
      },
    });
    const descriptor = descriptorFor(rs.mcpUrl);
    const first = manager.authorize(descriptor, { timeoutMs: 5000 });
    // Start the second sign-in only once the first is waiting in the browser.
    // A fixed sleep let a slow first flow be cancelled during discovery, so
    // the second flow took the parked browser and the test hung. A first flow
    // that ends before the browser fails here, on its own result.
    expect(await Promise.race([firstReachedBrowser.then(() => 'at browser'), first])).toBe('at browser');
    const second = manager.authorize(descriptor, { timeoutMs: 5000 });
    releaseFirst();

    expect(await first).toMatchObject({ ok: false, errorType: 'cancelled' });
    expect(await second).toEqual({ ok: true });
    expect(as1.tokenRequests()).toHaveLength(1);
  });

  it('N9b: a second sign-in during the first one\'s discovery cancels it before it registers or opens a browser', async () => {
    let firstInDiscovery: () => void = () => undefined;
    const reachedDiscovery = new Promise<void>((resolve) => { firstInDiscovery = resolve; });
    let releaseDiscovery: () => void = () => undefined;
    const discoveryGate = new Promise<void>((resolve) => { releaseDiscovery = resolve; });
    let held = false;
    // The first request any sign-in makes is discovery's credential-free probe.
    const fetchFn = async (input: string | URL, init?: RequestInit) => {
      if (!held) {
        held = true;
        firstInDiscovery();
        await discoveryGate;
      }
      return fetch(input, init);
    };
    const browser = fakeBrowser();
    const store = new McpOAuthCredentialStore(path.join(tempRoot, 'store'), codec);
    const manager = new McpOAuthManager({ store, fetchFn, openExternal: browser.openExternal, legacyAuthDir: () => tempRoot, platform: 'darwin' });
    const descriptor = descriptorFor(rs.mcpUrl);

    const first = manager.authorize(descriptor, { timeoutMs: 5000 });
    expect(await Promise.race([reachedDiscovery.then(() => 'in discovery'), first])).toBe('in discovery');
    const second = manager.authorize(descriptor, { timeoutMs: 5000 });
    releaseDiscovery();

    expect(await first).toMatchObject({ ok: false, errorType: 'cancelled' });
    expect(await second).toEqual({ ok: true });
    expect(browser.opened).toHaveLength(1);
    expect(as1.requests.filter((r) => r.path === '/register')).toHaveLength(1);
    expect(as1.tokenRequests()).toHaveLength(1);
  });

  it('N11: a refresh the provider refuses marks the server for re-authorization and opens no browser', async () => {
    const descriptor = descriptorFor(rs.mcpUrl);
    const opened: string[] = [];
    const browser = fakeBrowser();
    const bundle = createManager({ openExternal: async (url) => { opened.push(url); await browser.openExternal(url); } });
    await signIn(descriptor, bundle);
    opened.length = 0;
    as1.options.refreshError = 'invalid_grant';
    const key = bundle.manager.bindingKeyFor(descriptor);
    const first = await bundle.manager.getAccessToken(key);
    if (!first.ok) throw new Error('expected token');

    const refreshed = await bundle.manager.getAccessToken(key, { rejectedToken: first.accessToken });

    expect(refreshed).toEqual({ ok: false, errorType: 'token_exchange' });
    expect(opened).toHaveLength(0);
    expect(await bundle.manager.getStatus(descriptor)).toEqual({ state: 'needs_reauthorization', reason: 'token_exchange' });
  });

  it('N12: an https server whose metadata points at plain http endpoints is refused with nothing posted', async () => {
    const posted: string[] = [];
    const fetchFn = async (input: string | URL, init?: RequestInit) => {
      const url = String(input);
      if (init?.method === 'POST') posted.push(url);
      if (url.startsWith('https://mcp.example.com/.well-known/oauth-protected-resource')) {
        return new Response(JSON.stringify({ resource: 'https://mcp.example.com/mcp', authorization_servers: ['http://auth.example.com'] }), {
          status: 200, headers: { 'Content-Type': 'application/json' },
        });
      }
      return new Response('', { status: 404 });
    };
    const store = new McpOAuthCredentialStore(path.join(tempRoot, 'store'), codec);
    const manager = new McpOAuthManager({ store, fetchFn, openExternal: async () => undefined, legacyAuthDir: () => tempRoot, platform: 'darwin' });

    const result = await manager.authorize(descriptorFor('https://mcp.example.com/mcp'), { timeoutMs: 1000 });

    expect(result).toMatchObject({ ok: false, errorType: 'insecure_endpoint' });
    // Only the credential-free challenge probe to the configured server itself.
    expect(posted.filter((url) => url !== 'https://mcp.example.com/mcp')).toHaveLength(0);
  });

  it('N14: legacy credentials stamped for a different issuer are not imported or used', async () => {
    const descriptor = descriptorFor(rs.mcpUrl);
    const { getMcpRemoteServerHashes } = await import('../serverIdentity');
    const hash = getMcpRemoteServerHashes(descriptor)[0];
    as1.refreshTokens.add('legacy-refresh');
    writeLegacy(path.join(tempRoot, 'mcp-auth', 'mcp-remote-v1'), hash,
      { access_token: 'legacy-access', refresh_token: 'legacy-refresh', issuer: `${as2.base}/` },
      { client_id: 'legacy-client', redirect_uris: ['http://localhost:4444/oauth/callback'], issuer: `${as2.base}/` });
    const { manager } = createManager();

    expect(await manager.getStatus(descriptor)).toEqual({ state: 'unauthorized' });
    expect(as1.tokenRequests()).toHaveLength(0);
    expect(as2.requests).toHaveLength(0);
  });

  it('imports matching legacy credentials once, read-only, and refreshes only at the discovered issuer', async () => {
    const descriptor = descriptorFor(rs.mcpUrl);
    const { getMcpRemoteServerHashes } = await import('../serverIdentity');
    const hash = getMcpRemoteServerHashes(descriptor)[0];
    as1.refreshTokens.add('legacy-refresh');
    const legacyDir = path.join(tempRoot, 'mcp-auth', 'mcp-remote-v1');
    writeLegacy(legacyDir, hash,
      { access_token: 'legacy-access', refresh_token: 'legacy-refresh' },
      { client_id: 'legacy-client', redirect_uris: ['http://localhost:4444/oauth/callback'] });
    const before = fs.readFileSync(path.join(legacyDir, `${hash}_tokens.json`));
    const { manager } = createManager();

    const status = await manager.getStatus(descriptor);
    expect(status.state).toBe('authorized');
    const token = await manager.getAccessToken(manager.bindingKeyFor(descriptor));

    expect(token.ok).toBe(true);
    const refreshes = as1.tokenRequests().filter((r) => r.params.get('grant_type') === 'refresh_token');
    expect(refreshes.map((r) => r.params.get('refresh_token'))).toEqual(['legacy-refresh']);
    expect(fs.readFileSync(path.join(legacyDir, `${hash}_tokens.json`))).toEqual(before);
  });

  it('N15: a pre-registered client sends exactly its registered redirect URI on authorize and exchange', async () => {
    const port = await freePort();
    const redirectUri = `http://127.0.0.1:${port}/custom/callback`;
    const { manager } = createManager();

    const result = await manager.authorize(
      descriptorFor(rs.mcpUrl, { staticOAuthClientInfo: { client_id: 'static-1' }, redirectUri }),
      { timeoutMs: 5000 },
    );

    expect(result).toEqual({ ok: true });
    expect(as1.requests.filter((r) => r.path === '/register')).toHaveLength(0);
    const authorize = as1.requests.find((r) => r.path === '/authorize')!;
    expect(authorize.params.get('redirect_uri')).toBe(redirectUri);
    expect(authorize.params.get('client_id')).toBe('static-1');
    expect(as1.tokenRequests()[0].params.get('redirect_uri')).toBe(redirectUri);
  });

  it('N19: a pre-registered client whose port is busy fails with port_conflict instead of changing its URI', async () => {
    const blocker = await occupyPort();
    try {
      const { manager, browser } = createManager();
      const result = await manager.authorize(
        descriptorFor(rs.mcpUrl, { staticOAuthClientInfo: { client_id: 'static-1' }, callbackPort: blocker.port }),
        { timeoutMs: 5000 },
      );
      expect(result).toMatchObject({ ok: false, errorType: 'port_conflict' });
      expect(browser.opened).toHaveLength(0);
    } finally {
      blocker.close();
    }
  });

  it('N19: a dynamic client whose port is busy is re-registered on a free port', async () => {
    const blocker = await occupyPort();
    try {
      const { manager } = createManager();
      const result = await manager.authorize(descriptorFor(rs.mcpUrl, { callbackPort: blocker.port }), { timeoutMs: 5000 });
      expect(result).toEqual({ ok: true });
      const registered = JSON.parse(as1.requests.find((r) => r.path === '/register')!.body);
      expect(new URL(registered.redirect_uris[0]).port).not.toBe(String(blocker.port));
    } finally {
      blocker.close();
    }
  });

  it('N17: a refresh that lands after revoke is discarded and its new tokens are revoked too', async () => {
    const descriptor = descriptorFor(rs.mcpUrl);
    const { manager } = await signIn(descriptor);
    const key = manager.bindingKeyFor(descriptor);
    const first = await manager.getAccessToken(key);
    if (!first.ok) throw new Error('expected token');
    let releaseRefresh: () => void = () => undefined;
    as1.options.refreshHold = new Promise<void>((resolve) => { releaseRefresh = resolve; });

    const pending = manager.getAccessToken(key, { rejectedToken: first.accessToken });
    // Revoke once the server has accepted the refresh, and answer the refresh
    // only after the revoke is done, so it always lands after the revoke.
    expect(await Promise.race([refreshAccepted(as1).then(() => 'held'), pending])).toBe('held');
    const revoking = manager.revoke(descriptor);
    // If the wait below fails, a revoke still running after cleanup must not
    // add unhandled errors to that failure; `await revoking` still throws.
    revoking.catch(() => undefined);
    await revocationReached(as1);
    const revoked = await revoking;
    releaseRefresh();
    const late = await pending;

    expect(revoked).toMatchObject({ success: true, provider: 'revoked' });
    expect(late.ok).toBe(false);
    expect(await manager.getAccessToken(key)).toEqual({ ok: false, errorType: 'unauthorized' });
    // Both the original and the late refresh's tokens were revoked.
    const lateRefresh = as1.tokenRequests().filter((r) => r.params.get('grant_type') === 'refresh_token');
    expect(lateRefresh).toHaveLength(1);
    expect(as1.revoked.length).toBeGreaterThanOrEqual(4);
    expect(as1.validAccessTokens.size).toBe(0);
  });

  it('N17b: revoke ends local access before it asks the provider, so a refresh landing during that request is discarded', async () => {
    const descriptor = descriptorFor(rs.mcpUrl);
    const { manager } = await signIn(descriptor);
    const key = manager.bindingKeyFor(descriptor);
    const first = await manager.getAccessToken(key);
    if (!first.ok) throw new Error('expected token');
    let releaseRefresh: () => void = () => undefined;
    as1.options.refreshHold = new Promise<void>((resolve) => { releaseRefresh = resolve; });
    let releaseRevoke: () => void = () => undefined;

    const pending = manager.getAccessToken(key, { rejectedToken: first.accessToken });
    expect(await Promise.race([refreshAccepted(as1).then(() => 'held'), pending])).toBe('held');
    as1.options.revokeHold = new Promise<void>((resolve) => { releaseRevoke = resolve; });
    const revoking = manager.revoke(descriptor);
    revoking.catch(() => undefined);
    await revocationReached(as1);
    // The provider holds revoke()'s first request, and only that one. The
    // refresh lands now, while revoke() still waits for the provider.
    as1.options.revokeHold = undefined;
    releaseRefresh();
    const late = await pending;
    releaseRevoke();
    const revoked = await revoking;

    expect(late).toEqual({ ok: false, errorType: 'unauthorized' });
    expect(revoked).toMatchObject({ success: true, provider: 'revoked' });
    expect(await manager.getAccessToken(key)).toEqual({ ok: false, errorType: 'unauthorized' });
    expect(as1.revoked.length).toBeGreaterThanOrEqual(4);
    expect(as1.validAccessTokens.size).toBe(0);
  });

  it('N18: after revoke against a provider without revocation, a restart neither re-imports nor refreshes', async () => {
    delete as1.metadata.revocation_endpoint;
    as1.metadata.revocation_endpoint = undefined;
    const descriptor = descriptorFor(rs.mcpUrl);
    const { getMcpRemoteServerHashes } = await import('../serverIdentity');
    const hash = getMcpRemoteServerHashes(descriptor)[0];
    as1.refreshTokens.add('legacy-refresh');
    writeLegacy(path.join(tempRoot, 'mcp-auth', 'mcp-remote-v1'), hash,
      { access_token: 'legacy-access', refresh_token: 'legacy-refresh' },
      { client_id: 'legacy-client', redirect_uris: ['http://localhost:4444/oauth/callback'] });
    const first = createManager();
    expect((await first.manager.getStatus(descriptor)).state).toBe('authorized');
    expect(await first.manager.revoke(descriptor)).toMatchObject({ success: true, provider: 'unsupported' });
    const tokenRequestsAfterRevoke = as1.tokenRequests().length;

    const restarted = createManager();
    expect(await restarted.manager.getStatus(descriptor)).toEqual({ state: 'unauthorized' });
    await restarted.store.pruneRevokedBackups(Date.now() + 8 * 24 * 60 * 60 * 1000);
    const afterExpiry = createManager();
    expect(await afterExpiry.manager.getStatus(descriptor)).toEqual({ state: 'unauthorized' });
    expect(as1.tokenRequests()).toHaveLength(tokenRequestsAfterRevoke);
    expect(fs.readdirSync(path.join(tempRoot, 'store')).some((name) => name.includes('.revoked-'))).toBe(false);

    // An explicit sign-in still works after a revoke.
    expect(await afterExpiry.manager.authorize(descriptor, { timeoutMs: 5000 })).toEqual({ ok: true });
  });
});

/** Resolves once `server` has accepted a refresh grant, which `refreshHold` then holds. */
function refreshAccepted(server: FakeAuthorizationServer): Promise<void> {
  return vi.waitFor(() => {
    expect(server.tokenRequests().some((r) => r.params.get('grant_type') === 'refresh_token')).toBe(true);
  }, { timeout: 10_000, interval: 5 });
}

/**
 * Resolves once `server` has a revocation request. revoke() sends it while a
 * refresh is still held, so a revoke that waits for that refresh, and would
 * never finish, fails here by name rather than at the test timeout.
 */
function revocationReached(server: FakeAuthorizationServer): Promise<void> {
  return vi.waitFor(() => {
    expect(server.requests.some((r) => r.path === '/revoke'), 'revoke() asks the provider without waiting for the refresh in flight').toBe(true);
  }, { timeout: 5_000, interval: 5 });
}

async function freePort(): Promise<number> {
  const blocker = await occupyPort();
  blocker.close();
  return blocker.port;
}

async function occupyPort(): Promise<{ port: number; close: () => void }> {
  const net = await import('net');
  return new Promise((resolve) => {
    const server = net.createServer();
    server.listen(0, '127.0.0.1', () => {
      const port = (server.address() as { port: number }).port;
      resolve({ port, close: () => server.close() });
    });
  });
}

describe('McpOAuthManager review follow-ups', () => {
  let as2: FakeAuthorizationServer;

  beforeEach(async () => {
    as2 = await startFakeAuthorizationServer();
  });

  afterEach(async () => {
    await as2.close();
  });

  const legacyDir = () => path.join(tempRoot, 'mcp-auth', 'mcp-remote-v1');
  const legacyHash = async (descriptor: MCPRemoteConfigDescriptor) =>
    (await import('../serverIdentity')).getMcpRemoteServerHashes(descriptor)[0];

  it('does not import legacy tokens for a static client when the legacy client names another issuer', async () => {
    const descriptor = descriptorFor(rs.mcpUrl, { staticOAuthClientInfo: { client_id: 'static-1' } });
    as2.refreshTokens.add('legacy-refresh');
    writeLegacy(legacyDir(), await legacyHash(descriptor),
      { access_token: 'legacy-access', refresh_token: 'legacy-refresh' },
      { client_id: 'static-1', redirect_uris: ['http://localhost:4444/oauth/callback'], issuer: `${as2.base}/` });
    const { manager } = createManager();

    expect((await manager.getStatus(descriptor)).state).toBe('unauthorized');
    const token = await manager.getAccessToken(manager.bindingKeyFor(descriptor));
    expect(token.ok).toBe(false);
    expect(as1.tokenRequests()).toHaveLength(0);
  });

  it('a 401 for a token from before a re-sign-in does not clear the new sign-in', async () => {
    const descriptor = descriptorFor(rs.mcpUrl);
    const bundle = createManager();
    await signIn(descriptor, bundle);
    const key = bundle.manager.bindingKeyFor(descriptor);
    const old = await bundle.manager.getAccessToken(key);
    if (!old.ok) throw new Error('expected token');
    await signIn(descriptor, bundle);

    await bundle.manager.reportPersistentUnauthorized(key, null, old.accessToken);

    const current = await bundle.manager.getAccessToken(key);
    expect(current.ok && current.accessToken !== old.accessToken).toBe(true);
    expect((await bundle.manager.getStatus(descriptor)).state).toBe('authorized');
  });

  it('a sign-in superseded while its code exchange is in flight does not overwrite the newer one, and its tokens are revoked', async () => {
    let releaseFirstExchange: () => void = () => undefined;
    let firstExchangeStarted: () => void = () => undefined;
    const started = new Promise<void>((resolve) => { firstExchangeStarted = resolve; });
    const gate = new Promise<void>((resolve) => { releaseFirstExchange = resolve; });
    let exchanges = 0;
    const fetchFn = async (input: string | URL, init?: RequestInit) => {
      const url = new URL(String(input));
      if (url.pathname === '/token' && String(init?.body ?? '').includes('authorization_code')) {
        exchanges += 1;
        if (exchanges === 1) {
          firstExchangeStarted();
          await gate;
        }
      }
      return fetch(input, init);
    };
    const browser = fakeBrowser();
    const store = new McpOAuthCredentialStore(path.join(tempRoot, 'store'), codec);
    const manager = new McpOAuthManager({ store, fetchFn, openExternal: browser.openExternal, legacyAuthDir: () => tempRoot, platform: 'darwin' });
    const descriptor = descriptorFor(rs.mcpUrl);

    const first = manager.authorize(descriptor, { timeoutMs: 5000 });
    await started;
    const second = await manager.authorize(descriptor, { timeoutMs: 5000 });
    releaseFirstExchange();

    expect(second).toEqual({ ok: true });
    expect(await first).toMatchObject({ ok: false, errorType: 'cancelled' });
    const current = await manager.getAccessToken(manager.bindingKeyFor(descriptor));
    if (!current.ok) throw new Error('expected token');
    // Exactly one of the two issued access tokens survives, the newer one.
    const revoked = new Set(as1.revoked);
    expect(revoked.has(current.accessToken)).toBe(false);
    expect(as1.revoked.length).toBeGreaterThan(0);
  });

  it('finds protected-resource metadata named only in the server\'s 401 challenge', async () => {
    const fetchFn = async (input: string | URL, init?: RequestInit) => {
      const url = new URL(String(input));
      // No well-known documents at the conventional locations.
      if (url.origin === rs.base && (url.pathname === '/.well-known/oauth-protected-resource/mcp' || url.pathname === '/.well-known/oauth-protected-resource')) {
        return new Response('', { status: 404 });
      }
      return fetch(input, init);
    };
    rs.onMcp = (req, res) => {
      if (!req.headers.authorization) {
        res.writeHead(401, { 'WWW-Authenticate': `Bearer resource_metadata="${rs.base}/.well-known/oauth-protected-resource/custom"` }).end();
        return true;
      }
      return false;
    };
    const browser = fakeBrowser();
    const store = new McpOAuthCredentialStore(path.join(tempRoot, 'store'), codec);
    const manager = new McpOAuthManager({ store, fetchFn, openExternal: browser.openExternal, legacyAuthDir: () => tempRoot, platform: 'darwin' });

    expect(await manager.authorize(descriptorFor(rs.mcpUrl), { timeoutMs: 5000 })).toEqual({ ok: true });
  });

  it('never fetches a resource_metadata URL on another origin from the background 401 path', async () => {
    const descriptor = descriptorFor(rs.mcpUrl);
    const { manager } = await signIn(descriptor);
    const key = manager.bindingKeyFor(descriptor);
    const token = await manager.getAccessToken(key);
    if (!token.ok) throw new Error('expected token');

    await manager.reportPersistentUnauthorized(key, `Bearer resource_metadata="${as2.base}/.well-known/oauth-protected-resource"`, token.accessToken);

    expect(as2.requests).toHaveLength(0);
    expect(await manager.getStatus(descriptor)).toEqual({ state: 'needs_reauthorization', reason: 'token_exchange' });
  });

  it('refuses discovery that sends a public server\'s sign-in to a loopback address, before any request reaches it', async () => {
    const fetchFn = async (input: string | URL, init?: RequestInit) => {
      const url = new URL(String(input));
      if (url.hostname === 'mcp.example.com') {
        if (url.pathname.startsWith('/.well-known/oauth-protected-resource')) {
          return new Response(JSON.stringify({ resource: 'http://mcp.example.com/mcp', authorization_servers: [as2.base] }), {
            status: 200, headers: { 'Content-Type': 'application/json' },
          });
        }
        return new Response('', { status: 404 });
      }
      return fetch(input, init);
    };
    const store = new McpOAuthCredentialStore(path.join(tempRoot, 'store'), codec);
    const manager = new McpOAuthManager({ store, fetchFn, openExternal: async () => undefined, legacyAuthDir: () => tempRoot, platform: 'darwin' });

    const result = await manager.authorize(descriptorFor('http://mcp.example.com/mcp'), { timeoutMs: 2000 });

    expect(result).toMatchObject({ ok: false, errorType: 'insecure_endpoint' });
    expect(as2.requests).toHaveLength(0);
  });

  it('fails discovery when a metadata body breaks mid-read instead of falling back to default endpoints', async () => {
    const fetchFn = async (input: string | URL, init?: RequestInit) => {
      const url = new URL(String(input));
      if (url.origin === rs.base && url.pathname.startsWith('/.well-known/oauth-protected-resource')) {
        const body = new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(new TextEncoder().encode('{"resource":'));
            controller.error(new Error('connection reset'));
          },
        });
        return new Response(body, { status: 200, headers: { 'Content-Type': 'application/json' } });
      }
      return fetch(input, init);
    };
    const store = new McpOAuthCredentialStore(path.join(tempRoot, 'store'), codec);
    const manager = new McpOAuthManager({ store, fetchFn, openExternal: async () => undefined, legacyAuthDir: () => tempRoot, platform: 'darwin' });

    const result = await manager.authorize(descriptorFor(rs.mcpUrl), { timeoutMs: 2000 });

    expect(result).toMatchObject({ ok: false, errorType: 'network' });
    expect(rs.requests.filter((r) => r.method === 'POST' && r.path !== '/mcp')).toHaveLength(0);
    expect(as1.requests.filter((r) => r.method === 'POST')).toHaveLength(0);
  });

  it('retries the legacy import after a failed attempt instead of hiding the sign-in until restart', async () => {
    const descriptor = descriptorFor(rs.mcpUrl);
    as1.refreshTokens.add('legacy-refresh');
    as1.validAccessTokens.add('legacy-access');
    writeLegacy(legacyDir(), await legacyHash(descriptor),
      { access_token: 'legacy-access', refresh_token: 'legacy-refresh', expires_in: 3600 },
      { client_id: 'legacy-client', redirect_uris: ['http://localhost:4444/oauth/callback'] });
    let offline = true;
    const fetchFn = async (input: string | URL, init?: RequestInit) => {
      if (offline) throw new TypeError('fetch failed');
      return fetch(input, init);
    };
    const store = new McpOAuthCredentialStore(path.join(tempRoot, 'store'), codec);
    const manager = new McpOAuthManager({ store, fetchFn, openExternal: async () => undefined, legacyAuthDir: () => path.join(tempRoot, 'mcp-auth'), platform: 'darwin' });

    expect((await manager.getStatus(descriptor)).state).toBe('unauthorized');
    offline = false;
    expect((await manager.getStatus(descriptor)).state).toBe('authorized');
  });

  it('keeps an imported access token that has no refresh token and no known expiry', async () => {
    const descriptor = descriptorFor(rs.mcpUrl);
    as1.validAccessTokens.add('legacy-access-only');
    writeLegacy(legacyDir(), await legacyHash(descriptor),
      { access_token: 'legacy-access-only' },
      { client_id: 'legacy-client', redirect_uris: ['http://localhost:4444/oauth/callback'] });
    const { manager } = createManager();

    expect((await manager.getStatus(descriptor)).state).toBe('authorized');
    expect(await manager.getAccessToken(manager.bindingKeyFor(descriptor))).toEqual({ ok: true, accessToken: 'legacy-access-only' });
  });

  it('gives up on an OAuth request that never answers', async () => {
    const hang = (_input: string | URL, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => reject(new TypeError('aborted')));
    });
    const store = new McpOAuthCredentialStore(path.join(tempRoot, 'store'), codec);
    const manager = new McpOAuthManager({ store, fetchFn: hang, openExternal: async () => undefined, legacyAuthDir: () => tempRoot, platform: 'darwin', requestTimeoutMs: 50 });

    const result = await manager.authorize(descriptorFor(rs.mcpUrl), { timeoutMs: 60_000 });

    expect(result).toMatchObject({ ok: false, errorType: 'network' });
  });

  it('moves an undecryptable record aside instead of overwriting it', async () => {
    const descriptor = descriptorFor(rs.mcpUrl);
    const { manager } = createManager();
    const key = manager.bindingKeyFor(descriptor);
    const dir = path.join(tempRoot, 'store');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, `${key}.enc`), 'not-decryptable');

    expect(await manager.authorize(descriptor, { timeoutMs: 5000 })).toEqual({ ok: true });

    const aside = fs.readdirSync(dir).filter((name) => name.startsWith(`${key}.unreadable-`));
    expect(aside).toHaveLength(1);
    expect(fs.readFileSync(path.join(dir, aside[0]), 'utf8')).toBe('not-decryptable');
  });

  it('reports unavailable storage before opening the browser when a saved record can be neither read nor replaced', async () => {
    const noKeyring: SecretCodec = { ...codec, isEncryptionAvailable: () => false };
    const store = new McpOAuthCredentialStore(path.join(tempRoot, 'store'), noKeyring);
    const browser = fakeBrowser();
    const manager = new McpOAuthManager({ store, openExternal: browser.openExternal, legacyAuthDir: () => tempRoot, platform: 'linux' });
    const descriptor = descriptorFor(rs.mcpUrl);
    fs.mkdirSync(path.join(tempRoot, 'store'), { recursive: true });
    fs.writeFileSync(path.join(tempRoot, 'store', `${manager.bindingKeyFor(descriptor)}.enc`), 'sealed');

    const result = await manager.authorize(descriptor, { timeoutMs: 5000 });

    expect(result).toMatchObject({ ok: false, errorType: 'credential_storage_unavailable' });
    expect(browser.opened).toHaveLength(0);
  });
});

describe('McpOAuthManager stale legacy credentials', () => {
  it('does not report a dead imported sign-in as authorized, and the next sign-in registers a new client', async () => {
    // A months-old mcp-remote record whose refresh token the provider no longer honors.
    const descriptor = descriptorFor(rs.mcpUrl);
    const hash = (await import('../serverIdentity')).getMcpRemoteServerHashes(descriptor)[0];
    writeLegacy(path.join(tempRoot, 'mcp-auth', 'mcp-remote-0.1.36'), hash,
      { access_token: 'old-access', refresh_token: 'old-refresh-the-provider-forgot' },
      { client_id: 'old-client', redirect_uris: ['http://localhost:4444/oauth/callback'] });
    const { manager, store } = createManager();

    const status = await manager.getStatus(descriptor);

    expect(status).toEqual({ state: 'needs_reauthorization', reason: 'token_exchange' });
    // The stale imported registration is marked, so it is not reused.
    const stored = await store.load(manager.bindingKeyFor(descriptor));
    expect(stored.status === 'present' && stored.binding.clientRejected).toBe(true);
    const registrationsBefore = as1.requests.filter((r) => r.path === '/register').length;
    expect(await manager.authorize(descriptor, { timeoutMs: 5000 })).toEqual({ ok: true });
    expect(as1.requests.filter((r) => r.path === '/register').length).toBe(registrationsBefore + 1);
    expect((await manager.getStatus(descriptor)).state).toBe('authorized');
  });

  it('checks an imported record with a future recorded expiry against the provider before calling it signed in', async () => {
    const descriptor = descriptorFor(rs.mcpUrl);
    const hash = (await import('../serverIdentity')).getMcpRemoteServerHashes(descriptor)[0];
    writeLegacy(path.join(tempRoot, 'mcp-auth', 'mcp-remote-0.1.36'), hash,
      { access_token: 'old-access', refresh_token: 'old-refresh-the-provider-forgot', expires_in: 3600 },
      { client_id: 'old-client', redirect_uris: ['http://localhost:4444/oauth/callback'] });
    const { manager } = createManager();

    expect(await manager.getStatus(descriptor)).toEqual({ state: 'needs_reauthorization', reason: 'token_exchange' });
  });
});

describe('McpOAuthManager commits checked inside the store write', () => {
  it('an older sign-in that reaches its write after a newer one started does not win', async () => {
    const browser = fakeBrowser();
    let saves = 0;
    let secondEntered: () => void = () => undefined;
    const secondAtWrite = new Promise<void>((resolve) => { secondEntered = resolve; });
    let releaseSecond: () => void = () => undefined;
    const secondGate = new Promise<void>((resolve) => { releaseSecond = resolve; });
    let second: Promise<unknown> = Promise.resolve();
    const descriptor = descriptorFor(rs.mcpUrl);
    class RacingStore extends McpOAuthCredentialStore {
      override async saveIfGeneration(...args: Parameters<McpOAuthCredentialStore['saveIfGeneration']>): Promise<boolean> {
        saves += 1;
        if (saves === 1) {
          // The first flow passed its own check; a second sign-in starts now
          // and reaches its write before the first one is applied.
          second = manager.authorize(descriptor, { timeoutMs: 5000 });
          await secondAtWrite;
          try {
            return await super.saveIfGeneration(...args);
          } finally {
            releaseSecond();
          }
        }
        if (saves === 2) {
          secondEntered();
          await secondGate;
        }
        return super.saveIfGeneration(...args);
      }
    }
    const store = new RacingStore(path.join(tempRoot, 'store'), codec);
    const manager = new McpOAuthManager({ store, openExternal: browser.openExternal, legacyAuthDir: () => tempRoot, platform: 'darwin' });

    const first = await manager.authorize(descriptor, { timeoutMs: 5000 });

    expect(first).toMatchObject({ ok: false, errorType: 'cancelled' });
    expect(await second).toEqual({ ok: true });
    const current = await manager.getAccessToken(manager.bindingKeyFor(descriptor));
    if (!current.ok) throw new Error('expected token');
    expect(as1.revoked).not.toContain(current.accessToken);
  });

  it('a 401 report does not clear tokens a refresh rotated in while it was checking the server', async () => {
    const descriptor = descriptorFor(rs.mcpUrl);
    let duringReport: (() => Promise<void>) | null = null;
    const fetchFn = async (input: string | URL, init?: RequestInit) => {
      const url = new URL(String(input));
      if (duringReport && url.pathname.startsWith('/.well-known/oauth-protected-resource')) {
        const hook = duringReport;
        duringReport = null;
        await hook();
      }
      return fetch(input, init);
    };
    const browser = fakeBrowser();
    const store = new McpOAuthCredentialStore(path.join(tempRoot, 'store'), codec);
    const manager = new McpOAuthManager({ store, fetchFn, openExternal: browser.openExternal, legacyAuthDir: () => tempRoot, platform: 'darwin' });
    expect(await manager.authorize(descriptor, { timeoutMs: 5000 })).toEqual({ ok: true });
    const key = manager.bindingKeyFor(descriptor);
    const old = await manager.getAccessToken(key);
    if (!old.ok) throw new Error('expected token');
    let rotated = '';
    duringReport = async () => {
      const next = await manager.getAccessToken(key, { rejectedToken: old.accessToken });
      if (next.ok) rotated = next.accessToken;
    };

    await manager.reportPersistentUnauthorized(key, `Bearer resource_metadata="${rs.base}/.well-known/oauth-protected-resource/mcp"`, old.accessToken);

    expect(rotated).not.toBe('');
    expect(await manager.getAccessToken(key)).toEqual({ ok: true, accessToken: rotated });
    expect((await manager.getStatus(descriptor)).state).toBe('authorized');
  });
});
