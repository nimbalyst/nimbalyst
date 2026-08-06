/**
 * MCP-config behavior of sdkOptionsBuilder (NIM-2372).
 *
 * The builder used to set `strictMcpConfig: true` so the SDK ignored its own
 * discovery. That also hard-disabled every claude.ai account connector
 * (NIM-2240) and made the binary exit 1 on machines with an enterprise
 * managed-mcp.json. Nimbalyst now stays inside the ecosystem: no strict flag,
 * and "off" is written into Claude Code's own `disabledMcpServers`.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

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
  beforeEach(() => {
    __resetEnterpriseManagedMcpConfigCache();
  });

  it('never sets strictMcpConfig, so the SDK keeps its own discovery and claude.ai connectors', async () => {
    const { options } = await buildSdkOptions(makeDeps(), makeParams());

    expect(options.strictMcpConfig).toBeUndefined();
    expect(options.settingSources).toContain('user');
    expect(options.settingSources).toContain('project');
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

    expect(Object.keys(options.mcpServers)).toEqual(['nimbalyst']);
  });
});
