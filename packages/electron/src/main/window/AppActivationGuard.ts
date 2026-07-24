import { app } from 'electron';

let appIsActive = process.platform !== 'darwin';

app.on('did-become-active', () => {
    appIsActive = true;
});
app.on('did-resign-active', () => {
    appIsActive = false;
});

interface GuardedWindow {
    isDestroyed(): boolean;
    once(event: 'closed', listener: () => void): unknown;
    removeListener(event: 'closed', listener: () => void): unknown;
}

/**
 * Run a startup action only while Nimbalyst is already active. On macOS,
 * revealing a late-loading window can reactivate the app even when Electron's
 * showInactive API is used, so background startup actions wait until the user
 * explicitly returns to Nimbalyst.
 */
export function runWhenAppIsActive(
    window: GuardedWindow,
    action: () => void,
    platform: NodeJS.Platform = process.platform,
): void {
    if (window.isDestroyed()) return;

    if (platform !== 'darwin' || appIsActive) {
        action();
        return;
    }

    let settled = false;
    const cleanup = () => {
        app.removeListener('did-become-active', run);
        window.removeListener('closed', cancel);
    };
    const run = () => {
        if (settled) return;
        settled = true;
        cleanup();
        if (!window.isDestroyed()) action();
    };
    const cancel = () => {
        if (settled) return;
        settled = true;
        cleanup();
    };

    app.once('did-become-active', run);
    window.once('closed', cancel);

    // Close the registration race if the app became active between the first
    // isActive() check and listener installation.
    if (appIsActive) run();
}
