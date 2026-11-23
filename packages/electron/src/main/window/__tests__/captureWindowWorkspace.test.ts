// @vitest-environment node
/**
 * The hidden screenshot capture window (`?mode=capture`) is created by
 * OffscreenEditorManager, not WindowManager, so it has no WindowState. Extension
 * renderer code that calls a backend tool without an explicit workspacePath used
 * to fail there with "No workspace path available for backend tool call", which
 * is why a themed `capture_editor_screenshot` rendered extensions with a backend
 * module in an error state.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const fakeElectron = vi.hoisted(() => {
  let nextWebContentsId = 100;

  class FakeBrowserWindow {
    public webContents = { id: ++nextWebContentsId, send: vi.fn() };
    private destroyed = false;
    private listeners = new Map<string, () => void>();

    constructor(public options: unknown) {
      FakeBrowserWindow.instances.push(this);
    }

    static instances: FakeBrowserWindow[] = [];
    static getAllWindows(): FakeBrowserWindow[] {
      return FakeBrowserWindow.instances.filter(w => !w.isDestroyed());
    }

    on(eventName: string, handler: () => void): void {
      this.listeners.set(eventName, handler);
    }
    isDestroyed(): boolean {
      return this.destroyed;
    }
    async loadURL(): Promise<void> {}
    async loadFile(): Promise<void> {}
    close(): void {
      this.destroyed = true;
      this.listeners.get('closed')?.();
    }
  }

  return {
    FakeBrowserWindow,
    app: { isPackaged: false, getAppPath: () => '/app' },
    ipcMain: { handle: vi.fn(), removeHandler: vi.fn() },
  };
});

vi.mock('electron', () => ({
  default: { app: fakeElectron.app, BrowserWindow: fakeElectron.FakeBrowserWindow },
  app: fakeElectron.app,
  BrowserWindow: fakeElectron.FakeBrowserWindow,
  ipcMain: fakeElectron.ipcMain,
}));

vi.mock('../../utils/logger', () => ({
  logger: { main: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } },
}));

vi.mock('../../utils/appPaths', () => ({ getPreloadPath: () => '/preload.js' }));

vi.mock('../WindowManager', () => ({ findWindowByWorkspace: () => null }));

import {
  registerCaptureWindowMount,
  clearCaptureWindowMounts,
  resolveSenderWorkspacePath,
  resolveBackendToolCallWorkspacePath,
  resolveProjectFileRoot,
} from '../captureWindowWorkspace';
import { windowStates } from '../windowState';
import { OffscreenEditorManager } from '../../services/OffscreenEditorManager';

describe('capture window workspace resolution', () => {
  beforeEach(() => {
    windowStates.clear();
    fakeElectron.FakeBrowserWindow.instances = [];
    process.env['ELECTRON_RENDERER_URL'] = 'http://localhost:5273';
  });

  afterEach(() => {
    vi.useRealTimers();
    OffscreenEditorManager.getInstance().cleanup();
    windowStates.clear();
  });

  it('prefers the sender window active project over any capture mount', () => {
    windowStates.set(7, { workspacePath: '/ws/primary', activeWorkspacePath: '/ws/rail' } as never);
    registerCaptureWindowMount(101, '/ws/other/a.ipynb', '/ws/other');

    expect(resolveSenderWorkspacePath({ windowId: 7, webContentsId: 101 })).toBe('/ws/rail');
  });

  it('gives a backend tool call no project from a real window when it names none', () => {
    // #1299: an unnamed call used to get the on-screen rail project, which a
    // background caller has no reason to use. Only the capture window, whose
    // one mounted file fixes the project, may omit it.
    windowStates.set(7, { workspacePath: '/ws/primary', activeWorkspacePath: '/ws/rail' } as never);
    registerCaptureWindowMount(101, '/ws/demo/a.ipynb', '/ws/demo');

    expect(resolveBackendToolCallWorkspacePath({ requested: undefined, webContentsId: 55 })).toBeUndefined();
    expect(resolveBackendToolCallWorkspacePath({ requested: '/ws/named', webContentsId: 55 })).toBe('/ws/named');
    expect(resolveBackendToolCallWorkspacePath({ requested: undefined, webContentsId: 101 })).toBe('/ws/demo');
  });

  it('gives project file access the tab\'s rail project, checked against what main knows', () => {
    // #1299: an editor in a background rail project read and wrote against the
    // on-screen project's root. The tab names its project; main accepts it
    // only when that window has the project open.
    windowStates.set(7, { workspacePath: '/ws/a', additionalWorkspacePaths: ['/ws/b'], activeWorkspacePath: '/ws/a' } as never);
    registerCaptureWindowMount(101, '/ws/demo/a.ipynb', '/ws/demo');

    expect(resolveProjectFileRoot({ windowId: 7, webContentsId: 55, requested: '/ws/b' })).toBe('/ws/b');
    expect(resolveProjectFileRoot({ windowId: 7, webContentsId: 55, requested: '/ws/elsewhere' })).toBeUndefined();
    expect(resolveProjectFileRoot({ windowId: 7, webContentsId: 55, requested: undefined })).toBeUndefined();
    expect(resolveProjectFileRoot({ windowId: null, webContentsId: 101, requested: '/ws/demo' })).toBe('/ws/demo');
    expect(resolveProjectFileRoot({ windowId: null, webContentsId: 101, requested: undefined })).toBe('/ws/demo');
    expect(resolveProjectFileRoot({ windowId: null, webContentsId: 101, requested: '/ws/a' })).toBeUndefined();
  });

  it('falls back to the capture window mount when the sender has no window state', () => {
    registerCaptureWindowMount(101, '/ws/demo/a.ipynb', '/ws/demo');

    expect(resolveSenderWorkspacePath({ windowId: null, webContentsId: 101 })).toBe('/ws/demo');
    expect(resolveSenderWorkspacePath({ windowId: null, webContentsId: 999 })).toBeUndefined();

    clearCaptureWindowMounts(101);
    expect(resolveSenderWorkspacePath({ windowId: null, webContentsId: 101 })).toBeUndefined();
  });

  it('associates the mounted file workspace with the capture window and releases it on unmount', async () => {
    vi.useFakeTimers();
    const manager = OffscreenEditorManager.getInstance();

    const mount = manager.mountOffscreen('/ws/demo/notebook.ipynb', '/ws/demo');
    await vi.runAllTimersAsync();
    await mount;

    const captureWindow = fakeElectron.FakeBrowserWindow.instances.at(-1)!;
    const webContentsId = captureWindow.webContents.id;

    // This is the resolution a backend tool call from the capture window makes:
    // no window state, so only the offscreen mount can supply the workspace.
    expect(resolveSenderWorkspacePath({ windowId: null, webContentsId })).toBe('/ws/demo');

    manager.unmountOffscreen('/ws/demo/notebook.ipynb');
    await vi.runAllTimersAsync();

    expect(resolveSenderWorkspacePath({ windowId: null, webContentsId })).toBeUndefined();
  });

  /*
   * `project-fs:read` is the sibling-file surface an editor gets as `host.fs`.
   * It resolved its workspace straight out of `windowStates`, so it threw
   * "Project file access is unavailable outside a workspace" for the capture
   * window -- and an animation whose parts reference sibling `htmlFile`
   * partials rendered as empty boxes under `capture_editor_screenshot` while
   * looking correct in a tab. The rule that must hold is that the workspace
   * still comes from main's own records, never from a renderer argument.
   */
  describe('project file access from the capture window', () => {
    /** Mirrors `getAuthorizedWorkspaceRoot` in HistoryHandlers. */
    const authorize = (sender: { windowId: number | null; webContentsId: number }): string => {
      const workspaceRoot = resolveProjectFileRoot({ ...sender, requested: undefined });
      if (!workspaceRoot) throw new Error('Project file access is unavailable outside a workspace.');
      return workspaceRoot;
    };

    it('authorizes the workspace of the file main mounted there', () => {
      registerCaptureWindowMount(101, '/ws/demo/scene.anim.json', '/ws/demo');
      expect(authorize({ windowId: null, webContentsId: 101 })).toBe('/ws/demo');
    });

    it('still refuses a sender main has no record of', () => {
      expect(() => authorize({ windowId: null, webContentsId: 404 })).toThrow(
        'unavailable outside a workspace'
      );
    });

    it('does not let a stale mount outlive the capture', () => {
      registerCaptureWindowMount(101, '/ws/demo/scene.anim.json', '/ws/demo');
      clearCaptureWindowMounts(101);
      expect(() => authorize({ windowId: null, webContentsId: 101 })).toThrow();
    });
  });
});
