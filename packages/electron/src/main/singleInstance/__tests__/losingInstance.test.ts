// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../utils/logger', () => ({ logger: { main: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } } }));

import { EventEmitter } from 'events';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import os from 'os';
import path from 'path';
import { logger } from '../../utils/logger';
import {
    consumeLaunchSignals,
    isLaunchSignalFilename,
    PENDING_OPEN_FILE_SIGNAL,
    PENDING_OPEN_URL_SIGNAL,
    relayAppleEventThenQuit,
    relayFileToLockOwner,
} from '../launchRelay';
import { planLosingInstance } from '../losingInstancePlan';
import {
    markSingleInstanceLockLost,
    ownerOnly,
    ownsAppLifecycle,
    resetLifecycleOwnershipForTests,
} from '../lifecycleOwnership';

const file = { kind: 'file', path: '/home/me/notes/todo.md' } as const;
const folder = { kind: 'directory', path: '/home/me/notes' } as const;
const missing = { kind: 'missing', path: '/home/me/gone' } as const;

describe('what a process that lost the single-instance lock does (#1188, #1070)', () => {
    it.each(['linux', 'win32'] as const)('quits at once on %s when the launch names no file, folder or deep link', (platform) => {
        expect(planLosingInstance({ platform, launchTarget: null, hasDeepLink: false }))
            .toEqual({ action: 'quit', reason: 'no-target' });
    });

    it('waits for an open-file or open-url Apple Event on macOS when argv names nothing', () => {
        expect(planLosingInstance({ platform: 'darwin', launchTarget: null, hasDeepLink: false }))
            .toEqual({ action: 'wait-for-apple-event', timeoutMs: 5000 });
    });

    it.each(['darwin', 'linux', 'win32'] as const)('relays a file named in argv to the primary and quits on %s', (platform) => {
        expect(planLosingInstance({ platform, launchTarget: file, hasDeepLink: false }))
            .toEqual({ action: 'relay-file-and-quit', filePath: file.path });
    });

    it.each(['darwin', 'linux', 'win32'] as const)('quits without waiting on %s for a folder, a missing path or a deep link', (platform) => {
        expect(planLosingInstance({ platform, launchTarget: folder, hasDeepLink: false }))
            .toEqual({ action: 'quit', reason: 'directory' });
        expect(planLosingInstance({ platform, launchTarget: missing, hasDeepLink: false }))
            .toEqual({ action: 'quit', reason: 'missing' });
        expect(planLosingInstance({ platform, launchTarget: null, hasDeepLink: true }))
            .toEqual({ action: 'quit', reason: 'deep-link' });
    });
});

describe('guards on app initialisation and quit cleanup', () => {
    beforeEach(() => {
        resetLifecycleOwnershipForTests();
        vi.clearAllMocks();
    });

    it('runs the guarded handler with its arguments in a process that holds the lock or never asked for it', async () => {
        const cleanup = vi.fn(async (_event: { preventDefault(): void }) => 'cleaned');
        const event = { preventDefault: vi.fn() };

        expect(ownsAppLifecycle()).toBe(true);
        await expect(ownerOnly('quit cleanup', cleanup)(event)).resolves.toBe('cleaned');
        expect(cleanup).toHaveBeenCalledWith(event);
    });

    it('skips the before-quit cleanup after the lock was lost and leaves the quit to proceed', () => {
        // The real cleanup calls preventDefault first and quits again later.
        const cleanup = vi.fn((event: { preventDefault(): void }) => event.preventDefault());
        const event = { preventDefault: vi.fn() };

        markSingleInstanceLockLost();
        ownerOnly('quit cleanup', cleanup)(event);

        expect(ownsAppLifecycle()).toBe(false);
        expect(cleanup).not.toHaveBeenCalled();
        expect(event.preventDefault).not.toHaveBeenCalled();
        expect(logger.main.info).toHaveBeenCalledWith(expect.stringContaining('skipping quit cleanup'));
    });

    it('skips app initialisation when ready still fires in a process that lost the lock', async () => {
        // Electron emits ready even after an early app.quit(); whenReady callers must not boot.
        const initialise = vi.fn(async () => {});
        const ready = Promise.resolve();

        markSingleInstanceLockLost();
        await ready.then(ownerOnly('app initialisation', initialise));

        expect(initialise).not.toHaveBeenCalled();
    });

    it('reads ownership when the event fires, not when the handler is wrapped', () => {
        const onActivate = vi.fn();
        const guarded = ownerOnly('activate', onActivate);

        markSingleInstanceLockLost();
        guarded();

        expect(onActivate).not.toHaveBeenCalled();
    });
});

describe('relaying a launch from the process that lost the lock to the owner', () => {
    let userData: string;
    const preventDefault = () => {};

    beforeEach(() => {
        vi.useFakeTimers();
        userData = mkdtempSync(path.join(os.tmpdir(), 'nim-launch-relay-'));
    });
    afterEach(() => {
        vi.useRealTimers();
        rmSync(userData, { recursive: true, force: true });
    });

    function loseLockOnMac() {
        const plan = planLosingInstance({ platform: 'darwin', launchTarget: null, hasDeepLink: false });
        if (plan.action !== 'wait-for-apple-event') throw new Error(`unexpected plan ${plan.action}`);
        const loser = new EventEmitter();
        const quit = vi.fn();
        relayAppleEventThenQuit({ app: loser, userDataPath: userData, timeoutMs: plan.timeoutMs, quit });
        return { loser, quit };
    }

    function drainOwner() {
        const opened = { files: [] as string[], urls: [] as string[] };
        consumeLaunchSignals(userData, {
            openFile: (p) => opened.files.push(p),
            openUrl: (u) => opened.urls.push(u),
        });
        return opened;
    }

    it('hands a macOS open-url deep link to the owner when argv carries no URL', () => {
        const { loser, quit } = loseLockOnMac();
        const url = 'nimbalyst://tracker/abc?orgId=o1';

        loser.emit('open-url', { preventDefault }, url);

        expect(quit).toHaveBeenCalledTimes(1);
        expect(drainOwner()).toEqual({ files: [], urls: [url] });
        // Consumed once: a later watcher tick does not open it again.
        expect(drainOwner()).toEqual({ files: [], urls: [] });
        expect(existsSync(path.join(userData, PENDING_OPEN_URL_SIGNAL))).toBe(false);
    });

    it('hands a macOS open-file path to the owner and ignores a later event', () => {
        const { loser, quit } = loseLockOnMac();
        const file = path.join(userData, 'todo.md');
        writeFileSync(file, '# todo');

        loser.emit('open-file', { preventDefault }, file);
        loser.emit('open-url', { preventDefault }, 'nimbalyst://late');
        vi.advanceTimersByTime(10_000);

        expect(quit).toHaveBeenCalledTimes(1);
        expect(drainOwner()).toEqual({ files: [file], urls: [] });
    });

    it('quits after the wait with nothing relayed when no Apple Event arrives', () => {
        const { quit } = loseLockOnMac();

        vi.advanceTimersByTime(4999);
        expect(quit).not.toHaveBeenCalled();
        vi.advanceTimersByTime(1);

        expect(quit).toHaveBeenCalledTimes(1);
        expect(drainOwner()).toEqual({ files: [], urls: [] });
    });

    it('relays a file named in argv, and the owner skips a missing file or a non-nimbalyst URL', () => {
        const file = path.join(userData, 'notes.md');
        writeFileSync(file, '');
        relayFileToLockOwner(userData, file);
        expect(drainOwner()).toEqual({ files: [file], urls: [] });

        relayFileToLockOwner(userData, path.join(userData, 'gone.md'));
        writeFileSync(path.join(userData, PENDING_OPEN_URL_SIGNAL), 'https://example.com');
        expect(drainOwner()).toEqual({ files: [], urls: [] });
        expect(existsSync(path.join(userData, PENDING_OPEN_FILE_SIGNAL))).toBe(false);
        expect(existsSync(path.join(userData, PENDING_OPEN_URL_SIGNAL))).toBe(false);
    });

    it('watches both signal file names and nothing else', () => {
        expect(isLaunchSignalFilename(PENDING_OPEN_FILE_SIGNAL)).toBe(true);
        expect(isLaunchSignalFilename(PENDING_OPEN_URL_SIGNAL)).toBe(true);
        expect(isLaunchSignalFilename('main.log')).toBe(false);
        expect(isLaunchSignalFilename(null)).toBe(false);
    });
});
