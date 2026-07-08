/**
 * Application menu builder for Nimbalyst Electron app.
 *
 * Creates and manages the native application menu bar with support for:
 * - File operations (new, open, save, recent items)
 * - Edit commands (undo/redo, copy/paste, find/replace)
 * - View modes (files, agent) and panels (AI chat, bottom panel)
 * - Window management (minimize, close, window list with keyboard shortcuts)
 * - Theme switching (light, dark, crystal-dark, system)
 * - Developer tools (console, file watcher diagnostics, database server)
 * - Help and documentation
 *
 * The menu adapts based on:
 * - Platform (macOS vs Windows/Linux)
 * - Window state (workspace vs document mode)
 * - Active mode (files vs agent mode for context-aware New command)
 * - Development vs production build (shows/hides dev-only features)
 *
 * Menu updates are triggered when:
 * - Theme changes
 * - Recent items change
 * - Windows are opened/closed/focused
 */
import { Menu, BrowserWindow, app, dialog, shell, nativeTheme } from 'electron';
import { basename, join } from 'path';
import * as path from 'path';
import { existsSync } from 'fs';
import * as fs from 'fs';
import { windows, windowStates, createWindow, findWindowByFilePath, getWindowId } from '../window/WindowManager';
import { createAboutWindow } from '../window/AboutWindow';
import { createWorkspaceManagerWindow } from '../window/WorkspaceManagerWindow.ts';
import { createAIUsageReportWindow } from '../window/AIUsageReportWindow';
import { createDatabaseBrowserWindow } from '../window/DatabaseBrowserWindow';
import { createDeveloperDashboardWindow } from '../window/DeveloperDashboardWindow';
import { runDiffErgonomicsHarness } from '../file/DiffErgonomicsFixture';
import { loadFileIntoWindow } from '../file/FileOperations';
import { getRecentItems, clearRecentItems, addToRecentItems, getTheme, setTheme, store, getWorkspaceState, getWorkspaceWindowState, isExtensionDevToolsEnabled, setWorktreeOnboardingShown } from '../utils/store';
import { updateWindowTitleBars, updateNativeTheme } from '../theme/ThemeManager';
import { refreshWorkspaceFileTree } from '../file/FileWatcherDebug';
import { getFolderContents } from '../utils/FileTree';
import { logger } from '../utils/logger';
import { getFocusedWindow } from '../utils/windowFocus';
import { showSplashScreen } from '../window/SplashScreen';
import { autoUpdaterService } from '../services/autoUpdater';
import { KeyboardShortcuts } from './KeyboardShortcuts';
import { AnalyticsService } from '../services/analytics/AnalyticsService';
import { FeatureTrackingService } from '../services/analytics/FeatureTrackingService';
import {
    showExtensionProjectIntroDialog,
    showNewExtensionProjectDialog,
} from '../services/ExtensionProjectScaffolder';

// Import shared SDK docs path function
import { getExtensionSDKDocsPath } from '../utils/workspaceDetection';
import { database } from '../database/PGLiteDatabaseWorker';
import { getRegisteredWalkthroughs, getRegisteredTips } from '../ipc/WalkthroughHandlers';

// Create window list menu items
function createWindowListMenu(): any[] {
    const menuItems: any[] = [];
    const allWindows = BrowserWindow.getAllWindows();

    if (allWindows.length === 0) {
        return [];
    }

    // Categorize windows
    const workspaceWindows: { window: BrowserWindow; title: string }[] = [];
    const documentWindows: { window: BrowserWindow; title: string }[] = [];
    const otherWindows: { window: BrowserWindow; title: string }[] = [];

    allWindows.forEach((window) => {
        // Skip destroyed windows
        if (!window || window.isDestroyed()) {
            return;
        }

        const windowId = getWindowId(window);
        const state = windowId !== null ? windowStates.get(windowId) : undefined;
        let title = 'Untitled';
        let category: 'workspace' | 'document' | 'other' = 'document';

        // Check for special windows first
        if (isWorkspaceManagerWindow(window)) {
            title = 'Project Manager';
            category = 'other';
        } else if (isAboutWindow(window)) {
            title = 'About';
            category = 'other';
        } else if (state) {
            if (state.mode === 'workspace' && state.workspacePath) {
                title = basename(state.workspacePath);
                category = 'workspace';
            }
        }

        // Add to appropriate category
        if (category === 'workspace') {
            workspaceWindows.push({ window, title });
        } else if (category === 'document') {
            documentWindows.push({ window, title });
        } else {
            otherWindows.push({ window, title });
        }
    });

    // Build menu items with groups

    // Add workspace windows
    if (workspaceWindows.length > 0) {
        if (menuItems.length > 0) {
            menuItems.push({ type: 'separator' });
        }
        menuItems.push({ label: 'Open Projects', enabled: false });
        workspaceWindows.forEach(({ window, title }) => {
            menuItems.push({
                label: title,
                type: 'checkbox',
                checked: !window.isDestroyed() && window.isFocused(),
                click: async () => {
                    if (!window.isDestroyed()) {
                        window.focus();
                    }
                }
            });
        });
    }

    // Add document windows
    if (documentWindows.length > 0) {
        if (menuItems.length > 0) {
            menuItems.push({ type: 'separator' });
        }
        menuItems.push({ label: 'Open Documents', enabled: false });
        documentWindows.forEach(({ window, title }) => {
            menuItems.push({
                label: title,
                type: 'checkbox',
                checked: !window.isDestroyed() && window.isFocused(),
                click: async () => {
                    if (!window.isDestroyed()) {
                        window.focus();
                    }
                }
            });
        });
    }

    // Add other windows
    // if (otherWindows.length > 0) {
    //     if (menuItems.length > 0) {
    //         menuItems.push({ type: 'separator' });
    //     }
    //     menuItems.push({ label: 'Other Windows', enabled: false });
    //     otherWindows.forEach(({ window, title }) => {
    //         const accelerator = shortcutIndex < 9 ? `CmdOrCtrl+${shortcutIndex + 1}` : undefined;
    //         shortcutIndex++;
    //         menuItems.push({
    //             label: title,
    //             accelerator,
    //             type: 'checkbox',
    //             checked: window.isFocused(),
    //             click: async () => {
    //                 window.focus();
    //             }
    //         });
    //     });
    // }

    return menuItems;
}

// Create the recent projects submenu
async function createRecentSubmenu(): Promise<any[]> {
    const recentWorkspaces = await getRecentItems('workspaces');
    const submenu: any[] = [];

    if (recentWorkspaces.length > 0) {
        recentWorkspaces.forEach(workspace => {
            submenu.push({
                label: workspace.name,
                click: async () => {
                    // Check if workspace exists
                    if (existsSync(workspace.path)) {
                        // Check for saved workspace window state
                        const savedState = getWorkspaceWindowState(workspace.path);

                        // Create window with saved bounds if available
                        const window = createWindow(false, true, workspace.path, savedState?.bounds);

                        // Restore dev tools if they were open
                        if (savedState?.devToolsOpen) {
                            window.webContents.once('did-finish-load', () => {
                                window.webContents.openDevTools();
                            });
                        }
                    } else {
                        // Remove from recent if doesn't exist
                        const items = getRecentItems('workspaces').filter(item => item.path !== workspace.path);
                        store.set('recent.workspaces', items);
                        updateApplicationMenu();
                        dialog.showErrorBox('Project Not Found', `The project "${workspace.name}" could not be found at:\n${workspace.path}`);
                    }
                }
            });
        });

        submenu.push({ type: 'separator' });
        submenu.push({
            label: 'Clear Recent Projects',
            click: async () => {
                clearRecentItems('workspaces');
                updateApplicationMenu();
            }
        });
    }

    // If no recent items
    if (submenu.length === 0) {
        submenu.push({ label: 'No Recent Projects', enabled: false });
    }

    return submenu;
}

// Create application menu
export async function createApplicationMenu() {
    // Get current theme from store
    const currentTheme = getTheme();
    const isDev = process.env.NODE_ENV !== 'production';

    const template: any[] = [
        {
            label: 'File',
            submenu: [
                {
                    id: 'file-new-file',
                    label: 'New File...',
                    click: async () => {
                        const focusedWindow = getFocusedWindow();

                        if (focusedWindow) {
                            const windowId = getWindowId(focusedWindow);

                            if (windowId !== null) {
                                const state = windowStates.get(windowId);

                                if (state?.mode === 'workspace') {
                                    // Switch to files mode first (in case we're in agent mode)
                                    focusedWindow.webContents.send('set-content-mode', 'files');
                                    // Small delay to let mode switch complete before opening dialog
                                    setTimeout(() => {
                                        focusedWindow.webContents.send('file-new-in-workspace');
                                    }, 50);
                                } else {
                                    // In document mode, create new window
                                    createWindow();
                                }
                            } else {
                                createWindow();
                            }
                        } else {
                            createWindow();
                        }
                    }
                },
                {
                    id: 'file-new-session',
                    label: 'New Session...',
                    accelerator: KeyboardShortcuts.file.newSessionGlobal,
                    click: async () => {
                        const focusedWindow = getFocusedWindow();

                        if (focusedWindow) {
                            const windowId = getWindowId(focusedWindow);

                            if (windowId !== null) {
                                const state = windowStates.get(windowId);

                                if (state?.mode === 'workspace' && state.workspacePath) {
                                    // Switch to agent mode and create new session
                                    focusedWindow.webContents.send('set-content-mode', 'agent');
                                    focusedWindow.webContents.send('agent-new-session');
                                }
                            }
                        }
                    }
                },
                {
                    id: 'file-new-browser-tab',
                    label: 'New Browser Tab',
                    accelerator: KeyboardShortcuts.file.newBrowserTab,
                    click: async () => {
                        const focusedWindow = getFocusedWindow();
                        if (!focusedWindow) return;

                        const windowId = getWindowId(focusedWindow);
                        if (windowId === null) return;

                        const state = windowStates.get(windowId);
                        if (state?.mode !== 'workspace' || !state.workspacePath) return;

                        AnalyticsService.getInstance().sendEvent('menu_action_used', {
                            menu: 'file',
                            action: 'new_browser_tab',
                            hasKeyboardEquivalent: true,
                        });

                        // Switch to files mode first (in case we're in agent mode),
                        // then open the browser virtual tab once the mode settles.
                        focusedWindow.webContents.send('set-content-mode', 'files');
                        setTimeout(() => {
                            focusedWindow.webContents.send('file-new-browser-tab');
                        }, 50);
                    }
                },
                {
                    id: 'file-new-extension-project',
                    label: 'New Extension Project...',
                    click: async () => {
                        AnalyticsService.getInstance().sendEvent('menu_action_used', {
                            menu: 'file',
                            action: 'new_extension_project',
                            hasKeyboardEquivalent: false,
                        });

                        await showNewExtensionProjectDialog(getFocusedWindow());
                    }
                },
                {
                    id: 'file-import-claude-code-sessions',
                    label: 'Import Claude Code Sessions...',
                    click: async () => {
                        AnalyticsService.getInstance().sendEvent('claude_code_import_dialog_opened', {
                            source: 'file_menu',
                        });
                        const focused = getFocusedWindow();
                        if (focused) {
                            focused.webContents.send('show-session-import-dialog');
                        }
                    }
                },
                {
                    // Hidden menu item that handles Cmd+N dynamically based on current mode
                    id: 'file-new-dynamic',
                    label: 'New',
                    accelerator: KeyboardShortcuts.file.newFile,
                    visible: false, // Hidden from menu - only provides the accelerator
                    click: async () => {
                        const focusedWindow = getFocusedWindow();
                        if (!focusedWindow) {
                            createWindow();
                            return;
                        }

                        const windowId = getWindowId(focusedWindow);
                        if (windowId === null) {
                            createWindow();
                            return;
                        }

                        const state = windowStates.get(windowId);
                        if (state?.mode !== 'workspace' || !state.workspacePath) {
                            createWindow();
                            return;
                        }

                        // Check current mode at keypress time (not menu build time)
                        const workspaceState = getWorkspaceState(state.workspacePath);
                        const currentMode = workspaceState?.activeMode;

                        if (currentMode === 'agent') {
                            // In agent mode, create new AI session
                            focusedWindow.webContents.send('agent-new-session');
                        } else {
                            // In files/plan/settings mode, create new file
                            focusedWindow.webContents.send('file-new-in-workspace');
                        }
                    }
                },
                { type: 'separator' },
                {
                    label: 'Open...',
                    accelerator: KeyboardShortcuts.file.open,
                    click: async () => {
                        const result = await dialog.showOpenDialog({
                            properties: ['openFile'],
                            filters: [
                                { name: 'Markdown Files', extensions: ['md', 'markdown'] },
                                { name: 'Text Files', extensions: ['txt'] },
                                { name: 'All Files', extensions: ['*'] }
                            ]
                        });

                        if (!result.canceled && result.filePaths.length > 0) {
                            const filePath = result.filePaths[0];
                            // Check if file is already open
                            const existingWindow = findWindowByFilePath(filePath);
                            if (existingWindow) {
                                existingWindow.focus();
                            } else {
                                // Open in new window
                                const window = createWindow(true);
                                window.once('ready-to-show', () => {
                                    loadFileIntoWindow(window, filePath);
                                });
                            }
                        }
                    }
                },
                {
                    label: 'Open Project...',
                    click: async () => {
                        // Track menu action
                        AnalyticsService.getInstance().sendEvent('menu_action_used', {
                            menu: 'file',
                            action: 'open_project',
                            hasKeyboardEquivalent: true,
                        });

                        createWorkspaceManagerWindow();
                    }
                },
                { type: 'separator' },
                {
                    label: 'Recent Projects',
                    submenu: await createRecentSubmenu()
                },
                ...(process.platform !== 'darwin' ? [
                  {
                      label: 'Settings...',
                      accelerator: KeyboardShortcuts.window.aiModels,
                      click: async () => {
                          // Track settings opened
                          AnalyticsService.getInstance().sendEvent('global_settings_opened', {
                              source: 'menu',
                              section: 'general',
                          });
                          // Switch to settings mode in the focused window
                          const focused = getFocusedWindow();
                          if (focused && !isAboutWindow(focused)) {
                              focused.webContents.send('set-content-mode', 'settings');
                          }
                      }
                  },
                ]: []),
                { type: 'separator' },
                {
                    label: 'Save',
                    accelerator: KeyboardShortcuts.file.save,
                    click: async () => {
                        const focused = getFocusedWindow();
                        if (focused && !isAboutWindow(focused)) {
                            focused.webContents.send('file-save');
                        }
                    }
                },
                { type: 'separator' },
                {
                    label: 'Close Tab',
                    accelerator: KeyboardShortcuts.file.closeTab,
                    click: async () => {
                        const focused = getFocusedWindow();
                        if (focused) {
                            const windowId = getWindowId(focused);
                            if (windowId !== null) {
                                const state = windowStates.get(windowId);

                                // If in workspace or agentic coding mode, close the active tab
                                if (state?.mode === 'workspace' || state?.mode === 'agentic-coding') {
                                    logger.menu.info(`[Close Tab] Sending close-active-tab to window ${windowId}`);
                                    focused.webContents.send('close-active-tab');
                                    return;
                                }
                            }

                            // Default behavior: close the window
                            focused.close();
                        } else {
                            logger.menu.warn('[Close Tab] No focused window found');
                        }
                    }
                },
                {
                    label: 'Reopen Closed Tab',
                    accelerator: KeyboardShortcuts.file.reopenClosedTab,
                    click: async () => {
                        const focused = getFocusedWindow();
                        if (focused) {
                            const windowId = getWindowId(focused);
                            if (windowId !== null) {
                                const state = windowStates.get(windowId);

                                // Only works in workspace or agentic coding mode
                                if (state?.mode === 'workspace' || state?.mode === 'agentic-coding') {
                                    logger.menu.info(`[Reopen Closed Tab] Sending reopen-last-closed-tab to window ${windowId}`);
                                    focused.webContents.send('reopen-last-closed-tab');
                                } else {
                                    logger.menu.warn('[Reopen Closed Tab] Not in workspace/agentic mode');
                                }
                            }
                        } else {
                            logger.menu.warn('[Reopen Closed Tab] No focused window found');
                        }
                    }
                },
                {
                    label: 'Close Project',
                    accelerator: KeyboardShortcuts.file.closeProject,
                    click: async () => {
                        const focused = getFocusedWindow();

                        if (focused && !focused.isDestroyed()) {
                            // Get window info for logging
                            const windowId = getWindowId(focused);
                            const state = windowId !== null ? windowStates.get(windowId) : undefined;
                            let projectName = 'Untitled';

                            if (state?.mode === 'workspace' && state.workspacePath) {
                                projectName = basename(state.workspacePath);
                            } else if (state?.filePath) {
                                projectName = basename(state.filePath);
                            }

                            console.log('[Close Project] Closing:', {
                                windowId,
                                projectName,
                                mode: state?.mode,
                                electronId: focused.id
                            });

                            // TODO: Add warning dialog if AI/agent is running
                            focused.close();
                        } else {
                            console.error('[Close Project] No focused window found or window is destroyed');
                        }
                    }
                },
                { type: 'separator' },
                {
                    label: 'Quit',
                    accelerator: KeyboardShortcuts.file.quit,
                    click: async () => {
                        try {
                            console.log('Quit menu item clicked');
                            app.quit();
                        } catch (error) {
                            console.error('Error during quit:', error);
                            // Force quit if normal quit fails
                            process.exit(0);
                        }
                    }
                }
            ]
        },
        {
            label: 'Edit',
            submenu: [
                { label: 'Undo', accelerator: KeyboardShortcuts.edit.undo, role: 'undo' },
                { label: 'Redo', accelerator: KeyboardShortcuts.edit.redo, role: 'redo' },
                { type: 'separator' },
                { label: 'Cut', accelerator: KeyboardShortcuts.edit.cut, role: 'cut' },
                { label: 'Copy', accelerator: KeyboardShortcuts.edit.copy, role: 'copy' },
                {
                    label: 'Copy as Markdown',
                    accelerator: KeyboardShortcuts.edit.copyMarkdown,
                    click: async () => {
                        const focused = getFocusedWindow();
                        if (focused) {
                            focused.webContents.send('copy-as-markdown');
                        }
                    }
                },
                { label: 'Paste', accelerator: KeyboardShortcuts.edit.paste, role: 'paste' },
                { label: 'Select All', accelerator: KeyboardShortcuts.edit.selectAll, role: 'selectAll' },
                { type: 'separator' },
                {
                    label: 'Find...',
                    accelerator: KeyboardShortcuts.edit.find,
                    click: async () => {
                        const focused = getFocusedWindow();
                        if (focused) {
                            focused.webContents.send('menu:find');
                        }
                    }
                },
                {
                    label: 'Find Next',
                    accelerator: KeyboardShortcuts.edit.findNext,
                    click: async () => {
                        const focused = getFocusedWindow();
                        if (focused) {
                            focused.webContents.send('menu:find-next');
                        }
                    }
                },
                {
                    label: 'Find Previous',
                    accelerator: KeyboardShortcuts.edit.findPrevious,
                    click: async () => {
                        const focused = getFocusedWindow();
                        if (focused) {
                            focused.webContents.send('menu:find-previous');
                        }
                    }
                },
                { type: 'separator' },
                {
                    label: 'View Local History...',
                    accelerator: KeyboardShortcuts.edit.viewHistory,
                    click: async () => {
                        const focused = getFocusedWindow();
                        if (focused) {
                            focused.webContents.send('view-history');
                        }
                    }
                },
                {
                    label: 'View Folder History...',
                    accelerator: 'CmdOrCtrl+Shift+H',
                    click: async () => {
                        const focused = getFocusedWindow();
                        if (focused) {
                            focused.webContents.send('view-workspace-history');
                        }
                    }
                },
                { type: 'separator' },
                {
                    label: 'Approve Current Action',
                    accelerator: KeyboardShortcuts.edit.approve,
                    click: async () => {
                        const focused = getFocusedWindow();
                        if (focused) {
                            focused.webContents.send('approve-action');
                        }
                    }
                },
                {
                    label: 'Reject Current Action',
                    accelerator: KeyboardShortcuts.edit.reject,
                    click: async () => {
                        const focused = getFocusedWindow();
                        if (focused) {
                            focused.webContents.send('reject-action');
                        }
                    }
                }
            ]
        },
        {
            label: 'View',
            submenu: [
                // View Modes
                {
                    label: 'Files Mode',
                    accelerator: KeyboardShortcuts.view.filesMode,
                    click: async () => {
                        const focused = getFocusedWindow();
                        if (focused) {
                            focused.webContents.send('set-content-mode', 'files');
                        }
                    }
                },
                {
                    label: 'Agent Mode',
                    accelerator: KeyboardShortcuts.view.agentMode,
                    click: async () => {
                        console.log('[Menu] Agent Mode clicked');
                        const focused = getFocusedWindow();
                        console.log('[Menu] Focused window:', focused ? 'exists' : 'null');
                        if (focused) {
                            console.log('[Menu] Sending set-content-mode event with agent');
                            focused.webContents.send('set-content-mode', 'agent');
                        }
                    }
                },
                { type: 'separator' },
                // Panels
                {
                    label: 'Toggle AI Chat Panel',
                    accelerator: KeyboardShortcuts.view.toggleAIChat,
                    click: async () => {
                        const focused = getFocusedWindow();
                        if (focused) {
                            focused.webContents.send('toggle-ai-chat-panel');
                        }
                    }
                },
                {
                    label: 'Toggle Bottom Panel',
                    accelerator: KeyboardShortcuts.view.toggleBottomPanel,
                    click: async () => {
                        const focused = getFocusedWindow();
                        if (focused) {
                            focused.webContents.send('toggle-bottom-panel');
                        }
                    }
                },
                { type: 'separator' },
                // Navigation
                {
                    label: 'Navigate Back',
                    accelerator: KeyboardShortcuts.view.navigateBack,
                    click: async () => {
                        const focused = getFocusedWindow();
                        if (focused) {
                            focused.webContents.send('navigation:go-back');
                        }
                    }
                },
                {
                    label: 'Navigate Forward',
                    accelerator: KeyboardShortcuts.view.navigateForward,
                    click: async () => {
                        const focused = getFocusedWindow();
                        if (focused) {
                            focused.webContents.send('navigation:go-forward');
                        }
                    }
                },
                { type: 'separator' },
                // Tab Navigation
                {
                    label: 'Next Tab',
                    accelerator: KeyboardShortcuts.view.nextTab,
                    click: async () => {
                        const focused = getFocusedWindow();
                        if (focused) {
                            focused.webContents.send('next-tab');
                        }
                    }
                },
                {
                    label: 'Previous Tab',
                    accelerator: KeyboardShortcuts.view.prevTab,
                    click: async () => {
                        const focused = getFocusedWindow();
                        if (focused) {
                            focused.webContents.send('previous-tab');
                        }
                    }
                },
                { type: 'separator' },
                // Zoom
                {
                    label: 'Actual Size',
                    accelerator: KeyboardShortcuts.view.actualSize,
                    click: async () => {
                        const focused = getFocusedWindow();
                        if (focused) focused.webContents.setZoomFactor(1);
                    }
                },
                {
                    label: 'Zoom In',
                    accelerator: KeyboardShortcuts.view.zoomIn,
                    click: async () => {
                        const focused = getFocusedWindow();
                        if (focused) {
                            const currentZoom = focused.webContents.getZoomFactor();
                            focused.webContents.setZoomFactor(currentZoom + 0.1);
                        }
                    }
                },
                {
                    // Hidden alias for Zoom In so users can press CmdOrCtrl+=
                    // without holding Shift. The visible accelerator `Cmd+Plus`
                    // requires Shift+= on Windows/Linux QWERTY layouts and the
                    // Electron `Plus` accelerator can also miss the keystroke
                    // when Windows reports the unshifted `=` keycode. Pattern
                    // matches the hidden `New File` accelerator above. See #205.
                    label: 'Zoom In (alt)',
                    accelerator: 'CmdOrCtrl+=',
                    visible: false,
                    click: async () => {
                        const focused = getFocusedWindow();
                        if (focused) {
                            const currentZoom = focused.webContents.getZoomFactor();
                            focused.webContents.setZoomFactor(currentZoom + 0.1);
                        }
                    }
                },
                {
                    // Hidden alias matching the literal Shift+= keystroke that
                    // produces `+` on QWERTY layouts; some keyboard drivers
                    // report this with the Shift modifier still set, so the
                    // bare `CmdOrCtrl+=` binding above doesn't always catch it.
                    label: 'Zoom In (Shift+=)',
                    accelerator: 'CmdOrCtrl+Shift+=',
                    visible: false,
                    click: async () => {
                        const focused = getFocusedWindow();
                        if (focused) {
                            const currentZoom = focused.webContents.getZoomFactor();
                            focused.webContents.setZoomFactor(currentZoom + 0.1);
                        }
                    }
                },
                {
                    // Hidden alias for the numeric keypad `+`. Reported as a
                    // distinct keycode from the main-row `+`, so neither
                    // CmdOrCtrl+Plus nor CmdOrCtrl+= pick it up.
                    label: 'Zoom In (numpad)',
                    accelerator: 'CmdOrCtrl+numadd',
                    visible: false,
                    click: async () => {
                        const focused = getFocusedWindow();
                        if (focused) {
                            const currentZoom = focused.webContents.getZoomFactor();
                            focused.webContents.setZoomFactor(currentZoom + 0.1);
                        }
                    }
                },
                {
                    label: 'Zoom Out',
                    accelerator: KeyboardShortcuts.view.zoomOut,
                    click: async () => {
                        const focused = getFocusedWindow();
                        if (focused) {
                            const currentZoom = focused.webContents.getZoomFactor();
                            focused.webContents.setZoomFactor(Math.max(0.5, currentZoom - 0.1));
                        }
                    }
                },
                {
                    // Hidden alias for the numeric keypad `-`. Symmetric with
                    // the numpad zoom-in binding above.
                    label: 'Zoom Out (numpad)',
                    accelerator: 'CmdOrCtrl+numsub',
                    visible: false,
                    click: async () => {
                        const focused = getFocusedWindow();
                        if (focused) {
                            const currentZoom = focused.webContents.getZoomFactor();
                            focused.webContents.setZoomFactor(Math.max(0.5, currentZoom - 0.1));
                        }
                    }
                },
                { type: 'separator' },
                // Appearance
                {
                    label: 'Theme',
                    submenu: [
                        {
                            label: 'Light',
                            type: 'radio',
                            checked: currentTheme === 'light',
                            click: async () => {
                                const fromTheme = currentTheme;
                                const featureTracking = FeatureTrackingService.getInstance();
                                const isFirstChange = !featureTracking.hasBeenUsed('theme_changed' as any);

                                if (isFirstChange) {
                                    featureTracking.isFirstUse('theme_changed' as any);
                                }

                                setTheme('light');
                                updateNativeTheme();
                                BrowserWindow.getAllWindows().forEach(window => {
                                    window.webContents.send('theme-change', 'light');
                                });
                                updateWindowTitleBars();
                                await createApplicationMenu();

                                // Track theme change
                                AnalyticsService.getInstance().sendEvent('theme_changed', {
                                    fromTheme,
                                    toTheme: 'light',
                                    isFirstChange,
                                });
                            }
                        },
                        {
                            label: 'Dark',
                            type: 'radio',
                            checked: currentTheme === 'dark',
                            click: async () => {
                                const fromTheme = currentTheme;
                                const featureTracking = FeatureTrackingService.getInstance();
                                const isFirstChange = !featureTracking.hasBeenUsed('theme_changed' as any);

                                if (isFirstChange) {
                                    featureTracking.isFirstUse('theme_changed' as any);
                                }

                                setTheme('dark');
                                updateNativeTheme();
                                BrowserWindow.getAllWindows().forEach(window => {
                                    window.webContents.send('theme-change', 'dark');
                                });
                                updateWindowTitleBars();
                                await createApplicationMenu();

                                // Track theme change
                                AnalyticsService.getInstance().sendEvent('theme_changed', {
                                    fromTheme,
                                    toTheme: 'dark',
                                    isFirstChange,
                                });
                            }
                        },
                        {
                            label: 'Crystal Dark',
                            type: 'radio',
                            checked: currentTheme === 'crystal-dark',
                            click: async () => {
                                const fromTheme = currentTheme;
                                const featureTracking = FeatureTrackingService.getInstance();
                                const isFirstChange = !featureTracking.hasBeenUsed('theme_changed' as any);

                                if (isFirstChange) {
                                    featureTracking.isFirstUse('theme_changed' as any);
                                }

                                setTheme('crystal-dark');
                                updateNativeTheme();
                                BrowserWindow.getAllWindows().forEach(window => {
                                    window.webContents.send('theme-change', 'crystal-dark');
                                });
                                updateWindowTitleBars();
                                await createApplicationMenu();

                                // Track theme change
                                AnalyticsService.getInstance().sendEvent('theme_changed', {
                                    fromTheme,
                                    toTheme: 'crystal-dark',
                                    isFirstChange,
                                });
                            }
                        },
                        {
                            label: 'System',
                            type: 'radio',
                            checked: currentTheme === 'system',
                            click: async () => {
                                const fromTheme = currentTheme;
                                const featureTracking = FeatureTrackingService.getInstance();
                                const isFirstChange = !featureTracking.hasBeenUsed('theme_changed' as any);

                                if (isFirstChange) {
                                    featureTracking.isFirstUse('theme_changed' as any);
                                }

                                setTheme('system');
                                updateNativeTheme();
                                // Send resolved theme (light or dark) to renderers
                                const resolvedTheme = nativeTheme.shouldUseDarkColors ? 'dark' : 'light';
                                BrowserWindow.getAllWindows().forEach(window => {
                                    window.webContents.send('theme-change', resolvedTheme);
                                });
                                updateWindowTitleBars();
                                await createApplicationMenu();

                                // Track theme change
                                AnalyticsService.getInstance().sendEvent('theme_changed', {
                                    fromTheme,
                                    toTheme: 'system',
                                    isFirstChange,
                                });
                            }
                        }
                    ]
                },
                { type: 'separator' },
                // Full screen
                {
                    label: 'Toggle Full Screen',
                    accelerator: KeyboardShortcuts.view.toggleFullScreen,
                    click: async () => {
                        const focused = getFocusedWindow();
                        if (focused) {
                            focused.setFullScreen(!focused.isFullScreen());
                        }
                    }
                }
            ]
        },
        {
            label: 'Window',
            submenu: [
                {
                    label: 'Project Manager',
                    accelerator: KeyboardShortcuts.window.workspaceManager,
                    click: async () => {
                        // Track menu action
                        AnalyticsService.getInstance().sendEvent('menu_action_used', {
                            menu: 'window',
                            action: 'project_manager',
                            hasKeyboardEquivalent: true,
                        });
                        createWorkspaceManagerWindow();
                    }
                },
                {
                    label: 'Switch Project',
                    accelerator: KeyboardShortcuts.window.projectQuickOpen,
                    registerAccelerator: false, // Handled by renderer keyboard handler
                    click: () => {
                        const focused = getFocusedWindow();
                        if (focused) focused.webContents.send('open-navigation-dialog', 'project-quick-open');
                    }
                },
                { type: 'separator' },
                {
                    label: 'Quick Open',
                    accelerator: KeyboardShortcuts.file.open,
                    registerAccelerator: false,
                    click: () => {
                        const focused = getFocusedWindow();
                        if (focused) focused.webContents.send('open-navigation-dialog', 'quick-open');
                    }
                },
                {
                    label: 'Session Quick Open',
                    accelerator: KeyboardShortcuts.window.sessionQuickOpen,
                    registerAccelerator: false,
                    click: () => {
                        const focused = getFocusedWindow();
                        if (focused) focused.webContents.send('open-navigation-dialog', 'session-quick-open');
                    }
                },
                {
                    label: 'Prompt Quick Open',
                    accelerator: KeyboardShortcuts.window.promptQuickOpen,
                    registerAccelerator: false,
                    click: () => {
                        const focused = getFocusedWindow();
                        if (focused) focused.webContents.send('open-navigation-dialog', 'prompt-quick-open');
                    }
                },
                {
                    label: 'Content Search',
                    accelerator: KeyboardShortcuts.window.contentSearch,
                    registerAccelerator: false,
                    click: () => {
                        const focused = getFocusedWindow();
                        if (focused) focused.webContents.send('open-navigation-dialog', 'content-search');
                    }
                },
                {
                    label: 'Global Search',
                    accelerator: KeyboardShortcuts.window.globalSearch,
                    registerAccelerator: false, // Handled by renderer keyboard handler
                    click: () => {
                        const focused = getFocusedWindow();
                        if (focused) focused.webContents.send('open-navigation-dialog', 'global-search');
                    }
                },
                { type: 'separator' },
                {
                    label: 'AI Usage Report',
                    click: async () => {
                        // Track menu action
                        AnalyticsService.getInstance().sendEvent('menu_action_used', {
                            menu: 'window',
                            action: 'ai_usage_report',
                        });
                        createAIUsageReportWindow();
                    }
                },
                // {
                //     label: 'Session Manager',
                //     accelerator: KeyboardShortcuts.window.sessionManager,
                //     click: async () => {
                //         createSessionManagerWindow();
                //     }
                // },
                // {
                //     label: 'Agentic Coding...',
                //     accelerator: KeyboardShortcuts.window.agenticCoding,
                //     click: async () => {
                //         const focused = getFocusedWindow();
                //         if (!focused) return;
                //
                //         const windowId = getWindowId(focused);
                //         const state = windowId !== null ? windowStates.get(windowId) : undefined;
                //
                //         if (!state || !state.workspacePath) {
                //             dialog.showMessageBox(focused, {
                //                 type: 'info',
                //                 title: 'No Workspace',
                //                 message: 'Please open a workspace to use agentic coding.'
                //             });
                //             return;
                //         }
                //
                //         createAgenticCodingWindow({
                //             workspacePath: state.workspacePath,
                //             planDocumentPath: state.filePath && state.filePath.endsWith('.md') ? state.filePath : undefined
                //         });
                //     }
                // },
                { type: 'separator' },
                { label: 'Minimize', accelerator: KeyboardShortcuts.window.minimize, role: 'minimize' },
                { type: 'separator' },
                { label: 'Bring All to Front', role: 'front' },
                { type: 'separator' },
                ...createWindowListMenu()
            ]
        },
        {
            label: 'Developer',
            submenu: [
                {
                    label: 'For assisting the development of Nimbalyst',
                    enabled: false
                },
                { type: 'separator' },
                {
                    label: 'Toggle Developer Tools',
                    accelerator: KeyboardShortcuts.view.toggleDevTools,
                    click: async () => {
                        const focused = getFocusedWindow();
                        if (focused) focused.webContents.toggleDevTools();
                    }
                },
                {
                    label: 'New Extension Project...',
                    click: async () => {
                        AnalyticsService.getInstance().sendEvent('menu_action_used', {
                            menu: 'developer',
                            action: 'new_extension_project',
                            hasKeyboardEquivalent: false,
                        });

                        await showNewExtensionProjectDialog(getFocusedWindow());
                    }
                },
                { type: 'separator' },
                {
                    label: 'Reload',
                    accelerator: KeyboardShortcuts.view.reload,
                    click: async () => {
                        const focused = getFocusedWindow();
                        if (focused) focused.webContents.reload();
                    }
                },
                {
                    label: 'Force Reload',
                    accelerator: KeyboardShortcuts.view.forceReload,
                    click: async () => {
                        const focused = getFocusedWindow();
                        if (focused) focused.webContents.reloadIgnoringCache();
                    }
                },
                { type: 'separator' },
                {
                    label: 'Developer Dashboard',
                    click: () => {
                        createDeveloperDashboardWindow();
                    }
                },
                {
                    label: 'Diff Ergonomics Test Harness',
                    click: async () => {
                        await runDiffErgonomicsHarness(getFocusedWindow());
                    }
                },
                {
                    label: 'Refresh File Tree',
                    accelerator: KeyboardShortcuts.developer.refreshFileTree,
                    click: async () => {
                        const focused = getFocusedWindow();
                        if (focused) {
                            refreshWorkspaceFileTree(focused);
                        }
                    }
                },
                { type: 'separator' },
                {
                    label: 'Open Debug Log',
                    click: async () => {
                        const logPath = path.join(app.getPath('userData'), 'nimbalyst-debug.log');

                        // Create the log file if it doesn't exist
                        if (!fs.existsSync(logPath)) {
                            fs.writeFileSync(logPath, `=== Nimbalyst Debug Log ===\nNo debug messages yet.\n\nDebug logging is only active in development mode.\nTo enable debug logging in production, set NODE_ENV=development\n`);
                        }

                        shell.openPath(logPath).catch((err: any) => {
                            console.error('Failed to open debug log:', err);
                            dialog.showErrorBox('Error', `Could not open debug log at: ${logPath}`);
                        });
                    }
                },
                {
                    label: 'Open Main Log',
                    click: async () => {
                        const logPath = path.join(app.getPath('userData'), 'logs', 'main.log');

                        // Create the log file if it doesn't exist
                        if (!fs.existsSync(logPath)) {
                            const logsDir = path.dirname(logPath);
                            if (!fs.existsSync(logsDir)) {
                                fs.mkdirSync(logsDir, { recursive: true });
                            }
                            fs.writeFileSync(logPath, `=== Nimbalyst Main Log ===\nNo log messages yet.\n\nThis log contains main process and application logs.\n`);
                        }

                        shell.openPath(logPath).catch((err: any) => {
                            console.error('Failed to open main log:', err);
                            dialog.showErrorBox('Error', `Could not open main log at: ${logPath}`);
                        });
                    }
                },
                {
                    label: 'Rotate Logs',
                    click: async () => {
                        const userData = app.getPath('userData');
                        const results: string[] = [];

                        // Rotate debug logs (shift numbered backups, move current to .1)
                        try {
                            const baseName = 'nimbalyst-debug';
                            const ext = '.log';
                            const maxSessions = 5;

                            // Delete oldest
                            const oldestPath = path.join(userData, `${baseName}.${maxSessions - 1}${ext}`);
                            if (fs.existsSync(oldestPath)) {
                                fs.unlinkSync(oldestPath);
                            }

                            // Shift existing: N-1 -> N, ..., 1 -> 2
                            for (let i = maxSessions - 2; i >= 1; i--) {
                                const currentPath = path.join(userData, `${baseName}.${i}${ext}`);
                                const nextPath = path.join(userData, `${baseName}.${i + 1}${ext}`);
                                if (fs.existsSync(currentPath)) {
                                    fs.renameSync(currentPath, nextPath);
                                }
                            }

                            // Move current to .1
                            const currentLogPath = path.join(userData, `${baseName}${ext}`);
                            const firstBackupPath = path.join(userData, `${baseName}.1${ext}`);
                            if (fs.existsSync(currentLogPath)) {
                                fs.renameSync(currentLogPath, firstBackupPath);
                                results.push('Debug log rotated');
                            } else {
                                results.push('Debug log: no file to rotate');
                            }

                            // Start fresh debug log
                            const timestamp = new Date().toISOString();
                            fs.writeFileSync(currentLogPath, `=== Debug Log Started ${timestamp} (manual rotation) ===\n`);
                        } catch (error) {
                            results.push(`Debug log rotation failed: ${error}`);
                        }

                        // Rotate main log (shift numbered backups, same as startup)
                        try {
                            const logsDir = path.join(userData, 'logs');
                            const mainBase = 'main';
                            const mainExt = '.log';
                            const maxMainSessions = 3;

                            const mainLogPath = path.join(logsDir, `${mainBase}${mainExt}`);
                            let sizeMB = '0';
                            if (fs.existsSync(mainLogPath)) {
                                sizeMB = (fs.statSync(mainLogPath).size / (1024 * 1024)).toFixed(1);
                            }

                            // Delete oldest
                            const oldestMain = path.join(logsDir, `${mainBase}.${maxMainSessions - 1}${mainExt}`);
                            if (fs.existsSync(oldestMain)) {
                                fs.unlinkSync(oldestMain);
                            }

                            // Shift existing: N-1 -> N, ..., 1 -> 2
                            for (let i = maxMainSessions - 2; i >= 1; i--) {
                                const cur = path.join(logsDir, `${mainBase}.${i}${mainExt}`);
                                const nxt = path.join(logsDir, `${mainBase}.${i + 1}${mainExt}`);
                                if (fs.existsSync(cur)) {
                                    fs.renameSync(cur, nxt);
                                }
                            }

                            // Move current to .1 (electron-log will create a fresh main.log on next write)
                            if (fs.existsSync(mainLogPath)) {
                                fs.renameSync(mainLogPath, path.join(logsDir, `${mainBase}.1${mainExt}`));
                                results.push(`Main log rotated (was ${sizeMB} MB)`);
                            } else {
                                results.push('Main log: no file to rotate');
                            }
                        } catch (error) {
                            results.push(`Main log rotation failed: ${error}`);
                        }

                        const focused = getFocusedWindow();
                        if (focused) {
                            dialog.showMessageBox(focused, {
                                type: 'info',
                                title: 'Log Rotation',
                                message: 'Logs Rotated',
                                detail: results.join('\n'),
                                buttons: ['OK']
                            });
                        }
                    }
                },
                {
                    label: 'Open User Data Directory',
                    click: async () => {
                        const userDataPath = app.getPath('userData');
                        shell.openPath(userDataPath).catch((err: any) => {
                            console.error('Failed to open user data directory:', err);
                            dialog.showErrorBox('Error', `Could not open user data directory at: ${userDataPath}`);
                        });
                    }
                },
                { type: 'separator' },
                {
                    label: 'Show Dialogs',
                    submenu: [
                        {
                            label: 'Show Onboarding (New User)',
                            click: async () => {
                                const focused = getFocusedWindow();
                                if (focused) {
                                    focused.webContents.send('show-unified-onboarding', { forceNewUser: true });
                                }
                            }
                        },
                        {
                            label: 'Show Onboarding (Existing User)',
                            click: async () => {
                                const focused = getFocusedWindow();
                                if (focused) {
                                    focused.webContents.send('show-unified-onboarding', { forceExistingUser: true });
                                }
                            }
                        },
                        {
                            label: 'Show Discord Invitation',
                            click: async () => {
                                const focused = getFocusedWindow();
                                if (focused) {
                                    focused.webContents.send('show-discord-invitation');
                                }
                            }
                        },
                        {
                            label: 'Show Extension Project Intro',
                            click: async () => {
                                await showExtensionProjectIntroDialog(getFocusedWindow(), {
                                    forceShow: true,
                                    markShown: false,
                                });
                            }
                        },
                        {
                            label: 'Show Worktree Onboarding',
                            click: async () => {
                                const focused = getFocusedWindow();
                                if (focused) {
                                    focused.webContents.send('show-worktree-onboarding');
                                }
                            }
                        },
                        {
                            label: 'Show Windows Warning',
                            click: async () => {
                                const focused = getFocusedWindow();
                                if (focused) {
                                    focused.webContents.send('show-windows-claude-code-warning');
                                }
                            }
                        },
                        {
                            label: 'Show Commands Toast',
                            click: async () => {
                                const focused = getFocusedWindow();
                                if (focused) {
                                    focused.webContents.send('show-commands-toast');
                                }
                            }
                        },
                        {
                            label: 'Show Trust Toast',
                            click: async () => {
                                const focused = getFocusedWindow();
                                if (focused) {
                                    focused.webContents.send('show-trust-toast');
                                }
                            }
                        },
                        {
                            label: 'Show Figma MCP Migration Toast',
                            click: async () => {
                                const focused = getFocusedWindow();
                                if (focused) {
                                    focused.webContents.send('show-figma-mcp-migration');
                                }
                            }
                        },
                        {
                            label: 'Reset Worktree Onboarding',
                            click: () => {
                                setWorktreeOnboardingShown(false);
                            }
                        },
                        { type: 'separator' },
                        {
                            label: 'Show Database Recovery Dialog',
                            click: async () => {
                                database.showRecoveryDialog();
                            }
                        },
                        {
                            label: 'Show Splash Screen',
                            click: () => {
                                showSplashScreen();
                            }
                        },
                        { type: 'separator' },
                        {
                            label: 'Show Update Error Toast',
                            click: async () => {
                                const focused = getFocusedWindow();
                                if (focused) {
                                    focused.webContents.send('update-toast:error', {
                                        message: 'Certificate verification failed: the update signature does not match'
                                    });
                                }
                            }
                        }
                    ]
                },
                {
                    label: 'Show Walkthroughs',
                    submenu: [
                        // Dynamically generated from registered walkthroughs
                        ...getRegisteredWalkthroughs().map(walkthrough => ({
                            label: walkthrough.name,
                            click: async () => {
                                const focused = getFocusedWindow();
                                if (focused) {
                                    focused.webContents.send('trigger-walkthrough', walkthrough.id);
                                }
                            }
                        })),
                        ...(getRegisteredWalkthroughs().length > 0 ? [{ type: 'separator' as const }] : []),
                        {
                            label: 'Reset All Walkthroughs',
                            click: async () => {
                                const focused = getFocusedWindow();
                                if (focused) {
                                    focused.webContents.send('reset-walkthroughs');
                                }
                            }
                        }
                    ]
                },
                {
                    label: 'Show Tips',
                    submenu: [
                        ...getRegisteredTips().map(tip => ({
                            label: tip.name,
                            click: async () => {
                                const focused = getFocusedWindow();
                                if (focused) {
                                    focused.webContents.send('trigger-tip', tip.id);
                                }
                            }
                        })),
                        ...(getRegisteredTips().length > 0 ? [{ type: 'separator' as const }] : []),
                        {
                            label: 'Reset All Tips',
                            click: async () => {
                                const focused = getFocusedWindow();
                                if (focused) {
                                    focused.webContents.send('reset-tips');
                                }
                            }
                        }
                    ]
                },
                ...(isDev ? [
                    { type: 'separator' },
                    {
                        label: 'Database Browser',
                        click: async () => {
                            createDatabaseBrowserWindow();
                        }
                    }
                ] : [])
            ]
        }
    ];

    // Add app menu on macOS
    if (process.platform === 'darwin') {
        template.unshift({
            label: app.getName(),
            submenu: [
                {
                    label: 'About Nimbalyst',
                    click: async () => {
                        createAboutWindow();
                    }
                },
                {
                    label: 'Check for Updates...',
                    click: async () => {
                        autoUpdaterService.checkForUpdatesWithUI();
                    }
                },
                { type: 'separator' },
                {
                    label: 'Settings...',
                    accelerator: KeyboardShortcuts.window.aiModels,
                    click: async () => {
                        // Track settings opened
                        AnalyticsService.getInstance().sendEvent('global_settings_opened', {
                            source: 'menu',
                            section: 'general',
                        });
                        // Switch to settings mode in the focused window
                        const focused = getFocusedWindow();
                        if (focused && !isAboutWindow(focused)) {
                            focused.webContents.send('set-content-mode', 'settings');
                        }
                    }
                },
                { type: 'separator' },
                { label: 'Services', submenu: [] },
                { type: 'separator' },
                { label: 'Hide ' + app.getName(), accelerator: 'Command+H', role: 'hide' },
                { label: 'Hide Others', accelerator: 'Command+Shift+H', role: 'hideothers' },
                { label: 'Show All', role: 'unhide' },
                { type: 'separator' },
                {
                    label: 'Quit',
                    accelerator: 'Command+Q',
                    click: async () => {
                        try {
                            console.log('Quit menu item clicked (macOS)');
                            app.quit();
                        } catch (error) {
                            console.error('Error during quit:', error);
                            // Force quit if normal quit fails
                            process.exit(0);
                        }
                    }
                }
            ]
        });

        // Add Help menu for macOS
        template.push({
            label: 'Help',
            submenu: [
                // {
                //     label: 'Welcome',
                //     click: async () => {
                //         // Track help accessed
                //         AnalyticsService.getInstance().sendEvent('help_accessed', {
                //             helpType: 'welcome',
                //             context: 'menu',
                //         });
                //         // Send message to renderer to open welcome tab
                //         const focusedWindow = getFocusedWindow();
                //         if (focusedWindow) {
                //             focusedWindow.webContents.send('open-welcome-tab');
                //         }
                //     }
                // },
                {
                    label: 'Documentation',
                    click: async () => {
                        // Track help accessed
                        AnalyticsService.getInstance().sendEvent('help_accessed', {
                            helpType: 'docs',
                            context: 'menu',
                        });
                        shell.openExternal('https://docs.nimbalyst.com/');
                    }
                },
                {
                    label: 'Install Chrome Extension',
                    click: async () => {
                        AnalyticsService.getInstance().sendEvent('help_accessed', {
                            helpType: 'chrome_extension',
                            context: 'menu',
                        });
                        shell.openExternal('https://chromewebstore.google.com/detail/nimbalyst-web-clipper/fdbmklnnkalihoblphakoebgmieljkbb');
                    }
                },
                // Extension SDK Documentation - only show when Extension Development Kit is enabled
                ...(isExtensionDevToolsEnabled() ? [{
                    label: 'Extension SDK Documentation',
                    click: async () => {
                        AnalyticsService.getInstance().sendEvent('help_accessed', {
                            helpType: 'extension_sdk_docs',
                            context: 'menu',
                        });
                        const sdkDocsPath = getExtensionSDKDocsPath();
                        if (sdkDocsPath) {
                            // Open as a workspace window
                            addToRecentItems('workspaces', sdkDocsPath, 'Extension SDK Docs');
                            createWindow(false, true, sdkDocsPath);
                        } else {
                            dialog.showErrorBox(
                                'SDK Documentation Not Found',
                                'The Extension SDK documentation could not be found. Please reinstall Nimbalyst.'
                            );
                        }
                    }
                }] : []),
                {
                    label: 'Keyboard Shortcuts',
                    accelerator: 'CmdOrCtrl+/',
                    click: async () => {
                        // Track help accessed
                        AnalyticsService.getInstance().sendEvent('help_accessed', {
                            helpType: 'keyboard_shortcuts',
                            context: 'menu',
                        });
                        const focusedWindow = getFocusedWindow();
                        if (focusedWindow) {
                            focusedWindow.webContents.send('open-keyboard-shortcuts');
                        }
                    }
                },
                { type: 'separator' },
                {
                    label: 'Send Feedback...',
                    click: async () => {
                        AnalyticsService.getInstance().sendEvent('help_accessed', {
                            helpType: 'feedback',
                            context: 'menu',
                        });
                        const focusedWindow = getFocusedWindow();
                        if (focusedWindow) {
                            focusedWindow.webContents.send('open-feedback');
                        }
                    }
                },
                {
                    label: 'Browse Issues on GitHub',
                    click: async () => {
                        AnalyticsService.getInstance().sendEvent('help_accessed', {
                            helpType: 'github_issues',
                            context: 'menu',
                        });
                        shell.openExternal('https://github.com/nimbalyst/nimbalyst/issues');
                    }
                },
                {
                    label: 'GitHub Discussions',
                    click: async () => {
                        AnalyticsService.getInstance().sendEvent('help_accessed', {
                            helpType: 'github_discussions',
                            context: 'menu',
                        });
                        shell.openExternal('https://github.com/nimbalyst/nimbalyst/discussions');
                    }
                },
                { type: 'separator' },
                {
                    label: 'Community',
                    submenu: [
                        {
                            label: 'Join Discord',
                            click: async () => {
                                AnalyticsService.getInstance().sendEvent('help_accessed', { helpType: 'discord', context: 'menu' });
                                shell.openExternal('https://discord.gg/ubZDt4esEn');
                            }
                        },
                        { type: 'separator' },
                        {
                            label: 'YouTube',
                            click: async () => {
                                AnalyticsService.getInstance().sendEvent('help_accessed', { helpType: 'youtube', context: 'menu' });
                                shell.openExternal('https://youtube.com/@nimbalyst');
                            }
                        },
                        {
                            label: 'LinkedIn',
                            click: async () => {
                                AnalyticsService.getInstance().sendEvent('help_accessed', { helpType: 'linkedin', context: 'menu' });
                                shell.openExternal('https://linkedin.com/company/nimbalyst');
                            }
                        },
                        {
                            label: 'X (Twitter)',
                            click: async () => {
                                AnalyticsService.getInstance().sendEvent('help_accessed', { helpType: 'x', context: 'menu' });
                                shell.openExternal('https://x.com/nimbalyst');
                            }
                        },
                        {
                            label: 'TikTok',
                            click: async () => {
                                AnalyticsService.getInstance().sendEvent('help_accessed', { helpType: 'tiktok', context: 'menu' });
                                shell.openExternal('https://www.tiktok.com/@nimbalyst');
                            }
                        },
                        {
                            label: 'Instagram',
                            click: async () => {
                                AnalyticsService.getInstance().sendEvent('help_accessed', { helpType: 'instagram', context: 'menu' });
                                shell.openExternal('https://www.instagram.com/nimbalyst');
                            }
                        },
                    ]
                }
            ]
        });
    } else {
        // Windows and Linux
        template.push({
            label: 'Help',
            submenu: [
                {
                    label: 'Welcome',
                    click: async () => {
                        // Track help accessed
                        AnalyticsService.getInstance().sendEvent('help_accessed', {
                            helpType: 'welcome',
                            context: 'menu',
                        });
                        // Send message to renderer to open welcome tab
                        const focusedWindow = getFocusedWindow();
                        if (focusedWindow) {
                            focusedWindow.webContents.send('open-welcome-tab');
                        }
                    }
                },
                {
                    label: 'Documentation',
                    click: async () => {
                        // Track help accessed
                        AnalyticsService.getInstance().sendEvent('help_accessed', {
                            helpType: 'docs',
                            context: 'menu',
                        });
                        shell.openExternal('https://docs.nimbalyst.com/');
                    }
                },
                {
                    label: 'Install Chrome Extension',
                    click: async () => {
                        AnalyticsService.getInstance().sendEvent('help_accessed', {
                            helpType: 'chrome_extension',
                            context: 'menu',
                        });
                        shell.openExternal('https://chromewebstore.google.com/detail/nimbalyst-web-clipper/fdbmklnnkalihoblphakoebgmieljkbb');
                    }
                },
                // Extension SDK Documentation - only show when Extension Development Kit is enabled
                ...(isExtensionDevToolsEnabled() ? [{
                    label: 'Extension SDK Documentation',
                    click: async () => {
                        AnalyticsService.getInstance().sendEvent('help_accessed', {
                            helpType: 'extension_sdk_docs',
                            context: 'menu',
                        });
                        const sdkDocsPath = getExtensionSDKDocsPath();
                        if (sdkDocsPath) {
                            // Open as a workspace window
                            addToRecentItems('workspaces', sdkDocsPath, 'Extension SDK Docs');
                            createWindow(false, true, sdkDocsPath);
                        } else {
                            dialog.showErrorBox(
                                'SDK Documentation Not Found',
                                'The Extension SDK documentation could not be found. Please reinstall Nimbalyst.'
                            );
                        }
                    }
                }] : []),
                {
                    label: 'Keyboard Shortcuts',
                    accelerator: 'CmdOrCtrl+/',
                    click: async () => {
                        // Track help accessed
                        AnalyticsService.getInstance().sendEvent('help_accessed', {
                            helpType: 'keyboard_shortcuts',
                            context: 'menu',
                        });
                        const focusedWindow = getFocusedWindow();
                        if (focusedWindow) {
                            focusedWindow.webContents.send('open-keyboard-shortcuts');
                        }
                    }
                },
                { type: 'separator' },
                {
                    label: 'Send Feedback...',
                    click: async () => {
                        AnalyticsService.getInstance().sendEvent('help_accessed', {
                            helpType: 'feedback',
                            context: 'menu',
                        });
                        const focusedWindow = getFocusedWindow();
                        if (focusedWindow) {
                            focusedWindow.webContents.send('open-feedback');
                        }
                    }
                },
                {
                    label: 'Browse Issues on GitHub',
                    click: async () => {
                        AnalyticsService.getInstance().sendEvent('help_accessed', {
                            helpType: 'github_issues',
                            context: 'menu',
                        });
                        shell.openExternal('https://github.com/nimbalyst/nimbalyst/issues');
                    }
                },
                {
                    label: 'GitHub Discussions',
                    click: async () => {
                        AnalyticsService.getInstance().sendEvent('help_accessed', {
                            helpType: 'github_discussions',
                            context: 'menu',
                        });
                        shell.openExternal('https://github.com/nimbalyst/nimbalyst/discussions');
                    }
                },
                { type: 'separator' },
                {
                    label: 'Community',
                    submenu: [
                        {
                            label: 'Join Discord',
                            click: async () => {
                                AnalyticsService.getInstance().sendEvent('help_accessed', { helpType: 'discord', context: 'menu' });
                                shell.openExternal('https://discord.gg/ubZDt4esEn');
                            }
                        },
                        { type: 'separator' },
                        {
                            label: 'YouTube',
                            click: async () => {
                                AnalyticsService.getInstance().sendEvent('help_accessed', { helpType: 'youtube', context: 'menu' });
                                shell.openExternal('https://youtube.com/@nimbalyst');
                            }
                        },
                        {
                            label: 'LinkedIn',
                            click: async () => {
                                AnalyticsService.getInstance().sendEvent('help_accessed', { helpType: 'linkedin', context: 'menu' });
                                shell.openExternal('https://linkedin.com/company/nimbalyst');
                            }
                        },
                        {
                            label: 'X (Twitter)',
                            click: async () => {
                                AnalyticsService.getInstance().sendEvent('help_accessed', { helpType: 'x', context: 'menu' });
                                shell.openExternal('https://x.com/nimbalyst');
                            }
                        },
                        {
                            label: 'TikTok',
                            click: async () => {
                                AnalyticsService.getInstance().sendEvent('help_accessed', { helpType: 'tiktok', context: 'menu' });
                                shell.openExternal('https://www.tiktok.com/@nimbalyst');
                            }
                        },
                        {
                            label: 'Instagram',
                            click: async () => {
                                AnalyticsService.getInstance().sendEvent('help_accessed', { helpType: 'instagram', context: 'menu' });
                                shell.openExternal('https://www.instagram.com/nimbalyst');
                            }
                        },
                    ]
                },
                { type: 'separator' },
                {
                    label: 'About Nimbalyst',
                    click: async () => {
                        createAboutWindow();
                    }
                },
                {
                    label: 'Check for Updates...',
                    click: async () => {
                        autoUpdaterService.checkForUpdatesWithUI();
                    }
                }
            ]
        });
    }

    Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

// Update application menu
export async function updateApplicationMenu() {
    try {
        await createApplicationMenu();
    } catch (error) {
        logger.menu.error('Error updating application menu:', error);
    }
}

// Helper to check if window is about window
function isAboutWindow(window: BrowserWindow): boolean {
    // Check if window is destroyed first
    if (!window || window.isDestroyed()) {
        return false;
    }
    // Check if this is the about window by checking the title
    return window.getTitle() === 'About Nimbalyst';
}

// Helper to check if window is workspace manager window
function isWorkspaceManagerWindow(window: BrowserWindow): boolean {
    // Check if window is destroyed first
    if (!window || window.isDestroyed()) {
        return false;
    }
    // Check if this is the workspace manager window by checking the title
    return window.getTitle() === 'Project Manager - Nimbalyst';
}
