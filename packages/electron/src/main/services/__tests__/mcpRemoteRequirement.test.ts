// @vitest-environment node
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { requiresMcpRemote, resolveMcpRemoteRequirementOptions } from '../mcpRemoteRequirement';
import { MCPConfigService } from '../MCPConfigService';
import type { MCPServerConfig } from '@nimbalyst/runtime/types/MCPServerConfig';

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
    // Codex, Codex ACP and Copilot go through the same code path and were never
    // verified. They keep the wrapper until someone measures them.
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
  // The regression guard. These two paths drifted apart once already: Codex wraps
  // everything, Claude Code takes the native-HTTP shortcut, and a server whose
  // only credential was a cached mcp-remote token went out bare on the Claude
  // side and 401'd. Assert the OUTCOME matches, not the branch taken.
  const service = new MCPConfigService();
  let authDir: string;

  beforeEach(async () => {
    authDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'nim-mcp-auth-'));
    process.env.MCP_REMOTE_CONFIG_DIR = authDir;
    // The real disk lookup, so a hashing change that stops matching token files
    // fails here instead of silently disabling the fix.
    checkMcpRemoteAuthStatus.mockImplementation(
      actualOAuth.checkMcpRemoteAuthStatus as unknown as typeof checkMcpRemoteAuthStatus
    );
  });

  afterEach(async () => {
    delete process.env.MCP_REMOTE_CONFIG_DIR;
    checkMcpRemoteAuthStatus.mockImplementation(async () => ({ authorized: false }));
    await fs.promises.rm(authDir, { recursive: true, force: true });
  });

  const writeCachedToken = async (url: string): Promise<void> => {
    const versionDir = path.join(authDir, 'mcp-remote-0.1.37');
    await fs.promises.mkdir(versionDir, { recursive: true });
    const hash = crypto.createHash('md5').update(url).digest('hex');
    await fs.promises.writeFile(
      path.join(versionDir, `${hash}_tokens.json`),
      JSON.stringify({ access_token: 'cached-by-mcp-remote' })
    );
  };

  /** Where the CLI will actually get its credential for this server. */
  const credentialSource = async (
    config: MCPServerConfig,
    options: { nativeHttpSupported?: boolean }
  ): Promise<'mcp-remote-cache' | 'declared-config-only'> => {
    const resolved = await resolveMcpRemoteRequirementOptions(config, options);
    const runtime = service.processServerConfigForRuntime(config, resolved);
    const wrapped = runtime.type === 'stdio'
      && (runtime.args ?? []).some((arg) => arg === 'mcp-remote' || arg.startsWith('mcp-remote@'));
    return wrapped ? 'mcp-remote-cache' : 'declared-config-only';
  };

  it('routes a cached-token http server through mcp-remote on BOTH paths', async () => {
    const config = http();
    await writeCachedToken(config.url!);

    const codex = await credentialSource(config, {});
    const claudeCode = await credentialSource(config, { nativeHttpSupported: true });

    expect(claudeCode).toBe(codex);
    expect(claudeCode).toBe('mcp-remote-cache');
  });

  it('keeps the native-HTTP passthrough when no token was ever cached', async () => {
    // The savings the native-HTTP change bought (~15 processes / 516 MB per
    // session) come entirely from this case, so it must not regress into a wrap.
    const config = http({ headers: { Authorization: 'Bearer ghp_static' } });

    await expect(credentialSource(config, { nativeHttpSupported: true }))
      .resolves.toBe('declared-config-only');
  });
});

describe('MCPConfigService.isOAuthAuthorized', () => {
  const service = new MCPConfigService();

  it('still probes mcp-remote for a native-OAuth server when the caller opted into the wrapper', async () => {
    // Codex, Codex ACP and Copilot pass useMcpRemoteForNativeOAuth, meaning "wrap
    // native-OAuth servers with mcp-remote". requiresMcpRemote answers "no wrapper"
    // for anything carrying OAuth credentials, so skipping the probe on its say-so
    // reported every such server authorized and stopped those providers dropping
    // the unauthorized ones.
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
