import { describe, it, expect, beforeEach, vi } from 'vitest';

// Hoisted mocks: simple-git fakes that individual tests can wire per scenario,
// plus logger fakes that the vi.mock factory below references. Hoisting is
// required because vi.mock factories run before any non-hoisted top-level
// statements.
const {
  mockStatus,
  mockLog,
  loggerInfo,
  loggerError,
  loggerWarn,
  loggerDebug,
} = vi.hoisted(() => ({
  mockStatus: vi.fn(),
  mockLog: vi.fn(),
  loggerInfo: vi.fn(),
  loggerError: vi.fn(),
  loggerWarn: vi.fn(),
  loggerDebug: vi.fn(),
}));

vi.mock('simple-git', () => ({
  default: () => ({
    status: mockStatus,
    log: mockLog,
  }),
}));

// chokidar.watch is invoked at .start() once preflight passes. We never want
// real file watchers in tests, so return a no-op that satisfies the FSWatcher
// interface enough for our assertions.
vi.mock('chokidar', () => ({
  default: {
    watch: vi.fn(() => ({
      on: vi.fn().mockReturnThis(),
      close: vi.fn().mockResolvedValue(undefined),
    })),
  },
}));

// Pretend `<workspace>/.git` is a regular directory.
vi.mock('fs', async () => {
  const actual = await vi.importActual<typeof import('fs')>('fs');
  return {
    ...actual,
    promises: {
      ...actual.promises,
      stat: vi.fn().mockResolvedValue({
        isDirectory: () => true,
        isFile: () => false,
      }),
      readFile: vi.fn(),
    },
  };
});

vi.mock('electron', () => ({
  BrowserWindow: { getAllWindows: vi.fn(() => []) },
}));

vi.mock('../../utils/logger', () => ({
  logger: {
    main: {
      info: loggerInfo,
      error: loggerError,
      warn: loggerWarn,
      debug: loggerDebug,
    },
  },
}));

vi.mock('../../ipc/GitStatusHandlers', () => ({
  clearGitStatusCache: vi.fn(),
}));

import { GitRefWatcher } from '../GitRefWatcher';

describe('GitRefWatcher.start - empty repo handling', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('skips cleanly when git.log throws "does not have any commits yet"', async () => {
    mockStatus.mockResolvedValue({ current: 'master' });
    mockLog.mockRejectedValue(
      new Error("fatal: your current branch 'master' does not have any commits yet"),
    );

    const watcher = new GitRefWatcher();
    await expect(watcher.start('/fake/workspace')).resolves.toBeUndefined();

    expect(loggerInfo).toHaveBeenCalledWith(
      '[GitRefWatcher] Skipping workspace with no commits yet:',
      'workspace',
    );
    // The fresh-init path must NOT log via logger.error -- that was the
    // original symptom (multi-line stack trace in main.log).
    expect(loggerError).not.toHaveBeenCalled();

    expect(watcher.getStats().activeWatchers).toBe(0);
  });

  it('still logs error and skips when git.log throws an unrelated message', async () => {
    mockStatus.mockResolvedValue({ current: 'master' });
    mockLog.mockRejectedValue(new Error('unexpected git failure'));

    const watcher = new GitRefWatcher();
    await watcher.start('/fake/workspace');

    // The outer catch in start() handles all other errors and logs them.
    expect(loggerError).toHaveBeenCalledWith(
      '[GitRefWatcher] Failed to start watching:',
      expect.any(Error),
    );
    expect(watcher.getStats().activeWatchers).toBe(0);
  });

  it('skips detached HEAD workspaces (existing behavior preserved)', async () => {
    mockStatus.mockResolvedValue({ current: undefined });

    const watcher = new GitRefWatcher();
    await watcher.start('/fake/workspace');

    expect(loggerInfo).toHaveBeenCalledWith(
      '[GitRefWatcher] Skipping detached HEAD workspace:',
      '/fake/workspace',
    );
    expect(watcher.getStats().activeWatchers).toBe(0);
  });
});
