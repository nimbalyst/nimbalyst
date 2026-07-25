/**
 * PATH-overlay tests for sdkOptionsBuilder.
 *
 * Regression coverage for NIM-376 — removing setupClaudeCodeEnvironment() in
 * commit 0b186492 left options.env.PATH as process.env.PATH. Dock/Finder
 * launches of Electron have a minimal PATH (/usr/bin:/bin:/usr/sbin:/sbin),
 * which caused the Claude Code SDK's stdio MCP spawns to fail with
 * "Executable not found in $PATH: npx" for every npx-based MCP server.
 *
 * The fix overlays ClaudeCodeDeps.enhancedPathLoader() onto env.PATH so the
 * SDK can resolve npx / uvx / docker / etc.
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
import { ClaudeCodeDeps } from '../claudeCode/dependencyInjection';

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

describe('buildSdkOptions PATH overlay (NIM-376)', () => {
  let originalPath: string | undefined;

  beforeEach(() => {
    originalPath = process.env.PATH;
    ClaudeCodeDeps.setEnhancedPathLoader(null);
  });

  afterEach(() => {
    if (originalPath === undefined) {
      delete process.env.PATH;
    } else {
      process.env.PATH = originalPath;
    }
    ClaudeCodeDeps.setEnhancedPathLoader(null);
  });

  it('overlays env.PATH from enhancedPathLoader when configured', async () => {
    process.env.PATH = '/usr/bin:/bin'; // simulate minimal GUI-launched PATH
    ClaudeCodeDeps.setEnhancedPathLoader(
      () => '/opt/homebrew/bin:/Users/me/.nvm/versions/node/v20/bin:/usr/bin:/bin'
    );

    const { options } = await buildSdkOptions(makeDeps(), makeParams());

    expect(options.env.PATH).toBe(
      '/opt/homebrew/bin:/Users/me/.nvm/versions/node/v20/bin:/usr/bin:/bin'
    );
  });

  it('falls back to process.env.PATH when no enhancedPathLoader is set', async () => {
    process.env.PATH = '/usr/bin:/bin';
    // loader intentionally unset

    const { options } = await buildSdkOptions(makeDeps(), makeParams());

    expect(options.env.PATH).toBe('/usr/bin:/bin');
  });

  it('falls back to process.env.PATH when enhancedPathLoader returns empty string', async () => {
    process.env.PATH = '/usr/bin:/bin';
    ClaudeCodeDeps.setEnhancedPathLoader(() => '');

    const { options } = await buildSdkOptions(makeDeps(), makeParams());

    expect(options.env.PATH).toBe('/usr/bin:/bin');
  });
});
