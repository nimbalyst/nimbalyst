import { BrowserWindow, dialog, app, nativeImage, ipcMain, screen, nativeTheme, Menu, type IpcMainEvent, type IpcMainInvokeEvent } from 'electron';
import { safeHandle, safeOn } from '../utils/ipcRegistry';
import { join, basename } from 'path';
import { existsSync } from 'fs';
import { WindowState, FileTreeItem } from '../types';
import { WINDOW_CASCADE_OFFSET } from '../utils/constants';
import { getTheme, saveWorkspaceWindowState, getWorkspaceNavigationHistory, saveWorkspaceNavigationHistory } from '../utils/store';
import { stopFileWatcher } from '../file/FileWatcher';
import { stopWorkspaceWatcher, startWorkspaceWatcher } from '../file/WorkspaceWatcher.ts';
import { getFolderContents } from '../utils/FileTree';
import { getTitleBarColors } from '../theme/ThemeManager';
import { ElectronDocumentService, setupDocumentServiceHandlers } from '../services/ElectronDocumentService';
import { ElectronFileSystemService } from '../services/ElectronFileSystemService';
import { isWorktreePath, resolveProjectPath } from '../utils/workspaceDetection';
import { getPreloadPath } from '../utils/appPaths';
import {
  setFileSystemService,
  clearFileSystemService,
  setFileSystemServiceFor,
} from '@nimbalyst/runtime';
import { navigationHistoryService } from '../services/NavigationHistoryService';
import { AnalyticsService } from '../services/analytics/AnalyticsService';
import { FeatureTrackingService } from '../services/analytics/FeatureTrackingService';
import { ExtensionLogService } from '../services/ExtensionLogService';
import { getMcpConfigService } from '../mcpConfigServiceRef';
import { addNimAssetRoot } from '../protocols/nimAssetProtocol';
import { addNimPreviewWorkspaceRoot } from '../protocols/nimPreviewProtocol';
import { windows, windowStates, anyWindowReferencesWorkspace, resolveDocumentServicePath } from './windowState';

// Window management
export { windows, windowStates };
export const savingWindows = new Set<number>();
export const windowFocusOrder = new Map<number, number>(); // Track focus order for each window
export const windowDevToolsState = new Map<number, boolean>(); // Track dev tools state for each window

/**
 * Lifecycle-bound deletion tracking.
 *
 * When a file is deleted (UI delete, rename, move, or watcher-detected
 * deletion), an entry is added here. While an entry exists, the save-file
 * IPC handler refuses to write to that path -- protecting against
 * in-flight autosaves recreating the file with stale buffer content.
 *
 * Entries are cleared when the renderer signals via `editor:released-deleted-path`
 * that no editor still holds the path AND a fresh load has been observed
 * (DocumentModel.loadContent fires this notification on success). A 5-minute
 * absolute fallback prevents the map from growing without bound in the face
 * of a renderer bug or premature renderer process crash.
 */
interface RecentlyDeletedEntry {
    addedAt: number;
    fallbackTimer: ReturnType<typeof setTimeout>;
}
const recentlyDeletedEntries = new Map<string, RecentlyDeletedEntry>();
const RECENTLY_DELETED_FALLBACK_MS = 5 * 60 * 1000;

export function markRecentlyDeleted(filePath: string): void {
    // If already tracked, refresh the fallback timer.
    const existing = recentlyDeletedEntries.get(filePath);
    if (existing) {
        clearTimeout(existing.fallbackTimer);
    }
    const fallbackTimer = setTimeout(() => {
        recentlyDeletedEntries.delete(filePath);
    }, RECENTLY_DELETED_FALLBACK_MS);
    recentlyDeletedEntries.set(filePath, {
        addedAt: Date.now(),
        fallbackTimer,
    });
}

export function clearRecentlyDeleted(filePath: string): void {
    const entry = recentlyDeletedEntries.get(filePath);
    if (!entry) return;
    clearTimeout(entry.fallbackTimer);
    recentlyDeletedEntries.delete(filePath);
}

export function isRecentlyDeleted(filePath: string): boolean {
    return recentlyDeletedEntries.has(filePath);
}

/**
 * Backwards-compatible wrapper for callers that previously held a Set
 * reference (`recentlyDeletedFiles.has(...)`, `.add(...)`, `.delete(...)`).
 * New code should call the lifecycle helpers directly.
 */
export const recentlyDeletedFiles = {
    has: (filePath: string): boolean => isRecentlyDeleted(filePath),
    add: (filePath: string): void => markRecentlyDeleted(filePath),
    delete: (filePath: string): void => clearRecentlyDeleted(filePath),
};

// Store document services for each workspace
export const documentServices = new Map<string, ElectronDocumentService>();
// File-system services live in a separate module so the multi-project rail
// handlers can register/free them without importing this whole module.
import { fileSystemServices } from './serviceRegistry';

function resolveDocumentServiceForEvent(event: IpcMainEvent | IpcMainInvokeEvent): ElectronDocumentService | null {
    const browserWindow = BrowserWindow.fromWebContents(event.sender);
    if (!browserWindow) {
        // console.log('[DocumentService] No browser window from event');
        return null;
    }
    const windowId = getWindowId(browserWindow);
    if (windowId === null) {
        // console.log('[DocumentService] No window ID');
        return null;
    }
    const state = windowStates.get(windowId);
    // Honor the project rail's active selection (issue #591). Reading the raw
    // primary `workspacePath` here leaked another project's tracker items when
    // the visible project differed from the window's startup project.
    const path = resolveDocumentServicePath(state);
    if (!path) {
        return null;
    }
    const service = documentServices.get(path);
    // console.log('[DocumentService] Resolved service for path:', path, '-> found:', !!service);
    return service ?? null;
}

let windowIdCounter = 0;
let windowPositionOffset = 0;
let untitledCounter = 0;
let focusOrderCounter = 0; // Counter for tracking focus order

// Export function to increment and get focus order counter
export function incrementFocusOrderCounter(): number {
    return ++focusOrderCounter;
}

// Track whether the app is in the process of quitting so we don't block window close
let isQuitting = false;
app.on('before-quit', () => {
  isQuitting = true;
});

// Get focused window or create new one
export function getFocusedOrNewWindow(): BrowserWindow {
    const focusedWindow = BrowserWindow.getFocusedWindow();
    if (focusedWindow) {
        return focusedWindow;
    }

    // If no focused window, create a new one
    return createWindow();
}

export interface CreateWindowOptions {
    /** Show the window without activating the app (no focus steal). */
    showInactive?: boolean;
}

export function createWindow(
    isOpeningFile: boolean = false,
    isWorkspaceMode: boolean = false,
    workspacePath: string | null = null,
    savedBounds?: { x: number; y: number; width: number; height: number },
    options?: CreateWindowOptions
): BrowserWindow {
    const startTime = Date.now();
    try {
        // console.log('[MAIN] Creating window at', new Date().toISOString());

        // Set up icon path - icon.png is at the package root in both dev and packaged builds
        // (included in electron-builder's `files` array, so it's inside the ASAR at the root)
        let iconPath: string | undefined = join(app.getAppPath(), 'icon.png');

        // Check if icon exists
        if (!existsSync(iconPath)) {
            console.log('[MAIN] Icon not found at:', iconPath);
            iconPath = undefined;
        } else {
            // console.log('[MAIN] Using icon at:', iconPath);
        }

        // Calculate window position with cascading effect
        let x: number | undefined;
        let y: number | undefined;
        let width = 1024;
        let height = 768;

        if (savedBounds) {
            // Use saved bounds from session
            x = savedBounds.x;
            y = savedBounds.y;
            width = savedBounds.width;
            height = savedBounds.height;
        } else {
            // Get the display containing the cursor
            const cursorPoint = screen.getCursorScreenPoint();
            const display = screen.getDisplayNearestPoint(cursorPoint);

            // Calculate position with cascading offset
            x = display.bounds.x + 100 + windowPositionOffset;
            y = display.bounds.y + 100 + windowPositionOffset;

            // Update offset for next window (wrap around after 10 windows)
            windowPositionOffset = (windowPositionOffset + WINDOW_CASCADE_OFFSET) % (WINDOW_CASCADE_OFFSET * 10);

            // Make sure window is not off screen
            if (x + width > display.bounds.x + display.bounds.width) {
                x = display.bounds.x + 100;
            }
            if (y + height > display.bounds.y + display.bounds.height) {
                y = display.bounds.y + 100;
            }
        }

        // Determine the current theme and set appropriate background color
        // IMPORTANT: These colors MUST match the CSS theme files exactly to prevent flash
        const currentTheme = getTheme();
        // console.log('[WINDOW-MANAGER] Creating window with theme:', currentTheme);
        let backgroundColor = '#ffffff'; // Default to white for light theme

        if (currentTheme === 'dark') {
            backgroundColor = '#2d2d2d'; // Matches --nim-bg in NimbalystTheme.css (dark)
        } else if (currentTheme === 'crystal-dark') {
            backgroundColor = '#0f172a'; // Matches --nim-bg in NimbalystTheme.css (crystal-dark)
        } else if (currentTheme === 'light') {
            backgroundColor = '#ffffff'; // Matches --nim-bg in NimbalystTheme.css (light)
        } else {
            // system/auto - use nativeTheme which should match prefers-color-scheme
            backgroundColor = nativeTheme.shouldUseDarkColors ? '#2d2d2d' : '#ffffff';
        }
        // console.log('[WINDOW-MANAGER] Background color:', backgroundColor);

        const preloadPath = getPreloadPath();

        const windowOptions: Electron.BrowserWindowConstructorOptions = {
            width,
            height,
            x,
            y,
            title: isWorkspaceMode && workspacePath ? basename(workspacePath) : 'Nimbalyst',
            backgroundColor,
            webPreferences: {
                nodeIntegration: false,
                contextIsolation: true,
                preload: preloadPath,
                // Issue #146: webSecurity enforces same-origin policy. We
                // previously disabled it so the renderer could load workspace
                // images via `<img src="file://...">`. Those four call sites
                // (ImageViewer, ImageDiffViewer, HistoryDialog,
                // AttachmentPreview) now go through the registered
                // `nim-asset://` scheme (see protocols/nimAssetProtocol.ts),
                // which is treated as same-origin by the renderer. Leaving
                // webSecurity at its default (true).
                webviewTag: false
            },
            show: false,
            titleBarStyle: process.platform === 'darwin' ? undefined : 'default',
        };

        if (iconPath) {
            windowOptions.icon = nativeImage.createFromPath(iconPath);
        }

        const window = new BrowserWindow(windowOptions);

        // Generate a unique window ID
        const windowId = ++windowIdCounter;
        // console.log('[MAIN] Created window with ID:', windowId, 'Electron ID:', window.id);

        // Store window and initial state
        windows.set(windowId, window);
        windowStates.set(windowId, {
            mode: isWorkspaceMode ? 'workspace' : 'document',
            filePath: null,
            workspacePath: isWorkspaceMode ? workspacePath : null,
            documentEdited: false
        });

        // Issue #146: register the workspace path with the nim-asset protocol
        // so the renderer can render workspace images via `nim-asset://`. This
        // happens before the renderer mounts, so the allowlist is ready when
        // image components first render.
        if (isWorkspaceMode && workspacePath) {
            addNimAssetRoot(workspacePath);
            addNimPreviewWorkspaceRoot(workspacePath);
        }
        if (isWorkspaceMode && workspacePath) {
            if (!documentServices.has(workspacePath)) {
                const docService = new ElectronDocumentService(workspacePath);
                documentServices.set(workspacePath, docService);
                setupDocumentServiceHandlers(resolveDocumentServiceForEvent);
                // console.log('[MAIN] Created DocumentService for workspace:', workspacePath);
            }
            if (!fileSystemServices.has(workspacePath)) {
                const fileSystemService = new ElectronFileSystemService(workspacePath);
                fileSystemServices.set(workspacePath, fileSystemService);
                // Set the file system service globally for the runtime
                setFileSystemService(fileSystemService);
                // Also register it in the per-path runtime registry so AI
                // tool dispatch in inactive rail projects can resolve the
                // correct workspace's service without falling back to the
                // global (see fileTools.resolveFileSystemServiceForCall).
                setFileSystemServiceFor(workspacePath, fileSystemService);
                // console.log('[MAIN] Created FileSystemService for workspace:', workspacePath);
            }

            // Track workspace feature first use
            const featureTracking = FeatureTrackingService.getInstance();
            if (featureTracking.isFirstUse('workspace')) {
                const daysSinceInstall = featureTracking.getDaysSinceInstall();
                AnalyticsService.getInstance().sendEvent('feature_first_use', {
                    feature: 'workspace',
                    daysSinceInstall,
                });
            }

            // Restore navigation history for this workspace
            const navHistory = getWorkspaceNavigationHistory(workspacePath);
            if (navHistory) {
                navigationHistoryService.restoreNavigationState(windowId, navHistory);
                // console.log('[MAIN] Restored navigation history for workspace:', workspacePath);
            }

            // Note: nimbalyst-local directory is created as needed by OnboardingService
        }
        windowFocusOrder.set(windowId, ++focusOrderCounter); // Track initial focus order

        // console.log('[MAIN] Window stored in maps. Mode:', isWorkspaceMode ? 'workspace' : 'document');
        // console.log('[MAIN] Windows Map now has:', windows.size, 'windows');
        // console.log('[MAIN] Window IDs in map:', [...windows.keys()]);

        // Increase max listeners to avoid warning (we have multiple event handlers)
        window.webContents.setMaxListeners(20);

        // Capture console messages from renderer for debugging and extension log capture
        // Always capture for extension logs, but only emit to IPC in dev mode
        window.webContents.on('console-message', (_event, level, message, line, sourceId) => {
            // Always send to extension log service for agent debugging
            ExtensionLogService.getInstance().addRendererLog(level, message, line, sourceId);

            // Only emit to main process file logging in dev mode
            if (process.env.NODE_ENV !== 'production') {
                const levelNames = ['verbose', 'info', 'warning', 'error'];
                const levelName = levelNames[level] || 'unknown';

                // Send to main process for file logging
                const timestamp = new Date().toISOString();
                const logData = {
                    timestamp,
                    level: levelName,
                    source: sourceId || 'renderer',
                    message: `${message} ${line ? `(line ${line})` : ''}`
                };

                // Emit to IPC for file logging
                ipcMain.emit('console-log', null, logData);
            }
        });

        // Handle window close with unsaved changes
        window.on('close', (event) => {
            if (isQuitting) {
                // Allow close to proceed without prompts during app quit
                return;
            }

            const state = windowStates.get(windowId);
            if (state?.documentEdited) {
                event.preventDefault();
                // Send message to renderer to show custom dialog
                window.webContents.send('confirm-close-unsaved');
            }
        });

        // Store state for use in both 'close' and 'closed' handlers
        let savedState: WindowState | undefined;

        window.on('close', (event) => {
            // Save workspace-specific window state before closing
            const state = windowStates.get(windowId);
            savedState = state; // Preserve for 'closed' handler

            if (state?.mode === 'workspace' && state.workspacePath) {
                const bounds = window.getBounds();
                const focusOrder = windowFocusOrder.get(windowId) || 0;
                const devToolsOpen = windowDevToolsState.get(windowId) || false;

                saveWorkspaceWindowState(state.workspacePath, {
                    mode: 'workspace',
                    workspacePath: state.workspacePath,
                    filePath: state.filePath ?? undefined,
                    bounds,
                    focusOrder,
                    devToolsOpen
                });

                // Save navigation history
                const navHistory = navigationHistoryService.saveNavigationState(windowId);
                if (navHistory) {
                    saveWorkspaceNavigationHistory(state.workspacePath, navHistory);
                }
            }

            // Remove from windowStates so saveSessionState() will skip this closing window
            windowStates.delete(windowId);

            // Save global session state (will not include this window since we removed it from windowStates)
            // This ensures closed windows are not restored on next launch
            // SKIP during restart - session state was already saved before windows close
            import('../index').then(({ isRestarting }) => {
                if (isRestarting()) {
                    console.log('[MAIN] Skipping session save during restart (session already saved)');
                    return;
                }
                import('../session/SessionState').then(({ saveSessionState }) => {
                    saveSessionState();
                });
            });
        });

        window.on('closed', () => {
            windows.delete(windowId);
            // Use saved state from 'close' handler
            const state = savedState;
            savingWindows.delete(windowId);
            windowFocusOrder.delete(windowId);
            windowDevToolsState.delete(windowId);
            stopFileWatcher(windowId);
            stopWorkspaceWatcher(windowId);

            // Clean up MCP workspace-to-window mapping
            import('../mcp/httpServer').then(({ unregisterWindow }) => {
                unregisterWindow(windowId);
            }).catch(err => {
                console.error('[MAIN] Error unregistering window from MCP:', err);
            });

            // Clean up navigation history for this window
            navigationHistoryService.removeWindow(windowId);

            // Clean up document/file-system services for any workspace this
            // window referenced (its primary path AND any rail-warm
            // additional paths). A path is freed only when no other window
            // still references it — covers both window-per-project overlap
            // and the multi-project rail.
            if (state?.mode === 'workspace') {
                const referencedPaths = new Set<string>();
                if (state.workspacePath) referencedPaths.add(state.workspacePath);
                state.additionalWorkspacePaths?.forEach((p) => referencedPaths.add(p));

                for (const path of referencedPaths) {
                    if (anyWindowReferencesWorkspace(path)) continue;

                    const docService = documentServices.get(path);
                    if (docService) {
                        docService.destroy();
                        documentServices.delete(path);
                        console.log('[MAIN] Destroyed DocumentService for workspace:', path);
                    }
                    const fileSystemService = fileSystemServices.get(path);
                    if (fileSystemService) {
                        fileSystemService.destroy();
                        fileSystemServices.delete(path);
                        clearFileSystemService();
                        console.log('[MAIN] Destroyed FileSystemService for workspace:', path);
                    }
                    try {
                        const mcpService = getMcpConfigService();
                        if (mcpService) {
                            mcpService.stopWatchingWorkspaceConfig(path);
                            console.log('[MAIN] Stopped watching MCP config for workspace:', path);
                        }
                    } catch (error) {
                        console.error('[MAIN] Error stopping MCP config watcher:', error);
                    }
                }
            }

            // Note: We do NOT save global session state here because this window has already
            // been removed from the windows Map. Session state is saved on app quit in main/index.ts
            // which captures all open windows at that moment.

            // Update menu to reflect window closure
            // This will be handled by the menu system
        });

        // Save session state when window is created
        import('../session/SessionState').then(({ saveSessionState }) => {
            setTimeout(async () => {
                await saveSessionState();
            }, 1000);
        });

        // Update menu when window gains/loses focus
        window.on('focus', () => {
            // Update focus order
            windowFocusOrder.set(windowId, ++focusOrderCounter);
            // This will be handled by the menu system
        });

        window.on('blur', () => {
            // This will be handled by the menu system
        });

        // Track dev tools state
        window.webContents.on('devtools-opened', () => {
            windowDevToolsState.set(windowId, true);
        });

        window.webContents.on('devtools-closed', () => {
            windowDevToolsState.set(windowId, false);
        });

        // Load the HTML file with error handling
        const loadContent = () => {
            // Add theme to URL query params to prevent flash
            const themeParam = `theme=${currentTheme}`;
            // console.log('[WINDOW-MANAGER] Loading window with theme param:', themeParam);

            // Check for explicit renderer URL from environment (for Playwright tests)
            if (process.env.ELECTRON_RENDERER_URL) {
                const url = new URL(process.env.ELECTRON_RENDERER_URL);
                url.searchParams.set('theme', currentTheme);
                // console.log('[MAIN] Loading from ELECTRON_RENDERER_URL:', url.toString());
                return window.loadURL(url.toString());
            } else if (process.env.NODE_ENV === 'development') {
                // Use VITE_PORT if set (for isolated dev mode), otherwise default to 5273
                const devPort = process.env.VITE_PORT || '5273';
                const url = `http://localhost:${devPort}?${themeParam}`;
                // console.log('[MAIN] Loading from dev server:', url);
                return window.loadURL(url);
            } else {
                // console.log('[MAIN] Loading from built files with theme:', currentTheme);
                // Use loadFile which handles App Translocation properly
                // Note: Due to code splitting, __dirname is out/main/chunks/, not out/main/
                // Use app.getAppPath() to reliably find the renderer
                const appPath = app.getAppPath();
                let htmlPath: string;
                if (app.isPackaged) {
                    // Packaged: app.asar contains out/ at root
                    htmlPath = join(appPath, 'out/renderer/index.html');
                } else if (appPath.includes('/out/main') || appPath.includes('\\out\\main')) {
                    // Playwright running built output: appPath is out/main
                    htmlPath = join(appPath, '../renderer/index.html');
                } else {
                    // Fallback for other built scenarios
                    htmlPath = join(appPath, 'out/renderer/index.html');
                }
                return window.loadFile(htmlPath, { query: { theme: currentTheme } });
            }
        };

        loadContent().catch(err => {
            console.error('[MAIN] Failed to load window content:', err);
            // Try to reload once
            setTimeout(() => {
                if (!window.isDestroyed()) {
                    loadContent().catch(err2 => {
                        console.error('[MAIN] Failed to reload window content:', err2);
                    });
                }
            }, 1000);
        });

        // Show window when ready
        window.once('ready-to-show', () => {
            // console.log('[MAIN] Window ready to show at', new Date().toISOString(), 'elapsed:', Date.now() - startTime, 'ms');
            if (options?.showInactive) {
                window.showInactive();
            } else {
                window.show();
            }
        });

        // Handle renderer process crashes
        window.webContents.on('render-process-gone', (event, details) => {
            console.error('[MAIN] Renderer process gone:', details);
            if (!window.isDestroyed()) {
                // Reload the window
                window.reload();
            }
        });

        // Handle unresponsive renderer
        window.webContents.on('unresponsive', () => {
            console.warn('[MAIN] Window became unresponsive');
            const choice = dialog.showMessageBoxSync(window, {
                type: 'warning',
                buttons: ['Reload', 'Keep Waiting'],
                defaultId: 0,
                message: 'The window is not responding',
                detail: 'Would you like to reload the window?'
            });

            if (choice === 0 && !window.isDestroyed()) {
                window.reload();
            }
        });

        // Handle responsive again
        window.webContents.on('responsive', () => {
            console.log('[MAIN] Window became responsive again');
        });

        // Handle context menu for spell check suggestions
        window.webContents.on('context-menu', (_event, params) => {
            const menuTemplate: Electron.MenuItemConstructorOptions[] = [];

            // Spell check suggestions
            if (params.misspelledWord) {
                if (params.dictionarySuggestions.length > 0) {
                    for (const suggestion of params.dictionarySuggestions) {
                        menuTemplate.push({
                            label: suggestion,
                            click: () => {
                                window.webContents.replaceMisspelling(suggestion);
                            }
                        });
                    }
                } else {
                    menuTemplate.push({
                        label: 'No suggestions',
                        enabled: false
                    });
                }

                menuTemplate.push({ type: 'separator' });

                menuTemplate.push({
                    label: 'Add to Dictionary',
                    click: () => {
                        window.webContents.session.addWordToSpellCheckerDictionary(params.misspelledWord);
                    }
                });

                menuTemplate.push({ type: 'separator' });
            }

            // Standard edit operations when there's editable content
            if (params.isEditable) {
                menuTemplate.push(
                    { label: 'Cut', role: 'cut', enabled: params.editFlags.canCut },
                    { label: 'Copy', role: 'copy', enabled: params.editFlags.canCopy },
                    { label: 'Paste', role: 'paste', enabled: params.editFlags.canPaste }
                );

                if (params.selectionText) {
                    menuTemplate.push(
                        { type: 'separator' },
                        { label: 'Select All', role: 'selectAll' }
                    );
                }
            } else if (params.selectionText) {
                // Non-editable but has selection - just show copy
                menuTemplate.push(
                    { label: 'Copy', role: 'copy' }
                );
            }

            // Only show menu if we have items
            if (menuTemplate.length > 0) {
                const menu = Menu.buildFromTemplate(menuTemplate);
                menu.popup({ window });
            }
        });

        // When the window is ready, send initial data
        window.webContents.once('did-finish-load', () => {
            // console.log('[MAIN] did-finish-load at', new Date().toISOString(), 'elapsed:', Date.now() - startTime, 'ms');

            // DO NOT send theme-change here - the window already got the theme via getThemeSync()
            // Sending it again causes a flash as React re-applies the same theme
            // Only send theme-change when user actually changes theme from menu

            if (isWorkspaceMode && workspacePath) {
                // Don't send 'workspace-opened' here - the renderer already knows it's in workspace mode
                // from the initial state. Sending this event causes the tabs to be cleared.
                // Just start watching the workspace directory for changes
                setTimeout(() => {
                    startWorkspaceWatcher(window, workspacePath);
                }, 100);
            } else if (!isOpeningFile) {
                // Create new untitled document
                untitledCounter++;
                const untitledName = untitledCounter === 1 ? 'Untitled' : `Untitled ${untitledCounter}`;
                setTimeout(() => {
                    window.webContents.send('new-untitled-document', { untitledName });
                }, 100);
            }
        });

        // console.log('[MAIN] Window created successfully at', new Date().toISOString(), 'elapsed:', Date.now() - startTime, 'ms');
        return window;

    } catch (error) {
        console.error('Error creating window:', error);
        throw error;
    }
}

// Find window by file path
export function findWindowByFilePath(filePath: string): BrowserWindow | null {
    for (const [windowId, window] of windows) {
        const state = windowStates.get(windowId);
        if (state?.filePath === filePath) {
            return window;
        }
    }
    return null;
}

/**
 * Find window by workspace path (stable identifier)
 *
 * IMPORTANT: This is the preferred way to route to windows for async/deferred operations
 * (like notifications, sounds, etc.) because workspace paths are STABLE identifiers,
 * while Electron window IDs are TRANSIENT and change when windows close/reopen.
 *
 * Routing Strategy:
 * - Use workspacePath for: OS notifications, sound notifications, any deferred routing
 * - Use event.sender for: Immediate IPC responses during the same call
 * - Window IDs should only be used as a fallback when workspace path is unavailable
 *
 * This function is worktree-aware: if the given path is a worktree path, it will also
 * check for windows registered under the parent project path, and vice versa.
 *
 * @param workspacePath The absolute path to the workspace directory
 * @returns The BrowserWindow for that workspace, or null if not found
 */
export function findWindowByWorkspace(workspacePath: string): BrowserWindow | null {
    // First try exact match — primary or any rail-warm additional path.
    // Prefer windows where the path is currently active so MCP routes to
    // the visible project when several windows host the same workspace.
    let bestActiveMatch: BrowserWindow | null = null;
    let bestAnyMatch: BrowserWindow | null = null;

    for (const [windowId, window] of windows) {
        const state = windowStates.get(windowId);
        if (!state) continue;

        const isActive = (state.activeWorkspacePath ?? state.workspacePath) === workspacePath;
        const isReferenced =
            state.workspacePath === workspacePath ||
            state.additionalWorkspacePaths?.includes(workspacePath) === true;

        if (isActive) {
            bestActiveMatch = window;
            break;
        }
        if (isReferenced && !bestAnyMatch) {
            bestAnyMatch = window;
        }
    }

    if (bestActiveMatch) return bestActiveMatch;
    if (bestAnyMatch) return bestAnyMatch;

    // If the given path is a worktree, try to find window by parent project path
    if (isWorktreePath(workspacePath)) {
        const projectPath = resolveProjectPath(workspacePath);
        for (const [windowId, window] of windows) {
            const state = windowStates.get(windowId);
            if (!state) continue;
            if (
                state.workspacePath === projectPath ||
                state.additionalWorkspacePaths?.includes(projectPath)
            ) {
                return window;
            }
        }
    }

    // If the given path is a project path, check if any window is a worktree of that project
    for (const [windowId, window] of windows) {
        const state = windowStates.get(windowId);
        if (!state) continue;
        const candidatePaths: string[] = [];
        if (state.workspacePath) candidatePaths.push(state.workspacePath);
        if (state.additionalWorkspacePaths) candidatePaths.push(...state.additionalWorkspacePaths);

        for (const candidate of candidatePaths) {
            if (isWorktreePath(candidate) && resolveProjectPath(candidate) === workspacePath) {
                return window;
            }
        }
    }

    return null;
}

/**
 * Find the most recently focused workspace window.
 * Uses the windowFocusOrder map to determine which workspace window
 * was focused most recently. Falls back to BrowserWindow.getFocusedWindow()
 * if it's a workspace window.
 */
export function getMostRecentlyFocusedWorkspaceWindow(): BrowserWindow | null {
    let bestWindowId: number | null = null;
    let bestFocusOrder = -1;

    for (const [windowId, state] of windowStates) {
        if (state?.mode === 'workspace' || state?.mode === 'agentic-coding') {
            const focusOrder = windowFocusOrder.get(windowId) || 0;
            if (focusOrder > bestFocusOrder) {
                bestFocusOrder = focusOrder;
                bestWindowId = windowId;
            }
        }
    }

    if (bestWindowId !== null) {
        const win = windows.get(bestWindowId);
        if (win && !win.isDestroyed()) {
            return win;
        }
    }

    return null;
}

// Find custom window ID from BrowserWindow
export function getWindowId(browserWindow: BrowserWindow): number | null {
    for (const [windowId, window] of windows) {
        if (window === browserWindow) {
            return windowId;
        }
    }
    return null;
}

// IPC handler to check if a window is focused
safeHandle('window:is-focused', (event) => {
    const window = BrowserWindow.fromWebContents(event.sender);
    return window ? window.isFocused() : false;
});

// IPC handler to force focus a window (for testing)
safeHandle('window:force-focus', (event) => {
    const window = BrowserWindow.fromWebContents(event.sender);
    if (window) {
        window.focus();
        return true;
    }
    return false;
});

// Handle close-window responses from renderer's custom dialog
safeOn('close-window-save', (event) => {
    const window = BrowserWindow.fromWebContents(event.sender);
    if (window && !window.isDestroyed()) {
        const windowId = getWindowId(window);
        if (windowId !== null) {
            // Send save request
            window.webContents.send('save-before-close');
            // Wait for save to complete, then close
            setTimeout(() => {
                const currentState = windowStates.get(windowId);
                if (!currentState?.documentEdited && !window.isDestroyed()) {
                    window.destroy();
                }
            }, 100);
        }
    }
});

safeOn('close-window-discard', (event) => {
    const window = BrowserWindow.fromWebContents(event.sender);
    if (window && !window.isDestroyed()) {
        window.destroy();
    }
});
