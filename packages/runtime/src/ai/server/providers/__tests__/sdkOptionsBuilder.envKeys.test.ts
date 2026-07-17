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
  let originalToolSearch: string | undefined;
  let originalDisableAutoupdater: string | undefined;
  let originalDisableUpdates: string | undefined;

  beforeEach(() => {
    originalAnthropic = process.env.ANTHROPIC_API_KEY;
    originalOpenAI = process.env.OPENAI_API_KEY;
    originalEntrypoint = process.env.CLAUDE_CODE_ENTRYPOINT;
    originalToolSearch = process.env.ENABLE_TOOL_SEARCH;
    originalDisableAutoupdater = process.env.DISABLE_AUTOUPDATER;
    originalDisableUpdates = process.env.DISABLE_UPDATES;
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
    if (originalToolSearch === undefined) {
      delete process.env.ENABLE_TOOL_SEARCH;
    } else {
      process.env.ENABLE_TOOL_SEARCH = originalToolSearch;
    }
    if (originalDisableAutoupdater === undefined) {
      delete process.env.DISABLE_AUTOUPDATER;
    } else {
      process.env.DISABLE_AUTOUPDATER = originalDisableAutoupdater;
    }
    if (originalDisableUpdates === undefined) {
      delete process.env.DISABLE_UPDATES;
    } else {
      process.env.DISABLE_UPDATES = originalDisableUpdates;
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
    delete process.env.ENABLE_TOOL_SEARCH;

    const { options } = await buildSdkOptions(makeDeps(), makeParams());

    // Flags buildSdkOptions always composes onto the spawned session env.
    // 'true' = unconditional tool-search deferral: every MCP server except the
    // alwaysLoad core defers regardless of the model's context window. The old
    // 'auto:2' default meant a 20K-token eager floor on 1M-context models.
    expect(options.env.ENABLE_TOOL_SEARCH).toBe('true');
    expect(options.env.CLAUDE_CODE_ENTRYPOINT).toBe('cli');
  });

  it('forwards an explicit high effort selection instead of using the CLI default', async () => {
    const { options } = await buildSdkOptions(
      makeDeps({ config: { effortLevel: 'high' } }),
      makeParams()
    );

    expect(options.env.CLAUDE_CODE_EFFORT_LEVEL).toBe('high');
  });

  it('disables SDK extended thinking for supported Claude Agent models', async () => {
    const { options } = await buildSdkOptions(
      makeDeps({ config: { thinkingMode: 'disabled' } }),
      makeParams()
    );

    expect(options.thinking).toEqual({ type: 'disabled' });
  });

  it('omits the SDK thinking option when extended thinking is enabled', async () => {
    const { options } = await buildSdkOptions(
      makeDeps({ config: { thinkingMode: 'enabled' } }),
      makeParams()
    );

    expect(options.thinking).toBeUndefined();
  });

  it('omits the SDK thinking option for unsupported Claude Agent models', async () => {
    const { options } = await buildSdkOptions(
      makeDeps({
        resolveModelVariant: () => 'claude-fable-4-6-20260615',
        config: { thinkingMode: 'disabled' },
      }),
      makeParams()
    );

    expect(options.thinking).toBeUndefined();
  });

  it('disables the CLI self-updater by default on every spawn (NIM-1573)', async () => {
    // The bundled native CLI is version-pinned to the SDK JS we ship. Its
    // built-in AutoUpdater does a non-atomic in-place `rename claude.exe ->
    // claude.exe.old.<ts>` + re-download on version drift; an interrupted
    // update leaves an orphan and no binary, permanently breaking Claude Code.
    // Pin the updater off so nothing mutates the in-place binary.
    delete process.env.DISABLE_AUTOUPDATER;
    delete process.env.DISABLE_UPDATES;

    const { options } = await buildSdkOptions(makeDeps(), makeParams());

    expect(options.env.DISABLE_AUTOUPDATER).toBe('1');
    expect(options.env.DISABLE_UPDATES).toBe('1');
  });

  it('lets a user-configured DISABLE_AUTOUPDATER override the default (NIM-1573)', async () => {
    delete process.env.DISABLE_AUTOUPDATER;

    const { options } = await buildSdkOptions(
      makeDeps(),
      makeParams({ settingsEnv: { DISABLE_AUTOUPDATER: '0' } })
    );

    expect(options.env.DISABLE_AUTOUPDATER).toBe('0');
  });

  it('lets a user-configured ENABLE_TOOL_SEARCH override the default', async () => {
    // NIM-1475: the hardcoded default used to be spread after settingsEnv,
    // silently clobbering the ENABLE_TOOL_SEARCH=false remediation our own
    // Bedrock error guidance tells users to apply.
    delete process.env.ENABLE_TOOL_SEARCH;

    const { options } = await buildSdkOptions(
      makeDeps(),
      makeParams({ settingsEnv: { ENABLE_TOOL_SEARCH: 'false' } })
    );

    expect(options.env.ENABLE_TOOL_SEARCH).toBe('false');
  });
});
