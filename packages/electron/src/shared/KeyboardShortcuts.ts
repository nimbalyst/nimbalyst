/**
 * Centralized keyboard shortcuts for the application
 * Shared between main and renderer processes
 */

export const KeyboardShortcuts = {
  // File Menu
  file: {
    newFile: 'Cmd+N',
    newSession: 'Cmd+N',
    sessionLaunchPopup: 'Cmd+Shift+N',
    newBrowserTab: 'Cmd+Shift+B',
    open: 'Cmd+O',
    save: 'Cmd+S',
    closeTab: 'Cmd+W',
    reopenClosedTab: 'Cmd+Shift+T',
    closeProject: 'Cmd+Shift+W',
    quit: 'Cmd+Q'
  },

  // Edit Menu
  edit: {
    undo: 'Cmd+Z',
    redo: 'Cmd+Shift+Z',
    cut: 'Cmd+X',
    copy: 'Cmd+C',
    copyMarkdown: 'Cmd+Shift+C',
    paste: 'Cmd+V',
    pasteAsText: 'Cmd+Shift+V',
    selectAll: 'Cmd+A',
    find: 'Cmd+F',
    findNext: 'Cmd+G',
    findPrevious: 'Cmd+Shift+G',
    findAndReplace: 'Cmd+F', // Same as find - both open search/replace bar now
    viewHistory: 'Cmd+Y',
    approve: 'Cmd+Enter',
    reject: 'Cmd+Shift+Backspace'
  },

  // View Menu
  view: {
    // View modes - keep existing shortcuts
    filesMode: 'Cmd+E',
    agentMode: 'Cmd+K',

    // Panels
    toggleAIChat: 'Cmd+Shift+A',
    toggleBottomPanel: 'Cmd+J',
    toggleTerminalPanel: 'Ctrl+`',
    toggleCliTerminalDrawer: 'Ctrl+Shift+`',
    trackerMode: 'Cmd+T',
    collabMode: 'Cmd+D',
    prReviewMode: 'Cmd+U',
    toggleSidebar: 'Cmd+B',

    // Navigation
    navigateBack: 'Cmd+[',
    navigateForward: 'Cmd+]',

    // Tab navigation - use Option instead of Alt for macOS compatibility
    nextTab: 'Cmd+Option+Right',
    prevTab: 'Cmd+Option+Left',

    // Zoom
    actualSize: 'Cmd+0',
    zoomIn: 'Cmd+Plus',
    zoomOut: 'Cmd+-',

    // Developer tools
    toggleDevTools: 'Cmd+Alt+I',
    reload: 'Cmd+R',
    forceReload: 'Cmd+Shift+R',

    // Full screen - platform-specific (F11 is standard on Windows/Linux)
    toggleFullScreen: process.platform === 'darwin' ? 'Ctrl+Cmd+F' : 'F11'
  },

  // Window Menu
  window: {
    workspaceManager: 'Cmd+P',
    sessionManager: 'Cmd+Shift+H',
    sessionQuickOpen: 'Cmd+L',
    promptQuickOpen: 'Cmd+Shift+L',
    contentSearch: 'Cmd+Shift+F',
    globalSearch: 'Cmd+Shift+O',
    teamQuickOpen: 'Cmd+Shift+D',
    projectQuickOpen: 'Cmd+Shift+P',
    kanbanView: 'Cmd+Shift+K',
    newWorktree: 'Cmd+Alt+W',
    aiModels: 'Cmd+,',
    minimize: 'Cmd+M'
  },

  // Developer Menu
  developer: {
    refreshFileTree: 'Cmd+Shift+F5'
  }
} as const;

/**
 * Get platform-specific shortcut display (for renderer).
 * On macOS, modifiers are shown without + separators (e.g., ⌘⇧A not ⌘+⇧+A).
 * On Windows/Linux, Cmd is rewritten to Ctrl and Option to Alt, with the
 * familiar `+` joiner kept (e.g., Ctrl+Shift+A).
 *
 * The `isMac` parameter defaults to a `navigator.platform` check so renderer
 * call sites get the right output automatically. Pass it explicitly in tests
 * to avoid monkey-patching `navigator`.
 */
export function getShortcutDisplay(
  shortcut: string,
  isMac: boolean = typeof navigator !== 'undefined'
    && navigator.platform.startsWith('Mac'),
): string {
  if (!isMac) {
    return shortcut.replace('Cmd', 'Ctrl').replace('Option', 'Alt');
  }
  return shortcut
    .replace('Cmd', '⌘')
    .replace('Ctrl', '⌃')
    .replace('Option', '⌥')
    .replace('Alt', '⌥')
    .replace('Shift', '⇧')
    .replace(/\+/g, '');
}

/**
 * Get Electron accelerator format (for main process)
 */
export function getElectronAccelerator(shortcut: string): string {
  return shortcut.replace('Cmd', 'CmdOrCtrl');
}
