import { BrowserWindow, type WebContents } from 'electron';
import { basename } from 'path';
import { writeFileAtomicSync } from './safeFileWrite';
import { windowStates, getWindowId, findWindowByFilePath } from '../window/WindowManager';
import { addToRecentItems } from '../utils/store';

export interface PendingFileOpen {
    requestId: number;
    path: string;
    workspacePath?: string;
}

// First paint is not editor readiness (#1864). Retain requests across renderer
// startup/reload until the receiving editor selects the tab or reports failure.
const pendingFileOpens = new WeakMap<WebContents, PendingFileOpen[]>();
let nextFileOpenId = 0;

export function getPendingFileOpens(sender: WebContents, workspacePath: string): PendingFileOpen[] {
    if (!workspacePath) throw new Error('Pending file opens require workspacePath');
    return (pendingFileOpens.get(sender) ?? []).filter(request => !request.workspacePath || request.workspacePath === workspacePath);
}

export function acknowledgeFileOpen(sender: WebContents, workspacePath: string, requestId: number): void {
    if (!workspacePath || !Number.isSafeInteger(requestId)) throw new Error('File open acknowledgement requires workspacePath and requestId');
    const requests = pendingFileOpens.get(sender);
    if (!requests) return;
    const index = requests.findIndex(request => request.requestId === requestId && (!request.workspacePath || request.workspacePath === workspacePath));
    if (index !== -1) requests.splice(index, 1);
}

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

        // Captured once: the BrowserWindow.webContents getter throws after the
        // window is destroyed, which is when the 'destroyed' handler runs.
        const contents = window.webContents;
        let requests = pendingFileOpens.get(contents);
        if (!requests) {
            requests = [];
            pendingFileOpens.set(contents, requests);
            contents.once('destroyed', () => pendingFileOpens.delete(contents));
        }
        const request: PendingFileOpen = {
            requestId: ++nextFileOpenId,
            path: filePath,
            workspacePath: state?.activeWorkspacePath ?? state?.workspacePath ?? undefined,
        };
        requests.push(request);
        // This is a notification, not proof of delivery. A newly mounted
        // renderer also pulls the queue, closing the subscribe/startup race.
        contents.send('open-document', request);

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
