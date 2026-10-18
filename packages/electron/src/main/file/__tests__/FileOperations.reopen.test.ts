// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { BrowserWindow } from 'electron';

const { windowStates, windowIds } = vi.hoisted(() => ({
  windowStates: new Map<number, { filePath: string | null; documentEdited: boolean }>(),
  windowIds: new Map<unknown, number>(),
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
}));

vi.mock('../../utils/store', () => ({
  addToRecentItems: vi.fn(),
}));

import { loadFileIntoWindow, reloadIntoWindowWithFile } from '../FileOperations';

function makeWindow(id: number) {
  const window = {
    webContents: { send: vi.fn() },
    setRepresentedFilename: vi.fn(),
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
    expect(window.webContents.send).toHaveBeenCalledWith('open-document', { path: '/ws/a.md' });
  });

  it('leaves a file no window has loaded to the workspace routing', () => {
    const window = makeWindow(1);
    loadFileIntoWindow(window as unknown as BrowserWindow, '/ws/a.md');
    window.webContents.send.mockClear();

    expect(reloadIntoWindowWithFile('/ws/b.md')).toBe(false);
    expect(window.webContents.send).not.toHaveBeenCalled();
  });
});
