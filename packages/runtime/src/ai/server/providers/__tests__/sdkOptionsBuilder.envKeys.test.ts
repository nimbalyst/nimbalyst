/**
 * Env-key hardening tests for sdkOptionsBuilder.
 *
 * Regression coverage for the $100 shell-env-key incident — see CLAUDE.md
 * "Never Use Environment Variables as Implicit API Key Sources".
 *
 * As of claude-agent-sdk 0.2.111, `options.env` overlays `process.env`
 * instead of replacing it, so defense-in-depth requires both:
 *   1. Stripping the keys from process.env at main-process bootstrap, AND
 *   2. Stripping those keys from every shell/settings overlay we compose.
 *
 * These tests cover step 2. Login-based Claude Agent sessions must leave the
 * keys absent entirely; setting ANTHROPIC_API_KEY='' shadows OAuth login in
 * the native binary and breaks prompt execution.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

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
    mcpConfigService: { getMcpServersConfig: async () => ({}) },
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

describe('buildSdkOptions env-key hardening', () => {
  let originalAnthropic: string | undefined;
  let originalOpenAI: string | undefined;
  let originalEntrypoint: string | undefined;

  beforeEach(() => {
    originalAnthropic = process.env.ANTHROPIC_API_KEY;
    originalOpenAI = process.env.OPENAI_API_KEY;
    originalEntrypoint = process.env.CLAUDE_CODE_ENTRYPOINT;
  });

  afterEach(() => {
    if (originalAnthropic === undefined) {
      delete process.env.ANTHROPIC_API_KEY;
    } else {
      process.env.ANTHROPIC_API_KEY = originalAnthropic;
    }
    if (originalOpenAI === undefined) {
      delete process.env.OPENAI_API_KEY;
    } else {
      process.env.OPENAI_API_KEY = originalOpenAI;
    }
    if (originalEntrypoint === undefined) {
      delete process.env.CLAUDE_CODE_ENTRYPOINT;
    } else {
      process.env.CLAUDE_CODE_ENTRYPOINT = originalEntrypoint;
    }
  });

  it('removes ANTHROPIC_API_KEY when no configured key is provided', async () => {
    process.env.ANTHROPIC_API_KEY = 'sk-ant-leaked-from-shell';
    process.env.OPENAI_API_KEY = 'sk-leaked-from-shell';

    const { options } = await buildSdkOptions(
      makeDeps({ config: {} }),
      makeParams({ shellEnv: { ANTHROPIC_API_KEY: 'sk-ant-leaked-shellenv' } })
    );

    expect(options.env.ANTHROPIC_API_KEY).toBeUndefined();
    expect(options.env.OPENAI_API_KEY).toBeUndefined();
  });

  it('ignores ANTHROPIC_API_KEY that settingsEnv might carry', async () => {
    const { options } = await buildSdkOptions(
      makeDeps({ config: {} }),
      makeParams({
        settingsEnv: {
          ANTHROPIC_API_KEY: 'sk-ant-sneaked-via-settings',
          SOME_OTHER_FLAG: '1',
        },
      })
    );

    expect(options.env.ANTHROPIC_API_KEY).toBeUndefined();
    expect(options.env.SOME_OTHER_FLAG).toBe('1');
  });

  it('uses the configured API key from provider config when present', async () => {
    process.env.ANTHROPIC_API_KEY = 'sk-ant-leaked-from-shell';

    const { options } = await buildSdkOptions(
      makeDeps({ config: { apiKey: 'sk-ant-user-configured' } }),
      makeParams()
    );

    expect(options.env.ANTHROPIC_API_KEY).toBe('sk-ant-user-configured');
  });

  it('sets the base env flags buildSdkOptions applies to every spawn', async () => {
    delete process.env.CLAUDE_CODE_ENTRYPOINT;

    const { options } = await buildSdkOptions(makeDeps(), makeParams());

    // Flags buildSdkOptions always composes onto the spawned session env.
    expect(options.env.ENABLE_TOOL_SEARCH).toBe('auto:2');
    expect(options.env.CLAUDE_CODE_ENTRYPOINT).toBe('cli');
  });
});
