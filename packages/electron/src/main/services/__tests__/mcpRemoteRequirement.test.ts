// @vitest-environment node
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { requiresMcpRemote, resolveMcpRemoteRequirementOptions } from '../mcpRemoteRequirement';
import { MCPConfigService } from '../MCPConfigService';
import type { MCPServerConfig } from '@nimbalyst/runtime/types/MCPServerConfig';
import { McpOAuthCredentialStore } from '../mcpOAuth/credentialStore';
import { McpOAuthManager } from '../mcpOAuth/McpOAuthManager';
import { McpRemoteGateway } from '../mcpOAuth/gateway';
import { setMcpOAuthForTest } from '../mcpOAuth';
import { setMcpGatewayShimPathForTest } from '../mcpOAuth/shimPath';
import { __setShellEnvironmentForTest } from '../shellEnvironment';
import type { McpOAuthBinding } from '../mcpOAuth/types';

const discoverMcpRemoteOAuthRequirement = vi.fn(async () => true);
const checkMcpRemoteAuthStatus = vi.fn(async () => ({ authorized: false }));

// Narrow mock: only the three probe helpers are faked. `usesNativeRemoteOAuth`
// and `extractMcpRemoteConfig` stay real so the classification under test is the
// real one.
vi.mock('../MCPRemoteOAuth', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../MCPRemoteOAuth')>()),
  discoverMcpRemoteOAuthRequirement: (...args: unknown[]) =>
    discoverMcpRemoteOAuthRequirement(...(args as [])),
  checkMcpRemoteAuthStatus: (...args: unknown[]) => checkMcpRemoteAuthStatus(...(args as [])),
}));

const actualOAuth = await vi.importActual<typeof import('../MCPRemoteOAuth')>('../MCPRemoteOAuth');

const http = (extra: Partial<MCPServerConfig> = {}): MCPServerConfig =>
  ({ type: 'http', url: 'https://api.example.com/mcp', ...extra }) as MCPServerConfig;

describe('requiresMcpRemote', () => {
  it('does NOT require the wrapper for a static-header server on a native-HTTP CLI', () => {
    // The whole bug: a server authenticating with a plain bearer header needs no
    // OAuth, so mcp-remote buys nothing and costs a process tree plus a token
    // on the command line.
    const config = http({ headers: { Authorization: 'Bearer ghp_static' } });
    expect(requiresMcpRemote(config, { nativeHttpSupported: true })).toBe(false);
  });

  it('DOES require the wrapper when the CLI has no native HTTP transport', () => {
    // Unknown/non-native callers keep the compatibility wrapper.
    const config = http({ headers: { Authorization: 'Bearer ghp_static' } });
    expect(requiresMcpRemote(config, { nativeHttpSupported: false })).toBe(true);
  });

  it('DOES require the wrapper when the server declares dynamic OAuth', () => {
    // No clientId/clientSecret, but an oauth block means tokens are negotiated
    // and stored by mcp-remote in ~/.mcp-auth.
    const config = http({ oauth: {} } as Partial<MCPServerConfig>);
    expect(requiresMcpRemote(config, { nativeHttpSupported: true })).toBe(true);
  });

  it('does NOT require the wrapper when OAuth credentials are supplied', () => {
    // Existing native-OAuth escape hatch, preserved.
    const config = http({ oauth: { clientId: 'abc' } } as Partial<MCPServerConfig>);
    expect(requiresMcpRemote(config, { nativeHttpSupported: true })).toBe(false);
  });

  it('DOES require the wrapper for a pre-registered client Nimbalyst authorizes with', () => {
    // staticClientInfo is the no-DCR remedy the Authorize button offers, and it
    // only works through mcp-remote. It must NOT be mistaken for the
    // clientId/clientSecret escape hatch above, which hands auth to the CLI.
    const config = http({
      oauth: { staticClientInfo: { client_id: 'abc' } },
    } as Partial<MCPServerConfig>);
    expect(requiresMcpRemote(config, { nativeHttpSupported: true })).toBe(true);
  });

  it('never applies to stdio servers', () => {
    const config = { type: 'stdio', command: 'node', args: ['x.js'] } as MCPServerConfig;
    expect(requiresMcpRemote(config, { nativeHttpSupported: true })).toBe(false);
    expect(requiresMcpRemote(config, { nativeHttpSupported: false })).toBe(false);
  });

  it('never applies to sse servers, which are already remote-capable', () => {
    const config = { type: 'sse', url: 'http://127.0.0.1:3456/mcp/x' } as MCPServerConfig;
    expect(requiresMcpRemote(config, { nativeHttpSupported: true })).toBe(false);
  });

  it('DOES require the wrapper when mcp-remote already holds a token for the server', () => {
    // NIM-2433. Nothing in this config says OAuth, but the token in ~/.mcp-auth
    // is the real credential and only mcp-remote can present it.
    const config = http();
    expect(
      requiresMcpRemote(config, { nativeHttpSupported: true, hasCachedMcpRemoteToken: true })
    ).toBe(true);
  });

  it('defaults to the safe answer when nativeHttpSupported is unspecified', () => {
    // An unknown caller must keep today's behaviour, not silently lose the wrapper.
    const config = http({ headers: { Authorization: 'Bearer x' } });
    expect(requiresMcpRemote(config, {})).toBe(true);
  });
});

describe('Codex and Claude Code reach the same credential (NIM-2433)', () => {
  // Both CLIs speak Streamable HTTP natively. A server whose only credential is
  // one Nimbalyst holds must still go through Nimbalyst's gateway on both paths.
  const service = new MCPConfigService();
  let tempRoot: string;
  let manager: McpOAuthManager;
  const LAUNCH_TOKEN = 'launch-token';
  const SHIM = '/app/resources/mcp-gateway-stdio.mjs';

  beforeEach(async () => {
    tempRoot = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'nim-mcp-auth-'));
    manager = new McpOAuthManager({
      store: new McpOAuthCredentialStore(path.join(tempRoot, 'store'), {
        isEncryptionAvailable: () => true,
        encryptString: (plain) => Buffer.from(plain),
        decryptString: (encrypted) => encrypted.toString(),
      }),
      openExternal: async () => undefined,
      legacyAuthDir: () => path.join(tempRoot, 'mcp-auth'),
    });
    setMcpOAuthForTest({
      manager,
      gateway: new McpRemoteGateway(manager),
      endpoint: { port: 4567, getToken: () => LAUNCH_TOKEN },
    });
    setMcpGatewayShimPathForTest(SHIM);
    // The real status lookup, so a key change that stops matching stored
    // credentials fails here instead of silently disabling the fix.
    checkMcpRemoteAuthStatus.mockImplementation(
      actualOAuth.checkMcpRemoteAuthStatus as unknown as typeof checkMcpRemoteAuthStatus
    );
  });

  afterEach(async () => {
    setMcpOAuthForTest({ manager: null, gateway: null, endpoint: null });
    setMcpGatewayShimPathForTest(null);
    checkMcpRemoteAuthStatus.mockImplementation(async () => ({ authorized: false }));
    await fs.promises.rm(tempRoot, { recursive: true, force: true });
  });

  const storeCredential = async (config: MCPServerConfig): Promise<void> => {
    const descriptor = actualOAuth.extractMcpRemoteConfig(config, { useMcpRemoteForNativeOAuth: true })!;
    const key = manager.bindingKeyFor(descriptor);
    const issuer = 'https://auth.example.com/';
    const binding: McpOAuthBinding = {
      version: 1,
      bindingKey: key,
      serverUrl: descriptor.serverUrl,
      issuer,
      asMetadata: {
        issuer,
        authorization_endpoint: `${issuer}authorize`,
        token_endpoint: `${issuer}token`,
        response_types_supported: ['code'],
      },
      client: { client_id: 'c1', redirect_uri: 'http://localhost:1/oauth/callback', redirect_uris: [], redirectUriConfirmed: true, source: 'dcr', issuer },
      tokens: { access_token: 'remote-access-secret', refresh_token: 'remote-refresh-secret', expires_at: Date.now() + 3_600_000, issuer },
      state: 'active',
      origin: 'authorized',
      generation: 1,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    const store = (manager as unknown as { store: McpOAuthCredentialStore }).store;
    expect(await store.saveIfGeneration(binding, 0)).toBe(true);
  };

  /** Where the CLI will actually get its credential for this server. */
  const credentialSource = async (
    config: MCPServerConfig,
    options: { nativeHttpSupported?: boolean }
  ): Promise<'nimbalyst-gateway' | 'declared-config-only'> => {
    const resolved = await resolveMcpRemoteRequirementOptions(config, options);
    const runtime = service.processServerConfigForRuntime(config, resolved);
    return (runtime.url ?? '').includes('/mcp-remote/') || (runtime.args ?? []).some((arg) => arg.includes('/mcp-remote/'))
      ? 'nimbalyst-gateway'
      : 'declared-config-only';
  };

  it('routes a server with a stored credential through the gateway on BOTH paths', async () => {
    const config = http();
    await storeCredential(config);

    const codex = await credentialSource(config, { nativeHttpSupported: true });
    const claudeCode = await credentialSource(config, { nativeHttpSupported: true });

    expect(claudeCode).toBe(codex);
    expect(claudeCode).toBe('nimbalyst-gateway');
  });

  it('N13: the generated entries carry only the loopback token, never the remote credential', async () => {
    const config = http({ oauth: {} });
    await storeCredential(config);

    const httpEntry = service.processServerConfigForRuntime(config, { nativeHttpSupported: true });
    const stdioEntry = service.processServerConfigForRuntime(config, {});

    expect(httpEntry).toMatchObject({
      type: 'http',
      url: expect.stringMatching(/^http:\/\/127\.0\.0\.1:4567\/mcp-remote\/[a-f0-9]+$/),
      headers: { Authorization: expect.stringMatching(/^Bearer [a-f0-9]{64}$/) },
    });
    expect(stdioEntry).toMatchObject({
      type: 'stdio',
      command: process.execPath,
      args: [SHIM, expect.stringContaining('/mcp-remote/')],
      env: { ELECTRON_RUN_AS_NODE: '1', NIMBALYST_MCP_GATEWAY_TOKEN: expect.stringMatching(/^[a-f0-9]{64}$/) },
    });
    // The route token rides in env, not argv, where process listings show it,
    // and neither entry carries the launch token, which opens every server.
    expect(JSON.stringify(stdioEntry.args)).not.toContain(stdioEntry.env!.NIMBALYST_MCP_GATEWAY_TOKEN);
    expect(JSON.stringify([httpEntry, stdioEntry])).not.toContain(LAUNCH_TOKEN);
    for (const entry of [httpEntry, stdioEntry]) {
      const serialized = JSON.stringify(entry);
      expect(serialized).not.toContain('remote-access-secret');
      expect(serialized).not.toContain('remote-refresh-secret');
      expect(serialized).not.toContain('npx');
      expect(serialized).not.toContain('mcp-remote@');
    }
  });

  it('keeps static API keys out of argv for CLIs that need the stdio bridge', async () => {
    const config = http({ headers: { Authorization: 'Bearer ghp_static_secret' } });

    const stdioEntry = service.processServerConfigForRuntime(config, {});

    expect(stdioEntry.type).toBe('stdio');
    expect(JSON.stringify(stdioEntry)).not.toContain('ghp_static_secret');
  });

  it('routes a native-OAuth server through the gateway only for callers that cannot run its OAuth', async () => {
    const config = http({ oauth: { clientId: 'cli-owned' } });

    const claude = service.processServerConfigForRuntime(config, { nativeHttpSupported: true });
    const codex = service.processServerConfigForRuntime(config, { nativeHttpSupported: true, useMcpRemoteForNativeOAuth: true });

    expect(claude.url).toBe(config.url);
    expect(codex.url).toContain('/mcp-remote/');
  });

  it('keeps the native-HTTP passthrough when no credential was ever stored', async () => {
    // The savings the native-HTTP change bought (~15 processes / 516 MB per
    // session) come entirely from this case, so it must not regress into a wrap.
    const config = http({ headers: { Authorization: 'Bearer ghp_static' } });

    await expect(credentialSource(config, { nativeHttpSupported: true }))
      .resolves.toBe('declared-config-only');
  });

  it('preserves a Codex static-header server as Streamable HTTP', async () => {
    // Regression: wrapping this as stdio and overlaying it on the same server in
    // ~/.codex/config.toml leaves both `command` and `url`, which Codex rejects
    // with "url is not supported for stdio" during thread/start.
    const config = http({ headers: { Authorization: 'Key test-token' } });
    const options = await resolveMcpRemoteRequirementOptions(config, {
      nativeHttpSupported: true,
    });

    const runtime = service.processServerConfigForRuntime(config, options);

    expect(runtime).toEqual(config);
    expect(runtime.command).toBeUndefined();
  });

  describe('stored npx mcp-remote entries', () => {
    const routes = (): Map<string, { descriptor: { serverUrl: string; headers: Record<string, string> } }> =>
      (currentGateway as unknown as { routes: Map<string, { descriptor: { serverUrl: string; headers: Record<string, string> } }> }).routes;
    let currentGateway: McpRemoteGateway;

    beforeEach(() => {
      currentGateway = new McpRemoteGateway(manager);
      setMcpOAuthForTest({ gateway: currentGateway });
    });

    const keyOf = (url: string | undefined): string => (url ?? '').split('/mcp-remote/')[1] ?? '';

    it('bridges a template-style entry on every caller, with no npx in the result', () => {
      const config = {
        type: 'stdio',
        command: 'npx',
        args: ['-y', 'mcp-remote', 'https://mcp.linear.app/mcp'],
        oauth: {},
      } as MCPServerConfig;

      const claude = service.processServerConfigForRuntime(config, { nativeHttpSupported: true });
      const codex = service.processServerConfigForRuntime(config, { nativeHttpSupported: true, useMcpRemoteForNativeOAuth: true });
      const stdioOnly = service.processServerConfigForRuntime(config, {});

      expect(claude).toMatchObject({ type: 'http', url: expect.stringContaining('/mcp-remote/') });
      expect(codex).toMatchObject({ type: 'http', url: claude.url });
      expect(stdioOnly).toMatchObject({ type: 'stdio', command: process.execPath, args: [SHIM, claude.url] });
      for (const entry of [claude, codex, stdioOnly]) {
        expect(JSON.stringify(entry)).not.toContain('npx');
      }
      expect(routes().get(keyOf(claude.url))?.descriptor.serverUrl).toBe('https://mcp.linear.app/mcp');
    });

    it('resolves ${VAR} from the server env into the gateway route, not the CLI entry', () => {
      const config = {
        type: 'stdio',
        command: 'npx',
        args: ['-y', 'mcp-remote@latest', 'https://api.githubcopilot.com/mcp/', '--header', 'Authorization:Bearer ${GITHUB_PERSONAL_ACCESS_TOKEN}'],
        env: { GITHUB_PERSONAL_ACCESS_TOKEN: 'ghp_from_server_env' },
      } as MCPServerConfig;

      const entry = service.processServerConfigForRuntime(config, { nativeHttpSupported: true });

      expect(entry.url).toContain('/mcp-remote/');
      expect(JSON.stringify(entry)).not.toContain('ghp_from_server_env');
      expect(routes().get(keyOf(entry.url))?.descriptor.headers).toEqual({ Authorization: 'Bearer ghp_from_server_env' });
    });

    it('keeps running mcp-remote when the command uses an option the gateway does not implement', () => {
      const config = {
        type: 'stdio',
        command: 'npx',
        args: ['-y', 'mcp-remote', 'https://mcp.example.com/mcp', '--ignore-tool', 'delete_*'],
      } as MCPServerConfig;

      const entry = service.processServerConfigForRuntime(config, { nativeHttpSupported: true });

      expect(entry.type).toBe('stdio');
      expect(entry.args).toEqual(config.args);
      expect(routes().size).toBe(0);
    });

    it('keeps running mcp-remote when a ${VAR} has no value in the server env', () => {
      // mcp-remote would have read it from the environment it inherited;
      // Nimbalyst does not consult its own process environment for it.
      const config = {
        type: 'stdio',
        command: 'npx',
        args: ['-y', 'mcp-remote', 'https://mcp.example.com/mcp', '--header', 'Authorization:Bearer ${UNSET_TOKEN}'],
        env: {},
      } as MCPServerConfig;

      const entry = service.processServerConfigForRuntime(config, { nativeHttpSupported: true });

      expect(entry.type).toBe('stdio');
      expect(entry.args).toEqual(config.args);
    });

    it('resolves a ${VAR} defined only in the login shell into the gateway route, as mcp-remote did', () => {
      __setShellEnvironmentForTest({ SHELL_ONLY_KEY: 'key-from-login-shell' });
      try {
        const httpConfig = http({ headers: { Authorization: 'Bearer ${SHELL_ONLY_KEY}' }, oauth: {} });
        const command = {
          type: 'stdio',
          command: 'npx',
          args: ['-y', 'mcp-remote', 'https://mcp.other.example/mcp', '--header', 'X-Api-Key:${SHELL_ONLY_KEY}'],
        } as MCPServerConfig;

        const httpEntry = service.processServerConfigForRuntime(httpConfig, { nativeHttpSupported: true });
        const commandEntry = service.processServerConfigForRuntime(command, { nativeHttpSupported: true });

        expect(routes().get(keyOf(httpEntry.url))?.descriptor.headers).toEqual({ Authorization: 'Bearer key-from-login-shell' });
        expect(routes().get(keyOf(commandEntry.url))?.descriptor.headers).toEqual({ 'X-Api-Key': 'key-from-login-shell' });
        for (const entry of [httpEntry, commandEntry]) {
          expect(JSON.stringify(entry)).not.toContain('key-from-login-shell');
        }
      } finally {
        __setShellEnvironmentForTest(null);
      }
    });

    it('resolves ${VAR} in a direct HTTP header from the server env for a native-HTTP CLI', () => {
      // A CLI's own expansion only sees its process environment, never the
      // server's env block, so the template's key would otherwise go out literally.
      const config = http({
        headers: { Authorization: 'Bearer ${CORRIDOR_API_KEY}' },
        env: { CORRIDOR_API_KEY: 'corridor-key' },
      });

      const entry = service.processServerConfigForRuntime(config, { nativeHttpSupported: true });

      expect(entry.url).toBe(config.url);
      expect(entry.headers).toEqual({ Authorization: 'Bearer corridor-key' });
    });

    it('an explicitly empty env value overrides the login shell in the gateway route', () => {
      __setShellEnvironmentForTest({ SHARED_KEY: 'from-login-shell' });
      try {
        const config = http({ headers: { 'X-Api-Key': '${SHARED_KEY}' }, env: { SHARED_KEY: '' }, oauth: {} });

        const entry = service.processServerConfigForRuntime(config, { nativeHttpSupported: true });

        // An empty header is not sent; the shell's value must not take its place.
        expect(routes().get(keyOf(entry.url))?.descriptor.headers).toEqual({});
      } finally {
        __setShellEnvironmentForTest(null);
      }
    });

    it('resolves an env entry that names a login-shell variable for a server handed to the CLI directly', () => {
      __setShellEnvironmentForTest({ SHELL_SECRET: 'shell-secret' });
      try {
        const config = http({ headers: { Authorization: 'Bearer ${API_KEY}' }, env: { API_KEY: '${SHELL_SECRET}' } });

        const entry = service.processServerConfigForRuntime(config, { nativeHttpSupported: true });

        expect(entry.url).toBe(config.url);
        expect(entry.headers).toEqual({ Authorization: 'Bearer shell-secret' });
      } finally {
        __setShellEnvironmentForTest(null);
      }
    });

    it('takes the redirect URI from --static-oauth-client-metadata, as mcp-remote did', () => {
      const config = {
        type: 'stdio',
        command: 'npx',
        args: ['-y', 'mcp-remote', 'https://mcp.example.com/mcp',
          '--static-oauth-client-info', '{"client_id":"pre-registered"}',
          '--static-oauth-client-metadata', '{"redirect_uris":["http://localhost:7777/custom/callback"]}'],
      } as MCPServerConfig;

      const entry = service.processServerConfigForRuntime(config, { nativeHttpSupported: true });

      const descriptor = routes().get(keyOf(entry.url))?.descriptor as { redirectUri?: string } | undefined;
      expect(descriptor?.redirectUri).toBe('http://localhost:7777/custom/callback');
    });

    it('validates a ${VAR} URL against the server env, as it will be used', () => {
      const validate = (config: MCPServerConfig) =>
        (service as unknown as { validateConfig(c: unknown): void }).validateConfig({ mcpServers: { zapier: config } });
      const zapier = (value: string) =>
        ({ type: 'http', url: '${ZAPIER_MCP_URL}', env: { ZAPIER_MCP_URL: value } }) as MCPServerConfig;

      expect(() => validate(zapier('https://mcp.zapier.com/api/mcp/s/abc/mcp'))).not.toThrow();
      expect(() => validate(zapier(''))).toThrow(/url must be a valid URL/);
    });
  });
});

describe('MCPConfigService.isOAuthAuthorized', () => {
  const service = new MCPConfigService();

  it('still probes mcp-remote for a native-OAuth server when the caller opted into the wrapper', async () => {
    // Codex, Codex ACP and Copilot pass useMcpRemoteForNativeOAuth so the
    // authorization gate still checks mcp-remote's credential state. Skipping
    // the probe reported every such server authorized and stopped those
    // providers dropping the unauthorized ones.
    checkMcpRemoteAuthStatus.mockResolvedValueOnce({ authorized: false });

    const config = http({ oauth: { clientId: 'abc' } } as Partial<MCPServerConfig>);
    await expect(
      service.isOAuthAuthorized(config, { useMcpRemoteForNativeOAuth: true })
    ).resolves.toBe(false);
    expect(checkMcpRemoteAuthStatus).toHaveBeenCalled();
  });

  it('keeps an sse OAuth server that will never be wrapped in the first place', async () => {
    // nimbalyst#1057. requiresMcpRemote refuses to wrap anything that is not
    // `http`, so an sse server goes to the CLI directly and no token is ever
    // written to ~/.mcp-auth. Gating it on that token dropped every sse OAuth
    // server from the session with only an info log -- while the same config
    // worked in the Claude CLI, which uses its own keychain token.
    checkMcpRemoteAuthStatus.mockClear();

    const config = { type: 'sse', url: 'https://mcp.atlassian.com/v1/sse' } as MCPServerConfig;
    await expect(
      service.isOAuthAuthorized(config, { nativeHttpSupported: true })
    ).resolves.toBe(true);
    expect(checkMcpRemoteAuthStatus).not.toHaveBeenCalled();
  });

  it('skips the probe for a static-key server on a native-HTTP CLI', async () => {
    // The case the short-circuit exists for: no OAuth of any kind, so a 401 from
    // the probe must not get it classified as an unauthorized OAuth server.
    checkMcpRemoteAuthStatus.mockClear();

    const config = http({ headers: { Authorization: 'Bearer ghp_static' } });
    await expect(
      service.isOAuthAuthorized(config, { nativeHttpSupported: true })
    ).resolves.toBe(true);
    expect(checkMcpRemoteAuthStatus).not.toHaveBeenCalled();
  });
});
