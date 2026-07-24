/**
 * Tests for gitignore bypass and replay buffer in WorkspaceEventBus.
 *
 * These tests mock fs.watch to control event dispatch and verify:
 * - Bypass set add/remove
 * - .md files pass through gitignore
 * - gitignoreBypassed flag is set correctly on dispatched events
 * - Replay buffer stores dropped events and replays on bypass registration
 * - OptimizedWorkspaceWatcher ignores bypassed events
 */

import { describe, it, expect, beforeEach, afterEach, afterAll, vi } from 'vitest';

// ---------------------------------------------------------------------------
// Hoisted mocks — must run before vi.mock() factories
// ---------------------------------------------------------------------------

const {
  mockFsWatch,
  mockWatcherCallbacks,
  mockFsAccess,
  mockGitignoreReadFile,
  mockGitignoreReadFileSync,
  originalPlatform,
} = vi.hoisted(() => {
  // Force fs.watch recursive path (macOS/Windows) even on Linux CI,
  // since this test mocks fs.watch, not chokidar.
  const originalPlatform = process.platform;
  Object.defineProperty(process, 'platform', { value: 'darwin', writable: true });
  const mockWatcherCallbacks: Array<(eventType: string, filename: string | null) => void> = [];
  const mockFsWatch = vi.fn((_path: string, _opts: any, callback: any) => {
    mockWatcherCallbacks.push(callback);
    return {
      close: vi.fn(),
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
    mockFsAccess,
    mockGitignoreReadFile,
    mockGitignoreReadFileSync,
    originalPlatform,
  };
});

// Mock fs module
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

// Mock chokidar (not used on macOS/Windows but needs to be present)
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

// Mock logger
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

// Mock workspaceDetection to avoid electron/store imports
vi.mock('../../utils/workspaceDetection', () => ({
  isPathInWorkspace: (filePath: string, workspacePath: string) => {
    if (!filePath || !workspacePath) return false;
    return filePath === workspacePath || filePath.startsWith(workspacePath + '/');
  },
}));

// Mock the `ignore` package with enough behavior for our test patterns.
vi.mock('ignore', () => {
  const createMatcher = () => {
    const rules: string[] = [];
    const matcher = {
      add: vi.fn((input: string | string[]) => {
        const lines = Array.isArray(input) ? input : String(input).split('\n');
        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed || trimmed.startsWith('#')) continue;
          rules.push(trimmed.replace(/^\//, '').replace(/\/$/, ''));
        }
        return matcher;
      }),
      ignores: (p: string) => {
        return rules.some((rule) => p === rule || p.startsWith(`${rule}/`));
      },
    };
    return matcher;
  };
  return { default: createMatcher };
});

// ---------------------------------------------------------------------------
// Import after mocks are set up
// ---------------------------------------------------------------------------

import {
  subscribe,
  unsubscribe,
  addGitignoreBypass,
  removeGitignoreBypass,
  hasGitignoreBypass,
  resetBus,
  setGitignoreChangeHandler,
} from '../WorkspaceEventBus';
import type { WorkspaceEventListener } from '../WorkspaceEventBus';

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

const WORKSPACE = '/Users/test/project';

function createListener(): WorkspaceEventListener & {
  changes: Array<{ path: string; type: string; bypassed?: boolean }>;
} {
  const changes: Array<{ path: string; type: string; bypassed?: boolean }> = [];
  return {
    changes,
    onChange: vi.fn((filePath: string, gitignoreBypassed?: boolean) => {
      changes.push({ path: filePath, type: 'change', bypassed: gitignoreBypassed });
    }),
    onAdd: vi.fn((filePath: string, gitignoreBypassed?: boolean) => {
      changes.push({ path: filePath, type: 'add', bypassed: gitignoreBypassed });
    }),
    onUnlink: vi.fn((filePath: string, gitignoreBypassed?: boolean) => {
      changes.push({ path: filePath, type: 'unlink', bypassed: gitignoreBypassed });
    }),
  };
}

/** Simulate an fs.watch event for the most recently created watcher. */
function fireWatchEvent(eventType: string, filename: string) {
  const cb = mockWatcherCallbacks[mockWatcherCallbacks.length - 1];
  if (!cb) throw new Error('No watcher callback registered');
  cb(eventType, filename);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('WorkspaceEventBus gitignore bypass', () => {
  beforeEach(() => {
    mockWatcherCallbacks.length = 0;
    mockFsWatch.mockClear();
    mockFsAccess.mockReset();
    mockFsAccess.mockResolvedValue(undefined);
    mockGitignoreReadFile.mockReset();
    mockGitignoreReadFile.mockResolvedValue('temp/\n');
    mockGitignoreReadFileSync.mockReset();
    mockGitignoreReadFileSync.mockReturnValue('temp/\n');
    setGitignoreChangeHandler(null);
    resetBus();
  });

  afterAll(() => {
    Object.defineProperty(process, 'platform', { value: originalPlatform, writable: true });
  });

  afterEach(() => {
    setGitignoreChangeHandler(null);
    resetBus();
  });

  describe('bypass set management', () => {
    it('adds and removes bypass paths', async () => {
      const listener = createListener();
      await subscribe(WORKSPACE, 'test-sub', listener);

      addGitignoreBypass(WORKSPACE, `${WORKSPACE}/temp/bundle.js`);
      expect(hasGitignoreBypass(WORKSPACE, `${WORKSPACE}/temp/bundle.js`)).toBe(true);

      removeGitignoreBypass(WORKSPACE, `${WORKSPACE}/temp/bundle.js`);
      expect(hasGitignoreBypass(WORKSPACE, `${WORKSPACE}/temp/bundle.js`)).toBe(false);

      unsubscribe(WORKSPACE, 'test-sub');
    });

    it('returns false for non-existent bypass', async () => {
      const listener = createListener();
      await subscribe(WORKSPACE, 'test-sub', listener);

      expect(hasGitignoreBypass(WORKSPACE, `${WORKSPACE}/temp/nope.js`)).toBe(false);

      unsubscribe(WORKSPACE, 'test-sub');
    });

    it('handles bypass for non-existent workspace gracefully', () => {
      addGitignoreBypass('/nonexistent', '/nonexistent/file.js');
      expect(hasGitignoreBypass('/nonexistent', '/nonexistent/file.js')).toBe(false);
    });
  });

  describe('event dispatch with bypass', () => {
    it('reloads the workspace .gitignore matcher when the file changes', async () => {
      const listener = createListener();
      const onGitignoreChange = vi.fn();
      setGitignoreChangeHandler(onGitignoreChange);

      mockGitignoreReadFile.mockResolvedValue('build/\n');
      mockGitignoreReadFileSync.mockReturnValue('temp/\n');

      await subscribe(WORKSPACE, 'test-sub', listener);

      fireWatchEvent('change', 'temp/bundle.js');
      expect(listener.onChange).toHaveBeenLastCalledWith(
        `${WORKSPACE}/temp/bundle.js`,
        undefined,
      );

      fireWatchEvent('change', '.gitignore');
      fireWatchEvent('change', 'temp/bundle.js');

      expect(onGitignoreChange).toHaveBeenCalledWith(WORKSPACE);
      expect(listener.changes.filter((change) => change.path.endsWith('temp/bundle.js'))).toHaveLength(1);
      expect(listener.changes.some((change) => change.path.endsWith('/.gitignore'))).toBe(true);

      unsubscribe(WORKSPACE, 'test-sub');
    });

    it('dispatches non-gitignored events without bypass flag', async () => {
      const listener = createListener();
      await subscribe(WORKSPACE, 'test-sub', listener);

      // src/app.ts is not gitignored
      fireWatchEvent('change', 'src/app.ts');

      expect(listener.onChange).toHaveBeenCalledWith(
        `${WORKSPACE}/src/app.ts`,
        undefined,
      );
      expect(listener.changes[0]?.bypassed).toBeUndefined();

      unsubscribe(WORKSPACE, 'test-sub');
    });

    it('drops gitignored events not in bypass set', async () => {
      const listener = createListener();
      await subscribe(WORKSPACE, 'test-sub', listener);

      // temp/ is gitignored, not bypassed
      fireWatchEvent('change', 'temp/bundle.js');

      expect(listener.onChange).not.toHaveBeenCalled();

      unsubscribe(WORKSPACE, 'test-sub');
    });

    it('dispatches bypassed gitignored events with flag', async () => {
      const listener = createListener();
      await subscribe(WORKSPACE, 'test-sub', listener);

      // Add bypass then fire event
      addGitignoreBypass(WORKSPACE, `${WORKSPACE}/temp/bundle.js`);
      fireWatchEvent('change', 'temp/bundle.js');

      expect(listener.onChange).toHaveBeenCalledWith(
        `${WORKSPACE}/temp/bundle.js`,
        true,
      );
      expect(listener.changes[0]?.bypassed).toBe(true);

      unsubscribe(WORKSPACE, 'test-sub');
    });

    it('dispatches .md files in gitignored dirs with bypass flag', async () => {
      const listener = createListener();
      await subscribe(WORKSPACE, 'test-sub', listener);

      // .md files always bypass gitignore (Condition 2)
      fireWatchEvent('change', 'temp/README.md');

      expect(listener.onChange).toHaveBeenCalledWith(
        `${WORKSPACE}/temp/README.md`,
        true,
      );

      unsubscribe(WORKSPACE, 'test-sub');
    });

    it('handles rename events (add/unlink) with bypass', async () => {
      const listener = createListener();
      await subscribe(WORKSPACE, 'test-sub', listener);

      addGitignoreBypass(WORKSPACE, `${WORKSPACE}/temp/output.js`);

      // Simulate a rename event — fs.access resolves means it's an add
      mockFsAccess.mockResolvedValue(undefined);
      fireWatchEvent('rename', 'temp/output.js');

      // Wait for the async fs.access check
      await vi.waitFor(() => {
        expect(listener.onAdd).toHaveBeenCalledWith(
          `${WORKSPACE}/temp/output.js`,
          true,
        );
      });

      unsubscribe(WORKSPACE, 'test-sub');
    });

    it('retries rename events before treating a delayed file as unlink', async () => {
      vi.useFakeTimers();

      const listener = createListener();
      await subscribe(WORKSPACE, 'test-sub', listener);

      addGitignoreBypass(WORKSPACE, `${WORKSPACE}/temp/output.js`);

      mockFsAccess
        .mockRejectedValueOnce(new Error('not yet visible'))
        .mockRejectedValueOnce(new Error('still not visible'))
        .mockResolvedValueOnce(undefined);

      fireWatchEvent('rename', 'temp/output.js');

      await vi.advanceTimersByTimeAsync(125);

      expect(listener.onAdd).toHaveBeenCalledWith(
        `${WORKSPACE}/temp/output.js`,
        true,
      );
      expect(listener.onUnlink).not.toHaveBeenCalled();

      unsubscribe(WORKSPACE, 'test-sub');
      vi.useRealTimers();
    });
  });

  describe('replay buffer', () => {
    it('replays dropped events when bypass is registered', async () => {
      const listener = createListener();
      await subscribe(WORKSPACE, 'test-sub', listener);

      // Fire event BEFORE bypass is registered — should be dropped
      fireWatchEvent('change', 'temp/bundle.js');
      expect(listener.onChange).not.toHaveBeenCalled();

      // Now register bypass — should replay the dropped event
      addGitignoreBypass(WORKSPACE, `${WORKSPACE}/temp/bundle.js`);

      expect(listener.onChange).toHaveBeenCalledWith(
        `${WORKSPACE}/temp/bundle.js`,
        true,
      );

      unsubscribe(WORKSPACE, 'test-sub');
    });

    it('does not replay expired events', async () => {
      // Use fake timers throughout so Date.now() is controlled
      vi.useFakeTimers({ now: 1000000 });

      const listener = createListener();
      await subscribe(WORKSPACE, 'test-sub', listener);

      // Fire event at t=1000000
      fireWatchEvent('change', 'temp/bundle.js');
      expect(listener.onChange).not.toHaveBeenCalled();

      // Advance past TTL (5s)
      vi.advanceTimersByTime(6000);

      // Register bypass at t=1006000 — expired events should NOT replay
      addGitignoreBypass(WORKSPACE, `${WORKSPACE}/temp/bundle.js`);
      expect(listener.onChange).not.toHaveBeenCalled();

      unsubscribe(WORKSPACE, 'test-sub');
      vi.useRealTimers();
    });

    it('does not replay events for unrelated paths', async () => {
      const listener = createListener();
      await subscribe(WORKSPACE, 'test-sub', listener);

      // Drop event for temp/a.js
      fireWatchEvent('change', 'temp/a.js');

      // Register bypass for temp/b.js — should NOT replay temp/a.js
      addGitignoreBypass(WORKSPACE, `${WORKSPACE}/temp/b.js`);

      expect(listener.onChange).not.toHaveBeenCalled();

      unsubscribe(WORKSPACE, 'test-sub');
    });
  });

  describe('gitignored structure events for tree refresh', () => {
    it('dispatches gitignored add events to opt-in listeners with bypassed=true', async () => {
      const treeListener = createListener();
      treeListener.receiveGitignoredStructureEvents = true;
      const aiListener = createListener();
      await subscribe(WORKSPACE, 'tree-sub', treeListener);
      await subscribe(WORKSPACE, 'ai-sub', aiListener);

      // temp/ is gitignored and not in the bypass set. The agent just ran
      // `mkdir temp` (or similar) and the file-tree sidebar needs to know.
      mockFsAccess.mockResolvedValue(undefined);
      fireWatchEvent('rename', 'temp');

      await vi.waitFor(() => {
        expect(treeListener.onAdd).toHaveBeenCalledWith(
          `${WORKSPACE}/temp`,
          true,
        );
      });
      // AI/editor listener still drops gitignored adds it isn't tracking.
      expect(aiListener.onAdd).not.toHaveBeenCalled();

      unsubscribe(WORKSPACE, 'tree-sub');
      unsubscribe(WORKSPACE, 'ai-sub');
    });

    it('dispatches gitignored unlink events to opt-in listeners with bypassed=true', async () => {
      const treeListener = createListener();
      treeListener.receiveGitignoredStructureEvents = true;
      const aiListener = createListener();
      await subscribe(WORKSPACE, 'tree-sub', treeListener);
      await subscribe(WORKSPACE, 'ai-sub', aiListener);

      // The path no longer exists on disk -> unlink.
      mockFsAccess.mockRejectedValue(new Error('ENOENT'));
      fireWatchEvent('rename', 'temp');

      await vi.waitFor(() => {
        expect(treeListener.onUnlink).toHaveBeenCalledWith(
          `${WORKSPACE}/temp`,
          true,
        );
      });
      expect(aiListener.onUnlink).not.toHaveBeenCalled();

      unsubscribe(WORKSPACE, 'tree-sub');
      unsubscribe(WORKSPACE, 'ai-sub');
    });

    it('still drops gitignored change events for opt-in listeners', async () => {
      const treeListener = createListener();
      treeListener.receiveGitignoredStructureEvents = true;
      await subscribe(WORKSPACE, 'tree-sub', treeListener);

      // Content edits to gitignored files don't shape the tree, so still drop.
      fireWatchEvent('change', 'temp/bundle.js');

      expect(treeListener.onChange).not.toHaveBeenCalled();

      unsubscribe(WORKSPACE, 'tree-sub');
    });
  });

  describe('hardcoded ignores are never bypassed', () => {
    it('rejects bypass registration for excluded build artifact directories', async () => {
      const listener = createListener();
      await subscribe(WORKSPACE, 'test-sub', listener);

      addGitignoreBypass(WORKSPACE, `${WORKSPACE}/.build/output.d`);
      expect(hasGitignoreBypass(WORKSPACE, `${WORKSPACE}/.build/output.d`)).toBe(false);

      fireWatchEvent('change', '.build/output.d');
      expect(listener.onChange).not.toHaveBeenCalled();

      unsubscribe(WORKSPACE, 'test-sub');
    });

    it('always filters .git paths regardless of bypass', async () => {
      const listener = createListener();
      await subscribe(WORKSPACE, 'test-sub', listener);

      addGitignoreBypass(WORKSPACE, `${WORKSPACE}/.git/HEAD`);
      fireWatchEvent('change', '.git/HEAD');

      expect(listener.onChange).not.toHaveBeenCalled();

      unsubscribe(WORKSPACE, 'test-sub');
    });

    it('always filters .DS_Store regardless of bypass', async () => {
      const listener = createListener();
      await subscribe(WORKSPACE, 'test-sub', listener);

      addGitignoreBypass(WORKSPACE, `${WORKSPACE}/.DS_Store`);
      fireWatchEvent('change', '.DS_Store');

      expect(listener.onChange).not.toHaveBeenCalled();

      unsubscribe(WORKSPACE, 'test-sub');
    });
  });
});
