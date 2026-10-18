// @vitest-environment node
/**
 * The @-mention picker shows whatever "get-recent-workspace-files" returns
 * before the user types anything (GH #303).
 *
 * The store already caps how many recent files it keeps per workspace. The
 * handler used to cut that list down to 20, so the picker showed only some of
 * the files the user had recently viewed. These tests make sure the handler
 * returns every stored recent file that still exists on disk, in the stored
 * order.
 *
 * The recording side matters too: "add-to-workspace-recent-files" must save a
 * file under the project the user is looking at (the side rail's active
 * project), or the picker never sees it.
 */

import { describe, expect, it, vi, beforeEach } from 'vitest';

const handlers = new Map<string, (...args: any[]) => any>();
// Shared stand-ins that the mock factories below and the tests both reach.
const shared = vi.hoisted(() => ({
  windowStates: new Map<number, any>(),
  getWindowId: vi.fn(),
  fromWebContents: vi.fn(),
  addWorkspaceRecentFile: vi.fn(),
}));
const getWorkspaceRecentFiles = vi.fn();
const existingPaths = new Set<string>();

// Capture the handlers instead of registering them with Electron.
vi.mock('../../utils/ipcRegistry', () => ({
  safeHandle: (channel: string, handler: (...args: any[]) => any) => {
    handlers.set(channel, handler);
  },
  safeOn: (channel: string, handler: (...args: any[]) => any) => {
    handlers.set(channel, handler);
  },
}));

// Only the recent files lookup matters here. The rest are stand-ins.
vi.mock('../../utils/store', () => ({
  getWorkspaceRecentFiles: (...args: unknown[]) => getWorkspaceRecentFiles(...args),
  addWorkspaceRecentFile: (...args: unknown[]) => shared.addWorkspaceRecentFile(...args),
  // The real windowState module imports this one, so the store mock must offer it.
  getAttachedFolders: vi.fn(),
  store: {},
  getWorkspaceState: vi.fn(),
  getWorkspaceRoots: vi.fn(),
  updateWorkspaceState: vi.fn(),
  getAppSetting: vi.fn(),
}));

// The test decides which paths "exist" on disk.
vi.mock('fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('fs')>();
  return { ...actual, existsSync: (p: string) => existingPaths.has(p) };
});

// Stand-ins for modules the handler file loads but this test never uses.
vi.mock('electron', () => ({
  BrowserWindow: { fromWebContents: (...args: unknown[]) => shared.fromWebContents(...args) },
  shell: {},
  clipboard: {},
  nativeImage: {},
}));
vi.mock('../../services/analytics/AnalyticsService', () => ({
  AnalyticsService: { getInstance: () => ({}) },
}));
vi.mock('../../file/FileOpener', () => ({ openWorkspaceFile: vi.fn(), openFile: vi.fn() }));
vi.mock('@nimbalyst/runtime', () => ({ fuzzyMatchPath: vi.fn() }));
vi.mock('../../services/DocSyncService', () => ({ getSyncId: vi.fn(), removeFileFromIndex: vi.fn() }));
vi.mock('../../window/WindowManager', () => ({
  windowStates: shared.windowStates,
  getWindowId: (...args: unknown[]) => shared.getWindowId(...args),
  createWindow: vi.fn(),
  markRecentlyDeleted: vi.fn(),
  clearRecentlyDeleted: vi.fn(),
}));
// Keep the real window-state logic (resolveActiveWorkspacePath) so the test
// checks the true "which project is visible" answer. Only the Electron-facing
// helper is replaced.
vi.mock('../../window/windowState', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../window/windowState')>();
  return { ...actual, syncRepresentedFilename: vi.fn() };
});
vi.mock('../../file/FileWatcher', () => ({ startFileWatcher: vi.fn(), stopFileWatcher: vi.fn() }));
vi.mock('../../utils/FileTree', () => ({ getFolderContents: vi.fn(), listFolderFilesRecursive: vi.fn() }));
vi.mock('../../utils/textEncoding', () => ({ decodeTextFileBuffer: vi.fn() }));
vi.mock('../../utils/fileFilters', () => ({
  RIPGREP_EXCLUDE_ARGS_ARRAY: [],
  QUICKOPEN_FILE_TYPE_ARGS: [],
}));
vi.mock('../../file/FileOperations', () => ({ loadFileIntoWindow: vi.fn() }));
vi.mock('../../services/tracker/localKeyAllocator', () => ({
  getLocalKeyPrefixConfig: vi.fn(),
  reassignLocalKeyPrefix: vi.fn(),
}));
vi.mock('../../services/tracker/workspaceLocalKeyStore', () => ({ workspaceLocalKeyStore: {} }));
vi.mock('../../database/PGLiteDatabaseWorker', () => ({ database: {} }));
vi.mock('../../services/ripgrepPath', () => ({ getRipgrepPath: vi.fn() }));
vi.mock('../../file/QuickOpenFileScanner', () => ({
  findWorkspaceFiles: vi.fn(),
  listContentSearchRoots: vi.fn(),
}));
vi.mock('../../file/QuickOpenFileNameCache', () => ({ quickOpenFileNameCache: {} }));

import { registerWorkspaceHandlers } from '../WorkspaceHandlers';

const WORKSPACE = '/work/space';

function pathsNumbered(count: number): string[] {
  return Array.from({ length: count }, (_, i) => `${WORKSPACE}/file-${i}.md`);
}

async function getRecentFiles(): Promise<string[]> {
  const handler = handlers.get('get-recent-workspace-files');
  if (!handler) throw new Error('get-recent-workspace-files was not registered');
  return handler({ sender: {} }, WORKSPACE);
}

describe('get-recent-workspace-files', () => {
  beforeEach(() => {
    handlers.clear();
    existingPaths.clear();
    getWorkspaceRecentFiles.mockReset();
    registerWorkspaceHandlers();
  });

  it('returns the whole stored list, well past the old cut of 20, when every file still exists', async () => {
    const stored = pathsNumbered(50);
    stored.forEach(p => existingPaths.add(p));
    getWorkspaceRecentFiles.mockReturnValue(stored);

    expect(await getRecentFiles()).toEqual(stored);
  });

  it('skips files that no longer exist and keeps the order of the rest', async () => {
    const stored = pathsNumbered(40);
    // Every fourth file is gone from disk, which leaves 30 that still exist.
    const survivors = stored.filter((_, i) => i % 4 !== 0);
    survivors.forEach(p => existingPaths.add(p));
    getWorkspaceRecentFiles.mockReturnValue(stored);

    const result = await getRecentFiles();
    expect(result).toEqual(survivors);
    expect(result.length).toBeGreaterThan(20);
  });
});

describe('add-to-workspace-recent-files', () => {
  const WINDOW_ID = 7;

  function openFile(filePath: string) {
    const handler = handlers.get('add-to-workspace-recent-files');
    if (!handler) throw new Error('add-to-workspace-recent-files was not registered');
    return handler({ sender: {} }, filePath);
  }

  beforeEach(() => {
    handlers.clear();
    shared.windowStates.clear();
    shared.addWorkspaceRecentFile.mockReset();
    shared.fromWebContents.mockReset().mockReturnValue({});
    shared.getWindowId.mockReset().mockReturnValue(WINDOW_ID);
    registerWorkspaceHandlers();
  });

  it('records the file under the side rail project the user is looking at, not the startup project', async () => {
    shared.windowStates.set(WINDOW_ID, {
      workspacePath: '/work/start',
      activeWorkspacePath: '/work/rail',
    });

    await openFile('/work/rail/notes.md');

    expect(shared.addWorkspaceRecentFile).toHaveBeenCalledTimes(1);
    expect(shared.addWorkspaceRecentFile).toHaveBeenCalledWith('/work/rail', '/work/rail/notes.md');
  });

  it('records the file under the window project when no side rail project is active', async () => {
    shared.windowStates.set(WINDOW_ID, { workspacePath: '/work/start' });

    await openFile('/work/start/notes.md');

    expect(shared.addWorkspaceRecentFile).toHaveBeenCalledWith('/work/start', '/work/start/notes.md');
  });
});
