/**
 * Tests for the WorkspaceEventBus circuit breaker teardown (issue #629).
 *
 * On macOS, `fs.watch(recursive:true)` is FSEvents-backed and closing the
 * watcher synchronously from inside its own delivery callback can abort Electron
 * (SIGABRT/SIGTRAP). When an event storm trips the circuit breaker we must:
 *  - NOT close the watcher synchronously inside the watch callback,
 *  - close it on a later tick (setImmediate), and
 *  - close it exactly once no matter how many events arrive in the burst.
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

// Mirrors the private constant in WorkspaceEventBus. The breaker trips when the
// oldest entry in the ring buffer (size THRESHOLD) is still within the window,
// which happens one event after the buffer first wraps — i.e. event THRESHOLD+1.
const CIRCUIT_BREAKER_THRESHOLD = 5000;

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
function fireBurst(count: number) {
  for (let i = 0; i < count; i++) {
    fireWatchEvent('change', `src/file-${i}.ts`);
  }
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
  });

  afterAll(() => {
    Object.defineProperty(process, 'platform', { value: originalPlatform, writable: true });
  });

  it('does NOT close the watcher synchronously inside the burst callback', async () => {
    await subscribe(WORKSPACE, 'sub', createListener());
    const close = latestCloseMock();

    // Enough events to trip the breaker (THRESHOLD + buffer wrap + 1).
    fireBurst(CIRCUIT_BREAKER_THRESHOLD + 2);

    // The close must be deferred — calling it synchronously from inside the
    // FSEvents delivery callback is what crashes Electron.
    expect(close).not.toHaveBeenCalled();
  });

  it('closes the watcher on the next tick after tripping', async () => {
    await subscribe(WORKSPACE, 'sub', createListener());
    const close = latestCloseMock();

    fireBurst(CIRCUIT_BREAKER_THRESHOLD + 2);
    expect(close).not.toHaveBeenCalled();

    await flushImmediate();

    expect(close).toHaveBeenCalledTimes(1);
    // Registry entry is removed synchronously when the breaker trips.
    expect(getBusEntryCount()).toBe(0);
  });

  it('closes exactly once even when the burst keeps delivering after the trip', async () => {
    await subscribe(WORKSPACE, 'sub', createListener());
    const close = latestCloseMock();

    // Trip, then keep hammering events in the same synchronous burst.
    fireBurst(CIRCUIT_BREAKER_THRESHOLD + 2);
    fireBurst(2000);

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
});
