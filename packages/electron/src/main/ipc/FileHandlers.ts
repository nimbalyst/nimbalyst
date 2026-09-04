import { dialog, BrowserWindow, app } from 'electron';
import { safeHandle } from '../utils/ipcRegistry';
import { readFileSync, existsSync, mkdirSync, writeFileSync } from 'fs';
import { basename, join, dirname, extname } from 'path';
import { windowStates, savingWindows, recentlyDeletedFiles, findWindowByFilePath, createWindow, getWindowId, windows, documentServices } from '../window/WindowManager';
import { loadFileIntoWindow, saveFile } from '../file/FileOperations';
import { shouldBlockEmptyOverwrite, wouldDiscardUnseenContent, writeRecoverySnapshot } from '../file/safeFileWrite';
import { openFileWithDialog, openFile } from '../file/FileOpener';
import { startFileWatcher, stopFileWatcher } from '../file/FileWatcher';
import { AUTOSAVE_DELAY } from '../utils/constants';
import { addWorkspaceRecentFile } from '../utils/store';
import { logger } from '../utils/logger';
import { homedir } from 'os';
import { AnalyticsService } from '../services/analytics/AnalyticsService';
import { isPathInWorkspace, getRelativeWorkspacePath } from '../utils/workspaceDetection';
import { SessionFileWatcher } from '../file/SessionFileWatcher';
import { addGitignoreBypass, removeGitignoreBypass } from '../file/WorkspaceEventBus';
import { pushFileToIndex } from '../services/DocSyncService';
import { pushNewDocumentToSync } from '../file/WorkspaceWatcher';
import { getDialogDefaultPath, rememberDialogSelection } from '../utils/dialogPaths';
import { resolveClaudeConfigDir } from '@nimbalyst/runtime/ai/server/providers/claudeCode/claudeConfigDir';
import {
    FileSaveFailureTelemetryDeduper,
    classifyFileSaveError,
    getFileSaveSourceAnalytics,
    normalizeFileSaveSource,
    type FileSaveSource,
} from './fileSaveErrors';

// Helper function to get file type from extension
function getFileType(filePath: string): string {
    const ext = extname(filePath).toLowerCase();
    const typeMap: Record<string, string> = {
        '.md': 'markdown',
        '.markdown': 'markdown',
        '.txt': 'text',
        '.json': 'json',
        '.js': 'javascript',
        '.ts': 'typescript',
        '.tsx': 'typescript',
        '.jsx': 'javascript'
    };
    return typeMap[ext] || 'other';
}

// getWordCountCategory / hasFrontmatter lived here to build the `file_saved`
// payload. Both went with that event -- they had no other caller, and the word
// count in particular walked the whole document on every autosave.

export function registerFileHandlers() {
    const analytics = AnalyticsService.getInstance();
    const saveFailureTelemetry = new FileSaveFailureTelemetryDeduper();

    // Generic file dialog for extensions to select files
    // Returns the file path (not content) so extensions can load files themselves
    safeHandle('dialog:openFile', async (event, options?: {
        title?: string;
        buttonLabel?: string;
        filters?: Array<{ name: string; extensions: string[] }>;
        defaultPath?: string;
    }) => {
        const window = BrowserWindow.fromWebContents(event.sender);
        const dialogOptions: Electron.OpenDialogOptions = {
            title: options?.title || 'Select File',
            buttonLabel: options?.buttonLabel || 'Open',
            properties: ['openFile'],
            filters: options?.filters,
            defaultPath: getDialogDefaultPath({ window, explicitPath: options?.defaultPath }),
        };
        const result = window
            ? await dialog.showOpenDialog(window, dialogOptions)
            : await dialog.showOpenDialog(dialogOptions);

        if (!result.canceled) {
            rememberDialogSelection(result.filePaths[0], 'file');
        }

        return result;
    });

    // Open file dialog - uses unified FileOpener API
    safeHandle('open-file', async (event) => {
        const window = BrowserWindow.fromWebContents(event.sender);
        if (!window) return null;

        try {
            const result = await openFileWithDialog(window);
            if (!result) return null;

            return {
                filePath: result.filePath,
                content: result.content
            };
        } catch (error) {
            console.error('[FileHandlers] Failed to open file:', error);
            return null;
        }
    });

    // Save file
    safeHandle('save-file', async (
        event,
        content: string,
        specificFilePath: string,
        lastKnownContent?: string,
        requestedSaveSource?: FileSaveSource,
    ) => {
        const window = BrowserWindow.fromWebContents(event.sender);
        if (!window) {
            console.error('[SAVE] ✗ No window found for event sender');
            return null;
        }

        const windowId = getWindowId(window);
        if (windowId === null) {
            console.error('[FileHandlers] Failed to find custom window ID');
            return null;
        }
        const state = windowStates.get(windowId);
        // ALWAYS use the specificFilePath provided
        const filePath = specificFilePath;
        const saveSource = normalizeFileSaveSource(requestedSaveSource);
        const saveSourceAnalytics = getFileSaveSourceAnalytics(saveSource);

        // console.log('[SAVE] save-file handler called at', new Date().toISOString(), 'for path:', filePath);

        try {
            if (!filePath) {
                console.error('[SAVE] ✗ No file path in window state!');
                console.error('[SAVE] State details:', {
                    stateExists: !!state,
                    stateKeys: state ? Object.keys(state) : [],
                    windowStatesSize: windowStates.size
                });
                return null;
            }

            // Don't save to files that were just deleted via the UI or
            // detected-deleted by the watcher. While the path is tracked in
            // recentlyDeletedFiles, we refuse to write -- this protects
            // against autosave from a stale buffer overwriting a file that
            // the user deleted (or that was deleted then recreated by an AI
            // session). The lifecycle entry is cleared once the renderer
            // signals (via editor:released-deleted-path) that it has fully
            // released the path AND observed a fresh load.
            if (recentlyDeletedFiles.has(filePath)) {
                console.log('[SAVE] Refusing save to recently-deleted file:', filePath);
                // If the file exists on disk (e.g. AI recreated it after the
                // delete), surface its current contents as a conflict so the
                // renderer can show a non-blocking banner and preserve the
                // user's in-memory buffer. The renderer must NOT treat this
                // as success and clear its dirty flag.
                if (existsSync(filePath)) {
                    let diskContent = '';
                    try {
                        diskContent = readFileSync(filePath, 'utf-8');
                    } catch (err) {
                        console.error('[SAVE] Failed to read recently-deleted file:', err);
                    }
                    return {
                        success: false,
                        conflict: true,
                        filePath,
                        diskContent,
                    };
                }
                // File was deleted and not recreated. Tell the renderer the
                // save was blocked due to deletion so it can keep dirty state.
                return { success: false, deleted: true, filePath };
            }

            // Check for conflicts with external changes before saving
            if (lastKnownContent !== undefined && existsSync(filePath)) {
                try {
                    const currentDiskContent = readFileSync(filePath, 'utf-8');
                    if (currentDiskContent !== lastKnownContent) {
                        console.log('[SAVE] ⚠ Conflict detected - file changed on disk since last load');

                        return {
                            success: false,
                            conflict: true,
                            filePath,
                            diskContent: currentDiskContent
                        };
                    }
                } catch (readError) {
                    console.error('[SAVE] Failed to check for conflicts:', readError);
                    // Continue with save if we can't read the file
                }
            }

            // Don't recreate a file that was deleted from disk
            if (!existsSync(filePath)) {
                logger.main.info(`[SAVE] File no longer exists on disk, skipping save: ${filePath}`);
                return { success: false, deleted: true, filePath };
            }

            // An editor that never finished mounting serializes to an empty
            // buffer, and the conflict check above still passes because disk
            // matches last-known. Without this the autosave that follows
            // cleanly writes 0 bytes over the user's file (GitHub #647).
            // Only reads disk when the incoming content is already blank.
            if (content.trim().length === 0) {
                let diskContent = '';
                try {
                    diskContent = readFileSync(filePath, 'utf-8');
                } catch (readError) {
                    console.error('[SAVE] Failed to read file for empty-write check:', readError);
                }
                if (shouldBlockEmptyOverwrite({ content, diskContent, source: saveSource })) {
                    logger.main.warn(`[SAVE] Refused empty autosave over non-empty file: ${filePath}`);
                    return { success: false, errorType: 'empty_write_blocked', filePath };
                }
            }

            // #3684: a write with no baseline skipped the conflict check above,
            // so nothing established that this writer ever saw what is on disk.
            // Snapshot it before it is gone. Emitted *before* the destructive
            // act, per .claude/rules/destructive-data-paths.md -- a crash
            // mid-write must not take the evidence with it.
            if (existsSync(filePath)) {
                try {
                    const diskContent = readFileSync(filePath, 'utf-8');
                    if (wouldDiscardUnseenContent({ content, diskContent, lastKnownContent })) {
                        const snapshotPath = writeRecoverySnapshot(filePath, diskContent, Date.now());
                        logger.main.warn(
                            `[SAVE] Unconditional overwrite of ${filePath}; discarded content saved to ${snapshotPath}`,
                        );
                    }
                } catch (snapshotError) {
                    // Best effort -- never block the write the user asked for.
                    logger.main.error('[SAVE] Failed to snapshot discarded content:', snapshotError);
                }
            }

            // Mark that we're saving to prevent file watcher from reacting
            savingWindows.add(windowId);
            SessionFileWatcher.markEditorSave(filePath);

            saveFile(filePath, content);

            if (state) {
                state.documentEdited = false; // Reset dirty state after save
            }

            // Refresh metadata and tracker items cache immediately after save if in workspace mode
            if (state?.workspacePath) {
                const workspacePath = state.workspacePath; // Store in local variable for closure
                const documentService = documentServices.get(workspacePath);
                // console.log('[SAVE] Workspace mode:', workspacePath, 'documentService exists:', !!documentService);
                if (documentService) {
                    // Only refresh if file is actually in the workspace (not in a worktree)
                    // Use proper path boundary checking to avoid matching snake_worktrees when workspace is snake
                    const relativeFilePath = getRelativeWorkspacePath(filePath, workspacePath);
                    if (relativeFilePath !== null) {
                        // Add a small delay to ensure file is fully written before reading
                        setTimeout(async () => {
                            try {
                                // refreshFileMetadata already calls
                                // updateTrackerItemsCache for the same path;
                                // calling it again here just doubled the
                                // tracker_items queries on every save.
                                await documentService.refreshFileMetadata(filePath);
                            } catch (err) {
                                console.error('[SAVE] Failed to refresh metadata/tracker items:', err);
                            }
                        }, 50);
                    }
                }
            } else {
                console.log('[SAVE] Not in workspace mode, state:', state);
            }

            // Clear the saving flag after a delay to ensure the file watcher doesn't react
            setTimeout(() => {
                savingWindows.delete(windowId);
            }, AUTOSAVE_DELAY);

            // `file_saved` was removed here. It fired on every save including
            // debounced autosave -- 650,472 events in 30 days, the second-largest
            // event in the product -- and nothing consumed the count. Throttling
            // it would only have produced an "active editing" proxy that also had
            // no consumer. `file_save_failed` below is the signal worth keeping.
            saveFailureTelemetry.markSuccess(filePath);

            // Push file index update for .md files in sync-enabled projects
            if (filePath.endsWith('.md') && state?.workspacePath) {
              pushFileToIndex(filePath, state.workspacePath).catch(() => {});
            }

            return { success: true, filePath };
        } catch (error) {
            console.error('[SAVE] ✗ Error saving file:', error);
            savingWindows.delete(windowId); // Clean up on error

            const classifiedError = classifyFileSaveError(error);
            if (saveFailureTelemetry.shouldReport(filePath, saveSource, classifiedError.errorCode)) {
                analytics.sendEvent('file_save_failed', {
                    ...classifiedError,
                    fileType: filePath ? getFileType(filePath) : 'unknown',
                    isAutoSave: saveSourceAnalytics.isAutoSave,
                });
            }

            return {
                success: false,
                filePath,
                ...classifiedError,
            };
        }
    });

    // Save file as
    safeHandle('save-file-as', async (event, content: string) => {
        const window = BrowserWindow.fromWebContents(event.sender);
        if (!window) return null;

        const windowId = getWindowId(window);
        if (windowId === null) {
            console.error('[FileHandlers] Failed to find custom window ID');
            return null;
        }
        const state = windowStates.get(windowId);

        try {
            const result = await dialog.showSaveDialog(window, {
                filters: [
                    { name: 'Markdown Files', extensions: ['md'] },
                    { name: 'Text Files', extensions: ['txt'] },
                    { name: 'All Files', extensions: ['*'] }
                ],
                // An already-saved doc reopens at its own path; a new one lands
                // in the active workspace as untitled.md.
                defaultPath: state?.filePath
                    ? getDialogDefaultPath({ window, explicitPath: state.filePath })
                    : getDialogDefaultPath({ window, suggestedName: 'untitled.md' })
            });

            if (!result.canceled) {
                rememberDialogSelection(result.filePath, 'file');
            }

            if (!result.canceled && result.filePath) {
                const filePath = result.filePath;

                // Mark that we're saving to prevent file watcher from reacting
                savingWindows.add(windowId);
                SessionFileWatcher.markEditorSave(filePath);

                if (state) {
                    state.filePath = filePath;
                    state.documentEdited = false;
                }

                saveFile(filePath, content);

                // Clear the saving flag after a delay
                setTimeout(() => {
                    savingWindows.delete(windowId);
                    // console.log('[SAVE_AS] Cleared saving flag for window:', windowId);
                }, AUTOSAVE_DELAY);

                // Set represented filename for macOS
                if (process.platform === 'darwin') {
                    window.setRepresentedFilename(filePath);
                }

                return { success: true, filePath };
            }

            return null;
        } catch (error) {
            console.error('Error in save-file-as:', error);

            const classifiedError = classifyFileSaveError(error);
            // Track save failure
            analytics.sendEvent('file_save_failed', {
                ...classifiedError,
                fileType: state?.filePath ? getFileType(state.filePath) : 'unknown',
                isAutoSave: false
            });

            return null;
        }
    });

    // Show error dialog
    safeHandle('show-error-dialog', async (event, title: string, message: string) => {
        const window = BrowserWindow.fromWebContents(event.sender);
        if (!window) return;

        dialog.showErrorBox(title, message);
    });

    // Update current file path from renderer (for drag-drop and file creation)
    safeHandle('set-current-file', async (event, filePath: string | null) => {
        const window = BrowserWindow.fromWebContents(event.sender);
        if (!window) {
            console.error('[SET_FILE] ✗ No window found for event sender');
            return { success: false, error: 'No window found' };
        }

        const windowId = getWindowId(window);
        if (windowId === null) {
            console.error('[SET_FILE] Failed to find custom window ID');
            return { success: false, error: 'Window ID not found' };
        }
        let state = windowStates.get(windowId);

        // Create state if it doesn't exist (can happen with new windows)
        if (!state) {
            console.log('[SET_FILE] Creating new window state for window:', windowId);
            state = {
                mode: 'document',
                filePath: null,
                documentEdited: false,
                workspacePath: null
            };
            windowStates.set(windowId, state);
        }

        // Only proceed if the file path actually changed
        if (state.filePath === filePath) {
            // No change, skip everything
            return { success: true };
        }

        // console.log('[SET_FILE] set-current-file called at', new Date().toISOString());
        // console.log('[SET_FILE] Window ID:', windowId);
        // console.log('[SET_FILE] New file path:', filePath);
        // console.log('[SET_FILE] State exists:', !!state);

        // Update the file path (for window title, session restore, etc.)
        state.filePath = filePath;

        // NOTE: We DO NOT start/stop file watchers here anymore!
        // In workspace mode with tabs, each TabEditor manages its own watcher lifecycle.
        // Stopping watchers here was breaking inactive tab file watching.

        // Update represented filename for macOS
        if (filePath && process.platform === 'darwin') {
            window.setRepresentedFilename(filePath);
        }

        return { success: true };
    });

    // Create document for AI tools
    safeHandle('create-document', async (event, relativePath: string, initialContent: string, overwriteIfExists: boolean = false) => {
        const window = BrowserWindow.fromWebContents(event.sender);
        if (!window) {
            console.error('[CREATE_DOC] No window found for event sender');
            return { success: false, error: 'No window found' };
        }

        const windowId = getWindowId(window);
        if (windowId === null) {
            console.error('[CREATE_DOC] Failed to find custom window ID');
            return { success: false, error: 'Window ID not found' };
        }

        const state = windowStates.get(windowId);
        if (!state || !state.workspacePath) {
            console.error('[CREATE_DOC] No workspace path in window state');
            return { success: false, error: 'No workspace open' };
        }

        try {
            // Build the absolute path
            const absolutePath = join(state.workspacePath, relativePath);
            const directory = dirname(absolutePath);

            console.log('[CREATE_DOC] Creating document:', absolutePath);

            // Ensure the directory exists
            if (!existsSync(directory)) {
                mkdirSync(directory, { recursive: true });
                console.log('[CREATE_DOC] Created directory:', directory);
            }

            // Check if file already exists
            if (existsSync(absolutePath)) {
                console.log('[CREATE_DOC] File already exists:', absolutePath);
                if (!overwriteIfExists) {
                  return {
                    success: false,
                    error: 'File already exists',
                    filePath: absolutePath
                  };
                }
                console.log('[CREATE_DOC] Overwriting existing file');
            }

            // Write the initial content
            writeFileSync(absolutePath, initialContent || '', 'utf-8');
            console.log('[CREATE_DOC] File created successfully');

            // Track file creation
            analytics.sendEvent('file_created', {
                creationType: 'ai_tool',
                fileType: getFileType(absolutePath)
            });

            // Add to recent files
            if (state.workspacePath) {
                addWorkspaceRecentFile(state.workspacePath, absolutePath);
            }

            // Sync the new .md doc to mobile immediately (index + content) rather
            // than waiting on the file watcher to notice the create. save-file
            // already pushes to the index; createDocument did neither, so a new
            // design doc wasn't readable on mobile until a watcher event or restart.
            if (absolutePath.endsWith('.md') && state.workspacePath) {
                pushFileToIndex(absolutePath, state.workspacePath).catch(() => {});
                pushNewDocumentToSync(absolutePath, state.workspacePath);
            }

            return {
                success: true,
                filePath: absolutePath
            };
        } catch (error) {
            console.error('[CREATE_DOC] Error creating document:', error);
            return {
                success: false,
                error: error instanceof Error ? error.message : 'Unknown error'
            };
        }
    });

    // Write to the user-level Claude config directory
    safeHandle('write-global-claude-file', async (event, relativePath: string, content: string) => {
        try {
            const claudeDir = resolveClaudeConfigDir();
            const absolutePath = join(claudeDir, relativePath);
            const directory = dirname(absolutePath);

            console.log('[WRITE_GLOBAL] Writing to global .claude:', absolutePath);

            // Ensure the directory exists
            if (!existsSync(directory)) {
                mkdirSync(directory, { recursive: true });
                console.log('[WRITE_GLOBAL] Created directory:', directory);
            }

            // Write the content (overwrites if exists)
            writeFileSync(absolutePath, content, 'utf-8');
            console.log('[WRITE_GLOBAL] File written successfully');

            return {
                success: true,
                filePath: absolutePath
            };
        } catch (error) {
            console.error('[WRITE_GLOBAL] Error writing file:', error);
            return {
                success: false,
                error: error instanceof Error ? error.message : 'Unknown error'
            };
        }
    });

    // Read from the user-level Claude config directory
    safeHandle('read-global-claude-file', async (event, relativePath: string) => {
        try {
            const claudeDir = resolveClaudeConfigDir();
            const absolutePath = join(claudeDir, relativePath);

            console.log('[READ_GLOBAL] Reading from global .claude:', absolutePath);

            if (!existsSync(absolutePath)) {
                return {
                    success: false,
                    error: 'File not found'
                };
            }

            const content = readFileSync(absolutePath, 'utf-8');
            console.log('[READ_GLOBAL] File read successfully');

            return {
                success: true,
                content,
                filePath: absolutePath
            };
        } catch (error) {
            console.error('[READ_GLOBAL] Error reading file:', error);
            return {
                success: false,
                error: error instanceof Error ? error.message : 'Unknown error'
            };
        }
    });

    // Append to CLAUDE.md memory files
    // Supports both user memory (~/.claude/CLAUDE.md) and project memory (<workspace>/CLAUDE.md)
    safeHandle('memory:append', async (event, { content, target, workspacePath }: { content: string; target: 'user' | 'project'; workspacePath?: string }) => {
        try {
            if (!content || !content.trim()) {
                return {
                    success: false,
                    error: 'Content cannot be empty'
                };
            }

            let memoryFilePath: string;

            if (target === 'user') {
                // User memory goes to <claude config dir>/CLAUDE.md
                const claudeDir = resolveClaudeConfigDir();
                memoryFilePath = join(claudeDir, 'CLAUDE.md');

                // Ensure the config directory exists
                if (!existsSync(claudeDir)) {
                    mkdirSync(claudeDir, { recursive: true });
                }
            } else {
                // Project memory goes to <workspace>/CLAUDE.md (at the repo root)
                if (!workspacePath) {
                    return {
                        success: false,
                        error: 'Workspace path is required for project memory'
                    };
                }

                memoryFilePath = join(workspacePath, 'CLAUDE.md');
            }

            // Read existing content if file exists
            let existingContent = '';
            if (existsSync(memoryFilePath)) {
                existingContent = readFileSync(memoryFilePath, 'utf-8');
            }

            // Append content with separator if file already has content
            const separator = existingContent.trim() ? '\n' : '';
            const formattedContent = `${existingContent.trim()}${separator}${content.trim()}\n`;

            // Write the updated content
            writeFileSync(memoryFilePath, formattedContent, 'utf-8');

            logger.ai.info(`[MEMORY] Appended to ${target} memory:`, memoryFilePath);

            return {
                success: true,
                filePath: memoryFilePath
            };
        } catch (error) {
            logger.ai.error('[MEMORY] Error appending to memory:', error);
            return {
                success: false,
                error: error instanceof Error ? error.message : 'Unknown error'
            };
        }
    });

    // Get the resolved path for a memory file
    safeHandle('memory:get-path', async (_event, { target, workspacePath }: { target: 'user' | 'project'; workspacePath?: string }) => {
        if (target === 'user') {
            return { filePath: join(resolveClaudeConfigDir(), 'CLAUDE.md') };
        } else {
            if (!workspacePath) return { filePath: null };
            return { filePath: join(workspacePath, 'CLAUDE.md') };
        }
    });

    // Start watching a file (when tab is opened)
    safeHandle('start-watching-file', async (event, filePath: string) => {
        const window = BrowserWindow.fromWebContents(event.sender);
        if (!window) {
            console.error('[START_WATCH] No window found');
            return { success: false };
        }

        if (!filePath || filePath.startsWith('virtual://')) {
            return { success: false };
        }

        try {
            // Register gitignore bypass so watcher events fire for open gitignored files
            const windowId = getWindowId(window);
            if (windowId !== null) {
                const state = windowStates.get(windowId);
                if (state?.workspacePath) {
                    addGitignoreBypass(state.workspacePath, filePath);
                }
            }

            // Wait for the watcher to be ready before returning
            await startFileWatcher(window, filePath);
            return { success: true };
        } catch (error) {
            logger.fileWatcher.error('[START_WATCH] Failed to start watcher:', error);
            return { success: false, error: String(error) };
        }
    });

    // Stop watching a specific file (when tab is closed)
    safeHandle('stop-watching-file', async (event, filePath: string) => {
        const window = BrowserWindow.fromWebContents(event.sender);
        if (!window) {
            console.error('[STOP_WATCH] No window found');
            return { success: false };
        }

        const windowId = getWindowId(window);
        if (windowId === null) {
            console.error('[STOP_WATCH] Failed to find custom window ID');
            return { success: false };
        }

        if (!filePath || filePath.startsWith('virtual://')) {
            return { success: false };
        }

        // Remove gitignore bypass when tab is closed
        const state = windowStates.get(windowId);
        if (state?.workspacePath) {
            removeGitignoreBypass(state.workspacePath, filePath);
        }

        return { success: true };
    });
}
