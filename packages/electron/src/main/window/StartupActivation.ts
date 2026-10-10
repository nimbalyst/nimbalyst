import { app } from 'electron';
import { logger } from '../utils/logger';

/**
 * Startup foregrounding coordinator.
 *
 * Launch used to reveal each window with a plain show(), which on macOS
 * reactivates Nimbalyst — a workspace restore could yank focus back from
 * whatever the user switched to, repeatedly, across a 30s+ load. The first fix
 * gated every show() behind "the app is currently active", which traded that
 * for a worse failure: a window whose ready-to-show landed while the app was
 * inactive was never shown *at all*, so a launch where macOS never sent
 * did-become-active (updater relaunch, `open -g`, or simply switching away
 * mid-load) left the user with no visible window until they clicked the Dock.
 *
 * This module separates the two concerns. Startup windows are always revealed
 * as they become ready, with showInactive() so none of them steals focus. Once
 * startup has created everything it intends to and every one of those windows
 * has been revealed, the app is foregrounded exactly once, targeting the window
 * that should end up frontmost.
 */

export interface StartupWindow {
    /** BrowserWindow id, for launch-tracing logs only. */
    readonly id?: number;
    isDestroyed(): boolean;
    show(): void;
    focus(): void;
    once(event: 'closed', listener: () => void): unknown;
    removeListener(event: 'closed', listener: () => void): unknown;
}

export interface BeginStartupActivationOptions {
    platform?: NodeJS.Platform;
}

export interface RegisterStartupWindowOptions {
    /**
     * Mark this window as the one to foreground at the end. Registration order
     * decides ties: session restore creates windows in ascending focus order,
     * so the last registration wins and the most recently focused window from
     * the previous run comes back on top.
     */
    frontmost?: boolean;
}

/**
 * A window that never paints must not wedge the foregrounding step forever.
 * Generous on purpose: ready-to-show is measured in tens of seconds on a large
 * workspace (29.5s in the 2026-08-11 trace), so this is a liveness backstop,
 * not a deadline — timing out never forces an unpainted window on screen.
 */
const WINDOW_READY_TIMEOUT_MS = 45_000;

/** Backstop for a startup path that throws before finishStartupWindowCreation(). */
const STARTUP_CAP_MS = 60_000;

type Phase = 'idle' | 'creating' | 'waiting' | 'done';

interface PendingEntry {
    timer: ReturnType<typeof setTimeout>;
    onClosed: () => void;
}

let phase: Phase = 'idle';
let platform: NodeJS.Platform = process.platform;
let pending = new Map<StartupWindow, PendingEntry>();
let cohort = new WeakSet<StartupWindow>();
let revealed = new WeakSet<StartupWindow>();
let registeredCount = 0;
let frontmostWindow: StartupWindow | null = null;
let lastRevealedWindow: StartupWindow | null = null;
let foregroundOnNextReveal = false;
let capTimer: ReturnType<typeof setTimeout> | null = null;
let activatedCallbacks: Array<() => void> = [];

/** Automatic macOS activate events during launch must not bypass the reveal coordinator. */
export function isStartupActivationPending(): boolean {
    return phase === 'creating' || phase === 'waiting';
}

function unrefTimer(timer: ReturnType<typeof setTimeout>): void {
    const maybeUnref = timer as unknown as { unref?: () => void };
    if (typeof maybeUnref.unref === 'function') maybeUnref.unref();
}

function clearPending(window: StartupWindow): void {
    const entry = pending.get(window);
    if (!entry) return;
    clearTimeout(entry.timer);
    window.removeListener('closed', entry.onClosed);
    pending.delete(window);
}

/**
 * Arm the coordinator. Called once at the top of app.whenReady(), before any
 * startup window is created.
 */
export function beginStartupActivation(options?: BeginStartupActivationOptions): void {
    if (phase !== 'idle') return;
    phase = 'creating';
    platform = options?.platform ?? process.platform;
    capTimer = setTimeout(() => activateNow('startup-cap-elapsed'), STARTUP_CAP_MS);
    unrefTimer(capTimer);
}

/**
 * Add a window to the startup cohort. No-op once startup foregrounding has
 * already happened, so windows opened later keep their normal activating show.
 * Returns whether the window joined.
 */
export function registerStartupWindow(
    window: StartupWindow,
    options?: RegisterStartupWindowOptions,
): boolean {
    if (phase !== 'creating' && phase !== 'waiting') return false;
    if (window.isDestroyed()) return false;

    if (options?.frontmost) frontmostWindow = window;

    if (cohort.has(window)) return true;
    cohort.add(window);
    registeredCount++;
    logger.main.info(`[startup] Registered window id=${window.id} frontmost=${!!options?.frontmost}`);

    const onClosed = () => {
        clearPending(window);
        maybeActivate();
    };
    const timer = setTimeout(() => {
        logger.main.warn(`[startup] Window id=${window.id} still has not painted; stopping the wait for it`);
        clearPending(window);
        maybeActivate();
    }, WINDOW_READY_TIMEOUT_MS);
    unrefTimer(timer);

    pending.set(window, { timer, onClosed });
    window.once('closed', onClosed);
    return true;
}

/** Whether a window is part of the startup cohort (used to pick show vs showInactive). */
export function isStartupCohortWindow(window: StartupWindow): boolean {
    return cohort.has(window);
}

/** Called after a cohort window has been revealed with showInactive(). */
export function notifyStartupWindowRevealed(window: StartupWindow): void {
    logger.main.info(`[startup] Revealed window id=${window.id} inCohort=${cohort.has(window)} stillPending=${pending.has(window)}`);
    if (!cohort.has(window)) return;
    if (!window.isDestroyed()) {
        revealed.add(window);
        lastRevealedWindow = window;
    }
    clearPending(window);

    // Every startup window took longer to paint than the coordinator was
    // willing to wait, so foregrounding was held back for the first one that
    // actually made it on screen. This is it.
    if (foregroundOnNextReveal) {
        const target = pickTarget();
        if (target) {
            foreground(target, 'first-paint-after-wait');
            return;
        }
    }

    maybeActivate();
}

/**
 * Startup has requested every window it is going to request. Foregrounding
 * happens as soon as the outstanding windows have painted.
 */
export function finishStartupWindowCreation(): void {
    if (phase !== 'creating') return;
    phase = 'waiting';
    logger.main.info(`[startup] Window creation finished; ${pending.size} window(s) still to paint`);
    maybeActivate();
}

/**
 * Run a callback once startup foregrounding is done — for actions that would
 * otherwise activate the app mid-load (restoring detached dev tools). Runs
 * immediately if foregrounding has already happened or never armed.
 */
export function onStartupActivated(callback: () => void): void {
    if ((phase === 'done' && !foregroundOnNextReveal) || phase === 'idle') {
        callback();
        return;
    }
    activatedCallbacks.push(callback);
}

function maybeActivate(): void {
    if (phase !== 'waiting') return;
    if (pending.size > 0) return;
    activateNow('startup-windows-ready');
}

/**
 * The window to bring forward — only ever one that has actually painted.
 * Foregrounding through an unpainted window puts an empty frame on screen and
 * steals focus for it, which is the failure this coordinator exists to avoid.
 */
function pickTarget(): StartupWindow | null {
    if (frontmostWindow && revealed.has(frontmostWindow) && !frontmostWindow.isDestroyed()) {
        return frontmostWindow;
    }
    if (lastRevealedWindow && !lastRevealedWindow.isDestroyed()) return lastRevealedWindow;
    return null;
}

function activateNow(reason: string): void {
    if (phase === 'done' || phase === 'idle') return;
    phase = 'done';

    if (capTimer) {
        clearTimeout(capTimer);
        capTimer = null;
    }
    for (const window of [...pending.keys()]) clearPending(window);

    if (registeredCount === 0) {
        flushActivatedCallbacks();
        return;
    }

    const target = pickTarget();
    if (!target) {
        // Nothing has painted yet. Foregrounding now would mean showing an
        // empty window, so hand the job to whichever window paints first.
        foregroundOnNextReveal = true;
        logger.main.info(`[startup] No startup window has painted yet (${reason}); waiting for first paint`);
        return;
    }

    foreground(target, reason);
}

function foreground(target: StartupWindow, reason: string): void {
    foregroundOnNextReveal = false;
    logger.main.info(
        `[startup] Foregrounding once (${reason}, ${registeredCount} startup window(s), target id=${target.id})`
    );

    target.show();
    target.focus();
    if (platform === 'darwin') {
        app.focus({ steal: true });
    }

    flushActivatedCallbacks();
}

function flushActivatedCallbacks(): void {
    const callbacks = activatedCallbacks;
    activatedCallbacks = [];
    for (const callback of callbacks) {
        try {
            callback();
        } catch (error) {
            logger.main.error('[startup] Post-activation callback failed:', error);
        }
    }
}

/** Test-only: drop all coordinator state between cases. */
export function resetStartupActivationForTests(): void {
    if (capTimer) clearTimeout(capTimer);
    for (const entry of pending.values()) clearTimeout(entry.timer);
    phase = 'idle';
    platform = process.platform;
    pending = new Map();
    cohort = new WeakSet();
    revealed = new WeakSet();
    registeredCount = 0;
    frontmostWindow = null;
    lastRevealedWindow = null;
    foregroundOnNextReveal = false;
    capTimer = null;
    activatedCallbacks = [];
}
