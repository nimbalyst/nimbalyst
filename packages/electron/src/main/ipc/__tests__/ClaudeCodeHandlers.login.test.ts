import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

/**
 * Verifies that `claude-code:login` opens the terminal in the project folder
 * passed by the caller, so the CLI's /login lands in the same directory the
 * user is working in (not the terminal's default home dir).
 */
const mocks = vi.hoisted(() => {
  const handlers = new Map<string, (event: any, ...args: any[]) => Promise<any>>();
  return {
    handlers,
    spawn: vi.fn(() => ({ unref: vi.fn() })),
    existsSync: vi.fn(() => true),
    statSync: vi.fn(() => ({ isDirectory: () => true })),
    resolveClaudeCodeExecutablePath: vi.fn(() => '/bundled/claude'),
    setupClaudeCodeEnvironment: vi.fn(() => ({ PATH: '/fake/path' })),
    sendEvent: vi.fn(),
  };
});

vi.mock('child_process', () => ({ spawn: mocks.spawn }));

vi.mock('fs', () => ({
  default: { existsSync: mocks.existsSync, statSync: mocks.statSync },
  existsSync: mocks.existsSync,
  statSync: mocks.statSync,
}));

vi.mock('../../utils/ipcRegistry', () => ({
  safeHandle: (channel: string, fn: (event: any, ...args: any[]) => Promise<any>) => {
    mocks.handlers.set(channel, fn);
  },
  safeOn: () => {},
}));

vi.mock('@anthropic-ai/claude-agent-sdk', () => ({ query: vi.fn() }));

vi.mock('@nimbalyst/runtime/electron/claudeCodeEnvironment', () => ({
  setupClaudeCodeEnvironment: mocks.setupClaudeCodeEnvironment,
  resolveClaudeCodeExecutablePath: mocks.resolveClaudeCodeExecutablePath,
}));

vi.mock('../../services/ClaudeCodeDetector', () => ({
  claudeCodeDetector: { getStatus: vi.fn(), clearCache: vi.fn() },
}));

vi.mock('../../utils/logger', () => ({
  logger: { ipc: { error: vi.fn(), info: vi.fn(), warn: vi.fn() } },
}));

vi.mock('../../services/analytics/AnalyticsService.ts', () => ({
  AnalyticsService: { getInstance: () => ({ sendEvent: mocks.sendEvent }) },
}));

vi.mock('../../utils/store', () => ({
  shouldShowClaudeCodeWindowsWarning: vi.fn(() => false),
  dismissClaudeCodeWindowsWarning: vi.fn(),
}));

import { registerClaudeCodeHandlers } from '../ClaudeCodeHandlers';

const originalPlatform = process.platform;
function setPlatform(platform: NodeJS.Platform) {
  Object.defineProperty(process, 'platform', { value: platform, configurable: true });
}

async function invokeLogin(workspacePath?: string) {
  const handler = mocks.handlers.get('claude-code:login');
  if (!handler) throw new Error('login handler not registered');
  return handler({}, workspacePath);
}

/** First spawn() call args, untyped for convenient tuple indexing in assertions. */
function firstSpawnCall(): any[] {
  return mocks.spawn.mock.calls[0] as any[];
}

describe('claude-code:login opens the terminal in the project folder', () => {
  beforeEach(() => {
    mocks.handlers.clear();
    mocks.spawn.mockClear();
    mocks.existsSync.mockReturnValue(true);
    mocks.statSync.mockReturnValue({ isDirectory: () => true } as any);
    mocks.resolveClaudeCodeExecutablePath.mockReturnValue('/bundled/claude');
    registerClaudeCodeHandlers();
  });

  afterEach(() => {
    setPlatform(originalPlatform);
  });

  it('darwin: injects a cd into the project folder before launching the CLI', async () => {
    setPlatform('darwin');
    await invokeLogin('/Users/me/My Project');

    const [cmd, cmdArgs] = firstSpawnCall();
    expect(cmd).toBe('osascript');
    const script = cmdArgs[1];
    expect(script).toContain(`cd '/Users/me/My Project' && `);
  });

  it('linux: passes cwd to spawn and cds into the project folder', async () => {
    setPlatform('linux');
    await invokeLogin('/home/me/proj');

    const [, cmdArgs, opts] = firstSpawnCall();
    expect(opts).toMatchObject({ cwd: '/home/me/proj' });
    expect(cmdArgs[1]).toContain(`cd '/home/me/proj'; `);
  });

  it('does not cd when no workspace path is supplied (preserves prior behavior)', async () => {
    setPlatform('darwin');
    await invokeLogin(undefined);

    const script = firstSpawnCall()[1][1];
    expect(script).not.toContain('cd ');
  });

  it('ignores a workspace path that is not an existing directory', async () => {
    setPlatform('darwin');
    mocks.existsSync.mockReturnValue(false);
    await invokeLogin('/does/not/exist');

    const script = firstSpawnCall()[1][1];
    expect(script).not.toContain('cd ');
  });
});
