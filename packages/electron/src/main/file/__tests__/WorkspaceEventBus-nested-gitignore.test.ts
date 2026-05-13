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
  // Bus refuses workspaces below MIN_WORKSPACE_DEPTH=3, so on Linux CI where
  // os.tmpdir() is /tmp (depth 1) we need an extra parent level.
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
