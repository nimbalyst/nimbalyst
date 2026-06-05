import { BrowserWindow, shell, nativeImage, app, powerMonitor } from 'electron';
import { safeHandle, safeOn } from '../utils/ipcRegistry';
import { windowStates, windows, getWindowId } from '../window/WindowManager';
import { basename, join } from 'path';
import { writeFileSync, existsSync } from 'fs';
import { tmpdir } from 'os';
import { reportDesktopActivity, setWindowFocused, setScreenLocked, setIdleThresholdMs, attemptReconnect } from '../services/SyncManager';
import { startNetworkAvailability, onNetworkAvailable, notifyNetworkAvailable } from '../services/NetworkAvailability';
import { AnalyticsService } from '../services/analytics/AnalyticsService';
import { getPackageRoot } from '../utils/appPaths';

/** Timestamp of last app_foregrounded event, used to throttle to once per 30 minutes */
let lastForegroundedEventAt = 0;
const FOREGROUND_THROTTLE_MS = 30 * 60 * 1000; // 30 minutes

export function registerWindowHandlers() {
    // Get initial window state
    safeHandle('get-initial-state', (event) => {
        const window = BrowserWindow.fromWebContents(event.sender);
        if (!window) return null;

        const windowId = [...windows.entries()].find(([, win]) => win === window)?.[0];
        if (windowId === undefined) return null;

        const state = windowStates.get(windowId);
        if (!state) return null;

        if (state.mode === 'workspace' && state.workspacePath) {
            const openProjectPaths = [state.workspacePath, ...(state.additionalWorkspacePaths ?? [])]
                .filter((path, index, paths) => typeof path === 'string' && path.length > 0 && paths.indexOf(path) === index);
            const activeWorkspacePath =
                state.activeWorkspacePath && openProjectPaths.includes(state.activeWorkspacePath)
                    ? state.activeWorkspacePath
                    : state.workspacePath;
            return {
                mode: 'workspace',
                workspacePath: state.workspacePath,
                workspaceName: basename(state.workspacePath),
                activeWorkspacePath,
                openProjectPaths,
            };
        }

        return {
            mode: 'document'
        };
    });

    // Open external URL in default browser
    safeHandle('open-external', async (event, url: string) => {
        if (url && typeof url === 'string') {
            await shell.openExternal(url);
        }
    });

    safeHandle('legal:open-third-party-notices', async () => {
        const noticesPath = app.isPackaged
            ? join(process.resourcesPath, 'legal', 'THIRD_PARTY_NOTICES.txt')
            : join(getPackageRoot(), 'resources', 'generated', 'THIRD_PARTY_NOTICES.txt');

        if (!existsSync(noticesPath)) {
            return { success: false, error: `Third-party notices file not found at: ${noticesPath}` };
        }

        const result = await shell.openPath(noticesPath);
        if (result) {
            return { success: false, error: result };
        }

        return { success: true };
    });

    // Get current workspace path for the calling window
    safeHandle('workspace:get-current', (event) => {
        const window = BrowserWindow.fromWebContents(event.sender);
        if (!window) return null;

        const windowId = [...windows.entries()].find(([, win]) => win === window)?.[0];
        if (windowId === undefined) return null;

        const state = windowStates.get(windowId);
        if (!state || state.mode !== 'workspace') return null;

        return {
            path: state.workspacePath,
            name: state.workspacePath ? basename(state.workspacePath) : null
        };
    });
    // Set document edited state
    safeOn('set-document-edited', (event, edited: boolean) => {
        const window = BrowserWindow.fromWebContents(event.sender);
        if (!window) return;

        window.setDocumentEdited(edited);
    });

    // Set window title
    safeOn('set-title', (event, title: string) => {
        const window = BrowserWindow.fromWebContents(event.sender);
        if (window) {
            window.setTitle(title);
        }
    });


    // Open image in default application
    safeHandle('image:open-in-default-app', async (event, imagePath: string) => {
        try {
            // Handle data URLs by creating a temp file
            if (imagePath.startsWith('data:')) {
                const tempPath = await createTempFileFromDataURL(imagePath);
                if (tempPath) {
                    await shell.openPath(tempPath);
                    return { success: true };
                } else {
                    return { success: false, error: 'Failed to create temp file from data URL' };
                }
            }

            // Handle file:// URLs
            let filePath = imagePath;
            if (filePath.startsWith('file://')) {
                filePath = filePath.replace('file://', '');
            }

            // Check if file exists
            if (!existsSync(filePath)) {
                return { success: false, error: 'File does not exist' };
            }

            // Open in default application
            const result = await shell.openPath(filePath);
            if (result) {
                // openPath returns an error string if it failed, empty string on success
                return { success: false, error: result };
            }
            return { success: true };
        } catch (error: any) {
            console.error('[IMAGE] Failed to open image:', error);
            return { success: false, error: error.message };
        }
    });

    // Start native drag for image
    safeHandle('image:start-drag', async (event, imagePath: string) => {
        try {
            const window = BrowserWindow.fromWebContents(event.sender);
            if (!window) {
                return { success: false, error: 'Window not found' };
            }

            // Handle data URLs by creating a temp file
            if (imagePath.startsWith('data:')) {
                const tempPath = await createTempFileFromDataURL(imagePath);
                if (!tempPath) {
                    return { success: false, error: 'Failed to create temp file from data URL' };
                }
                imagePath = tempPath;
            }

            // Handle file:// URLs
            let filePath = imagePath;
            if (filePath.startsWith('file://')) {
                filePath = filePath.replace('file://', '');
            }

            // Check if file exists
            if (!existsSync(filePath)) {
                return { success: false, error: 'File does not exist' };
            }

            // Create icon for drag preview
            const icon = nativeImage.createFromPath(filePath);

            // Start drag operation
            event.sender.startDrag({
                file: filePath,
                icon: icon.resize({ width: 64, height: 64 })
            });

            return { success: true };
        } catch (error: any) {
            console.error('[IMAGE] Failed to start drag:', error);
            return { success: false, error: error.message };
        }
    });

    // Report user activity from renderer (for sync presence awareness)
    safeOn('user-activity', () => {
        reportDesktopActivity();
    });

    // Track window focus for sync presence and DAU analytics
    // Note: These are app-level events, not window-specific
    app.on('browser-window-focus', () => {
        setWindowFocused(true);

        // Emit app_foregrounded for DAU tracking when a window gains focus,
        // throttled to once per 30 minutes to keep event volume low
        const now = Date.now();
        if (now - lastForegroundedEventAt >= FOREGROUND_THROTTLE_MS) {
            lastForegroundedEventAt = now;
            AnalyticsService.getInstance().sendEvent('app_foregrounded');
        }
    });

    app.on('browser-window-blur', () => {
        // Check if any window is still focused
        const anyFocused = BrowserWindow.getAllWindows().some(w => w.isFocused());
        setWindowFocused(anyFocused);
    });

    // Track screen lock state for sync presence. Note: reconnect logic itself
    // lives in NetworkAvailability -- this handler is only for presence.
    powerMonitor.on('lock-screen', () => {
        setScreenLocked(true);
    });

    powerMonitor.on('unlock-screen', () => {
        setScreenLocked(false);
    });

    // Start the centralized NetworkAvailability broker and subscribe the sync
    // reconnect cascade to it. The broker owns all OS-level network signals
    // (resume, unlock, net.isOnline polling, renderer online events) and
    // debounces them so attemptReconnect runs at most once per burst.
    startNetworkAvailability();
    onNetworkAvailable(() => {
        attemptReconnect().catch(() => {
            // Errors are logged in attemptReconnect
        });
    });

    // Allow the renderer to forward `window.online` events. Chromium fires
    // these on network-interface changes even when macOS doesn't deliver
    // a powerMonitor event (e.g. hotel wifi handoff without sleep/lock).
    safeOn('sync:network-came-online', () => {
        notifyNetworkAvailable('renderer:window.online');
    });

    // IPC handler to set idle threshold for testing
    safeHandle('sync:set-idle-threshold', (_event, ms: number) => {
        if (typeof ms === 'number' && ms > 0) {
            setIdleThresholdMs(ms);
            return { success: true };
        }
        return { success: false, error: 'Invalid threshold value' };
    });
}

// Helper function to create a temp file from a data URL
async function createTempFileFromDataURL(dataURL: string): Promise<string | null> {
    try {
        // Parse data URL: data:image/png;base64,iVBORw0KGgo...
        const matches = dataURL.match(/^data:([^;]+);base64,(.+)$/);
        if (!matches) {
            console.error('[IMAGE] Invalid data URL format');
            return null;
        }

        const mimeType = matches[1];
        const base64Data = matches[2];

        // Determine file extension from MIME type
        const extensionMap: Record<string, string> = {
            'image/png': 'png',
            'image/jpeg': 'jpg',
            'image/jpg': 'jpg',
            'image/gif': 'gif',
            'image/webp': 'webp',
            'image/svg+xml': 'svg',
        };
        const extension = extensionMap[mimeType] || 'png';

        // Create temp file
        const tempPath = join(tmpdir(), `image-${Date.now()}.${extension}`);
        const buffer = Buffer.from(base64Data, 'base64');
        writeFileSync(tempPath, buffer);

        return tempPath;
    } catch (error) {
        console.error('[IMAGE] Failed to create temp file:', error);
        return null;
    }
}
