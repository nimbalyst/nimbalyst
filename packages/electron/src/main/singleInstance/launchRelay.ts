import type { EventEmitter } from 'events';
import { existsSync, readFileSync, unlinkSync, writeFileSync } from 'fs';
import path from 'path';
import { logger } from '../utils/logger';

/**
 * Signal files a process that lost the single-instance lock writes into
 * userData for the lock owner, which watches that directory. Files and deep
 * links that reach the loser through argv also reach the owner through its
 * `second-instance` event; these signals cover what argv does not carry: a
 * file named in argv (kept for dev, where the owner may be a different app),
 * and on macOS the `open-file` and `open-url` Apple Events.
 */
export const PENDING_OPEN_FILE_SIGNAL = '.pending-open-file';
export const PENDING_OPEN_URL_SIGNAL = '.pending-open-url';

export function isLaunchSignalFilename(filename: string | null | undefined): boolean {
    return filename === PENDING_OPEN_FILE_SIGNAL || filename === PENDING_OPEN_URL_SIGNAL;
}

function writeSignal(userDataPath: string, signal: string, value: string): void {
    const signalPath = path.join(userDataPath, signal);
    try {
        writeFileSync(signalPath, value, 'utf-8');
        logger.main.info(`[SingleInstance] Wrote signal file: ${signalPath}`);
    } catch (err) {
        logger.main.error('[SingleInstance] Failed to write signal file:', err);
    }
}

export function relayFileToLockOwner(userDataPath: string, filePath: string): void {
    writeSignal(userDataPath, PENDING_OPEN_FILE_SIGNAL, filePath);
}

/**
 * macOS: a launch that lost the lock gets its file or deep link as an Apple
 * Event (`open-file` or `open-url`), delivered only once the event loop runs
 * and never in argv, so the owner's `second-instance` event cannot see it.
 * Wait for either event, relay it through a signal file, then quit. Quit
 * anyway after `timeoutMs` if neither arrives.
 */
export function relayAppleEventThenQuit(options: {
    app: Pick<EventEmitter, 'on'>;
    userDataPath: string;
    timeoutMs: number;
    quit: () => void;
}): void {
    const { app, userDataPath, quit } = options;
    let relayed = false;
    const relayOnce = (signal: string, value: string) => {
        if (relayed) return;
        relayed = true;
        writeSignal(userDataPath, signal, value);
        quit();
    };

    app.on('open-file', (event: { preventDefault(): void }, filePath: string) => {
        event.preventDefault();
        logger.main.info(`[SingleInstance] Second instance received open-file: ${filePath}`);
        relayOnce(PENDING_OPEN_FILE_SIGNAL, filePath);
    });
    app.on('open-url', (event: { preventDefault(): void }, url: string) => {
        event.preventDefault();
        logger.main.info('[SingleInstance] Second instance received open-url');
        relayOnce(PENDING_OPEN_URL_SIGNAL, url);
    });

    setTimeout(() => {
        if (relayed) return;
        relayed = true;
        logger.main.info('[SingleInstance] No open-file or open-url after timeout, quitting');
        quit();
    }, options.timeoutMs);
}

function takeSignal(userDataPath: string, signal: string): string | null {
    const signalPath = path.join(userDataPath, signal);
    try {
        if (!existsSync(signalPath)) return null;
        const value = readFileSync(signalPath, 'utf-8').trim();
        unlinkSync(signalPath);
        return value || null;
    } catch (err) {
        logger.main.warn(`[SingleInstance] Failed to read signal file ${signalPath}:`, err);
        return null;
    }
}

/**
 * Lock owner: consume any signal a second instance wrote. A file is opened
 * only if it exists; a URL only if it is a nimbalyst:// link.
 */
export function consumeLaunchSignals(
    userDataPath: string,
    handlers: { openFile: (filePath: string) => void; openUrl: (url: string) => void },
): void {
    const filePath = takeSignal(userDataPath, PENDING_OPEN_FILE_SIGNAL);
    if (filePath && existsSync(filePath)) {
        logger.main.info(`[SingleInstance] Opening file from signal: ${filePath}`);
        handlers.openFile(filePath);
    }
    const url = takeSignal(userDataPath, PENDING_OPEN_URL_SIGNAL);
    if (url && url.startsWith('nimbalyst://')) {
        logger.main.info('[SingleInstance] Opening deep link from signal');
        handlers.openUrl(url);
    }
}
