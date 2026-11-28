/**
 * Tests for nested-repo .gitignore handling in WorkspaceEventBus.
 *
 * Covers issue #207: a non-git workspace root containing nested git repos.
 * The watcher must honor each nested repo's .gitignore so that build-output
 * trees the nested repo already excludes do not flood the watcher.
 *
 * These tests mock fs.watch (so events can be fired synthetically) but use
 * the real filesystem and real `ignore` package, so on-disk .git and .gitignore
 * files drive the behavior end-to-end.
 *
 * A backlog overflow keeps the native handle but loses the events it dropped,
 * which can include a .gitignore change; the rules on disk apply once the
 * overflow episode ends.
 */

import { describe, it, expect, beforeEach, afterEach, afterAll, vi } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

// ---------------------------------------------------------------------------
// Hoisted mocks — must run before vi.mock() factories
// ---------------------------------------------------------------------------

const { mockFsWatch, mockWatcherCallbacks, originalPlatform } = vi.hoisted(() => {
  // Force fs.watch recursive path (macOS/Windows) even on Linux CI,
  // since this test mocks fs.watch, not chokidar.
  const originalPlatform = process.platform;
  Object.defineProperty(process, 'platform', { value: 'darwin', writable: true });
  const mockWatcherCallbacks: Array<(eventType: string, filename: string | null) => void> = [];
  const mockFsWatch = vi.fn((_path: string, _opts: unknown, callback: (eventType: string, filename: string | null) => void) => {
    mockWatcherCallbacks.push(callback);
    return {
      close: vi.fn(),
      on: vi.fn().mockReturnThis(),
    };
  });
  return { mockFsWatch, mockWatcherCallbacks, originalPlatform };
});

vi.mock('fs', async () => {
  const actual = await vi.importActual<typeof import('fs')>('fs');
  return { ...actual, watch: mockFsWatch };
});

// Stub chokidar — not used on darwin but the import path runs.
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
    main: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
    workspaceWatcher: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
  },
}));

vi.mock('../../utils/workspaceDetection', () => ({
  isPathInWorkspace: (filePath: string, workspacePath: string) => {
    if (!filePath || !workspacePath) return false;
    return filePath === workspacePath || filePath.startsWith(workspacePath + '/');
  },
}));

import {
  subscribe,
  unsubscribe,
  resetBus,
  drainWorkspaceEvents,
  setGitignoreChangeHandler,
} from '../WorkspaceEventBus';
import type { WorkspaceEventListener } from '../WorkspaceEventBus';
import type { FileWatchHealth } from '../../../shared/fileWatchHealth';

function createListener(): WorkspaceEventListener & {
  changes: Array<{ path: string; type: string; bypassed?: boolean }>;
} {
  const changes: Array<{ path: string; type: string; bypassed?: boolean }> = [];
  return {
    changes,
    receiveGitignoredStructureEvents: false,
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

function fireWatchEvent(eventType: string, filename: string) {
  const cb = mockWatcherCallbacks[mockWatcherCallbacks.length - 1];
  if (!cb) throw new Error('No watcher callback registered');
  cb(eventType, filename);
}

/**
 * Build the issue #207 layout on disk:
 *   <workspace>/                 (no .git, no .gitignore)
 *     nested/.git/               (nested repo)
 *     nested/.gitignore          (lists "/rootfs")
 *     nested/src/app.ts
 *     nested/rootfs/etc/foo.txt
 */
function buildIssue207Layout(): { workspace: string; cleanup: () => void } {
  // Nest under an extra parent so the workspace is never a bare container dir
  // like /tmp, which the bus refuses to watch.
  const baseDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nimbalyst-test-'));
  const parent = path.join(baseDir, 'parent');
  fs.mkdirSync(parent, { recursive: true });
  const workspace = fs.mkdtempSync(path.join(parent, 'wsbus-nested-'));
  const nested = path.join(workspace, 'nested');
  fs.mkdirSync(path.join(nested, '.git'), { recursive: true });
  fs.writeFileSync(path.join(nested, '.gitignore'), '/rootfs\n');
  fs.mkdirSync(path.join(nested, 'src'), { recursive: true });
  fs.writeFileSync(path.join(nested, 'src', 'app.ts'), '');
  fs.mkdirSync(path.join(nested, 'rootfs', 'etc'), { recursive: true });
  fs.writeFileSync(path.join(nested, 'rootfs', 'etc', 'foo.txt'), '');
  return {
    workspace,
    cleanup: () => fs.rmSync(baseDir, { recursive: true, force: true }),
  };
}

describe('WorkspaceEventBus nested-repo .gitignore (issue #207)', () => {
  let layout: { workspace: string; cleanup: () => void };

  beforeEach(() => {
    mockWatcherCallbacks.length = 0;
    mockFsWatch.mockClear();
    resetBus();
    layout = buildIssue207Layout();
  });

  afterEach(() => {
    resetBus();
    layout.cleanup();
  });

  afterAll(() => {
    Object.defineProperty(process, 'platform', { value: originalPlatform, writable: true });
  });

  it('drops content events for files inside a nested-repo gitignored dir', async () => {
    const listener = createListener();
    await subscribe(layout.workspace, 'sub-1', listener);

    fireWatchEvent('change', 'nested/rootfs/etc/foo.txt');
    await drainWorkspaceEvents(layout.workspace);

    expect(listener.onChange).not.toHaveBeenCalled();
    unsubscribe(layout.workspace, 'sub-1');
  });

  it('still dispatches files outside the nested ignore', async () => {
    const listener = createListener();
    await subscribe(layout.workspace, 'sub-1', listener);

    fireWatchEvent('change', 'nested/src/app.ts');
    await drainWorkspaceEvents(layout.workspace);

    expect(listener.onChange).toHaveBeenCalledWith(
      path.join(layout.workspace, 'nested/src/app.ts'),
      undefined,
    );
    unsubscribe(layout.workspace, 'sub-1');
  });

  it('reloads a nested repo .gitignore when it changes on disk', async () => {
    const listener = createListener();
    await subscribe(layout.workspace, 'sub-1', listener);

    fireWatchEvent('change', 'nested/rootfs/etc/foo.txt');
    await drainWorkspaceEvents(layout.workspace);
    expect(listener.onChange).not.toHaveBeenCalled();

    fs.writeFileSync(path.join(layout.workspace, 'nested', '.gitignore'), '/dist\n');
    fireWatchEvent('change', 'nested/.gitignore');
    fireWatchEvent('change', 'nested/rootfs/etc/foo.txt');
    // Events past the watcher's per-batch time budget are delivered on a later
    // turn, and reloading the .gitignore can use that budget up on a busy machine.
    await drainWorkspaceEvents(layout.workspace);

    expect(listener.onChange).toHaveBeenCalledWith(
      path.join(layout.workspace, 'nested/rootfs/etc/foo.txt'),
      undefined,
    );
    unsubscribe(layout.workspace, 'sub-1');
  });

  /** A recording listener whose `recovered` resolves at the first `watching` after a `recovering`. */
  function episodeListener() {
    const listener = createListener();
    const states: FileWatchHealth[] = [];
    let resolve!: () => void;
    const recovered = new Promise<void>(done => { resolve = done; });
    listener.onHealthChanged = (health) => {
      states.push(health);
      if (health.state === 'watching' && states.some(state => state.state === 'recovering')) resolve();
    };
    return { listener, states, recovered };
  }

  /**
   * A checkout-sized storm that overflows the event backlog, then the end of
   * its episode. What `dropped` writes and fires queues behind the first 200
   * events, so the overflow drops it; with `afterFirstDrop` the episode's
   * first overflow has already happened and a second one drops it.
   */
  async function overflowDropping(episode: ReturnType<typeof episodeListener>, dropped: () => void, afterFirstDrop = false) {
    for (let i = 0; i < 200; i++) fireWatchEvent('change', `src/a-${i}.ts`);
    if (afterFirstDrop) for (let i = 0; i < 16_600; i++) fireWatchEvent('change', `src/z-${i}.ts`);
    dropped();
    for (let i = 0; i < 16_600; i++) fireWatchEvent('change', `src/b-${i}.ts`);
    await episode.recovered;
    await drainWorkspaceEvents(layout.workspace);
    // The handle was kept, and the rule changes never reached the bus.
    expect(mockFsWatch).toHaveBeenCalledTimes(1);
    expect(episode.states).toContainEqual(expect.objectContaining({ state: 'recovering', reason: 'event_queue_overflow' }));
    expect(episode.listener.changes.filter(change => /\/\.git(ignore)?$/.test(change.path))).toEqual([]);
    episode.listener.changes.length = 0;
  }

  /** The workspace root ignores generated/, which holds a file. */
  function ignoreGeneratedAtRoot() {
    fs.writeFileSync(path.join(layout.workspace, '.gitignore'), 'generated/\n');
    fs.mkdirSync(path.join(layout.workspace, 'generated'));
    fs.writeFileSync(path.join(layout.workspace, 'generated', 'api.ts'), 'export {}\n');
  }

  it('N1: honours a root .gitignore change that an overflow dropped once the episode ends', async () => {
    ignoreGeneratedAtRoot();
    const gitViews = vi.fn();
    setGitignoreChangeHandler(gitViews);
    const episode = episodeListener();
    await subscribe(layout.workspace, 'sub-1', episode.listener);
    fireWatchEvent('change', 'generated/api.ts');
    await drainWorkspaceEvents(layout.workspace);
    expect(episode.listener.changes).toEqual([]);

    // The branch the checkout lands on ignores dist/ instead of generated/.
    await overflowDropping(episode, () => {
      fs.writeFileSync(path.join(layout.workspace, '.gitignore'), 'dist/\n');
      fireWatchEvent('change', '.gitignore');
    });

    fireWatchEvent('change', 'generated/api.ts');
    fireWatchEvent('change', 'dist/app.js');
    await drainWorkspaceEvents(layout.workspace);
    expect(episode.listener.changes.map(change => change.path)).toEqual([path.join(layout.workspace, 'generated/api.ts')]);
    // Git views refresh as after a .gitignore edit the bus saw.
    expect(gitViews).toHaveBeenCalledExactlyOnceWith(layout.workspace);
    setGitignoreChangeHandler(null);
  });

  it('N1: honours a .gitignore change that a later overflow of the same episode dropped', async () => {
    ignoreGeneratedAtRoot();
    const episode = episodeListener();
    await subscribe(layout.workspace, 'sub-1', episode.listener);

    await overflowDropping(episode, () => {
      fs.writeFileSync(path.join(layout.workspace, '.gitignore'), 'dist/\n');
      fireWatchEvent('change', '.gitignore');
    }, true);
    expect(episode.states.filter(state => state.state === 'recovering')).toHaveLength(1);

    fireWatchEvent('change', 'generated/api.ts');
    await drainWorkspaceEvents(layout.workspace);
    expect(episode.listener.changes.map(change => change.path)).toEqual([path.join(layout.workspace, 'generated/api.ts')]);
  });

  it('N1: honours a nested repo .gitignore change that an overflow dropped once the episode ends', async () => {
    const episode = episodeListener();
    await subscribe(layout.workspace, 'sub-1', episode.listener);
    fireWatchEvent('change', 'nested/rootfs/etc/foo.txt');
    await drainWorkspaceEvents(layout.workspace);
    expect(episode.listener.changes).toEqual([]);

    await overflowDropping(episode, () => {
      fs.writeFileSync(path.join(layout.workspace, 'nested', '.gitignore'), '/dist\n');
      fireWatchEvent('change', 'nested/.gitignore');
    });

    fireWatchEvent('change', 'nested/rootfs/etc/foo.txt');
    fireWatchEvent('change', 'nested/dist/out.js');
    await drainWorkspaceEvents(layout.workspace);
    expect(episode.listener.changes.map(change => change.path)).toEqual([path.join(layout.workspace, 'nested/rootfs/etc/foo.txt')]);
  });

  it('N1: applies the rules of a nested repo whose creation an overflow dropped', async () => {
    const other = path.join(layout.workspace, 'other');
    fs.mkdirSync(path.join(other, 'artifacts'), { recursive: true });
    fs.writeFileSync(path.join(other, 'artifacts', 'out.txt'), '');
    fs.writeFileSync(path.join(other, 'main.ts'), '');
    const episode = episodeListener();
    await subscribe(layout.workspace, 'sub-1', episode.listener);
    fireWatchEvent('change', 'other/artifacts/out.txt');
    await drainWorkspaceEvents(layout.workspace);
    expect(episode.listener.changes.map(change => change.path)).toEqual([path.join(other, 'artifacts/out.txt')]);

    // A clone into other/ makes it a repo that ignores artifacts/.
    await overflowDropping(episode, () => {
      fs.mkdirSync(path.join(other, '.git'));
      fs.writeFileSync(path.join(other, '.gitignore'), 'artifacts/\n');
      fireWatchEvent('rename', 'other/.git');
      fireWatchEvent('rename', 'other/.gitignore');
    });

    fireWatchEvent('change', 'other/artifacts/out.txt');
    fireWatchEvent('change', 'other/main.ts');
    await drainWorkspaceEvents(layout.workspace);
    expect(episode.listener.changes.map(change => change.path)).toEqual([path.join(other, 'main.ts')]);
  });

  it('does not deliver structure events for nested-ignored paths to listeners that did not opt in', async () => {
    const listener = createListener();
    listener.receiveGitignoredStructureEvents = false;
    await subscribe(layout.workspace, 'sub-1', listener);

    fireWatchEvent('rename', 'nested/rootfs/etc/foo.txt');

    // Wait for the async exists-check inside the rename branch
    await drainWorkspaceEvents(layout.workspace);

    expect(listener.onAdd).not.toHaveBeenCalled();
    expect(listener.onUnlink).not.toHaveBeenCalled();
    unsubscribe(layout.workspace, 'sub-1');
  });

  it('delivers structure events for nested-ignored paths to listeners that opt in', async () => {
    const listener = createListener();
    listener.receiveGitignoredStructureEvents = true;
    await subscribe(layout.workspace, 'sub-1', listener);

    fireWatchEvent('rename', 'nested/rootfs/etc/foo.txt');

    await drainWorkspaceEvents(layout.workspace);

    // Path exists on disk, so the rename resolves to an `add`.
    expect(listener.onAdd).toHaveBeenCalledWith(
      path.join(layout.workspace, 'nested/rootfs/etc/foo.txt'),
      true,
    );
    unsubscribe(layout.workspace, 'sub-1');
  });
});
