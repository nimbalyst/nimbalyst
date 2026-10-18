import { BrowserWindow } from 'electron';
import { basename } from 'path';
import { writeFileAtomicSync } from './safeFileWrite';
import { windowStates, getWindowId, findWindowByFilePath } from '../window/WindowManager';
import { addToRecentItems } from '../utils/store';

// Function to open a file in a window - sends open-document event to renderer
// which triggers handleWorkspaceFileSelect to load content and create tab
export function loadFileIntoWindow(window: BrowserWindow, filePath: string) {
    try {
        const windowId = getWindowId(window);
        if (windowId === null) {
            console.error('[LOAD_FILE] Failed to find custom window ID');
            return;
        }
        const state = windowStates.get(windowId);

        if (state) {
            state.filePath = filePath;
            state.documentEdited = false;
        } else {
            console.error('[LOAD_FILE] No window state found for window ID:', windowId);
        }

        // Send open-document event - renderer handles content loading via switchWorkspaceFile
        window.webContents.send('open-document', { path: filePath });

        // Set represented filename for macOS
        if (process.platform === 'darwin') {
            window.setRepresentedFilename(filePath);
        }

        // Add to recent documents
        addToRecentItems('documents', filePath, basename(filePath));

    } catch (error) {
        console.error('[LOAD_FILE] Error loading file from OS:', error);
    }
}

// Re-send a file the OS asked for again to the window that last loaded it. state.filePath
// is the last file loaded into a new tab in that window, not the active tab: switching or
// closing tabs never updates it. The renderer selects the tab, or reopens it if it was closed.
// Returns false when no window has loaded the file, so the caller routes it by workspace.
export function reloadIntoWindowWithFile(filePath: string): boolean {
    const existingWindow = findWindowByFilePath(filePath);
    if (!existingWindow) {
        return false;
    }
    loadFileIntoWindow(existingWindow, filePath);
    return true;
}

// Save file. Atomic because a crash during a plain writeFileSync leaves the
// user's file at 0 bytes -- see safeFileWrite.ts and GitHub #647.
export function saveFile(filePath: string, content: string): void {
    writeFileAtomicSync(filePath, content);
}
