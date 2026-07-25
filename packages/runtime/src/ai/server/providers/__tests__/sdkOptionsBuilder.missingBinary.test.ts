/**
 * NIM-1573: honest failure on the run path when the bundled Claude runtime is
 * missing.
 *
 * On packaged builds there is no SDK self-resolve fallback. If buildSdkOptions
 * lets pathToClaudeCodeExecutable become undefined, the SDK self-resolves its JS
 * cli.js and emits a misleading "does not match this system's libc ... musl"
 * ReferenceError. Instead, buildSdkOptions must throw the honest
 * "repair Nimbalyst" message so the provider's catch surfaces it verbatim.
 *
 * In dev (isPackaged false) the SDK can self-resolve, so a resolution failure
 * must remain non-fatal (options.pathToClaudeCodeExecutable === undefined).
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { isPackagedRef, resolveCliMock } = vi.hoisted(() => ({
  isPackagedRef: { value: true },
  resolveCliMock: vi.fn<() => Promise<string>>(),
}));

vi.mock('electron', () => ({
  app: {
    get isPackaged() {
      return isPackagedRef.value;
    },
  },
}));

vi.mock('../claudeCode/cliPathResolver', () => ({
  resolveClaudeAgentCliPath: resolveCliMock,
}));

vi.mock('../../../../electron/claudeCodeEnvironment', () => ({
  setupClaudeCodeEnvironment: () => ({}),
  resolveNativeBinaryPath: () => undefined,
}));

import { buildSdkOptions } from '../claudeCode/sdkOptionsBuilder';
import { ClaudeCodeDeps } from '../claudeCode/dependencyInjection';

const HONEST_MESSAGE =
  "Nimbalyst's bundled Claude runtime is missing -- reinstall or repair Nimbalyst.";

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

describe('buildSdkOptions missing bundled runtime (NIM-1573)', () => {
  beforeEach(() => {
    resolveCliMock.mockReset();
    ClaudeCodeDeps.setCustomClaudeCodePathLoader(null as any);
    isPackagedRef.value = true;
  });

  afterEach(() => {
    ClaudeCodeDeps.setCustomClaudeCodePathLoader(null as any);
  });

  it('throws the honest repair message (not undefined path) on a packaged build with no binary', async () => {
    isPackagedRef.value = true;
    resolveCliMock.mockRejectedValue(new Error(HONEST_MESSAGE));

    await expect(buildSdkOptions(makeDeps(), makeParams())).rejects.toThrow(/repair Nimbalyst/i);
  });

  it('does NOT throw in dev (SDK can self-resolve); leaves the path undefined', async () => {
    isPackagedRef.value = false;
    resolveCliMock.mockRejectedValue(new Error(HONEST_MESSAGE));

    const { options } = await buildSdkOptions(makeDeps(), makeParams());
    expect(options.pathToClaudeCodeExecutable).toBeUndefined();
  });

  it('uses a user-configured custom path instead of failing, even when the bundled binary is missing', async () => {
    isPackagedRef.value = true;
    resolveCliMock.mockRejectedValue(new Error(HONEST_MESSAGE));
    ClaudeCodeDeps.setCustomClaudeCodePathLoader(() => '/custom/claude');

    const { options } = await buildSdkOptions(makeDeps(), makeParams());
    expect(options.pathToClaudeCodeExecutable).toBe('/custom/claude');
  });
});
