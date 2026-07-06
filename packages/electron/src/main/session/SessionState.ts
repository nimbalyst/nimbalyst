import { BrowserWindow } from 'electron';
import { existsSync, readFileSync, readdirSync } from 'fs';
import { windows, windowStates, createWindow, windowFocusOrder, windowDevToolsState, getWindowId } from '../window/WindowManager';
import { loadFileIntoWindow } from '../file/FileOperations';
import { getSessionState, saveSessionState as saveToStore, SessionState, clearSessionState } from '../utils/store';
import { startWorkspaceWatcher } from '../file/WorkspaceWatcher.ts';
import { getFolderContents } from '../utils/FileTree';
import { basename } from 'path';
import { logger } from '../utils/logger';
import { AnalyticsService } from '../services/analytics/AnalyticsService';
import { GitStatusService } from '../services/GitStatusService';
import { autoMatchTeamForWorkspace } from '../services/TeamService';
import { updateTrackerSchemaWorkspace } from '../services/TrackerSchemaService';

// Save session state
export async function saveSessionState() {
    const sessionWindows: any[] = [];

    for (const [windowId, window] of windows) {
        const state = windowStates.get(windowId);
        if (!state || window.isDestroyed()) continue;

        // Don't save untitled empty documents
        if (state.mode === 'document' && !state.filePath && !state.documentEdited) {
            continue;
        }

        const bounds = window.getBounds();
        const focusOrder = windowFocusOrder.get(windowId) || 0;
        const devToolsOpen = windowDevToolsState.get(windowId) || false;
        const sessionWindow: any = {
            mode: state.mode,
            bounds,
            focusOrder,
            devToolsOpen
        };

        if (state.filePath) {
            sessionWindow.filePath = state.filePath;
        }
        if (state.workspacePath) {
            sessionWindow.workspacePath = state.workspacePath;
        }

        sessionWindows.push(sessionWindow);
    }

    const sessionState: SessionState = {
        windows: sessionWindows,
        lastUpdated: Date.now()
    };

    logger.session.debug(`[SAVE] Saving session state: ${sessionWindows.length} window(s): ${sessionWindows.map((w) => w.workspacePath || w.filePath || w.mode).join(', ')}`);
    saveToStore(sessionState);

    // Verify the save by reading it back
    const verified = getSessionState();
    logger.session.debug(`[SAVE] Verified session state: ${verified?.windows?.length ?? 0} window(s)`);
}

// Restore session state
// Returns true if windows were restored, false otherwise.
// The last window (highest focus order) uses show() to activate the app once;
// all other windows use showInactive() to avoid repeated activation.
export async function restoreSessionState(): Promise<boolean> {
    // In test mode (PLAYWRIGHT=1), always clear and skip session restoration
    // Tests that want to test restoration will not set PLAYWRIGHT env var at all
    if (process.env.PLAYWRIGHT === '1') {
        logger.session.info('Test mode: clearing and skipping session restoration');
        clearSessionState();
        return false;
    }

    const sessionState = getSessionState();

    // logger.session.info('[RESTORE] Retrieved session state:', JSON.stringify(sessionState, null, 2));

    if (!sessionState || !sessionState.windows || sessionState.windows.length === 0) {
        logger.session.info('[RESTORE] No session state to restore (empty or missing)');
        return false;
    }

    // logger.session.info(`[RESTORE] Restoring session with ${sessionState.windows.length} window(s)`);

    // Sort windows by focus order - LOWEST first, HIGHEST last
    // Windows are shown in creation order, and macOS will naturally focus the last shown window
    const sortedWindows = [...sessionState.windows].sort((a, b) => {
        const aOrder = a.focusOrder || 0;
        const bOrder = b.focusOrder || 0;
        return aOrder - bOrder;
    });

    logger.session.info(`Window creation order (by focusOrder):`, sortedWindows.map((w, i) =>
        `${i}: ${w.mode} focusOrder=${w.focusOrder}`
    ));

    // Restore each window in order
    // Use async creation to ensure windows are created sequentially
    // The last window (highest focus order) uses show() to activate the app once;
    // all earlier windows use showInactive() so the app doesn't steal focus repeatedly.
    const totalWindows = sortedWindows.length;

    for (let index = 0; index < totalWindows; index++) {
        const sessionWindow = sortedWindows[index];

        // Wait for previous window to be ready before creating next
        await new Promise<void>((resolve) => {
            setTimeout(async () => {
                let window: BrowserWindow | null = null;

                if (sessionWindow.mode === 'workspace' && sessionWindow.workspacePath) {
                    // Check if workspace path still exists
                    if (existsSync(sessionWindow.workspacePath)) {
                        // Track workspace opened from startup restore
                        try {
                            // Count files and check for subfolders
                            let fileCount = 0;
                            let hasSubfolders = false;
                            try {
                                const entries = readdirSync(sessionWindow.workspacePath, { withFileTypes: true });
                                for (const entry of entries) {
                                    if (entry.isFile()) {
                                        fileCount++;
                                    } else if (entry.isDirectory() && !entry.name.startsWith('.')) {
                                        hasSubfolders = true;
                                    }
                                }
                            } catch (error) {
                                // Ignore count errors
                            }

                            // Bucket file count
                            let fileCountBucket = '1-10';
                            if (fileCount > 100) fileCountBucket = '100+';
                            else if (fileCount > 50) fileCountBucket = '51-100';
                            else if (fileCount > 10) fileCountBucket = '11-50';

                            // Check git repository status (defaults to false if git not available)
                            let isGitRepository = false;
                            let isGitHub = false;

                            try {
                                const gitStatusService = new GitStatusService();
                                isGitRepository = await gitStatusService.isGitRepo(sessionWindow.workspacePath);
                                if (isGitRepository) {
                                    isGitHub = await gitStatusService.hasGitHubRemote(sessionWindow.workspacePath);
                                }
                            } catch (gitError) {
                                // Git checks failed - continue with defaults (false, false)
                                logger.session.error('Error checking git status:', gitError);
                            }

                            const analytics = AnalyticsService.getInstance();
                            analytics.sendEvent('workspace_opened', {
                                fileCount: fileCountBucket,
                                hasSubfolders,
                                source: 'startup_restore',
                                isGitRepository,
                                isGitHub,
                            });
                        } catch (error) {
                            logger.session.error('Error tracking workspace_opened event:', error);
                        }

                        // Last window uses show() to activate app once; others use showInactive()
                        const isLastWindow = index === totalWindows - 1;
                        window = createWindow(false, true, sessionWindow.workspacePath, sessionWindow.bounds, isLastWindow ? undefined : { showInactive: true });
                        logger.session.info(`Restored workspace window: ${sessionWindow.workspacePath}`);

                        const restoredWorkspacePath = sessionWindow.workspacePath;
                        setTimeout(() => {
                            // Yield before running background workspace matching so
                            // restored windows don't block the startup tick.
                            void autoMatchTeamForWorkspace(restoredWorkspacePath).catch(() => {});
                            updateTrackerSchemaWorkspace(restoredWorkspacePath);
                        }, 0);

                        // Note: Workspace tabs will be restored by the workspace's own tab state management
                        // We don't manually open files here to avoid interfering with tab restoration
                    } else {
                        logger.session.warn(`Workspace path no longer exists: ${sessionWindow.workspacePath}`);
                    }
                } else if (sessionWindow.mode === 'document' && sessionWindow.filePath) {
                    // Check if file still exists
                    if (existsSync(sessionWindow.filePath)) {
                        // Last window uses show() to activate app once; others use showInactive()
                        const isLastDocWindow = index === totalWindows - 1;
                        window = createWindow(true, false, undefined, sessionWindow.bounds, isLastDocWindow ? undefined : { showInactive: true });
                        if (window) {
                            window.once('ready-to-show', () => {
                                loadFileIntoWindow(window!, sessionWindow.filePath!);
                            });
                            logger.session.info(`Restored document window: ${sessionWindow.filePath}`);
                        }
                    } else {
                        logger.session.warn(`File no longer exists: ${sessionWindow.filePath}`);
                    }
                }

                // Restore dev tools state
                if (window && sessionWindow.devToolsOpen) {
                    // Wait for window to be ready before opening dev tools
                    window.webContents.once('did-finish-load', () => {
                        window.webContents.openDevTools();
                    });
                }

                resolve();
            }, 300); // 300ms delay between each window creation
        });
    }

    return true;
}
