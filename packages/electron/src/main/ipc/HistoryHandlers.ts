import * as fs from 'fs/promises';
import * as path from 'path';
import { HistoryManager } from '../HistoryManager';
import { safeHandle, safeOn } from '../utils/ipcRegistry';
import { getAppSetting } from '../utils/store';
import { BrowserWindow, type IpcMainInvokeEvent } from 'electron';
import { getWindowId, windowStates } from '../window/WindowManager';
import { dirtyEditorRegistry } from '../services/DirtyEditorRegistry';
import { ProjectFileService } from '../services/ProjectFileService';
import type { ProjectFileEdit, ProjectFileWriteReceipt } from '@nimbalyst/runtime';

// Initialize history manager
const historyManager = new HistoryManager();
const projectFiles = new ProjectFileService(
    historyManager,
    (filePath) => dirtyEditorRegistry.isDirty(filePath),
);

function getAuthorizedWorkspaceRoot(event: IpcMainInvokeEvent): string {
    const window = BrowserWindow.fromWebContents(event.sender);
    if (!window) throw new Error('Project file access requires a workspace window.');
    const windowId = getWindowId(window);
    const workspaceRoot = windowId === null ? undefined : windowStates.get(windowId)?.workspacePath;
    if (!workspaceRoot) throw new Error('Project file access is unavailable outside a workspace.');
    return workspaceRoot;
}

function broadcastProjectFileWrite(workspaceRoot: string, receipt: ProjectFileWriteReceipt): void {
    for (const window of BrowserWindow.getAllWindows()) {
        const windowId = getWindowId(window);
        const candidateRoot = windowId === null ? undefined : windowStates.get(windowId)?.workspacePath;
        if (!window.isDestroyed() && candidateRoot && path.resolve(candidateRoot) === path.resolve(workspaceRoot)) {
            window.webContents.send('project-fs:changed', receipt);
        }
    }
}

export async function registerHistoryHandlers() {
    // Configure history manager with user settings before initialization
    const maxAgeDays = getAppSetting<number>('historyMaxAgeDays');
    const maxSnapshots = getAppSetting<number>('historyMaxSnapshots');
    historyManager.configure({ maxAgeDays, maxSnapshots });

    // Initialize history manager
    await historyManager.initialize();

    safeHandle('project-fs:read', async (event, paths: string[]) => {
        return projectFiles.read(getAuthorizedWorkspaceRoot(event), paths);
    });

    safeHandle('project-fs:write', async (event, edit: ProjectFileEdit) => {
        const workspaceRoot = getAuthorizedWorkspaceRoot(event);
        const receipt = await projectFiles.write(workspaceRoot, edit);
        broadcastProjectFileWrite(workspaceRoot, receipt);
        return receipt;
    });

    // Create snapshot
    safeHandle('history:create-snapshot', async (event, filePath: string, state: string, type: string, description?: string) => {
        try {
            await historyManager.createSnapshot(filePath, state, type as any, description);
        } catch (error) {
            console.error('[HistoryHandlers] Failed to create snapshot:', error);
            throw error;
        }
    });

    // List snapshots
    safeHandle('history:list-snapshots', async (event, filePath: string) => {
        return await historyManager.listSnapshots(filePath);
    });

    // Load snapshot
    safeHandle('history:load-snapshot', async (event, filePath: string, timestamp: string) => {
        return await historyManager.loadSnapshot(filePath, timestamp);
    });

    // Delete snapshot
    safeHandle('history:delete-snapshot', async (event, filePath: string, timestamp: string) => {
        await historyManager.deleteSnapshot(filePath, timestamp);
    });

    // PHASE 4/5: Get pending AI edit tags
    safeHandle('history:get-pending-tags', async (event, filePath?: string) => {
        return await historyManager.getPendingTags(filePath);
    });

    // PHASE 5: Create tag (for testing)
    safeHandle('history:create-tag', async (event, workspacePath: string, filePath: string, tagId: string, content: string, sessionId: string, toolUseId: string) => {
        await historyManager.createTag(workspacePath, filePath, tagId, content, sessionId, toolUseId);
    });

    // PHASE 5: Get tag (for testing)
    safeHandle('history:get-tag', async (event, filePath: string, tagId: string) => {
        return await historyManager.getTag(filePath, tagId);
    });

    // PHASE 5: Update tag status
    safeHandle('history:update-tag-status', async (event, filePath: string, tagId: string, status: string, workspacePath?: string) => {
        await historyManager.updateTagStatus(filePath, tagId, status as any, workspacePath);
    });

    // PHASE 5: Update tag content
    safeHandle('history:update-tag-content', async (event, filePath: string, tagId: string, content: string) => {
        await historyManager.updateTagContent(filePath, tagId, content);
    });

    // Incremental approval tags
    safeHandle('history:create-incremental-approval-tag', async (
        event,
        filePath: string,
        content: string,
        sessionId: string,
        metadata?: { acceptedGroups?: string[], rejectedGroups?: string[], remainingGroups?: string[] }
    ) => {
        return await historyManager.createIncrementalApprovalTag(filePath, content, sessionId, metadata);
    });

    safeHandle('history:get-diff-baseline', async (event, filePath: string) => {
        return await historyManager.getDiffBaseline(filePath);
    });

    // Get count of files with pending-review tags in a workspace
    safeHandle('history:get-pending-count', async (event, workspacePath: string) => {
        return await historyManager.getPendingCount(workspacePath);
    });

    // Get count of files with pending-review tags for a specific session
    safeHandle('history:get-pending-count-for-session', async (event, workspacePath: string, sessionId: string) => {
        return await historyManager.getPendingCountForSession(workspacePath, sessionId);
    });

    // Get list of files with pending-review tags for a specific session
    safeHandle('history:get-pending-files-for-session', async (event, workspacePath: string, sessionId: string) => {
        return await historyManager.getPendingFilesForSession(workspacePath, sessionId);
    });

    // Clear all pending tags in a workspace
    safeHandle('history:clear-all-pending', async (event, workspacePath: string) => {
        return await historyManager.clearAllPending(workspacePath);
    });

    // Clear pending tags for a specific session
    safeHandle('history:clear-pending-for-session', async (event, workspacePath: string, sessionId: string) => {
        return await historyManager.clearPendingForSession(workspacePath, sessionId);
    });

    // Debug helper: get all tags with full metadata
    safeHandle('history:get-all-tags', async (event, filePath: string) => {
        const { database } = await import('../database/PGLiteDatabaseWorker');

        const result = await database.query(`
            SELECT metadata, timestamp
            FROM document_history
            WHERE file_path = $1
            ORDER BY timestamp DESC
        `, [filePath]);

        return result.rows.map((row: any) => {
            // Parse metadata if it's a string (PGLite returns JSONB as strings)
            const metadata = typeof row.metadata === 'string' ? JSON.parse(row.metadata) : row.metadata;
            return {
                ...metadata,
                timestamp: row.timestamp
            };
        });
    });

    // Mark all incremental-approval tags for a session as reviewed
    safeHandle('history:mark-incremental-tags-reviewed', async (event, filePath: string, sessionId: string) => {
        const { database } = await import('../database/PGLiteDatabaseWorker');
        const now = Date.now();

        await database.query(`
            UPDATE document_history
            SET metadata = jsonb_set(
                  jsonb_set(metadata, '{status}', to_jsonb('reviewed'::text)),
                  '{updatedAt}', to_jsonb($1::bigint)
                )
            WHERE file_path = $2
              AND metadata->>'type' = 'incremental-approval'
              AND metadata->>'sessionId' = $3
        `, [now, filePath, sessionId]);
    });

    // List all files with history in a workspace
    safeHandle('history:list-workspace-files', async (event, workspacePath: string) => {
        return await historyManager.listWorkspaceFiles(workspacePath);
    });

    // Check which files exist on disk
    safeHandle('history:check-files-exist', async (event, filePaths: string[]) => {
        const results: Record<string, boolean> = {};
        await Promise.all(filePaths.map(async (filePath) => {
            try {
                await fs.access(filePath);
                results[filePath] = true;
            } catch {
                results[filePath] = false;
            }
        }));
        return results;
    });

    // Restore a deleted file from history
    safeHandle('history:restore-deleted-file', async (event, filePath: string, timestamp: string) => {
        try {
            // Load the snapshot content
            const content = await historyManager.loadSnapshot(filePath, timestamp);

            // Ensure parent directory exists
            const dirPath = path.dirname(filePath);
            await fs.mkdir(dirPath, { recursive: true });

            // Write the file
            await fs.writeFile(filePath, content, 'utf-8');

            return { success: true };
        } catch (error: any) {
            console.error('[HistoryHandlers] Failed to restore deleted file:', error);
            return { success: false, error: error.message };
        }
    });

    // Batch restore multiple deleted files to their most recent versions
    safeHandle('history:batch-restore-deleted-files', async (event, filePaths: string[]) => {
        const results: { path: string; success: boolean; error?: string }[] = [];

        for (const filePath of filePaths) {
            try {
                // Get the most recent snapshot for this file
                const snapshots = await historyManager.listSnapshots(filePath);
                if (snapshots.length === 0) {
                    results.push({ path: filePath, success: false, error: 'No snapshots found' });
                    continue;
                }

                // Load the most recent snapshot (first in list, sorted by timestamp DESC)
                const latestSnapshot = snapshots[0];
                const content = await historyManager.loadSnapshot(filePath, latestSnapshot.timestamp);

                // Ensure parent directory exists
                const dirPath = path.dirname(filePath);
                await fs.mkdir(dirPath, { recursive: true });

                // Write the file
                await fs.writeFile(filePath, content, 'utf-8');

                results.push({ path: filePath, success: true });
            } catch (error: any) {
                console.error('[HistoryHandlers] Failed to restore file:', filePath, error);
                results.push({ path: filePath, success: false, error: error.message });
            }
        }

        return results;
    });
}

export { historyManager };
