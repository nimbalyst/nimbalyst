import { runWhenAppIsActive } from './AppActivationGuard';

export interface RevealableWindow {
    show(): void;
    showInactive(): void;
    maximize(): void;
    isDestroyed(): boolean;
    once(event: 'closed', listener: () => void): unknown;
    removeListener(event: 'closed', listener: () => void): unknown;
}

export interface RevealOptions {
    showInactive?: boolean;
    deferShowUntilAppActive?: boolean;
}

/**
 * Reveal a ready-to-show window, honoring the no-focus-steal startup guard.
 *
 * maximize() must run *inside* the guarded show action. On a hidden window
 * Electron's maximize() implicitly shows the window, so calling it before the
 * guard reveals (and on macOS reactivates) the window ahead of the app-active
 * gate — the exact focus steal deferShowUntilAppActive prevents. Restoring a
 * maximized window therefore has to defer maximize alongside the show, not
 * ahead of it. See PR #1079 review (ghinkle).
 */
export function revealReadyWindow(
    window: RevealableWindow,
    options: RevealOptions | undefined,
    savedBounds: { isMaximized?: boolean } | undefined,
    platform: NodeJS.Platform = process.platform,
): void {
    const showWindow = () => {
        if (options?.showInactive) {
            window.showInactive();
        } else {
            window.show();
        }
        if (savedBounds?.isMaximized) {
            window.maximize();
        }
    };

    if (options?.deferShowUntilAppActive) {
        runWhenAppIsActive(window, showWindow, platform);
        return;
    }

    showWindow();
}
