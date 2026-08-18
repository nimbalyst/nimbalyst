/**
 * Regression coverage for the double `window.on('close', ...)` registration
 * in WindowManager.ts: Node's EventEmitter runs every registered listener
 * regardless of `event.preventDefault()`, so a second listener that always
 * saved-and-deleted window state used to wipe a window's `windowStates`
 * entry even when the FIRST listener cancelled the close for unsaved
 * changes. The window then stayed on screen with its main-side state gone.
 *
 * This suite drives the real `close`/`closed` listeners `createWindow()`
 * registers, using a fake `BrowserWindow` that mirrors Electron's actual
 * event semantics:
 *   - `close()` fires every 'close' listener, then only proceeds to fire
 *     'closed' if none of them called `preventDefault()`.
 *   - `destroy()` skips 'close' entirely and always fires 'closed' (mirrors
 *     the real `close-window-save` / `close-window-discard` IPC handlers,
 *     which call `window.destroy()` directly after the renderer's dialog
 *     resolves).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => {
  return {
    getTheme: vi.fn(() => 'light'),
    saveWorkspaceWindowState: vi.fn(),
    getWorkspaceWindowState: vi.fn((_path: string): { filePath?: string } | undefined => undefined),
    getWorkspaceNavigationHistory: vi.fn(() => null),
    saveWorkspaceNavigationHistory: vi.fn(),
    stopFileWatcher: vi.fn(),
    stopWorkspaceWatcher: vi.fn(),
    startWorkspaceWatcher: vi.fn(),
    stopWarmWorkspaceWatch: vi.fn(),
    getFolderContents: vi.fn(),
    getTitleBarColors: vi.fn(() => ({ color: '#000', symbolColor: '#fff' })),
    setupDocumentServiceHandlers: vi.fn(),
    isWorktreePath: vi.fn(() => false),
    resolveProjectPath: vi.fn((p: string) => p),
    getPreloadPath: vi.fn(() => '/fake/preload.js'),
    setFileSystemService: vi.fn(),
    clearFileSystemService: vi.fn(),
    setFileSystemServiceFor: vi.fn(),
    saveNavigationState: vi.fn(() => null),
    restoreNavigationState: vi.fn(),
    removeWindow: vi.fn(),
    revealReadyWindow: vi.fn(),
    registerStartupWindow: vi.fn(),
    signalFirstWindowLoaded: vi.fn(),
    getMcpConfigService: vi.fn(() => null),
    addNimAssetRoot: vi.fn(),
    addNimPreviewWorkspaceRoot: vi.fn(),
    scheduleAttachmentStagingCleanup: vi.fn(),
    isRestarting: vi.fn(() => false),
    saveSessionState: vi.fn(async () => {}),
    unregisterWindow: vi.fn(),
    docServiceDestroy: vi.fn(),
    fsServiceDestroy: vi.fn(),
    beforeQuitHandlers: [] as Array<() => void>,
  };
});

vi.mock('electron', () => {
  return {
    BrowserWindow: class FakeBrowserWindow {
      static _nextId = 1;
      id: number;
      webContents: any;
      private listeners = new Map<string, Array<(...args: any[]) => void>>();
      destroyed = false;

      constructor(_options: any) {
        this.id = FakeBrowserWindow._nextId++;
        this.webContents = {
          send: vi.fn(),
          on: vi.fn(),
          once: vi.fn(),
          setMaxListeners: vi.fn(),
          session: { addWordToSpellCheckerDictionary: vi.fn() },
          getURL: () => '',
          replaceMisspelling: vi.fn(),
        };
      }

      on(event: string, handler: (...args: any[]) => void) {
        const arr = this.listeners.get(event) ?? [];
        arr.push(handler);
        this.listeners.set(event, arr);
        return this;
      }

      once(event: string, handler: (...args: any[]) => void) {
        return this.on(event, handler);
      }

      getBounds() {
        return { x: 0, y: 0, width: 800, height: 600 };
      }

      isDestroyed() {
        return this.destroyed;
      }

      isFocused() {
        return false;
      }

      loadURL = vi.fn(() => Promise.resolve());
      loadFile = vi.fn(() => Promise.resolve());
      setTitleBarOverlay = vi.fn();

      /** Mirrors a real window-close: every 'close' listener runs; 'closed'
       *  only fires if none of them prevented the default. */
      simulateCloseAttempt(): boolean {
        const event = {
          defaultPrevented: false,
          preventDefault() {
            this.defaultPrevented = true;
          },
        };
        for (const handler of this.listeners.get('close') ?? []) {
          handler(event);
        }
        if (!event.defaultPrevented) {
          this.destroyed = true;
          for (const handler of this.listeners.get('closed') ?? []) {
            handler();
          }
        }
        return event.defaultPrevented;
      }

      /** Mirrors `BrowserWindow.destroy()`: skips 'close' entirely, always
       *  fires 'closed'. Used by the close-window-save/discard IPC flow. */
      destroy() {
        this.destroyed = true;
        for (const handler of this.listeners.get('closed') ?? []) {
          handler();
        }
      }
    },
    dialog: { showMessageBoxSync: vi.fn(() => 0) },
    app: {
      getAppPath: () => '/fake/app',
      isPackaged: false,
      on: vi.fn((event: string, handler: (...args: any[]) => void) => {
        if (event === 'before-quit') mocks.beforeQuitHandlers.push(handler);
      }),
      getPath: vi.fn(() => '/fake/userdata'),
    },
    nativeImage: { createFromPath: vi.fn(() => ({})) },
    ipcMain: { emit: vi.fn(), handle: vi.fn(), on: vi.fn() },
    screen: {
      getCursorScreenPoint: () => ({ x: 0, y: 0 }),
      getDisplayNearestPoint: () => ({ bounds: { x: 0, y: 0, width: 1920, height: 1080 } }),
    },
    nativeTheme: { shouldUseDarkColors: false },
    Menu: { buildFromTemplate: vi.fn(() => ({ popup: vi.fn() })), setApplicationMenu: vi.fn() },
  };
});

vi.mock('../../utils/ipcRegistry', () => ({
  safeHandle: vi.fn(),
  safeOn: vi.fn(),
}));

vi.mock('fs', () => ({ existsSync: () => false }));

vi.mock('../../utils/constants', () => ({ WINDOW_CASCADE_OFFSET: 40 }));

vi.mock('../../utils/store', () => ({
  getTheme: mocks.getTheme,
  saveWorkspaceWindowState: mocks.saveWorkspaceWindowState,
  getWorkspaceWindowState: mocks.getWorkspaceWindowState,
  getWorkspaceNavigationHistory: mocks.getWorkspaceNavigationHistory,
  saveWorkspaceNavigationHistory: mocks.saveWorkspaceNavigationHistory,
}));

vi.mock('../../file/FileWatcher', () => ({
  stopFileWatcher: mocks.stopFileWatcher,
}));

vi.mock('../../file/WorkspaceWatcher.ts', () => ({
  stopWorkspaceWatcher: mocks.stopWorkspaceWatcher,
  startWorkspaceWatcher: mocks.startWorkspaceWatcher,
  stopWarmWorkspaceWatch: mocks.stopWarmWorkspaceWatch,
}));

vi.mock('../../utils/FileTree', () => ({
  getFolderContents: mocks.getFolderContents,
}));

vi.mock('../../theme/ThemeManager', () => ({
  getTitleBarColors: mocks.getTitleBarColors,
}));

class FakeDocService {
  destroy = mocks.docServiceDestroy;
}
class FakeFsService {
  destroy = mocks.fsServiceDestroy;
}

vi.mock('../../services/ElectronDocumentService', () => ({
  ElectronDocumentService: vi.fn(function () {
    return new FakeDocService();
  }),
  setupDocumentServiceHandlers: mocks.setupDocumentServiceHandlers,
}));

vi.mock('../../services/ElectronFileSystemService', () => ({
  ElectronFileSystemService: vi.fn(function () {
    return new FakeFsService();
  }),
}));

vi.mock('../../utils/workspaceDetection', () => ({
  isWorktreePath: mocks.isWorktreePath,
  resolveProjectPath: mocks.resolveProjectPath,
}));

vi.mock('../../utils/appPaths', () => ({
  getPreloadPath: mocks.getPreloadPath,
}));

// Mocks the barrel specifier deliberately, matching `WindowManager.ts`'s own
// import. CLAUDE.md's rule (NIM-2374) exists to stop the real barrel loading
// and dragging in the Lexical tree -- and this PLAIN factory is what prevents
// it; the expensive shape the rule names is the `importOriginal` spread, which
// forces the real barrel to load.
//
// Mocking the deep path (`@nimbalyst/runtime/core/FileSystemService`) instead
// is worse here, not better: `WindowManager.ts` imports the barrel, so nothing
// intercepts it, the real barrel loads, and this file's import time goes from
// ~0.1s to ~4.3s -- measured. The full fix is to move the SOURCE import to the
// deep path too, per the rule's "import from the deep path in source too". That
// needs the packaged main-process build's `runtime/core/*` subpath resolution
// verified first, so it is a follow-up rather than a drive-by here.
vi.mock('@nimbalyst/runtime', () => ({
  setFileSystemService: mocks.setFileSystemService,
  clearFileSystemService: mocks.clearFileSystemService,
  setFileSystemServiceFor: mocks.setFileSystemServiceFor,
}));

vi.mock('../../services/NavigationHistoryService', () => ({
  navigationHistoryService: {
    saveNavigationState: mocks.saveNavigationState,
    restoreNavigationState: mocks.restoreNavigationState,
    removeWindow: mocks.removeWindow,
  },
}));

vi.mock('../revealReadyWindow', () => ({
  revealReadyWindow: mocks.revealReadyWindow,
}));

vi.mock('../StartupActivation', () => ({
  registerStartupWindow: mocks.registerStartupWindow,
}));

vi.mock('../../services/startupMaintenanceGate', () => ({
  signalFirstWindowLoaded: mocks.signalFirstWindowLoaded,
}));

vi.mock('../../services/analytics/AnalyticsService', () => ({
  AnalyticsService: { getInstance: () => ({ sendEvent: vi.fn() }) },
}));

vi.mock('../../services/analytics/FeatureTrackingService', () => ({
  FeatureTrackingService: {
    getInstance: () => ({ isFirstUse: () => false, getDaysSinceInstall: () => 0 }),
  },
}));

vi.mock('../../services/ExtensionLogService', () => ({
  ExtensionLogService: { getInstance: () => ({ addRendererLog: vi.fn() }) },
}));

vi.mock('../../mcpConfigServiceRef', () => ({
  getMcpConfigService: mocks.getMcpConfigService,
}));

vi.mock('../../protocols/nimAssetProtocol', () => ({
  addNimAssetRoot: mocks.addNimAssetRoot,
}));

vi.mock('../../protocols/nimPreviewProtocol', () => ({
  addNimPreviewWorkspaceRoot: mocks.addNimPreviewWorkspaceRoot,
}));

vi.mock('../../services/attachments/attachmentStagingCleanup', () => ({
  scheduleAttachmentStagingCleanup: mocks.scheduleAttachmentStagingCleanup,
}));

vi.mock('../../index', () => ({
  isRestarting: mocks.isRestarting,
}));

vi.mock('../../session/SessionState', () => ({
  saveSessionState: mocks.saveSessionState,
}));

vi.mock('../../mcp/httpServer', () => ({
  unregisterWindow: mocks.unregisterWindow,
}));

// Imported AFTER mocks so the real `close`/`closed` listener wiring in
// createWindow() runs against the fakes above. windowState.ts and
// sessionSaveOnClose.ts are intentionally left un-mocked -- they are plain
// Maps / pure logic with no Electron dependency, and this suite wants to
// exercise the real `windowStates` map and the real quit/restart guard.
import { createWindow, getWindowId, resolveBoundsPersistPaths } from '../WindowManager';
import { windows, windowStates } from '../windowState';

function flushMicrotasks() {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

describe('WindowManager close/closed listeners', () => {
  beforeEach(() => {
    windows.clear();
    windowStates.clear();
    vi.clearAllMocks();
    mocks.getTheme.mockReturnValue('light');
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('a cancelled close (unsaved changes) leaves windowStates and windows intact', async () => {
    const window = createWindow(false, true, '/ws/project-a') as any;
    const windowId = getWindowId(window)!;
    windowStates.get(windowId)!.documentEdited = true;

    // Proves the `@nimbalyst/runtime/core/FileSystemService` mock actually
    // intercepts `createWindow`'s real call, not a silent no-op (mocking the
    // wrong specifier would leave this unset and eventually throw against
    // the real module's FileSystemService state instead).
    expect(mocks.setFileSystemService).toHaveBeenCalledWith(expect.anything());
    expect(mocks.setFileSystemServiceFor).toHaveBeenCalledWith('/ws/project-a', expect.anything());

    const prevented = window.simulateCloseAttempt();

    expect(prevented).toBe(true);
    expect(window.webContents.send).toHaveBeenCalledWith('confirm-close-unsaved');

    // The bug: a second unconditional 'close' listener used to run anyway
    // and wipe this window's state even though the close was cancelled.
    expect(windowStates.has(windowId)).toBe(true);
    expect(windowStates.get(windowId)?.documentEdited).toBe(true);
    expect(windows.has(windowId)).toBe(true);

    // Bounds/nav-history persistence is benign on a cancelled close (gets
    // overwritten by the eventual real close) and the pre-fix code already
    // did this unconditionally -- preserve that, unlike the destructive
    // windowStates.delete / session re-save which must NOT run here.
    expect(mocks.saveWorkspaceWindowState).toHaveBeenCalledWith(
      '/ws/project-a',
      expect.objectContaining({ mode: 'workspace', workspacePath: '/ws/project-a' })
    );

    await flushMicrotasks();
  });

  it('a real close (no unsaved changes) still saves workspace state and tears the window down', async () => {
    const window = createWindow(false, true, '/ws/project-b') as any;
    const windowId = getWindowId(window)!;
    windowStates.get(windowId)!.documentEdited = false;

    const prevented = window.simulateCloseAttempt();

    expect(prevented).toBe(false);
    expect(mocks.saveWorkspaceWindowState).toHaveBeenCalledWith(
      '/ws/project-b',
      expect.objectContaining({ mode: 'workspace', workspacePath: '/ws/project-b' })
    );
    expect(windowStates.has(windowId)).toBe(false);
    expect(windows.has(windowId)).toBe(false);

    await flushMicrotasks();
  });

  it('a window whose first close attempt was cancelled still fully tears down after the user discards', async () => {
    const window = createWindow(false, true, '/ws/project-c') as any;
    const windowId = getWindowId(window)!;
    windowStates.get(windowId)!.documentEdited = true;

    // First attempt: user has unsaved changes, dialog is shown, close is cancelled.
    expect(window.simulateCloseAttempt()).toBe(true);
    expect(windowStates.has(windowId)).toBe(true);

    // User picks "discard" in the renderer dialog; close-window-discard calls
    // window.destroy() directly, which (per Electron) skips 'close' entirely.
    window.destroy();

    // windowStates must still be released even though 'close' never ran again.
    expect(windowStates.has(windowId)).toBe(false);
    expect(windows.has(windowId)).toBe(false);
    expect(mocks.docServiceDestroy).toHaveBeenCalled();

    await flushMicrotasks();
  });

  it('releases the warm watch for a path that was still ACTIVE (never backgrounded) when its window closes', async () => {
    // Residual gap fixed alongside the cancelled-close bug: a path that was
    // never demoted to a background/rail-warm watch (i.e. it was the
    // window's active project right up to close) is never covered by
    // stopWorkspaceWatcher's own orphan sweep, because that sweep only
    // iterates already-backgrounded paths.
    const window = createWindow(false, true, '/ws/active-on-close') as any;
    const windowId = getWindowId(window)!;
    windowStates.get(windowId)!.documentEdited = false;

    window.simulateCloseAttempt();

    expect(mocks.stopWarmWorkspaceWatch).toHaveBeenCalledWith('/ws/active-on-close');

    await flushMicrotasks();
  });

  describe('resolveBoundsPersistPaths (pure)', () => {
    it('returns only the primary path for a window with no rail-warm paths', () => {
      expect(
        resolveBoundsPersistPaths({
          mode: 'workspace',
          filePath: null,
          workspacePath: '/ws/solo',
          documentEdited: false,
        })
      ).toEqual(['/ws/solo']);
    });

    it('includes every rail-warm additional path, deduped, alongside the primary', () => {
      expect(
        resolveBoundsPersistPaths({
          mode: 'workspace',
          filePath: null,
          workspacePath: '/ws/primary',
          additionalWorkspacePaths: ['/ws/second', '/ws/third', '/ws/primary'],
          documentEdited: false,
        })
      ).toEqual(['/ws/primary', '/ws/second', '/ws/third']);
    });

    it('returns nothing for a document-mode window', () => {
      expect(
        resolveBoundsPersistPaths({
          mode: 'document',
          filePath: '/tmp/untitled.md',
          workspacePath: null,
          documentEdited: false,
        })
      ).toEqual([]);
    });
  });

  it('a window closing with rail-warm additional paths writes bounds to every referenced path, not just the primary', async () => {
    const window = createWindow(false, true, '/ws/rail-primary') as any;
    const windowId = getWindowId(window)!;
    const state = windowStates.get(windowId)!;
    state.documentEdited = false;
    state.additionalWorkspacePaths = ['/ws/rail-second'];
    state.activeWorkspacePath = '/ws/rail-second';
    state.filePath = '/ws/rail-second/README.md';

    // The background (non-active) path already has its own remembered
    // open file from a previous session -- the close handler must not
    // clobber it with the active project's currently open file.
    mocks.getWorkspaceWindowState.mockImplementation((path: string) =>
      path === '/ws/rail-primary' ? { filePath: '/ws/rail-primary/old-notes.md' } : undefined
    );

    window.simulateCloseAttempt();

    expect(mocks.saveWorkspaceWindowState).toHaveBeenCalledWith(
      '/ws/rail-primary',
      expect.objectContaining({
        workspacePath: '/ws/rail-primary',
        // Not the active path: carries forward its own previously-saved
        // filePath instead of inheriting the active project's open file.
        filePath: '/ws/rail-primary/old-notes.md',
      })
    );
    expect(mocks.saveWorkspaceWindowState).toHaveBeenCalledWith(
      '/ws/rail-second',
      expect.objectContaining({
        workspacePath: '/ws/rail-second',
        // The active path: gets the window's live filePath.
        filePath: '/ws/rail-second/README.md',
      })
    );

    await flushMicrotasks();
  });

  // MUST run last: `isQuitting` is a module-level flag in WindowManager.ts
  // flipped permanently by the captured `before-quit` handler, with no reset
  // hook exported for tests.
  it('during app quit, close proceeds without the dialog even with unsaved changes', async () => {
    expect(mocks.beforeQuitHandlers.length).toBeGreaterThan(0);
    mocks.beforeQuitHandlers[0]();

    const window = createWindow(false, true, '/ws/project-quit') as any;
    const windowId = getWindowId(window)!;
    windowStates.get(windowId)!.documentEdited = true;

    const prevented = window.simulateCloseAttempt();

    expect(prevented).toBe(false);
    expect(window.webContents.send).not.toHaveBeenCalledWith('confirm-close-unsaved');
    expect(mocks.saveWorkspaceWindowState).toHaveBeenCalledWith(
      '/ws/project-quit',
      expect.objectContaining({ mode: 'workspace', workspacePath: '/ws/project-quit' })
    );
    expect(windowStates.has(windowId)).toBe(false);

    await flushMicrotasks();
  });
});
