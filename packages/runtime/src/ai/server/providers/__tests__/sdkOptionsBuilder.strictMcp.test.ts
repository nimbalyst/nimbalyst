/**
 * strictMcpConfig tests for sdkOptionsBuilder.
 *
 * Regression coverage for the SDK-path half of NIM-843. The CLI path got
 * `--strict-mcp-config` so the genuine `claude` binary uses ONLY Nimbalyst's
 * filtered snapshot. The SDK path (this builder) never set the equivalent
 * `strictMcpConfig: true`, so with settingSources including 'user'/'project'
 * the SDK re-discovered and merged ~/.claude.json + .mcp.json mcpServers on top
 * of the filtered `mcpServers` list — leaking user-disabled third-party servers
 * into claude-agent-sdk sessions, ignoring the Nimbalyst toggle.
 *
 * strictMcpConfig only gates MCP discovery; settingSources still loads user/
 * project slash commands, skills, and hooks, so the command features are kept.
 */

import { describe, expect, it, vi } from 'vitest';

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

describe('buildSdkOptions strictMcpConfig (NIM-843 SDK path)', () => {
  it('sets strictMcpConfig so the SDK ignores ~/.claude.json / .mcp.json MCP discovery', async () => {
    const { options } = await buildSdkOptions(makeDeps(), makeParams());

    expect(options.strictMcpConfig).toBe(true);
  });

  it('still loads user/project settingSources for slash commands (strict only gates MCP)', async () => {
    const { options } = await buildSdkOptions(makeDeps(), makeParams());

    // Default (no settings loader) enables all sources; strict must not strip them.
    expect(options.settingSources).toContain('user');
    expect(options.settingSources).toContain('project');
  });
});
