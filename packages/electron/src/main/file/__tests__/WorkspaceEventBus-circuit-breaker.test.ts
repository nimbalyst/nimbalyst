// @vitest-environment node
/**
 * Tests for the WorkspaceEventBus native handle teardown (issue #629) and
 * event storms.
 *
 * On macOS, `fs.watch(recursive:true)` is FSEvents-backed and closing the
 * watcher synchronously from inside its own callback can abort Electron
 * (SIGABRT/SIGTRAP). When a native failure retires the handle we must:
 *  - NOT close the watcher synchronously inside the watch callback,
 *  - close it on a later tick (setImmediate), and
 *  - close it exactly once no matter how many events arrive in the burst.
 *
 * An event storm that overflows the event backlog loses events, not the
 * handle: it is never closed, and subscribers resync through watch health.
 *
 * These mock fs.watch so we can drive the burst and observe the close timing.
 */

import { describe, it, expect, beforeEach, afterEach, afterAll, vi } from 'vitest';

// ---------------------------------------------------------------------------
// Hoisted mocks — must run before vi.mock() factories
// ---------------------------------------------------------------------------

const {
  mockFsWatch,
  mockWatcherCallbacks,
  mockWatcherCloses,
  mockFsAccess,
  mockGitignoreReadFile,
  mockGitignoreReadFileSync,
  originalPlatform,
} = vi.hoisted(() => {
  // Force the fs.watch recursive path (macOS/Windows) even on Linux CI,
  // since this test mocks fs.watch, not chokidar.
  const originalPlatform = process.platform;
  Object.defineProperty(process, 'platform', { value: 'darwin', writable: true });

  const mockWatcherCallbacks: Array<(eventType: string, filename: string | null) => void> = [];
  // Parallel array: the close() mock for the watcher created on each fs.watch call.
  const mockWatcherCloses: Array<ReturnType<typeof vi.fn>> = [];

  const mockFsWatch = vi.fn((_path: string, _opts: any, callback: any) => {
    mockWatcherCallbacks.push(callback);
    const close = vi.fn();
    mockWatcherCloses.push(close);
    return {
      close,
      on: vi.fn().mockReturnThis(),
    };
  });

  const mockFsAccess = vi.fn(() => Promise.resolve());
  const mockGitignoreReadFile = vi.fn().mockRejectedValue(new Error('no .gitignore'));
  const mockGitignoreReadFileSync = vi.fn<(...args: any[]) => string>(() => {
    throw new Error('no .gitignore');
  });

  return {
    mockFsWatch,
    mockWatcherCallbacks,
    mockWatcherCloses,
    mockFsAccess,
    mockGitignoreReadFile,
    mockGitignoreReadFileSync,
    originalPlatform,
  };
});

vi.mock('fs', async () => {
  const actual = await vi.importActual<typeof import('fs')>('fs');
  return {
    ...actual,
    watch: mockFsWatch,
    readFileSync: mockGitignoreReadFileSync,
  };
});

vi.mock('fs/promises', async () => {
  const actual = await vi.importActual<typeof import('fs/promises')>('fs/promises');
  return {
    ...actual,
    readFile: mockGitignoreReadFile,
    access: mockFsAccess,
  };
});

// Mock chokidar (not used on macOS/Windows but the import must resolve).
vi.mock('chokidar', () => ({
  default: {
    watch: vi.fn(() => ({
      on: vi.fn().mockReturnThis(),
      close: vi.fn(),
      add: vi.fn(),
      unwatch: vi.fn(),
    })),
  },
}));

vi.mock('../../utils/logger', () => ({
  logger: {
    main: {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
    },
    workspaceWatcher: {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
    },
  },
}));

vi.mock('../../utils/workspaceDetection', () => ({
  isPathInWorkspace: (filePath: string, workspacePath: string) => {
    if (!filePath || !workspacePath) return false;
    return filePath === workspacePath || filePath.startsWith(workspacePath + '/');
  },
}));

// Minimal `ignore` mock: nothing is ignored, so every fired event counts toward
// the circuit breaker (which measures raw event pressure before filtering).
vi.mock('ignore', () => {
  const createMatcher = () => {
    const matcher = {
      add: vi.fn(() => matcher),
      ignores: () => false,
    };
    return matcher;
  };
  return { default: createMatcher };
});

// ---------------------------------------------------------------------------
// Import after mocks are set up
// ---------------------------------------------------------------------------

import { subscribe, unsubscribe, resetBus, getBusEntryCount } from '../WorkspaceEventBus';
import type { WorkspaceEventListener } from '../WorkspaceEventBus';
import { logger } from '../../utils/logger';
import type { FileWatchHealth } from '../../../shared/fileWatchHealth';

// Mirrors the private constant in WorkspaceEventBus. The breaker trips when the
// oldest entry in the ring buffer (size THRESHOLD) is still within the window,
// which happens one event after the buffer first wraps — i.e. event THRESHOLD+1.
const CIRCUIT_BREAKER_THRESHOLD = 16384;

const WORKSPACE = '/Users/test/project';

function createListener(): WorkspaceEventListener {
  return {
    onChange: vi.fn(),
    onAdd: vi.fn(),
    onUnlink: vi.fn(),
  };
}

/** Fire an fs.watch event on the most recently created watcher. */
function fireWatchEvent(eventType: string, filename: string) {
  const cb = mockWatcherCallbacks[mockWatcherCallbacks.length - 1];
  if (!cb) throw new Error('No watcher callback registered');
  cb(eventType, filename);
}

/** Fire `count` change events in one synchronous burst. */
function fireBurst(count: number, name = 'file') {
  for (let i = 0; i < count; i++) {
    fireWatchEvent('change', `src/${name}-${i}.ts`);
  }
}

/** Report a native error from the most recently created watcher. */
function nativeError(code: string) {
  const handle = mockFsWatch.mock.results[mockFsWatch.mock.results.length - 1].value;
  const onError = handle.on.mock.calls.find(([event]: [string]) => event === 'error')[1];
  onError(Object.assign(new Error(code), { code }));
}

/** A listener that records every health change it is sent. */
function recordingListener() {
  const states: FileWatchHealth[] = [];
  const listener = { ...createListener(), onHealthChanged: (health: FileWatchHealth) => { states.push(health); } };
  return { states, listener, changed: () => vi.mocked(listener.onChange).mock.calls.map(([file]) => file) };
}

/** Resolve after the next setImmediate, flushing deferred teardown. */
function flushImmediate(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

function latestCloseMock() {
  return mockWatcherCloses[mockWatcherCloses.length - 1];
}

describe('WorkspaceEventBus circuit breaker teardown (#629)', () => {
  beforeEach(() => {
    mockWatcherCallbacks.length = 0;
    mockWatcherCloses.length = 0;
    mockFsWatch.mockClear();
    mockFsAccess.mockReset();
    mockFsAccess.mockResolvedValue(undefined);
    mockGitignoreReadFile.mockReset();
    mockGitignoreReadFile.mockRejectedValue(new Error('no .gitignore'));
    mockGitignoreReadFileSync.mockReset();
    mockGitignoreReadFileSync.mockImplementation(() => {
      throw new Error('no .gitignore');
    });
    resetBus();
  });

  afterEach(() => {
    resetBus();
    vi.useRealTimers();
  });

  afterAll(() => {
    Object.defineProperty(process, 'platform', { value: originalPlatform, writable: true });
  });

  it('does NOT close the watcher synchronously inside its failure callback', async () => {
    await subscribe(WORKSPACE, 'sub', createListener());
    const close = latestCloseMock();

    fireBurst(100);
    nativeError('EMFILE');

    // The close must be deferred — calling it synchronously from inside the
    // FSEvents callback is what crashes Electron.
    expect(close).not.toHaveBeenCalled();
  });

  it('logs routine watcher startup at debug, but keeps failures and recovery visible', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    vi.mocked(logger.main.info).mockClear();
    vi.mocked(logger.main.warn).mockClear();
    await subscribe(WORKSPACE, 'logging', createListener());
    expect(logger.main.info).not.toHaveBeenCalled();
    expect(logger.main.warn).not.toHaveBeenCalled();

    nativeError('EMFILE');
    expect(logger.main.warn).toHaveBeenCalledWith(
      '[WorkspaceEventBus] Watcher health:',
      expect.objectContaining({ state: 'recovering', workspacePath: WORKSPACE }),
    );
    await flushImmediate();
    await vi.advanceTimersByTimeAsync(1000);
    expect(logger.main.info).toHaveBeenCalledWith(
      '[WorkspaceEventBus] Watcher health:',
      expect.objectContaining({ state: 'watching', workspacePath: WORKSPACE }),
    );
  });

  it('names the watch limit once per run of ENOSPC failures', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    mockGitignoreReadFileSync.mockImplementation((file: string) => {
      if (file === '/proc/sys/fs/inotify/max_user_watches') return '524288\n';
      throw new Error('no .gitignore');
    });
    vi.mocked(logger.main.warn).mockClear();
    await subscribe(WORKSPACE, 'limit', createListener());
    // The fs.watch mock stands in for chokidar here; only the platform check reads Linux.
    const failLatest = (code: string) => {
      const handle = mockFsWatch.mock.results[mockFsWatch.mock.results.length - 1].value;
      const onError = handle.on.mock.calls.find(([event]: [string]) => event === 'error')[1];
      Object.defineProperty(process, 'platform', { value: 'linux', writable: true });
      try { onError(Object.assign(new Error(code), { code })); }
      finally { Object.defineProperty(process, 'platform', { value: 'darwin', writable: true }); }
    };
    const limitWarnings = () => vi.mocked(logger.main.warn).mock.calls
      .filter(([message]) => String(message).includes('watch limit'));

    failLatest('ENOSPC');
    expect(limitWarnings()).toEqual([[
      `[WorkspaceEventBus] inotify watch limit (524288) reached for ${WORKSPACE}; add large folders to .gitignore or raise fs.inotify.max_user_watches. Next retry in 60s.`,
    ]]);
    await flushImmediate();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(mockFsWatch).toHaveBeenCalledTimes(2);
    failLatest('ENOSPC');
    expect(limitWarnings()).toHaveLength(1);
  });

  it('recovers delivery to the original subscriber after a native failure (#1499)', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    const listener = createListener();
    await subscribe(WORKSPACE, 'window', listener);
    const staleCallback = mockWatcherCallbacks[0];
    fireBurst(100);
    nativeError('EMFILE');
    await flushImmediate();
    vi.mocked(listener.onChange).mockClear();

    await vi.advanceTimersByTimeAsync(1000);
    expect(mockFsWatch).toHaveBeenCalledTimes(2);
    fireWatchEvent('change', 'note.md');
    expect(listener.onChange).toHaveBeenCalledWith(`${WORKSPACE}/note.md`, undefined);
    staleCallback('change', 'stale.md');
    expect(listener.onChange).toHaveBeenCalledTimes(1);
  });

  it('does not lose concurrently registered subscribers or double-count duplicate IDs', async () => {
    const first = createListener();
    const second = createListener();
    await Promise.all([subscribe(WORKSPACE, 'first', first), subscribe(WORKSPACE, 'second', second)]);
    await subscribe(WORKSPACE, 'second', second);
    expect(mockFsWatch).toHaveBeenCalledTimes(1);
    fireWatchEvent('change', 'note.md');
    expect(first.onChange).toHaveBeenCalledTimes(1);
    expect(second.onChange).toHaveBeenCalledTimes(1);
    unsubscribe(WORKSPACE, 'first');
    unsubscribe(WORKSPACE, 'second');
    expect(getBusEntryCount()).toBe(0);
  });

  it('closes the watcher on the next tick after a native failure', async () => {
    await subscribe(WORKSPACE, 'sub', createListener());
    const close = latestCloseMock();

    fireBurst(100);
    nativeError('EMFILE');
    expect(close).not.toHaveBeenCalled();

    await flushImmediate();

    expect(close).toHaveBeenCalledTimes(1);
    // Logical subscribers remain registered while the native handle recovers.
    expect(getBusEntryCount()).toBe(1);
  });

  it('closes exactly once even when the burst keeps delivering after a native failure', async () => {
    await subscribe(WORKSPACE, 'sub', createListener());
    const close = latestCloseMock();

    // Fail, then keep hammering events and errors in the same synchronous burst.
    fireBurst(100);
    nativeError('EMFILE');
    fireBurst(CIRCUIT_BREAKER_THRESHOLD + 130);
    nativeError('EMFILE');

    expect(close).not.toHaveBeenCalled();
    await flushImmediate();

    expect(close).toHaveBeenCalledTimes(1);
  });

  it('does not trip for event volume below the threshold', async () => {
    await subscribe(WORKSPACE, 'sub', createListener());
    const close = latestCloseMock();

    fireBurst(CIRCUIT_BREAKER_THRESHOLD - 100);
    await flushImmediate();

    expect(close).not.toHaveBeenCalled();
    expect(getBusEntryCount()).toBe(1);

    unsubscribe(WORKSPACE, 'sub');
  });

  it('C2: keeps the native handle through a backlog overflow and resyncs its subscribers', async () => {
    const { states, listener, changed } = recordingListener();
    await subscribe(WORKSPACE, 'overflow', listener);
    const close = latestCloseMock();

    fireBurst(CIRCUIT_BREAKER_THRESHOLD + 130);
    fireWatchEvent('change', 'after-drop.md');
    await vi.waitFor(() => expect(states).toHaveLength(4));

    expect(states).toEqual([
      expect.objectContaining({ state: 'starting' }),
      expect.objectContaining({ state: 'watching' }),
      expect.objectContaining({ state: 'recovering', reason: 'event_queue_overflow' }),
      expect.objectContaining({ state: 'watching' }),
    ]);
    // The dropped backlog is gone; everything after it arrived, in order.
    const files = changed();
    // The burst and the event after it, less the 16,384 dropped.
    expect(files).toHaveLength(CIRCUIT_BREAKER_THRESHOLD + 130 + 1 - CIRCUIT_BREAKER_THRESHOLD);
    expect(files.at(-1)).toBe(`${WORKSPACE}/after-drop.md`);
    const indices = files.slice(0, -1).map(file => Number(/file-(\d+)/.exec(file)![1]));
    expect(indices).toEqual([...indices].sort((a, b) => a - b));
    await flushImmediate();
    expect(mockFsWatch).toHaveBeenCalledTimes(1);
    expect(close).not.toHaveBeenCalled();
    fireWatchEvent('change', 'later.md');
    expect(listener.onChange).toHaveBeenLastCalledWith(`${WORKSPACE}/later.md`, undefined);
    expect(states).toHaveLength(4);
  });

  it('C3: publishes one recovering and one watching for repeated overflows, after the last backlog is delivered', async () => {
    vi.mocked(logger.main.warn).mockClear();
    vi.mocked(logger.main.info).mockClear();
    const { states, listener, changed } = recordingListener();
    let deliveredAtWatching = -1;
    listener.onHealthChanged = (health) => {
      states.push(health);
      if (health.state === 'watching') deliveredAtWatching = changed().length;
    };
    await subscribe(WORKSPACE, 'storm', listener);

    fireBurst(CIRCUIT_BREAKER_THRESHOLD + 130);
    fireBurst(CIRCUIT_BREAKER_THRESHOLD + 130, 'second');
    await vi.waitFor(() => expect(states).toHaveLength(4));
    for (let i = 0; i < 5; i++) await flushImmediate();

    expect(states.map(health => health.state)).toEqual(['starting', 'watching', 'recovering', 'watching']);
    expect(deliveredAtWatching).toBe(changed().length);
    expect(changed().at(-1)).toBe(`${WORKSPACE}/src/second-${CIRCUIT_BREAKER_THRESHOLD + 129}.ts`);
    expect(mockFsWatch).toHaveBeenCalledTimes(1);
    // One warn when the episode starts and one info when it ends; nothing per event or per drop.
    expect(vi.mocked(logger.main.warn).mock.calls).toEqual([[
      '[WorkspaceEventBus] Watcher health:',
      expect.objectContaining({ state: 'recovering', reason: 'event_queue_overflow', dropped: CIRCUIT_BREAKER_THRESHOLD }),
    ]]);
    expect(vi.mocked(logger.main.info).mock.calls).toEqual([[
      '[WorkspaceEventBus] Watcher health:',
      expect.objectContaining({ state: 'watching', dropped: 2 * CIRCUIT_BREAKER_THRESHOLD, durationMs: expect.any(Number) }),
    ]]);
  });

  it('C4: a native error during an overflow episode closes the handle and retries on the normal schedule', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    const { states, listener, changed } = recordingListener();
    await subscribe(WORKSPACE, 'episode-error', listener);
    const close = latestCloseMock();

    fireBurst(CIRCUIT_BREAKER_THRESHOLD + 130);
    const delivered = changed().length;
    nativeError('EMFILE');
    expect(states.at(-1)).toMatchObject({ state: 'recovering', reason: 'EMFILE', nextRetryAt: Date.now() + 1000 });
    expect(close).not.toHaveBeenCalled();
    await flushImmediate();
    expect(close).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(999);
    expect(mockFsWatch).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(mockFsWatch).toHaveBeenCalledTimes(2);
    // The retired handle's backlog and resync never reach subscribers.
    expect(changed()).toHaveLength(delivered);
    expect(states.map(health => health.state)).toEqual(['starting', 'watching', 'recovering', 'recovering', 'starting', 'watching']);

    // The replacement starts clean: its own overflow opens a new episode.
    fireBurst(CIRCUIT_BREAKER_THRESHOLD + 130, 'replacement');
    await vi.waitFor(() => expect(states).toHaveLength(8));
    expect(states.slice(6)).toEqual([
      expect.objectContaining({ state: 'recovering', reason: 'event_queue_overflow' }),
      expect.objectContaining({ state: 'watching' }),
    ]);
  });

  it('C4: stopping during an overflow episode closes the kept handle and publishes nothing more', async () => {
    vi.mocked(logger.main.debug).mockClear();
    const { states, listener, changed } = recordingListener();
    await subscribe(WORKSPACE, 'episode-stop', listener);
    const close = latestCloseMock();

    fireBurst(CIRCUIT_BREAKER_THRESHOLD + 130);
    fireBurst(1000, 'late');
    await flushImmediate();
    // One batch of the backlog after the drop is out; the handle is still open.
    expect(close).not.toHaveBeenCalled();
    expect(states.at(-1)).toMatchObject({ state: 'recovering', reason: 'event_queue_overflow' });

    const delivered = changed().length;
    unsubscribe(WORKSPACE, 'episode-stop');
    expect(close).toHaveBeenCalledTimes(1);
    expect(logger.main.debug).toHaveBeenCalledWith(
      '[WorkspaceEventBus] Watcher health:',
      expect.objectContaining({ state: 'stopped', workspacePath: WORKSPACE }),
    );
    for (let i = 0; i < 10; i++) await flushImmediate();
    expect(changed()).toHaveLength(delivered);
    expect(states.map(health => health.state)).toEqual(['starting', 'watching', 'recovering', 'stopped']);
    expect(mockFsWatch).toHaveBeenCalledTimes(1);
    expect(getBusEntryCount()).toBe(0);
  });
});


it('delivers an ordinary checkout burst without retiring its native watcher', async () => {
  resetBus();
  const listener = createListener();
  await subscribe(WORKSPACE, 'checkout', listener);
  const close = latestCloseMock();
  fireBurst(7500);
  await vi.waitFor(() => expect(listener.onChange).toHaveBeenCalledTimes(7500));
  expect(close).not.toHaveBeenCalled();
  unsubscribe(WORKSPACE, 'checkout');
});
