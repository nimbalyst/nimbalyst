import { logger } from '../utils/logger';

/**
 * Whether this process owns the app: the database, extension backends, MCP
 * servers, windows, logs and quit cleanup. True for the single-instance
 * winner and for processes that never ask for the lock (multi-instance dev,
 * Playwright). A process that lost the lock only relays its launch and quits,
 * and Electron still emits `ready` and the app events in it, even after an
 * early `app.quit()` (#1188, #1070). One-way: a loser never gains the lock.
 */
let ownsLifecycle = true;

export function markSingleInstanceLockLost(): void {
    ownsLifecycle = false;
}

export function ownsAppLifecycle(): boolean {
    return ownsLifecycle;
}

/**
 * Wrap an app event handler or `whenReady` callback so it does nothing in a
 * process that lost the lock. Ownership is read when the event fires. A
 * skipped `before-quit` never calls `preventDefault`, so the quit proceeds.
 */
export function ownerOnly<A extends unknown[], R>(
    label: string,
    handler: (...args: A) => R,
): (...args: A) => R | undefined {
    return (...args: A) => {
        if (!ownsLifecycle) {
            logger.main.info(`[SingleInstance] Another instance owns the app; skipping ${label}`);
            return undefined;
        }
        return handler(...args);
    };
}

export function resetLifecycleOwnershipForTests(): void {
    ownsLifecycle = true;
}
