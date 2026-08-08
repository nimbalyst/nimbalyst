import { dialog, type BrowserWindow } from 'electron';

export interface UnresponsiveHandlerOptions {
    /** `message` line for the dialog (differs per window). */
    message: string;
    /** Log prefix, e.g. '[MAIN]' or '[WorkspaceManager]'. */
    logLabel: string;
    /** Resolve the current window; may return null once it has been torn down. */
    getWindow: () => BrowserWindow | null;
}

/**
 * Build the `webContents` `unresponsive` handler.
 *
 * Uses the async dialog.showMessageBox, NOT showMessageBoxSync: the sync variant
 * spins a nested GLib modal loop that blocks the main process, so a dialog that
 * can't be dismissed (headless/off-screen/WSLg) wedges the whole app and defeats
 * the render-process-gone -> reload() recovery. The guard prevents stacking a
 * second dialog while one is already open, since the renderer keeps firing
 * `unresponsive` every few seconds while it stays hung.
 */
export function createUnresponsiveHandler(
    options: UnresponsiveHandlerOptions
): () => Promise<void> {
    const { message, logLabel, getWindow } = options;
    let dialogOpen = false;

    return async () => {
        console.warn(`${logLabel} Window became unresponsive`);
        if (dialogOpen) {
            return;
        }
        const window = getWindow();
        if (!window || window.isDestroyed()) {
            return;
        }
        dialogOpen = true;
        try {
            const { response } = await dialog.showMessageBox(window, {
                type: 'warning',
                buttons: ['Reload', 'Keep Waiting'],
                defaultId: 0,
                cancelId: 1,
                message,
                detail: 'Would you like to reload the window?'
            });

            const current = getWindow();
            if (response === 0 && current && !current.isDestroyed()) {
                current.reload();
            }
        } finally {
            dialogOpen = false;
        }
    };
}
