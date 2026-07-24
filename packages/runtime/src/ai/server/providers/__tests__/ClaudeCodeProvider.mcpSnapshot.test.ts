import { afterEach, describe, expect, it, vi } from 'vitest';

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

import { ProviderFactory } from '../../ProviderFactory';
import { buildSdkOptions } from '../claudeCode/sdkOptionsBuilder';

function makeDeps(
  getMcpServersSnapshot: Parameters<typeof buildSdkOptions>[0]['getMcpServersSnapshot'],
): Parameters<typeof buildSdkOptions>[0] {
  return {
    resolveModelVariant: () => 'opus',
    getMcpServersSnapshot,
    createCanUseToolHandler: () => () => true,
    toolHooksService: {
      createPreToolUseHook: () => () => ({}),
      createPostToolUseHook: () => () => ({}),
      createPermissionDeniedHook: () => () => ({}),
    },
    teammateManager: {
      resolveTeamContext: async () => undefined,
      packagedBuildOptions: undefined,
    },
    sessions: { getSessionId: () => 'claude-session-id' },
    config: {},
    abortController: new AbortController(),
  };
}

function makeParams(): Parameters<typeof buildSdkOptions>[1] {
  return {
    message: 'hello',
    workspacePath: '/tmp/workspace',
    sessionId: 'mcp-snapshot-stable',
    settingsEnv: {},
    shellEnv: {},
    systemPrompt: '',
    currentMode: undefined,
    imageContentBlocks: [],
    documentContentBlocks: [],
  };
}

describe('ClaudeCodeProvider MCP snapshot (NIM-1988)', () => {
  const sessionId = 'mcp-snapshot-stable';

  afterEach(() => {
    ProviderFactory.destroyProvider(sessionId, 'claude-code');
  });

  // Cache safety: the MCP map is handed to a new SDK query on every resumed
  // turn. If a server connects between turns, the live Electron map may grow,
  // but the serialized SDK surface must remain byte-identical for the session.
  it('keeps SDK MCP options byte-stable when a server connects mid-session', async () => {
    let extensionServerConnected = false;
    const loadLiveMcpServers = vi.fn(async () => ({
      nimbalyst: {
        type: 'sse',
        url: 'http://127.0.0.1:3456/mcp/core',
      },
      ...(extensionServerConnected
        ? {
            'nimbalyst-example': {
              type: 'sse',
              url: 'http://127.0.0.1:3456/mcp/ext/example',
            },
          }
        : {}),
    }));

    const provider = ProviderFactory.createProvider('claude-code', sessionId) as unknown as {
      mcpConfigService: { getMcpServersConfig: typeof loadLiveMcpServers };
      getMcpServersSnapshot: Parameters<typeof buildSdkOptions>[0]['getMcpServersSnapshot'];
    };
    provider.mcpConfigService = { getMcpServersConfig: loadLiveMcpServers };
    const deps = makeDeps((options) => provider.getMcpServersSnapshot(options));

    const turn1 = await buildSdkOptions(deps, makeParams());
    extensionServerConnected = true;
    const turn2 = await buildSdkOptions(deps, makeParams());

    const turn1Bytes = JSON.stringify(turn1.options.mcpServers);
    const turn2Bytes = JSON.stringify(turn2.options.mcpServers);

    expect(Object.keys(turn1.options.mcpServers)).toEqual(['nimbalyst']);
    expect(loadLiveMcpServers).toHaveBeenCalledTimes(1);
    // This exact byte equality is the real cache invariant. Re-loading the live
    // map here would add nimbalyst-example and force a tools_changed full-prefix
    // miss on the resumed turn.
    expect(turn2Bytes).toBe(turn1Bytes);
  });
});
