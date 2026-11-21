import { app } from 'electron';
import { logger } from '../utils/logger';
import { resolveLaunchTarget, userArgsStart, type LaunchTarget } from '../shellCommand/launchTarget';
import { restoreApplicationWindow } from './ApplicationWindowRecovery';

export interface SecondInstanceHandlers {
    handleDeepLink(url: string): void;
    /** Returns false when there was nothing to open. */
    openLaunchTarget(target: LaunchTarget): boolean;
}

/**
 * The primary instance's answer to a relaunch: forward its deep link or path,
 * else bring back the app window the user would expect (#1189).
 */
export function handleSecondInstance(
    argv: string[],
    workingDirectory: string,
    handlers: SecondInstanceHandlers,
): void {
    logger.main.info('[SingleInstance] second-instance event, argv:', argv);

    // On Windows the protocol URL is passed as the last argument
    const deepLinkUrl = argv.find(arg => arg.startsWith('nimbalyst://'));
    if (deepLinkUrl) {
        handlers.handleDeepLink(deepLinkUrl);
    }

    // A file or folder path: Windows/Linux file opens, and the
    // `nimbalyst` shell command, whose relative paths are resolved
    // against the terminal's directory.
    const launchTarget = resolveLaunchTarget(argv.slice(userArgsStart(app.isPackaged)), workingDirectory);
    if (launchTarget) {
        // A terminal launch leaves the terminal frontmost; bring
        // Nimbalyst forward before the target window is focused.
        if (process.platform === 'darwin') app.focus({ steal: true });
        if (handlers.openLaunchTarget(launchTarget)) return;
    }

    // Not getAllWindows()[0]: that can be a hidden helper such as the capture
    // window, and focusing it shows nothing.
    try {
        restoreApplicationWindow();
    } catch (error) {
        logger.main.error('[SingleInstance] Could not restore an app window:', error);
    }
}
