// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const allWindows = vi.hoisted(() => ({ list: [] as unknown[] }));
vi.mock('electron', async () => {
    const { EventEmitter } = await import('node:events');
    return {
        app: Object.assign(new EventEmitter(), { isReady: vi.fn(() => true), quit: vi.fn(), isPackaged: false, focus: vi.fn() }),
        // Every live window, helpers included, as Electron reports them.
        BrowserWindow: { getAllWindows: () => allWindows.list },
    };
});
vi.mock('../../utils/store', () => ({ getAttachedFolders: () => [] }));
vi.mock('../../utils/logger', () => ({ logger: { main: { info: vi.fn(), error: vi.fn() } } }));

import { tmpdir } from 'node:os';
import { app, type BrowserWindow } from 'electron';
import { logger } from '../../utils/logger';
import { windows } from '../windowState';
import { beginStartupActivation, finishStartupWindowCreation, resetStartupActivationForTests } from '../StartupActivation';
import {
    initializeApplicationWindowRecovery,
    recoverAfterProjectWindowClosed,
} from '../ApplicationWindowRecovery';
import { handleSecondInstance } from '../secondInstanceActivation';

function windowStub() {
    return {
        id: 1,
        isDestroyed: vi.fn(() => false),
        isMinimized: vi.fn(() => false),
        restore: vi.fn(), show: vi.fn(), focus: vi.fn(),
    };
}

describe('application window recovery (#1609)', () => {
    let dispose: () => void;
    let quitting: boolean;
    let preferred: BrowserWindow | null;
    let manager: BrowserWindow | null;
    const createManager = vi.fn(() => {
        manager = windowStub() as unknown as BrowserWindow;
        return manager;
    });
    const wasManuallyClosed = vi.fn(() => false);

    beforeEach(() => {
        vi.useFakeTimers();
        vi.clearAllMocks();
        windows.clear();
        allWindows.list = [];
        resetStartupActivationForTests();
        quitting = false;
        preferred = manager = null;
        vi.mocked(app.isReady).mockReturnValue(true);
        wasManuallyClosed.mockReturnValue(false);
        dispose = initializeApplicationWindowRecovery({
            isQuitting: () => quitting,
            getPreferredProjectWindow: () => preferred,
            getWorkspaceManagerWindow: () => manager,
            createWorkspaceManagerWindow: createManager,
            wasWorkspaceManagerManuallyClosed: wasManuallyClosed,
        });
    });
    afterEach(() => {
        dispose();
        resetStartupActivationForTests();
        windows.clear();
        vi.useRealTimers();
    });

    it('Dock activation opens one manager when no managed windows remain', () => {
        app.emit('activate');
        expect(createManager).toHaveBeenCalledOnce();
        // Creation waits for its own ready-to-show; activation must not paint it early.
        expect(manager!.show).not.toHaveBeenCalled();
        app.emit('activate');
        expect(createManager).toHaveBeenCalledOnce();
        expect(manager!.show).toHaveBeenCalledOnce();
    });

    it('restores the most recently focused project, even when hidden or minimized', () => {
        const older = windowStub();
        const recent = windowStub();
        recent.isMinimized.mockReturnValue(true);
        windows.set(1, older as unknown as BrowserWindow);
        windows.set(2, recent as unknown as BrowserWindow);
        preferred = recent as unknown as BrowserWindow;
        app.emit('activate');
        expect(recent.restore).toHaveBeenCalledOnce();
        expect(recent.show).toHaveBeenCalledOnce();
        expect(recent.focus).toHaveBeenCalledOnce();
        expect(older.show).not.toHaveBeenCalled();
        expect(createManager).not.toHaveBeenCalled();
    });

    it('ignores stale destroyed registry entries and restores a hidden manager', () => {
        const stale = windowStub();
        stale.isDestroyed.mockReturnValue(true);
        windows.set(1, stale as unknown as BrowserWindow);
        preferred = stale as unknown as BrowserWindow;
        const existing = windowStub();
        existing.isMinimized.mockReturnValue(true);
        manager = existing as unknown as BrowserWindow;
        app.emit('activate');
        expect(existing.restore).toHaveBeenCalledOnce();
        expect(existing.show).toHaveBeenCalledOnce();
        expect(existing.focus).toHaveBeenCalledOnce();
        expect(stale.show).not.toHaveBeenCalled();
        expect(createManager).not.toHaveBeenCalled();
    });

    it('recovers on the last project close without needing window-all-closed', async () => {
        recoverAfterProjectWindowClosed();
        await vi.runAllTimersAsync();
        expect(createManager).toHaveBeenCalledOnce();
    });

    it('coalesces project-closed and window-all-closed into one recovery', async () => {
        recoverAfterProjectWindowClosed();
        app.emit('window-all-closed');
        await vi.runAllTimersAsync();
        expect(createManager).toHaveBeenCalledOnce();
    });

    it('does not recover if a replacement project registers before the close settles', async () => {
        recoverAfterProjectWindowClosed();
        windows.set(2, windowStub() as unknown as BrowserWindow);
        await vi.runAllTimersAsync();
        expect(createManager).not.toHaveBeenCalled();
    });

    it('does not refocus an existing manager as a side effect of project closure', async () => {
        manager = windowStub() as unknown as BrowserWindow;
        recoverAfterProjectWindowClosed();
        await vi.runAllTimersAsync();
        expect(manager.show).not.toHaveBeenCalled();
        expect(createManager).not.toHaveBeenCalled();
    });

    it('does not resurrect windows when quit begins with recovery queued', async () => {
        recoverAfterProjectWindowClosed();
        quitting = true;
        app.emit('activate');
        await vi.runAllTimersAsync();
        expect(createManager).not.toHaveBeenCalled();
    });

    it('ignores activation before Electron is ready', () => {
        vi.mocked(app.isReady).mockReturnValue(false);
        app.emit('activate');
        expect(createManager).not.toHaveBeenCalled();
    });

    it('does not open or reveal extra windows during startup activation', () => {
        beginStartupActivation();
        app.emit('activate');
        expect(createManager).not.toHaveBeenCalled();
        finishStartupWindowCreation();
        app.emit('activate');
        expect(createManager).toHaveBeenCalledOnce();
    });

    it('reveals the manager without activating when the last project closes in the background', async () => {
        app.emit('did-resign-active');
        recoverAfterProjectWindowClosed();
        await vi.runAllTimersAsync();
        expect(createManager).toHaveBeenCalledWith({ revealInactive: true });

        manager = null;
        app.emit('did-become-active');
        recoverAfterProjectWindowClosed();
        await vi.runAllTimersAsync();
        expect(createManager).toHaveBeenLastCalledWith({ revealInactive: false });
    });

    it.each([
        ['darwin', false],
        ['win32', true],
    ] as const)('honors a manually closed manager on %s in real close order', async (platform, quits) => {
        const original = Object.getOwnPropertyDescriptor(process, 'platform')!;
        Object.defineProperty(process, 'platform', { value: platform });
        try {
            wasManuallyClosed.mockReturnValue(true);
            // The project's closed event precedes window-all-closed.
            recoverAfterProjectWindowClosed();
            app.emit('window-all-closed');
            await vi.runAllTimersAsync();
            expect(createManager).not.toHaveBeenCalled();
            expect(vi.mocked(app.quit).mock.calls.length > 0).toBe(quits);
            if (!quits) {
                app.emit('activate');
                expect(createManager).toHaveBeenCalledOnce();
            }
        } finally {
            Object.defineProperty(process, 'platform', original);
        }
    });

    describe('relaunch while running (second-instance, #1189)', () => {
        // A dev argv: [electron, appPath, ...user args].
        const bareLaunch = ['/usr/bin/electron', '/app'];
        const handlers = { handleDeepLink: vi.fn(), openLaunchTarget: vi.fn(() => true) };
        let captureHelper: ReturnType<typeof windowStub>;
        beforeEach(() => {
            // The hidden offscreen capture window (?mode=capture) is a live
            // BrowserWindow but never a registered project window.
            captureHelper = windowStub();
            allWindows.list = [captureHelper];
        });
        const relaunch = (argv = bareLaunch) => handleSecondInstance(argv, '/home/user', handlers);

        it('opens the Project Manager when only the hidden capture window is alive', () => {
            relaunch();
            expect(createManager).toHaveBeenCalledOnce();
            expect(captureHelper.focus).not.toHaveBeenCalled();
            expect(captureHelper.show).not.toHaveBeenCalled();
        });

        it('shows and focuses a hidden project window instead of the helper', () => {
            const hiddenProject = windowStub();
            windows.set(1, hiddenProject as unknown as BrowserWindow);
            allWindows.list = [captureHelper, hiddenProject];
            relaunch();
            expect(hiddenProject.show).toHaveBeenCalledOnce();
            expect(hiddenProject.focus).toHaveBeenCalledOnce();
            expect(captureHelper.focus).not.toHaveBeenCalled();
            expect(createManager).not.toHaveBeenCalled();
        });

        it('does nothing, and does not throw, while startup activation is pending', () => {
            beginStartupActivation();
            expect(() => relaunch()).not.toThrow();
            expect(createManager).not.toHaveBeenCalled();
            expect(captureHelper.focus).not.toHaveBeenCalled();
            expect(captureHelper.show).not.toHaveBeenCalled();
        });

        it('skips the fallback when the launch target was opened', () => {
            const folder = tmpdir();
            relaunch([...bareLaunch, folder]);
            expect(handlers.openLaunchTarget).toHaveBeenCalledWith({ kind: 'directory', path: folder });
            expect(createManager).not.toHaveBeenCalled();
            expect(captureHelper.focus).not.toHaveBeenCalled();
        });

        it('forwards a deep link and still brings an app window back', () => {
            relaunch([...bareLaunch, 'nimbalyst://open?x=1']);
            expect(handlers.handleDeepLink).toHaveBeenCalledWith('nimbalyst://open?x=1');
            expect(handlers.openLaunchTarget).not.toHaveBeenCalled();
            expect(createManager).toHaveBeenCalledOnce();
        });

        it('logs instead of throwing when window recovery is not initialized', () => {
            dispose();
            expect(() => relaunch()).not.toThrow();
            expect(logger.main.error).toHaveBeenCalledOnce();
            expect(createManager).not.toHaveBeenCalled();
        });
    });
});
