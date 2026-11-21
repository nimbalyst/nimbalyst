/**
 * PATH-overlay tests for sdkOptionsBuilder.
 *
 * Regression coverage for NIM-376 — removing setupClaudeCodeEnvironment() in
 * commit 0b186492 left options.env!.PATH as process.env.PATH. Dock/Finder
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

    expect(options.env!.PATH).toBe(
      '/opt/homebrew/bin:/Users/me/.nvm/versions/node/v20/bin:/usr/bin:/bin'
    );
  });

  it('falls back to process.env.PATH when no enhancedPathLoader is set', async () => {
    process.env.PATH = '/usr/bin:/bin';
    // loader intentionally unset

    const { options } = await buildSdkOptions(makeDeps(), makeParams());

    expect(options.env!.PATH).toBe('/usr/bin:/bin');
  });

  it('falls back to process.env.PATH when enhancedPathLoader returns empty string', async () => {
    process.env.PATH = '/usr/bin:/bin';
    ClaudeCodeDeps.setEnhancedPathLoader(() => '');

    const { options } = await buildSdkOptions(makeDeps(), makeParams());

    expect(options.env!.PATH).toBe('/usr/bin:/bin');
  });
});

// A widget answer that reached no live waiter mid-turn is queued; the
// PostToolBatch hook hands it to the lead as a user message the running turn
// reads before its next model request.
describe('buildSdkOptions PostToolBatch late-answer hook', () => {
  const batch = (extra: Record<string, unknown> = {}) =>
    ({ hook_event_name: 'PostToolBatch', tool_calls: [], session_id: 'cli', transcript_path: '', cwd: '', ...extra }) as any;
  const start = async () => {
    const built = await buildSdkOptions(makeDeps(), makeParams({ sessionId: 'nim-1' }));
    const sdk = built.promptInput[Symbol.asyncIterator]();
    await sdk.next(); // the turn's own prompt
    const hook = (input: any) =>
      built.options.hooks!.PostToolBatch![0].hooks[0](input, undefined, { signal: new AbortController().signal });
    return { sdk, hook, controller: built.promptController };
  };

  afterEach(() => ClaudeCodeDeps.setLateAnswerLoader(null));

  it('sends the queued answers as a user message read in the same turn, then settles them', async () => {
    const settle = vi.fn(async () => {});
    const load = vi.fn(async () => ({ text: 'Q: a', settle }));
    ClaudeCodeDeps.setLateAnswerLoader(load);
    const { sdk, hook } = await start();

    const replied = hook(batch());
    const sent = await sdk.next();
    expect(settle).not.toHaveBeenCalled();
    void sdk.next(); // the SDK asks for the next message once it has written this one

    expect(await replied).toEqual({});
    expect(load).toHaveBeenCalledWith('nim-1');
    expect(sent.value).toEqual({
      type: 'user',
      message: { role: 'user', content: 'Q: a' },
      parent_tool_use_id: null,
      priority: 'next',
      origin: { kind: 'human' },
    });
    expect(settle).toHaveBeenCalledWith(true);
  });

  it('returns the answers to the queue when the SDK does not take the message', async () => {
    const settle = vi.fn(async () => {});
    ClaudeCodeDeps.setLateAnswerLoader(async () => ({ text: 'Q: a', settle }));
    const { hook } = await start();
    vi.useFakeTimers();
    try {
      const replied = hook(batch());
      await vi.advanceTimersByTimeAsync(2_000);

      expect(await replied).toEqual({});
      expect(settle).toHaveBeenCalledWith(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it.each([
    ['a sub-agent batch', (hook: any) => hook(batch({ agent_id: 'agent-1' }))],
    ['an ended prompt stream', (hook: any, controller: any) => { controller.end('test'); return hook(batch()); }],
  ])('leaves the answers queued for %s', async (_label, run) => {
    const load = vi.fn(async () => ({ text: 'Q: a', settle: vi.fn() }));
    ClaudeCodeDeps.setLateAnswerLoader(load);
    const { hook, controller } = await start();

    expect(await run(hook, controller)).toEqual({});
    expect(load).not.toHaveBeenCalled();
  });

  it.each([
    ['nothing is queued', async () => null],
    ['the queue cannot be read', async () => { throw new Error('db closed'); }],
  ])('lets the batch continue unchanged when %s', async (_label, load) => {
    ClaudeCodeDeps.setLateAnswerLoader(load);
    const { hook } = await start();

    expect(await hook(batch())).toEqual({});
  });
});
