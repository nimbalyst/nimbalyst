import { BrowserWindow } from 'electron';
import { basename } from 'path';
import { writeFileAtomicSync } from './safeFileWrite';
import { windowStates, getWindowId } from '../window/WindowManager';
import { addToRecentItems } from '../utils/store';

// Function to open a file in a window - sends open-document event to renderer
// which triggers handleWorkspaceFileSelect to load content and create tab.
// `reveal` (1-based line) rides along for deep links; the renderer's pending-
// reveal registry handles editors that are still mounting.
export function loadFileIntoWindow(window: BrowserWindow, filePath: string, reveal?: { line: number }) {
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
        window.webContents.send('open-document', { path: filePath, ...(reveal ?? {}) });

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

// Save file. Atomic because a crash during a plain writeFileSync leaves the
// user's file at 0 bytes -- see safeFileWrite.ts and GitHub #647.
export function saveFile(filePath: string, content: string): void {
    writeFileAtomicSync(filePath, content);
}
