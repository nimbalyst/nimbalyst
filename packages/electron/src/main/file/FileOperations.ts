import { BrowserWindow } from 'electron';
import { writeFileSync } from 'fs';
import { basename } from 'path';
import { windowStates, getWindowId } from '../window/WindowManager';
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

// Save file
export function saveFile(filePath: string, content: string): void {
    writeFileSync(filePath, content, 'utf-8');
}
