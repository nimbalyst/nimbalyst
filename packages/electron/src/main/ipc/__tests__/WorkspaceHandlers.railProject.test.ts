// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const mocks = vi.hoisted(() => {
  const send = vi.fn();
  const fakeWindow = { isDestroyed: () => false, webContents: { send } };
  return {
    handlers: new Map<string, (...args: any[]) => any>(),
    windowStates: new Map<number, Record<string, any>>(),
    fakeWindow,
    send,
    openFile: vi.fn(async ({ filePath }: { filePath: string }) => ({ filePath, content: '' })),
    addWorkspaceRecentFile: vi.fn(),
    getWorkspaceRecentFiles: vi.fn(() => [] as string[]),
    getSyncId: vi.fn(() => 'sync-id'),
    trashItem: vi.fn(async () => {}),
  };
});

vi.mock('electron', () => ({
  BrowserWindow: { fromWebContents: () => mocks.fakeWindow, getAllWindows: () => [] },
  shell: { trashItem: mocks.trashItem },
  clipboard: {},
  nativeImage: {},
}));
vi.mock('../../utils/ipcRegistry', () => ({
  safeHandle: (name: string, fn: any) => mocks.handlers.set(name, fn),
  safeOn: (name: string, fn: any) => mocks.handlers.set(name, fn),
}));
vi.mock('../../window/WindowManager', () => ({
  windowStates: mocks.windowStates,
  getWindowId: () => 1,
  createWindow: vi.fn(),
  markRecentlyDeleted: vi.fn(),
  clearRecentlyDeleted: vi.fn(),
}));
vi.mock('../../window/windowState', async () => {
  const actual = await vi.importActual<typeof import('../../window/windowState')>('../../window/windowState');
  return { ...actual, windowStates: mocks.windowStates, syncRepresentedFilename: vi.fn() };
});
vi.mock('../../utils/store', () => ({
  getWorkspaceRecentFiles: mocks.getWorkspaceRecentFiles,
  addWorkspaceRecentFile: mocks.addWorkspaceRecentFile,
  store: {},
  getWorkspaceState: vi.fn(() => ({})),
  getWorkspaceRoots: vi.fn(() => []),
  updateWorkspaceState: vi.fn(),
  getAppSetting: vi.fn(),
  getAttachedFolders: () => [],
}));
vi.mock('../../file/FileOpener', () => ({ openWorkspaceFile: vi.fn(), openFile: mocks.openFile }));
vi.mock('../../services/DocSyncService', () => ({ getSyncId: mocks.getSyncId, removeFileFromIndex: vi.fn() }));
vi.mock('../../services/analytics/AnalyticsService', () => ({
  AnalyticsService: { getInstance: () => ({ sendEvent: vi.fn() }) },
}));
vi.mock('../../utils/systemShell', () => ({ systemShell: {} }));
vi.mock('../../utils/windowsClipboard', () => ({}));
vi.mock('@nimbalyst/runtime', () => ({ fuzzyMatchPath: vi.fn() }));
vi.mock('../../file/FileWatcher', () => ({ startFileWatcher: vi.fn(), stopFileWatcher: vi.fn() }));
vi.mock('../../utils/FileTree', () => ({}));
vi.mock('../../file/FileOperations', () => ({ loadFileIntoWindow: vi.fn() }));
vi.mock('../../services/tracker/localKeyAllocator', () => ({}));
vi.mock('../../services/tracker/workspaceLocalKeyStore', () => ({ workspaceLocalKeyStore: {} }));
vi.mock('../../database/PGLiteDatabaseWorker', () => ({ database: {} }));
vi.mock('../../file/QuickOpenFileScanner', () => ({}));
vi.mock('../../file/QuickOpenFileNameCache', () => ({ quickOpenFileNameCache: {} }));

import { registerWorkspaceHandlers } from '../WorkspaceHandlers';

describe('workspace handlers in a project-rail window', () => {
  let projectA: string;
  let projectB: string;

  beforeEach(() => {
    projectA = mkdtempSync(join(tmpdir(), 'nim-rail-a-'));
    projectB = mkdtempSync(join(tmpdir(), 'nim-rail-b-'));
    // Opened on A, user switched the rail to B.
    mocks.windowStates.set(1, {
      mode: 'workspace',
      workspacePath: projectA,
      additionalWorkspacePaths: [projectB],
      activeWorkspacePath: projectB,
    });
    mocks.handlers.clear();
    for (const fn of [mocks.send, mocks.openFile, mocks.addWorkspaceRecentFile, mocks.getWorkspaceRecentFiles, mocks.getSyncId]) {
      fn.mockClear();
    }
    registerWorkspaceHandlers();
  });

  afterEach(() => {
    mocks.windowStates.clear();
    rmSync(projectA, { recursive: true, force: true });
    rmSync(projectB, { recursive: true, force: true });
  });

  it('records a recent file under the rail project that contains it', async () => {
    await mocks.handlers.get('add-to-workspace-recent-files')!({ sender: {} }, join(projectB, 'a.md'));
    expect(mocks.addWorkspaceRecentFile).toHaveBeenCalledWith(projectB, join(projectB, 'a.md'));
  });

  it('lists recent files for the project on screen when the renderer names none', async () => {
    await mocks.handlers.get('get-recent-workspace-files')!({ sender: {} });
    expect(mocks.getWorkspaceRecentFiles).toHaveBeenCalledWith(projectB);
  });

  it('switch-workspace-file opens the file under its own rail project', async () => {
    await mocks.handlers.get('switch-workspace-file')!({ sender: {} }, join(projectB, 'b.md'));
    expect(mocks.openFile).toHaveBeenCalledWith(expect.objectContaining({ workspacePath: projectB }));
  });

  it('delete-file computes the sync id against the project that owns the file', async () => {
    const file = join(projectB, 'gone.md');
    writeFileSync(file, 'x');
    await mocks.handlers.get('delete-file')!({ sender: {} }, file);
    expect(mocks.getSyncId).toHaveBeenCalledWith(file, projectB);
  });

  it('workspace:open-file tells the renderer which rail project the file belongs to', async () => {
    await mocks.handlers.get('workspace:open-file')!({ sender: {} }, { workspacePath: projectA, filePath: 'docs/x.md' });
    expect(mocks.send).toHaveBeenCalledWith('open-document', { path: join(projectA, 'docs/x.md'), workspacePath: projectA });
    // A is not on screen, so the window is switched to it first.
    expect(mocks.send.mock.calls.map(call => call[0])).toEqual(['workspace:activate-project', 'open-document']);
    expect(mocks.send).toHaveBeenCalledWith('workspace:activate-project', { workspacePath: projectA });
  });

  it('workspace:open-file does not re-activate the project already on screen', async () => {
    await mocks.handlers.get('workspace:open-file')!({ sender: {} }, { workspacePath: projectB, filePath: 'y.md' });
    expect(mocks.send.mock.calls.map(call => call[0])).toEqual(['open-document']);
  });

  it('workspace:open-file names no project for a root outside the rail', async () => {
    const attached = join(tmpdir(), 'attached-folder');
    await mocks.handlers.get('workspace:open-file')!({ sender: {} }, { workspacePath: attached, filePath: 'x.md' });
    expect(mocks.send).toHaveBeenCalledWith('open-document', { path: join(attached, 'x.md') });
  });
});
