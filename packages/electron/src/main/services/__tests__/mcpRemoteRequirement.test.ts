// @vitest-environment node
import { describe, expect, it, vi } from 'vitest';
import { requiresMcpRemote } from '../mcpRemoteRequirement';
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

  it('defaults to the safe answer when nativeHttpSupported is unspecified', () => {
    // An unknown caller must keep today's behaviour, not silently lose the wrapper.
    const config = http({ headers: { Authorization: 'Bearer x' } });
    expect(requiresMcpRemote(config, {})).toBe(true);
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
