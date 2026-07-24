import { BrowserWindow } from 'electron';
import { windowStates } from '../window/WindowManager';
import { getFolderContents } from '../utils/FileTree';
import { checkFileForChanges } from './FileWatcher';
import * as workspaceEventBus from './WorkspaceEventBus';
import { basename } from 'path';

// Get global file watcher statistics
export function getGlobalFileWatcherStats() {
    const busStats = workspaceEventBus.getStats();

    const lines: string[] = [];
    lines.push('=== File Watcher Statistics (WorkspaceEventBus) ===');
    lines.push(`Type: ${busStats.type}`);
    lines.push(`Active workspaces: ${busStats.activeWorkspaces}`);

    if (busStats.workspaces.length > 0) {
        lines.push('\nWatched workspaces:');
        for (const ws of busStats.workspaces) {
            lines.push(`\n  ${ws.workspacePath}`);
            lines.push(`    Subscribers (${ws.subscriberCount}): ${ws.subscriberIds.join(', ')}`);
        }
    } else {
        lines.push('\nNo active workspace watchers');
    }

    // Add performance metrics
    lines.push('\n=== Performance Metrics ===');
    const memUsage = process.memoryUsage();
    lines.push(`Memory (RSS): ${Math.round(memUsage.rss / 1024 / 1024)}MB`);
    lines.push(`Memory (Heap Used): ${Math.round(memUsage.heapUsed / 1024 / 1024)}MB`);
    lines.push(`Memory (Heap Total): ${Math.round(memUsage.heapTotal / 1024 / 1024)}MB`);

    const handles = (process as any)._getActiveHandles?.()?.length || 'N/A';
    lines.push(`Active handles: ${handles}`);

    return lines.join('\n');
}

// Get file watcher status for debugging
export function getFileWatcherStatus(windowId: number): string {
    const state = windowStates.get(windowId);
    const lines: string[] = [];

    lines.push('=== Window State ===');
    if (state) {
        lines.push(`Mode: ${state.mode}`);
        lines.push(`File Path: ${state.filePath || 'None'}`);
        lines.push(`Workspace Path: ${state.workspacePath || 'None'}`);
        lines.push(`Document Edited: ${state.documentEdited}`);
    } else {
        lines.push('No window state found');
    }

    const busStats = workspaceEventBus.getStats();
    lines.push('\n=== Workspace Event Bus ===');
    lines.push(`Type: ${busStats.type}`);
    lines.push(`Active workspaces: ${busStats.activeWorkspaces}`);

    for (const ws of busStats.workspaces) {
        lines.push(`\n  ${ws.workspacePath}`);
        lines.push(`    Subscribers: ${ws.subscriberIds.join(', ')}`);
    }

    lines.push('\n=== System Info ===');
    lines.push(`Platform: ${process.platform}`);
    lines.push(`Node Version: ${process.version}`);
    lines.push(`Electron Version: ${process.versions.electron}`);

    return lines.join('\n');
}

// Force refresh the workspace file tree
export async function refreshWorkspaceFileTree(window: BrowserWindow) {
    const windowId = window.id;
    const state = windowStates.get(windowId);

    if (state?.mode === 'workspace' && state.workspacePath) {
        console.log('[DEBUG] Force refreshing file tree for:', state.workspacePath);

        // Get fresh file tree
        const fileTree = await getFolderContents(state.workspacePath);

        // Send to renderer
        window.webContents.send('workspace-file-tree-updated', { fileTree });

        // Also trigger a re-watch to ensure watchers are properly set up
        try {
            const { restartWorkspaceWatcher } = require('./WorkspaceWatcher.ts');
            restartWorkspaceWatcher(window, state.workspacePath);
            console.log('[DEBUG] Workspace watcher restarted');
        } catch (error) {
            console.error('[DEBUG] Failed to restart workspace watcher:', error);
        }
    } else if (state?.filePath) {
        // For single file mode, trigger a reload check
        console.log('[DEBUG] Checking file for changes:', state.filePath);

        try {
            checkFileForChanges(window, state.filePath);
        } catch (error) {
            console.error('[DEBUG] Failed to check file changes:', error);
        }
    }
}
