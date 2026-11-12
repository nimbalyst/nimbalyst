// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { BrowserWindow } from 'electron';
import { EventEmitter } from 'node:events';

const { windowStates, windowIds, findWorkspaceWindowMatch, multiProjectMode } = vi.hoisted(() => ({
  windowStates: new Map<number, { filePath: string | null; documentEdited: boolean }>(),
  windowIds: new Map<unknown, number>(),
  findWorkspaceWindowMatch: vi.fn((_workspacePath: string): unknown => null),
  multiProjectMode: { enabled: true },
}));

vi.mock('../../window/WindowManager', () => ({
  windowStates,
  getWindowId: (window: unknown) => windowIds.get(window) ?? null,
  findWindowByFilePath: (filePath: string) => {
    for (const [window, id] of windowIds) {
      if (windowStates.get(id)?.filePath === filePath) return window;
    }
    return null;
  },
  findWorkspaceWindowMatch,
}));

vi.mock('../../utils/store', () => ({
  addToRecentItems: vi.fn(),
  getMultiProjectMode: () => multiProjectMode.enabled,
}));

import { loadFileIntoWindow, loadFileIntoWorkspaceWindow, reloadIntoWindowWithFile } from '../FileOperations';
import * as fileOperations from '../FileOperations';

function makeWindow(id: number) {
  const window = {
    webContents: Object.assign(new EventEmitter(), { send: vi.fn(), isDestroyed: () => false }),
    setRepresentedFilename: vi.fn(),
    isDestroyed: () => false,
    isMinimized: () => false,
    restore: vi.fn(),
    focus: vi.fn(),
  };
  windowIds.set(window, id);
  windowStates.set(id, { filePath: null, documentEdited: false });
  return window;
}

describe('reloadIntoWindowWithFile', () => {
  beforeEach(() => {
    windowStates.clear();
    windowIds.clear();
  });

  it('re-sends a file the OS asks for again, after the user has switched away from or closed its tab', () => {
    const window = makeWindow(1);
    loadFileIntoWindow(window as unknown as BrowserWindow, '/ws/a.md');
    window.webContents.send.mockClear();

    // Switching or closing tabs happens in the renderer and leaves state.filePath at a.md.
    expect(reloadIntoWindowWithFile('/ws/a.md')).toBe(true);
    expect(window.webContents.send).toHaveBeenCalledWith('open-document', expect.objectContaining({ path: '/ws/a.md' }));
  });

  it('leaves a file no window has loaded to the workspace routing', () => {
    const window = makeWindow(1);
    loadFileIntoWindow(window as unknown as BrowserWindow, '/ws/a.md');
    window.webContents.send.mockClear();

    expect(reloadIntoWindowWithFile('/ws/b.md')).toBe(false);
    expect(window.webContents.send).not.toHaveBeenCalled();
  });

  it('retains early opens until acknowledged, scoped to the receiving window', () => {
    const first = makeWindow(1);
    const second = makeWindow(2);
    Object.assign(windowStates.get(1)!, { workspacePath: '/ws' });
    Object.assign(windowStates.get(2)!, { workspacePath: '/other' });
    // No renderer listener exists yet: the live sends alone cannot deliver these.
    loadFileIntoWindow(first as unknown as BrowserWindow, '/ws/a.md');
    loadFileIntoWindow(first as unknown as BrowserWindow, '/ws/b.md');
    const pending = fileOperations.getPendingFileOpens(first.webContents as any, '/ws');
    expect(pending.map(request => request.path)).toEqual(['/ws/a.md', '/ws/b.md']);
    expect(fileOperations.getPendingFileOpens(second.webContents as any, '/ws')).toEqual([]);
    expect(fileOperations.getPendingFileOpens(first.webContents as any, '/other')).toEqual([]);
    // A different window cannot acknowledge the first window's request.
    fileOperations.acknowledgeFileOpen(second.webContents as any, '/ws', pending[0].requestId);
    expect(fileOperations.getPendingFileOpens(first.webContents as any, '/ws')).toHaveLength(2);
    fileOperations.acknowledgeFileOpen(first.webContents as any, '/ws', pending[0].requestId);
    expect(fileOperations.getPendingFileOpens(first.webContents as any, '/ws').map(request => request.path)).toEqual(['/ws/b.md']);
  });

  it('keeps requests across renderer navigation, but disposes them when the window is destroyed', () => {
    const window = makeWindow(1);
    Object.assign(windowStates.get(1)!, { workspacePath: '/ws', activeWorkspacePath: '/other' });
    loadFileIntoWindow(window as unknown as BrowserWindow, '/external.md');
    window.webContents.emit('did-start-navigation');
    expect(fileOperations.getPendingFileOpens(window.webContents as any, '/ws')).toEqual([]);
    expect(fileOperations.getPendingFileOpens(window.webContents as any, '/other').map(request => request.path)).toEqual(['/external.md']);
    window.webContents.emit('destroyed');
    expect(fileOperations.getPendingFileOpens(window.webContents as any, '/other')).toEqual([]);
  });

  // Electron's BrowserWindow.webContents getter throws "Object has been destroyed"
  // once the window is gone, and 'destroyed' fires after that point (GitHub #1889).
  it('disposes requests on destroy without touching the destroyed window', () => {
    const window = makeWindow(1);
    const contents = window.webContents;
    loadFileIntoWindow(window as unknown as BrowserWindow, '/a.md');
    loadFileIntoWindow(window as unknown as BrowserWindow, '/b.md');
    expect(contents.listenerCount('destroyed')).toBe(1);
    Object.defineProperty(window, 'webContents', {
      get() { throw new TypeError('Object has been destroyed'); },
    });

    expect(() => contents.emit('destroyed')).not.toThrow();
    expect(fileOperations.getPendingFileOpens(contents as any, '/ws')).toEqual([]);
  });
});

describe('loadFileIntoWorkspaceWindow', () => {
  beforeEach(() => {
    windowStates.clear();
    windowIds.clear();
  });

  // Finder or `nimbalyst <file>` for a file in rail project B, while the window
  // that holds B is showing rail project A.
  it('switches the window to the file\'s rail project and queues the open for that project', () => {
    const window = makeWindow(1);
    Object.assign(windowStates.get(1)!, { workspacePath: '/a', activeWorkspacePath: '/a', additionalWorkspacePaths: ['/b'] });
    findWorkspaceWindowMatch.mockReturnValue({ window, windowId: 1, matchedPath: '/b', isActive: false, kind: 'referenced' });

    expect(loadFileIntoWorkspaceWindow('/b', '/b/notes.md')).toBe(true);

    expect(window.webContents.send).toHaveBeenCalledWith('workspace:activate-project', { workspacePath: '/b' });
    expect(window.webContents.send).toHaveBeenCalledWith('open-document', expect.objectContaining({ path: '/b/notes.md', workspacePath: '/b' }));
    expect(fileOperations.getPendingFileOpens(window.webContents as any, '/b').map(request => request.path)).toEqual(['/b/notes.md']);
    expect(fileOperations.getPendingFileOpens(window.webContents as any, '/a')).toEqual([]);
  });

  // With the rail off a window shows only its own project; one that still
  // references B from rail mode cannot show it, so B gets its own window.
  it('does not route to a window that cannot show the project while the rail is off', () => {
    const window = makeWindow(1);
    Object.assign(windowStates.get(1)!, { workspacePath: '/a', activeWorkspacePath: '/a', additionalWorkspacePaths: ['/b'] });
    findWorkspaceWindowMatch.mockReturnValue({ window, windowId: 1, matchedPath: '/b', isActive: false, kind: 'referenced' });
    multiProjectMode.enabled = false;
    try {
      expect(loadFileIntoWorkspaceWindow('/b', '/b/notes.md')).toBe(false);
    } finally {
      multiProjectMode.enabled = true;
    }
    expect(window.webContents.send).not.toHaveBeenCalled();
  });

  it('leaves a project no window holds to the caller', () => {
    findWorkspaceWindowMatch.mockReturnValue(null);
    expect(loadFileIntoWorkspaceWindow('/c', '/c/notes.md')).toBe(false);
  });
});
