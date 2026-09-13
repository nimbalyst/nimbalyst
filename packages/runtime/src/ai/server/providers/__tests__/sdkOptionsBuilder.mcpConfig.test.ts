/**
 * MCP-config behavior of sdkOptionsBuilder (NIM-2372).
 *
 * The builder used to set `strictMcpConfig: true` so the SDK ignored its own
 * discovery. That also hard-disabled every claude.ai account connector
 * (NIM-2240) and made the binary exit 1 on machines with an enterprise
 * managed-mcp.json. Nimbalyst now stays inside the ecosystem: no strict flag,
 * and "off" is written into Claude Code's own `disabledMcpServers`.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { setHostEnvironment } from '../../../../host/hostEnvironment';

vi.mock('electron', () => ({
  app: {
    isPackaged: false,
  },
}));

vi.mock('../claudeCode/cliPathResolver', () => ({
  resolveClaudeAgentCliPath: async () => '/fake/claude',
}));

vi.mock('../../../../electron/claudeCodeEnvironment', () => ({
  setupClaudeCodeEnvironment: () => ({}),
  resolveNativeBinaryPath: () => undefined,
}));

import { buildSdkOptions } from '../claudeCode/sdkOptionsBuilder';
import { ClaudeCodeDeps } from '../claudeCode/dependencyInjection';
import { __resetEnterpriseManagedMcpConfigCache } from '../claudeCode/enterpriseMcpConfig';

function makeDeps(overrides: Partial<Parameters<typeof buildSdkOptions>[0]> = {}) {
  return {
    resolveModelVariant: () => 'opus',
    getMcpServersSnapshot: async () => ({}),
    createCanUseToolHandler: () => () => true,
    toolHooksService: {
      createPreToolUseHook: () => () => ({}),
      createPostToolUseHook: () => () => ({}),
      createPermissionDeniedHook: () => () => ({}),
    },
    teammateManager: {
      resolveTeamContext: async () => undefined,
      packagedBuildOptions: undefined as any,
    },
    sessions: { getSessionId: () => null },
    config: {},
    abortController: new AbortController(),
    ...overrides,
  } as Parameters<typeof buildSdkOptions>[0];
}

function makeParams(overrides: Partial<Parameters<typeof buildSdkOptions>[1]> = {}) {
  return {
    message: 'hello',
    workspacePath: '/tmp/workspace',
    settingsEnv: {},
    shellEnv: {},
    systemPrompt: '',
    currentMode: undefined,
    imageContentBlocks: [],
    documentContentBlocks: [],
    ...overrides,
  } as Parameters<typeof buildSdkOptions>[1];
}

describe('buildSdkOptions MCP config (NIM-2372)', () => {
  let originalPluginLoader: typeof ClaudeCodeDeps.extensionPluginsLoader;
  afterEach(() => { setHostEnvironment(null); vi.unstubAllEnvs(); ClaudeCodeDeps.extensionPluginsLoader = originalPluginLoader; });
  beforeEach(() => {
    originalPluginLoader = ClaudeCodeDeps.extensionPluginsLoader;
    __resetEnterpriseManagedMcpConfigCache();
  });

  it('never sets strictMcpConfig, so the SDK keeps its own discovery and claude.ai connectors', async () => {
    const { options } = await buildSdkOptions(makeDeps(), makeParams());

    expect(options.strictMcpConfig).toBeUndefined();
    expect(options.settingSources).toContain('user');
    expect(options.settingSources).toContain('project');
  });

  it('keeps headless runs out of repository hooks and implicit MCP discovery', async () => {
    setHostEnvironment({ isPackaged: () => false, getAppPath: () => '/app', agentConfiguration: 'explicit-only' } as any);
    const { options } = await buildSdkOptions(makeDeps(), makeParams());
    expect(options.strictMcpConfig).toBe(true);
    expect(options.settingSources).toEqual([]);
  });

  it('disables skills, agents, and plugins under explicit-only, including the extension loader', async () => {
    setHostEnvironment({ isPackaged: () => false, getAppPath: () => '/app', agentConfiguration: 'explicit-only' });
    const pluginLoader = vi.fn(async () => [{ type: 'local' as const, path: '/untrusted/plugin' }]);
    ClaudeCodeDeps.extensionPluginsLoader = pluginLoader;
    const { options } = await buildSdkOptions(makeDeps(), makeParams());
    expect(options.skills).toEqual([]);
    expect(options.agents).toEqual({});
    expect(options.plugins).toEqual([]);
    expect(pluginLoader).not.toHaveBeenCalled();
  });

  it('uses the cli entrypoint even when the host sets an ambient entrypoint', async () => {
    setHostEnvironment({ isPackaged: () => false, getAppPath: () => '/app', agentConfiguration: 'explicit-only' });
    vi.stubEnv('CLAUDE_CODE_ENTRYPOINT', 'ambient-entrypoint');
    const { options } = await buildSdkOptions(makeDeps(), makeParams());
    expect(options.env?.CLAUDE_CODE_ENTRYPOINT).toBe('cli');
  });

  it('preserves platform networking and location variables without inheriting credentials or provider controls', async () => {
    setHostEnvironment({ isPackaged: () => false, getAppPath: () => '/app', agentConfiguration: 'explicit-only' });
    const platformEnv = {
      HTTPS_PROXY: 'http://proxy.example:8080', HTTP_PROXY: 'http://proxy.example:8080', NO_PROXY: 'localhost',
      https_proxy: 'http://proxy.example:8080', http_proxy: 'http://proxy.example:8080', no_proxy: 'localhost',
      NODE_EXTRA_CA_CERTS: '/etc/corp.pem', SSL_CERT_FILE: '/etc/cert.pem', SSL_CERT_DIR: '/etc/certs',
      CURL_CA_BUNDLE: '/tmp/runtime-ca.pem', REQUESTS_CA_BUNDLE: '/tmp/runtime-ca.pem', GIT_SSL_CAINFO: '/tmp/runtime-ca.pem',
      SHELL: '/bin/sh', LC_CTYPE: 'en_US.UTF-8', APPDATA: 'C:/AppData/Roaming', LOCALAPPDATA: 'C:/AppData/Local',
      SYSTEMDRIVE: 'C:', HOMEDRIVE: 'C:', HOMEPATH: '/Users/test', PROGRAMFILES: 'C:/Program Files',
      'PROGRAMFILES(X86)': 'C:/Program Files (x86)', NUMBER_OF_PROCESSORS: '8', OS: 'Windows_NT',
    };
    for (const [key, value] of Object.entries(platformEnv)) vi.stubEnv(key, value);
    for (const key of ['AWS_SECRET_ACCESS_KEY', 'OPENAI_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'CLAUDE_CODE_API_KEY_HELPER']) vi.stubEnv(key, 'synthetic-secret');
    const { options } = await buildSdkOptions(makeDeps(), makeParams());
    for (const [key, value] of Object.entries(platformEnv)) expect(options.env?.[key], key).toBe(value);
    for (const key of ['AWS_SECRET_ACCESS_KEY', 'OPENAI_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'CLAUDE_CODE_API_KEY_HELPER']) expect(options.env?.[key], key).toBeUndefined();
  });

  it('removes ambient credentials and startup injection from the headless child environment', async () => {
    setHostEnvironment({ isPackaged: () => false, getAppPath: () => '/app', agentConfiguration: 'explicit-only' });
    vi.stubEnv('NIM_SECURITY_TEST_SECRET', 'synthetic-marker');
    vi.stubEnv('NODE_OPTIONS', '--require /tmp/untrusted.js');
    vi.stubEnv('ANTHROPIC_BASE_URL', 'https://example.invalid');
    vi.stubEnv('ANTHROPIC_API_KEY', 'ambient-key');
    const { options } = await buildSdkOptions(makeDeps({ config: { apiKey: 'explicit-key' } }), makeParams({ shellEnv: { SHELL_SECRET: 'secret' } }));
    // The pinned SDK passes an explicit env through to the child process.
    const childEnv = options.env!;
    expect(childEnv.NIM_SECURITY_TEST_SECRET).toBeUndefined();
    expect(childEnv.NODE_OPTIONS).toBeUndefined();
    expect(childEnv.ANTHROPIC_BASE_URL).toBeUndefined();
    expect(childEnv.SHELL_SECRET).toBeUndefined();
    expect(childEnv.ANTHROPIC_API_KEY).toBe('explicit-key');
    expect(childEnv.PATH).toBeTruthy();
  });

  it('drops the whole mcpServers map under enterprise MCP lockdown (the binary rejects any dynamic config)', async () => {
    const deps = makeDeps({
      getMcpServersSnapshot: async () => ({ nimbalyst: { type: 'sse', url: 'http://127.0.0.1:1/mcp' } }),
      hasEnterpriseMcpLockdown: () => true,
    } as any);

    const { options } = await buildSdkOptions(deps, makeParams());

    expect(options.mcpServers).toEqual({});
  });

  it('passes the snapshot through when there is no lockdown', async () => {
    const deps = makeDeps({
      getMcpServersSnapshot: async () => ({ nimbalyst: { type: 'sse', url: 'http://127.0.0.1:1/mcp' } }),
      hasEnterpriseMcpLockdown: () => false,
    } as any);

    const { options } = await buildSdkOptions(deps, makeParams());

    expect(Object.keys(options.mcpServers!)).toEqual(['nimbalyst']);
  });
});
