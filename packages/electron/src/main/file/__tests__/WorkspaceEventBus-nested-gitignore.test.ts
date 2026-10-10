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
} from '../WorkspaceEventBus';
import type { WorkspaceEventListener } from '../WorkspaceEventBus';

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

    expect(listener.onChange).not.toHaveBeenCalled();
    unsubscribe(layout.workspace, 'sub-1');
  });

  it('still dispatches files outside the nested ignore', async () => {
    const listener = createListener();
    await subscribe(layout.workspace, 'sub-1', listener);

    fireWatchEvent('change', 'nested/src/app.ts');

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
    expect(listener.onChange).not.toHaveBeenCalled();

    fs.writeFileSync(path.join(layout.workspace, 'nested', '.gitignore'), '/dist\n');
    fireWatchEvent('change', 'nested/.gitignore');
    fireWatchEvent('change', 'nested/rootfs/etc/foo.txt');

    expect(listener.onChange).toHaveBeenCalledWith(
      path.join(layout.workspace, 'nested/rootfs/etc/foo.txt'),
      undefined,
    );
    unsubscribe(layout.workspace, 'sub-1');
  });

  it('does not deliver structure events for nested-ignored paths to listeners that did not opt in', async () => {
    const listener = createListener();
    listener.receiveGitignoredStructureEvents = false;
    await subscribe(layout.workspace, 'sub-1', listener);

    fireWatchEvent('rename', 'nested/rootfs/etc/foo.txt');

    // Wait briefly for the async exists-check inside the rename branch
    await new Promise((resolve) => setTimeout(resolve, 30));

    expect(listener.onAdd).not.toHaveBeenCalled();
    expect(listener.onUnlink).not.toHaveBeenCalled();
    unsubscribe(layout.workspace, 'sub-1');
  });

  it('delivers structure events for nested-ignored paths to listeners that opt in', async () => {
    const listener = createListener();
    listener.receiveGitignoredStructureEvents = true;
    await subscribe(layout.workspace, 'sub-1', listener);

    fireWatchEvent('rename', 'nested/rootfs/etc/foo.txt');

    await new Promise((resolve) => setTimeout(resolve, 30));

    // Path exists on disk, so the rename resolves to an `add`.
    expect(listener.onAdd).toHaveBeenCalledWith(
      path.join(layout.workspace, 'nested/rootfs/etc/foo.txt'),
      true,
    );
    unsubscribe(layout.workspace, 'sub-1');
  });
});

/**
 * An umbrella repo that ignores the separate clones inside it. Its own rules
 * stop at each clone's boundary, as in git: a clone's files follow the clone's
 * `.gitignore`. The umbrella's own linked worktrees keep the umbrella's rules.
 *
 *   <workspace>/.git/                       (umbrella repo)
 *   <workspace>/.gitignore                  ("/clone/", "/member/", "/build/", "/.claude/")
 *   <workspace>/clone/.git/ + .gitignore    (separate clone, ignores "/dist")
 *   <workspace>/member/.git                 (linked worktree of another repo)
 *   <workspace>/build/out.js                (plain ignored output)
 *   <workspace>/.claude/worktrees/agent/    (linked worktree of the umbrella)
 */
function buildUmbrellaLayout(): { workspace: string; cleanup: () => void } {
  const baseDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nimbalyst-test-'));
  const parent = path.join(baseDir, 'parent');
  fs.mkdirSync(parent, { recursive: true });
  const workspace = fs.mkdtempSync(path.join(parent, 'wsbus-umbrella-'));
  const write = (rel: string, content = '') => {
    fs.mkdirSync(path.dirname(path.join(workspace, rel)), { recursive: true });
    fs.writeFileSync(path.join(workspace, rel), content);
  };
  const linkWorktree = (rel: string, gitDir: string) => {
    fs.mkdirSync(gitDir, { recursive: true });
    fs.writeFileSync(path.join(gitDir, 'commondir'), '../..\n');
    write(`${rel}/.git`, `gitdir: ${gitDir}\n`);
  };
  fs.mkdirSync(path.join(workspace, '.git'), { recursive: true });
  write('.gitignore', '/clone/\n/member/\n/build/\n/.claude/\n');
  fs.mkdirSync(path.join(workspace, 'clone', '.git'), { recursive: true });
  write('clone/.gitignore', '/dist\n');
  write('clone/src/app.ts');
  write('clone/dist/bundle.js');
  write('build/out.js');
  linkWorktree('member', path.join(baseDir, 'other-repo', '.git', 'worktrees', 'member'));
  write('member/src/api.ts');
  linkWorktree('.claude/worktrees/agent', path.join(workspace, '.git', 'worktrees', 'agent'));
  write('.claude/worktrees/agent/src/agent.ts');
  return { workspace, cleanup: () => fs.rmSync(baseDir, { recursive: true, force: true }) };
}

describe('WorkspaceEventBus umbrella repo with ignored clones', () => {
  let layout: { workspace: string; cleanup: () => void };

  beforeEach(() => {
    mockWatcherCallbacks.length = 0;
    mockFsWatch.mockClear();
    resetBus();
    layout = buildUmbrellaLayout();
  });

  afterEach(() => {
    resetBus();
    layout.cleanup();
  });

  it("delivers a clone's files and another repo's worktree, by their own rules", async () => {
    const listener = createListener();
    await subscribe(layout.workspace, 'sub-1', listener);

    fireWatchEvent('change', 'clone/src/app.ts');
    fireWatchEvent('change', 'member/src/api.ts');
    fireWatchEvent('change', 'clone/dist/bundle.js');

    expect(listener.changes.map((change) => change.path)).toEqual([
      path.join(layout.workspace, 'clone/src/app.ts'),
      path.join(layout.workspace, 'member/src/api.ts'),
    ]);
    unsubscribe(layout.workspace, 'sub-1');
  });

  it("keeps dropping the umbrella's ignored output and its own linked worktrees", async () => {
    const listener = createListener();
    await subscribe(layout.workspace, 'sub-1', listener);

    fireWatchEvent('change', 'build/out.js');
    fireWatchEvent('change', '.claude/worktrees/agent/src/agent.ts');

    expect(listener.onChange).not.toHaveBeenCalled();
    unsubscribe(layout.workspace, 'sub-1');
  });
});
