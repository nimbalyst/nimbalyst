// @vitest-environment node
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
import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { assertGitSandbox, FIXTURE_IDENTITY_ARGS, gitSandboxEnv } from '../../services/testSupport/gitTestSandbox';

// ---------------------------------------------------------------------------
// Hoisted mocks — must run before vi.mock() factories
// ---------------------------------------------------------------------------

const { ignoredPredicates } = vi.hoisted(() => ({ ignoredPredicates: [] as Array<(filePath: string) => boolean> }));

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

// Record the `ignored` predicate the bus hands the native watcher. chokidar
// consults it on Linux to decide which folders to walk at all.
vi.mock('../WorkspaceNativeWatcher', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../WorkspaceNativeWatcher')>();
  return {
    ...actual,
    createWorkspaceNativeWatcher: (...args: Parameters<typeof actual.createWorkspaceNativeWatcher>) => {
      ignoredPredicates.push(args[3]);
      return actual.createWorkspaceNativeWatcher(...args);
    },
  };
});

// The faked darwin platform makes the availability probe run xcode-select,
// which Linux lacks. Every machine that runs this file has git: it runs git init.
vi.mock('../../utils/gitUtils', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../utils/gitUtils')>()),
  isGitAvailable: () => true,
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

// The bus runs git itself, so its own environment is sandboxed: no inherited
// GIT_* from a hook, and HOME, XDG_CONFIG_HOME and git's config files point at
// an empty temp dir so this machine's excludes file cannot leak in.
const originalEnv = { ...process.env };
let sandbox: string;

function replaceProcessEnv(next: NodeJS.ProcessEnv): void {
  for (const key of Object.keys(process.env)) if (!(key in next)) delete process.env[key];
  Object.assign(process.env, next);
}

beforeEach(() => {
  sandbox = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'nimbalyst-gitenv-')));
  replaceProcessEnv({ ...gitSandboxEnv(), HOME: path.join(sandbox, 'home'), XDG_CONFIG_HOME: path.join(sandbox, 'xdg') });
});

afterEach(() => {
  replaceProcessEnv(originalEnv);
  fs.rmSync(sandbox, { recursive: true, force: true });
});

function git(cwd: string, ...args: string[]): void {
  execFileSync('git', args, { cwd, stdio: 'pipe', env: gitSandboxEnv() });
}

/** A fresh repository at `<sandbox>/<name>`. */
function initRepo(name: string): string {
  const repo = path.join(sandbox, name);
  fs.mkdirSync(repo, { recursive: true });
  git(repo, 'init', '--initial-branch=main');
  return repo;
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

describe('WorkspaceEventBus .git/info/exclude and core.excludesFile', () => {
  beforeEach(() => {
    mockWatcherCallbacks.length = 0;
    mockFsWatch.mockClear();
    ignoredPredicates.length = 0;
    resetBus();
  });

  afterEach(() => {
    resetBus();
  });

  /** Subscribe, fire a content change per relative path, drain, and report what arrived. */
  async function deliveredChanges(workspace: string, ...relativePaths: string[]) {
    const listener = createListener();
    await subscribe(workspace, 'sub-1', listener);
    for (const relativePath of relativePaths) fireWatchEvent('change', relativePath);
    await drainWorkspaceEvents(workspace);
    const ignored = ignoredPredicates[ignoredPredicates.length - 1];
    return {
      delivered: listener.changes.map((change) => path.relative(workspace, change.path)),
      ignored: (relativePath: string) => ignored(path.join(workspace, relativePath)),
    };
  }

  it('B1: drops a folder excluded only by .git/info/exclude', async () => {
    const workspace = initRepo('repo');
    fs.writeFileSync(path.join(workspace, '.gitignore'), 'node_modules/\n');
    fs.writeFileSync(path.join(workspace, '.git', 'info', 'exclude'), '/scratch/\n');

    const { delivered, ignored } = await deliveredChanges(workspace, 'scratch/a.txt', 'docs/b.md');

    expect(delivered).toEqual(['docs/b.md']);
    expect(ignored('scratch')).toBe(true);
    expect(ignored('docs')).toBe(false);
  });

  it("B2: a linked worktree honours the main repository's info/exclude", async () => {
    const main = initRepo('main');
    assertGitSandbox(main);
    git(main, ...FIXTURE_IDENTITY_ARGS, 'commit', '--allow-empty', '-m', 'init');
    const workspace = path.join(sandbox, 'linked');
    git(main, 'worktree', 'add', '-b', 'feature', workspace);
    fs.writeFileSync(path.join(main, '.git', 'info', 'exclude'), '/scratch/\n');

    const { delivered, ignored } = await deliveredChanges(workspace, 'scratch/a.txt', 'docs/b.md');

    expect(delivered).toEqual(['docs/b.md']);
    expect(ignored('scratch')).toBe(true);
  });

  it('B3: honours core.excludesFile set in the repository config', async () => {
    const workspace = initRepo('repo');
    const excludesFile = path.join(sandbox, 'globalignore');
    fs.writeFileSync(excludesFile, '/scratch/\n');
    git(workspace, 'config', 'core.excludesFile', excludesFile);

    const { delivered, ignored } = await deliveredChanges(workspace, 'scratch/a.txt', 'docs/b.md');

    expect(delivered).toEqual(['docs/b.md']);
    expect(ignored('scratch')).toBe(true);
  });

  it('B3: with core.excludesFile unset, honours $XDG_CONFIG_HOME/git/ignore', async () => {
    const workspace = initRepo('repo');
    fs.mkdirSync(path.join(sandbox, 'xdg', 'git'), { recursive: true });
    fs.writeFileSync(path.join(sandbox, 'xdg', 'git', 'ignore'), '/scratch/\n');

    const { delivered, ignored } = await deliveredChanges(workspace, 'scratch/a.txt', 'docs/b.md');

    expect(delivered).toEqual(['docs/b.md']);
    expect(ignored('scratch')).toBe(true);
  });

  it('B3: when git fails, no excludes file applies and info/exclude still does', async () => {
    const workspace = initRepo('repo');
    fs.appendFileSync(path.join(workspace, '.git', 'config'), '[core\nbroken\n');
    fs.mkdirSync(path.join(sandbox, 'xdg', 'git'), { recursive: true });
    fs.writeFileSync(path.join(sandbox, 'xdg', 'git', 'ignore'), '/fromglobal/\n');
    fs.writeFileSync(path.join(workspace, '.git', 'info', 'exclude'), '/scratch/\n');

    const { delivered } = await deliveredChanges(workspace, 'fromglobal/a.txt', 'scratch/a.txt', 'docs/b.md');

    expect(delivered).toEqual(['fromglobal/a.txt', 'docs/b.md']);
  });

  it('applies the global excludes file inside checkouts only, as git does', async () => {
    const workspace = path.join(sandbox, 'plain');
    const clone = path.join(workspace, 'clone');
    fs.mkdirSync(clone, { recursive: true });
    git(clone, 'init', '--initial-branch=main');
    fs.mkdirSync(path.join(sandbox, 'xdg', 'git'), { recursive: true });
    fs.writeFileSync(path.join(sandbox, 'xdg', 'git', 'ignore'), '/scratch/\n');

    const { delivered } = await deliveredChanges(workspace, 'scratch/a.txt', 'clone/scratch/b.txt', 'clone/src/c.txt');

    expect(delivered).toEqual(['scratch/a.txt', 'clone/src/c.txt']);
  });

  it('B4: a .gitignore negation re-includes a path info/exclude ignores', async () => {
    const workspace = initRepo('repo');
    fs.writeFileSync(path.join(workspace, '.git', 'info', 'exclude'), '*.log\n');
    fs.writeFileSync(path.join(workspace, '.gitignore'), '!keep.log\n');

    const { delivered } = await deliveredChanges(workspace, 'x.log', 'keep.log');

    expect(delivered).toEqual(['keep.log']);
  });

  it('B5: without a root .gitignore, the fallback patterns and info/exclude both apply', async () => {
    const workspace = initRepo('repo');
    fs.writeFileSync(path.join(workspace, '.git', 'info', 'exclude'), '/scratch/\n');

    const { delivered, ignored } = await deliveredChanges(
      workspace, '.turbo/cache.txt', 'scratch/a.txt', 'docs/b.md',
    );

    expect(delivered).toEqual(['docs/b.md']);
    expect(ignored('.turbo')).toBe(true);
    expect(ignored('scratch')).toBe(true);
  });

  it("B6: a nested checkout follows its own repository's info/exclude", async () => {
    const workspace = initRepo('repo');
    const clone = path.join(workspace, 'clone');
    fs.mkdirSync(clone);
    git(clone, 'init', '--initial-branch=main');
    fs.writeFileSync(path.join(clone, '.git', 'info', 'exclude'), '/cache/\n');

    const { delivered, ignored } = await deliveredChanges(workspace, 'clone/cache/x.txt', 'clone/src/y.txt');

    expect(delivered).toEqual(['clone/src/y.txt']);
    expect(ignored('clone/cache')).toBe(true);
    expect(ignored('clone/src')).toBe(false);
  });
});
