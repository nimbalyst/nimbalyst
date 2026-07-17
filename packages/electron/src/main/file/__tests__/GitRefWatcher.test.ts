import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as path from 'path';
import * as os from 'os';
import * as fs from 'fs';

// Hoisted mocks: simple-git fakes that individual tests can wire per scenario,
// plus logger fakes that the vi.mock factory below references. Hoisting is
// required because vi.mock factories run before any non-hoisted top-level
// statements.
const {
  mockStatus,
  mockLog,
  mockDiffSummary,
  loggerInfo,
  loggerError,
  loggerWarn,
  loggerDebug,
  mockWatchFile,
  mockUnwatchFile,
  mockResolveGitContext,
} = vi.hoisted(() => ({
  mockStatus: vi.fn(),
  mockLog: vi.fn(),
  mockDiffSummary: vi.fn(),
  loggerInfo: vi.fn(),
  loggerError: vi.fn(),
  loggerWarn: vi.fn(),
  loggerDebug: vi.fn(),
  mockWatchFile: vi.fn(),
  mockUnwatchFile: vi.fn(),
  // Pass-through by default (workspace == root, byte-for-byte no-op) so the
  // existing fake-path tests below are unaffected. The subfolder test
  // overrides this to return a distinct repo root.
  mockResolveGitContext: vi.fn((workspacePath: string) => ({
    isRepo: true,
    gitRoot: workspacePath,
  })),
}));

vi.mock('simple-git', () => ({
  default: () => ({
    status: mockStatus,
    log: mockLog,
    diffSummary: mockDiffSummary,
  }),
}));

vi.mock('../../services/GitContextService', () => ({
  resolveGitContext: mockResolveGitContext,
}));

// Pretend `<workspace>/.git` is a regular directory.
vi.mock('fs', async () => {
  const actual = await vi.importActual<typeof import('fs')>('fs');
  return {
    ...actual,
    watchFile: mockWatchFile,
    unwatchFile: mockUnwatchFile,
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

import { GitRefWatcher, type CommitDetectedEvent } from '../GitRefWatcher';

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

  it('uses native file polling for git ref and index files', async () => {
    mockStatus.mockResolvedValue({ current: 'master' });
    mockLog.mockResolvedValue({ latest: { hash: 'abc123', message: 'Initial commit' } });

    const watcher = new GitRefWatcher();
    await watcher.start('/fake/workspace');

    expect(mockWatchFile).toHaveBeenCalledTimes(2);
    expect(mockWatchFile.mock.calls[0]?.[0]).toBe(path.join('/fake/workspace', '.git', 'refs', 'heads', 'master'));
    expect(mockWatchFile.mock.calls[1]?.[0]).toBe(path.join('/fake/workspace', '.git', 'index'));
    expect(watcher.getStats().activeWatchers).toBe(1);

    await watcher.stop('/fake/workspace');

    expect(mockUnwatchFile).toHaveBeenCalledTimes(2);
    expect(mockUnwatchFile.mock.calls[0]?.[0]).toBe(path.join('/fake/workspace', '.git', 'refs', 'heads', 'master'));
    expect(mockUnwatchFile.mock.calls[1]?.[0]).toBe(path.join('/fake/workspace', '.git', 'index'));
    expect(watcher.getStats().activeWatchers).toBe(0);
  });
});

describe('GitRefWatcher - subfolder workspace (#124)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('detects commits when the workspace is a subfolder of the repo (#124)', async () => {
    // The repo root differs from the watched workspace (issue #124): the
    // user opened `home/`, a subfolder of the repo rooted at `gitRoot`.
    const gitRoot = '/fake/repo-root';
    const workspacePath = path.join(gitRoot, 'home');

    // Unlike the fake-path tests above (where gitRoot === workspacePath is
    // a no-op), here git itself would resolve the toplevel to gitRoot.
    mockResolveGitContext.mockReturnValue({ isRepo: true, gitRoot });

    mockStatus.mockResolvedValue({ current: 'master' });
    mockLog
      .mockResolvedValueOnce({ latest: { hash: 'abc123', message: 'Initial commit' } })
      .mockResolvedValueOnce({ latest: { hash: 'def456', message: 'Second commit' } });
    mockDiffSummary.mockResolvedValue({ files: [{ file: 'home/file.txt' }] });

    const watcher = new GitRefWatcher();
    await watcher.start(workspacePath);
    expect(watcher.getStats().activeWatchers).toBe(1);

    const commitEventPromise = new Promise<CommitDetectedEvent>((resolve) => {
      watcher.onCommitDetected((event) => resolve(event));
    });

    // Simulate the ref file changing, the same way the native fs.watchFile
    // callback would fire on a real commit.
    const refListener = mockWatchFile.mock.calls[0]?.[2];
    expect(refListener).toBeTypeOf('function');
    const prevStats = { mtimeMs: 0, ctimeMs: 0, size: 0, ino: 0, nlink: 0 };
    const currStats = { mtimeMs: 1, ctimeMs: 1, size: 1, ino: 1, nlink: 1 };
    refListener(currStats, prevStats);

    const event = await commitEventPromise;

    // The committed file's absolute path must be joined against the repo
    // root, not the (sub-folder) workspace path.
    expect(event.committedFiles).toEqual([path.join(gitRoot, 'home', 'file.txt')]);
  });
});

describe('GitRefWatcher - symlinked workspace == repo root (#124 invariant)', () => {
  let realDir: string;
  let symlinkPath: string;

  beforeEach(() => {
    vi.clearAllMocks();
    // A real directory plus a real symlink pointing at it, so
    // fs.realpathSync (unmocked -- only watchFile/unwatchFile/promises.stat
    // /promises.readFile are stubbed above) resolves both to the same
    // canonical path, the same way it would for a symlinked project folder.
    realDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nim-gitrefwatcher-real-'));
    symlinkPath = path.join(
      os.tmpdir(),
      `nim-gitrefwatcher-symlink-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    );
    fs.symlinkSync(realDir, symlinkPath, 'dir');
  });

  afterEach(() => {
    fs.rmSync(symlinkPath, { force: true });
    fs.rmSync(realDir, { recursive: true, force: true });
  });

  it('joins committed-file paths against the logical (symlink) workspacePath, not the physical git root, when workspace == repo root', async () => {
    // git rev-parse --show-toplevel resolves symlinks and returns the
    // PHYSICAL path (realDir). workspacePath is the symlink the user
    // actually opened, and is what HistoryManager auto-approve keys off.
    mockResolveGitContext.mockReturnValue({ isRepo: true, gitRoot: realDir });

    mockStatus.mockResolvedValue({ current: 'master' });
    mockLog
      .mockResolvedValueOnce({ latest: { hash: 'abc123', message: 'Initial commit' } })
      .mockResolvedValueOnce({ latest: { hash: 'def456', message: 'Second commit' } });
    mockDiffSummary.mockResolvedValue({ files: [{ file: 'file.txt' }] });

    const watcher = new GitRefWatcher();
    await watcher.start(symlinkPath);
    expect(watcher.getStats().activeWatchers).toBe(1);

    const commitEventPromise = new Promise<CommitDetectedEvent>((resolve) => {
      watcher.onCommitDetected((event) => resolve(event));
    });

    // Simulate the ref file changing, the same way the native fs.watchFile
    // callback would fire on a real commit.
    const refListener = mockWatchFile.mock.calls[0]?.[2];
    expect(refListener).toBeTypeOf('function');
    const prevStats = { mtimeMs: 0, ctimeMs: 0, size: 0, ino: 0, nlink: 0 };
    const currStats = { mtimeMs: 1, ctimeMs: 1, size: 1, ino: 1, nlink: 1 };
    refListener(currStats, prevStats);

    const event = await commitEventPromise;

    // Must be joined against the symlink workspacePath (logical), not the
    // realpath-resolved git root (physical) -- otherwise commit auto-approve
    // silently stops matching for a symlinked workspace root.
    expect(event.committedFiles).toEqual([path.join(symlinkPath, 'file.txt')]);
  });
});
