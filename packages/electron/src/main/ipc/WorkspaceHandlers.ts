import { BrowserWindow, app, shell, clipboard } from 'electron';
import { readFileSync, readdirSync, statSync, existsSync, promises as fsPromises } from 'fs';
import * as fs from 'fs';
import { join, basename, dirname, extname } from 'path';
import * as path from 'path';
import { exec, execFile, spawn } from 'child_process';
import { promisify } from 'util';
import os from 'os';
import * as chardet from 'chardet';
import { AnalyticsService } from '../services/analytics/AnalyticsService';
import { openWorkspaceFile, openFile } from '../file/FileOpener';
import { fuzzyMatchPath } from '@nimbalyst/runtime';
import { getSyncId, removeFileFromIndex } from '../services/DocSyncService';

const { writeFile, mkdir, rename, unlink, rmdir, copyFile, readFile, rm, stat, cp } = fsPromises;

const execAsync = promisify(exec);
const execFileAsync = promisify(execFile);
import { windowStates, getWindowId, createWindow, markRecentlyDeleted, clearRecentlyDeleted } from '../window/WindowManager';
import { startFileWatcher, stopFileWatcher } from '../file/FileWatcher';
import { getFolderContents } from '../utils/FileTree';
import { RIPGREP_EXCLUDE_ARGS_ARRAY, QUICKOPEN_FILE_TYPE_ARGS } from '../utils/fileFilters';
import {
    getWorkspaceRecentFiles,
    addWorkspaceRecentFile,
    store,
    getWorkspaceState,
    updateWorkspaceState,
    getAppSetting
} from '../utils/store';
import { loadFileIntoWindow } from '../file/FileOperations';
import { safeHandle, safeOn } from '../utils/ipcRegistry';

/**
 * Deep merge utility for workspace state updates.
 * Recursively merges objects, replacing primitives and arrays.
 *
 * @param target - The target object to merge into
 * @param source - The source object to merge from
 */
function deepMerge(target: any, source: any): void {
    // console.log('[WorkspaceHandlers] deepMerge called with source:', JSON.stringify(source).substring(0, 300));
    for (const key in source) {
        if (source.hasOwnProperty(key)) {
            const sourceValue = source[key];
            const targetValue = target[key];

            // If both are plain objects, merge recursively
            if (
                sourceValue &&
                typeof sourceValue === 'object' &&
                !Array.isArray(sourceValue) &&
                targetValue &&
                typeof targetValue === 'object' &&
                !Array.isArray(targetValue)
            ) {
                deepMerge(targetValue, sourceValue);
            } else {
                // Otherwise, replace the value (primitives, arrays, null, etc.)
                target[key] = sourceValue;
            }
        }
    }
}

// Helper function to get file type from extension
function getFileType(filePath: string): string {
    const lowerPath = filePath.toLowerCase();
    // Check for compound extensions first
    if (lowerPath.endsWith('.mockup.html')) {
        return 'mockup';
    }
    const ext = extname(filePath).toLowerCase();
    const typeMap: Record<string, string> = {
        '.md': 'markdown',
        '.markdown': 'markdown',
        '.txt': 'text',
    };
    return typeMap[ext] || 'other';
}

// Cache for quick open file searches
const fileNameCaches = new Map<string, Array<{ path: string; name: string; type: 'file' | 'directory' }>>();

// Binary file extensions to exclude from QuickOpen results
// Note: Images are NOT excluded - Nimbalyst can display them
// Note: PDFs are NOT excluded - extensions may add support
const BINARY_EXTENSIONS = new Set([
    // Audio/Video
    '.mp3', '.mp4', '.avi', '.mov', '.wmv', '.flac', '.wav', '.ogg', '.webm', '.mkv',
    // Archives
    '.zip', '.tar', '.gz', '.rar', '.7z', '.bz2', '.xz',
    // Binaries/Libraries
    '.exe', '.dll', '.so', '.dylib', '.o', '.a', '.lib', '.bin',
    // Documents (non-text)
    '.doc', '.docx', '.xls', '.xlsx', '.ppt', '.pptx',
    // Database/Lock files
    '.db', '.sqlite', '.sqlite3', '.lock',
    // Fonts
    '.ttf', '.otf', '.woff', '.woff2', '.eot',
    // Other binary
    '.pyc', '.pyo', '.class', '.jar', '.war', '.ear',
    '.node', '.wasm',
]);

const NIMBALYST_LOCAL_DIRNAME = 'nimbalyst-local';

// Get the ripgrep binary path for the current platform.
// Resolves the rg bundled by the @vscode/ripgrep package at
// node_modules/@vscode/ripgrep/bin/rg(.exe). Result is cached for
// the lifetime of the process — search is called frequently and
// the binary doesn't move.
let cachedRgPath: string | null = null;
function getRipgrepPath(): string {
    if (cachedRgPath !== null) return cachedRgPath;

    const platform = os.platform();
    const rgBinaryName = platform === 'win32' ? 'rg.exe' : 'rg';
    const isPackaged = app.isPackaged;

    // Use a variable to avoid Vite trying to resolve 'node_modules' as an identifier
    const NODE_MODULES_DIR = ['node', '_', 'modules'].join('');
    const rgRelPath = path.join(NODE_MODULES_DIR, '@vscode', 'ripgrep', 'bin', rgBinaryName);

    const possibleRgPaths: string[] = [];

    if (isPackaged) {
        const resourcesPath = process.resourcesPath;
        possibleRgPaths.push(path.join(resourcesPath, 'app.asar.unpacked', rgRelPath));
    } else {
        possibleRgPaths.push(
            path.join(__dirname, '..', '..', rgRelPath),
            path.join(process.cwd(), rgRelPath),
        );
        // In monorepos, node_modules may be hoisted to the repo root.
        // Walk up from cwd to find it.
        let searchDir = process.cwd();
        for (let i = 0; i < 5; i++) {
            const parent = path.dirname(searchDir);
            if (parent === searchDir) break; // reached filesystem root
            possibleRgPaths.push(path.join(parent, rgRelPath));
            searchDir = parent;
        }
    }

    for (const testPath of possibleRgPaths) {
        if (existsSync(testPath)) {
            // Make sure the binary is executable in production (non-Windows)
            if (isPackaged && platform !== 'win32') {
                try {
                    fs.chmodSync(testPath, 0o755);
                } catch (e) {
                    console.warn('[SEARCH] Could not set executable permission on ripgrep:', e);
                }
            }
            // console.log('[SEARCH] Found ripgrep at:', testPath);
            cachedRgPath = testPath;
            return testPath;
        }
    }

    // Fall back to system rg
    console.warn('[SEARCH] Could not find bundled ripgrep, falling back to system rg. Probed:', possibleRgPaths);
    cachedRgPath = 'rg';
    return 'rg';
}

async function runRipgrepFiles(rootPath: string, options?: { noIgnore?: boolean }): Promise<string[]> {
    const rgPath = getRipgrepPath();
    const rgArgs = [
        '--files',
        '--hidden',  // Include dotfiles like .gitignore
        ...(options?.noIgnore ? ['--no-ignore'] : []),
        ...RIPGREP_EXCLUDE_ARGS_ARRAY,
        rootPath
    ];

    let stdout = '';
    try {
        const result = await execFileAsync(rgPath, rgArgs, { maxBuffer: 5 * 1024 * 1024 });
        stdout = result.stdout;
    } catch (execError: any) {
        // ripgrep returns exit code 1 when no matches found
        if (execError.code === 1) {
            stdout = execError.stdout || '';
        } else {
            throw execError;
        }
    }

    if (!stdout) return [];

    return stdout
        .split('\n')
        .filter(line => line.trim())
        .map(file => path.normalize(file));
}

// Cross-platform file finder using ripgrep --files.
// Respects .gitignore for the general workspace scan, but explicitly includes
// nimbalyst-local/ so local plan files remain mentionable in @ typeahead.
async function findWorkspaceFiles(dir: string): Promise<string[]> {
    const baseFiles = await runRipgrepFiles(dir);
    const nimbalystLocalPath = path.join(dir, NIMBALYST_LOCAL_DIRNAME);
    const extraFiles = existsSync(nimbalystLocalPath)
      ? await runRipgrepFiles(nimbalystLocalPath, { noIgnore: true })
      : [];

    return Array.from(new Set([...baseFiles, ...extraFiles]))
        .filter(file => {
            // Filter out binary files by extension
            const ext = path.extname(file).toLowerCase();
            return !BINARY_EXTENSIONS.has(ext);
        });
}

export function registerWorkspaceHandlers() {
    const analytics = AnalyticsService.getInstance();
    // Get folder contents
    safeHandle('get-folder-contents', async (event, dirPath: string) => {
        return await getFolderContents(dirPath);
    });

    // Refresh folder contents (for when user expands a folder)
    safeHandle('refresh-folder-contents', async (event, folderPath: string) => {
        return await getFolderContents(folderPath);
    });

    // Create new file
    safeHandle('create-file', async (event, filePath: string, content: string = '') => {
        try {
            await writeFile(filePath, content, 'utf-8');

            // Track file creation from menu
            analytics.sendEvent('file_created', {
                creationType: 'new_file_menu',
                fileType: getFileType(filePath)
            });

            return { success: true, filePath };
        } catch (error: any) {
            console.error('Error creating file:', error);
            return { success: false, error: error.message };
        }
    });

    // Create new folder
    safeHandle('create-folder', async (event, folderPath: string) => {
        try {
            await mkdir(folderPath, { recursive: true });
            return { success: true, folderPath };
        } catch (error: any) {
            console.error('Error creating folder:', error);
            return { success: false, error: error.message };
        }
    });

    // Read file content (without changing watcher or state)
    // Options:
    //   - encoding: 'utf-8' (default), 'latin1', 'ascii', etc., or 'binary' for base64, or 'auto' to auto-detect
    //   - binary: true to force binary/base64 reading (auto-detected by extension if not specified)
    safeHandle('read-file-content', async (event, filePath: string, options?: { encoding?: BufferEncoding | 'binary' | 'auto'; binary?: boolean }) => {
        // Skip virtual files - they don't exist on disk
        if (filePath.startsWith('virtual://')) {
            return null;
        }

        if (!existsSync(filePath)) {
            // console.log('[READ_FILE] File does not exist:', filePath);
            return null;
        }

        try {
            const forceBinary = options?.binary || options?.encoding === 'binary';

            // Auto-detect binary files by extension if not explicitly specified
            let isBinary = forceBinary;
            if (!forceBinary) {
                const ext = extname(filePath).toLowerCase();
                const binaryExtensions = ['.pdf', '.png', '.jpg', '.jpeg', '.gif', '.bmp', '.ico', '.zip', '.tar', '.gz', '.woff', '.woff2', '.ttf', '.eot'];
                isBinary = binaryExtensions.includes(ext);
            }

            if (isBinary) {
                // Read binary files as base64
                const buffer = readFileSync(filePath);
                const content = buffer.toString('base64');
                return { success: true, content, isBinary: true };
            } else {
                // Read text files - auto-detect encoding or use specified encoding
                let encoding: BufferEncoding = 'utf-8';

                if (options?.encoding === 'auto' || !options?.encoding) {
                    // Auto-detect encoding for text files
                    const buffer = readFileSync(filePath);
                    const detected = chardet.detect(buffer);

                    if (detected) {
                        // Map detected encoding to Node.js encoding name
                        const encodingMap: Record<string, BufferEncoding> = {
                            'UTF-8': 'utf8',
                            'UTF-16LE': 'utf16le',
                            'UTF-16BE': 'utf16le', // Node doesn't have utf16be, use utf16le
                            'ISO-8859-1': 'latin1',
                            'windows-1252': 'latin1',
                            'Shift_JIS': 'utf8', // Fallback to utf8 for unsupported
                            'GB18030': 'utf8', // Fallback to utf8 for unsupported
                        };

                        encoding = encodingMap[detected] || 'utf8';
                    }
                } else if (options.encoding !== 'binary') {
                    encoding = options.encoding as BufferEncoding;
                }

                const content = readFileSync(filePath, encoding);
                return { success: true, content, isBinary: false, detectedEncoding: encoding };
            }
        } catch (error: any) {
            console.error('[READ_FILE] Failed to read file:', filePath, error);
            return { success: false, error: error.message };
        }
    });

    // Switch workspace file - uses unified FileOpener API
    safeHandle('switch-workspace-file', async (event, filePath: string) => {
        const window = BrowserWindow.fromWebContents(event.sender);
        if (!window) {
            console.error('[SWITCH_FILE] No window found for event sender');
            return null;
        }

        // Skip virtual files - they don't exist on disk
        if (filePath.startsWith('virtual://')) {
            return null;
        }

        try {
            const windowId = getWindowId(window);
            const state = windowId !== null ? windowStates.get(windowId) : null;

            // Use unified FileOpener API with skipFileWatcher=true
            // File watchers are managed separately by start-watching-file/stop-watching-file
            // when tabs are opened/closed, not when switching between them
            const result = await openFile({
                filePath,
                workspacePath: state?.workspacePath || undefined,
                source: 'tab_switch',
                targetWindow: window,
                skipFileWatcher: true,  // Tabs manage their own watchers
                skipAnalytics: true      // Don't track tab switches as file opens
            });

            return {
                filePath: result.filePath,
                content: result.content
            };
        } catch (error) {
            console.error('[SWITCH_FILE] Error switching workspace file:', error);
            const errorMessage = error instanceof Error ? error.message : 'Failed to open file';
            return { error: errorMessage };
        }
    });

    // Build file name cache for quick open
    safeHandle('build-quick-open-cache', async (event, workspacePath: string) => {
        try {
            // Use cross-platform Node.js file walking instead of Unix find command
            const files = await findWorkspaceFiles(workspacePath);

            const cache: Array<{ path: string; name: string; type: 'file' | 'directory' }> = [];

            // Extract unique directories from file paths
            const dirs = new Set<string>();
            for (const file of files) {
                // Walk up the directory tree from each file
                let dir = dirname(file);
                while (dir.length > workspacePath.length) {
                    if (dirs.has(dir)) break; // Already seen this dir and its parents
                    dirs.add(dir);
                    dir = dirname(dir);
                }
            }

            // Add directories to cache
            for (const dir of dirs) {
                cache.push({
                    path: dir,
                    name: basename(dir).toLowerCase(),
                    type: 'directory'
                });
            }

            // Add files to cache
            for (const file of files) {
                cache.push({
                    path: file,
                    name: basename(file).toLowerCase(),
                    type: 'file'
                });
            }

            fileNameCaches.set(workspacePath, cache);
            return { success: true, fileCount: cache.length };
        } catch (error) {
            console.error('Error building quick open cache:', error);
            return { success: false, error: String(error) };
        }
    });

    // Search workspace file names only (fast, uses cache)
    // Supports fuzzy matching with CamelCase abbreviations (e.g., "ClaCoPro" matches "ClaudeCodeProvider")
    safeHandle('search-workspace-file-names', async (event, workspacePath: string, query: string) => {
        try {
            const trimmedQuery = query.trim();

            // Use cache if available
            const cache = fileNameCaches.get(workspacePath);
            if (!cache) {
                console.warn('Quick open cache not built for workspace:', workspacePath);
                return [];
            }

            // Empty query: return top-level items sorted by path depth then alphabetically
            if (!trimmedQuery) {
                const sorted = [...cache]
                    .sort((a, b) => {
                        const depthA = a.path.split('/').length;
                        const depthB = b.path.split('/').length;
                        if (depthA !== depthB) return depthA - depthB;
                        return a.path.localeCompare(b.path);
                    })
                    .slice(0, 50);
                return sorted.map(item => ({
                    path: path.normalize(item.path),
                    isFileNameMatch: true,
                    matches: [],
                    score: 0,
                    type: item.type,
                }));
            }

            // Use fuzzy matching for better search experience
            // Supports: substring, CamelCase abbreviation (ClaCoPro), delimiter-separated (tra-bug)
            const scoredResults = cache
                .map(item => {
                    const match = fuzzyMatchPath(trimmedQuery, item.path);
                    return {
                        item,
                        match,
                    };
                })
                .filter(r => r.match.matches)
                .sort((a, b) => b.match.score - a.match.score)
                .slice(0, 50);

            const results = scoredResults.map(r => ({
                // Normalize path separators to platform-native format
                path: path.normalize(r.item.path),
                isFileNameMatch: true,
                matches: [],
                score: r.match.score,
                type: r.item.type,
            }));

            return results;
        } catch (error) {
            console.error('Error searching file names:', error);
            return [];
        }
    });

    // Search workspace file content using ripgrep (slower)
    safeHandle('search-workspace-file-content', async (event, workspacePath: string, query: string) => {
        try {
            const trimmedQuery = query.trim();
            if (!trimmedQuery) return [];

            const rgPath = getRipgrepPath();
            const rgArgs = [
                ...QUICKOPEN_FILE_TYPE_ARGS,
                '-i',
                '--json',
                ...RIPGREP_EXCLUDE_ARGS_ARRAY,
                trimmedQuery,
                workspacePath
            ];

            let stdout = '';
            try {
                const result = await execFileAsync(rgPath, rgArgs, { maxBuffer: 5 * 1024 * 1024 });
                stdout = result.stdout;
            } catch (execError: any) {
                // ripgrep returns exit code 1 when no matches found, which is not an error
                if (execError.code === 1) {
                    stdout = execError.stdout || '';
                } else {
                    throw execError;
                }
            }

            const contentMatches = new Map<string, any>();
            if (stdout) {
                const lines = stdout.split('\n').filter(line => line.trim());
                for (const line of lines) {
                    try {
                        const item = JSON.parse(line);
                        if (item.type === 'match') {
                            const filePath = item.data.path.text;
                            if (!contentMatches.has(filePath)) {
                                contentMatches.set(filePath, {
                                    path: path.normalize(filePath),
                                    isContentMatch: true,
                                    matches: []
                                });
                            }

                            contentMatches.get(filePath).matches.push({
                                line: item.data.line_number,
                                text: item.data.lines.text.trim(),
                                start: item.data.submatches[0]?.start || 0,
                                end: item.data.submatches[0]?.end || item.data.lines.text.length
                            });
                        }
                    } catch (e) {
                        // Skip invalid JSON lines
                    }
                }
            }

            return Array.from(contentMatches.values()).slice(0, 50);
        } catch (error) {
            console.error('Error searching file content:', error);
            return [];
        }
    });

    // Legacy handler that combines both (for backward compatibility)
    safeHandle('search-workspace-files', async (event, workspacePath: string, query: string) => {
        try {
            const trimmedQuery = query.trim();
            if (!trimmedQuery) return [];

            const allResults: any[] = [];

            // First, search file names using ripgrep --files
            try {
                const allFiles = await findWorkspaceFiles(workspacePath);
                const queryLower = trimmedQuery.toLowerCase();
                const matchingFiles = allFiles
                    .filter(file => basename(file).toLowerCase().includes(queryLower))
                    .slice(0, 50);

                for (const file of matchingFiles) {
                    allResults.push({
                        path: file,
                        isFileNameMatch: true,
                        matches: []
                    });
                }
            } catch (e) {
                // Ignore file name search errors
            }

            // Then search content using ripgrep
            try {
                const rgPath = getRipgrepPath();
                const rgArgs = [
                    '--type', 'md',
                    '-i',
                    '--json',
                    ...RIPGREP_EXCLUDE_ARGS_ARRAY,
                    trimmedQuery,
                    workspacePath
                ];

                let stdout = '';
                try {
                    const result = await execFileAsync(rgPath, rgArgs, { maxBuffer: 5 * 1024 * 1024 });
                    stdout = result.stdout;
                } catch (execError: any) {
                    // ripgrep returns exit code 1 when no matches found, which is not an error
                    if (execError.code === 1) {
                        stdout = execError.stdout || '';
                    } else {
                        throw execError;
                    }
                }

                if (stdout) {
                    const lines = stdout.split('\n').filter(line => line.trim());
                    const contentMatches = new Map<string, any>();

                    for (const line of lines) {
                        try {
                            const item = JSON.parse(line);
                            if (item.type === 'match') {
                                const filePath = path.normalize(item.data.path.text);
                                if (!contentMatches.has(filePath)) {
                                    contentMatches.set(filePath, {
                                        path: filePath,
                                        isContentMatch: true,
                                        matches: []
                                    });
                                }

                                contentMatches.get(filePath).matches.push({
                                    line: item.data.line_number,
                                    text: item.data.lines.text.trim(),
                                    start: item.data.submatches[0]?.start || 0,
                                    end: item.data.submatches[0]?.end || item.data.lines.text.length
                                });
                            }
                        } catch (e) {
                            // Skip invalid JSON lines
                        }
                    }

                    // Merge content matches with existing results
                    for (const [filePath, data] of contentMatches) {
                        const existing = allResults.find(r => r.path === filePath);
                        if (existing) {
                            existing.matches = data.matches;
                            existing.isContentMatch = true;
                        } else {
                            allResults.push(data);
                        }
                    }
                }
            } catch (error: any) {
                console.error('Error executing ripgrep:', error);
                console.error('[SEARCH] Error details:', error.message, error.code);
            }

            // Sort by relevance: files matching both name and content first
            allResults.sort((a, b) => {
                const aScore = (a.isFileNameMatch ? 2 : 0) + (a.isContentMatch ? 1 : 0);
                const bScore = (b.isFileNameMatch ? 2 : 0) + (b.isContentMatch ? 1 : 0);
                return bScore - aScore;
            });

            return allResults.slice(0, 50);

        } catch (error) {
            console.error('Error searching workspace files:', error);
            return [];
        }
    });

    // Get recent workspace files.
    //
    // Pre-#188 (single-workspace-per-window) this resolved the workspace from
    // BrowserWindow state. After the multi-project rail landed, a single
    // window can have multiple workspaces pinned and the caller knows which
    // one it cares about; falling back to window state caused Cmd+O Quick Open
    // and the @-mention picker to pull "recent files" from whichever workspace
    // the window happened to be tracking last, which leaks files from other
    // pinned workspaces into the picker. See #301 (Quick Open) and #304
    // (@-mention shows alphabetical instead of recents because the cross-
    // workspace recent list failed its path-prefix filter and fell through to
    // the alphabetical search path).
    //
    // The renderer now passes workspacePath explicitly. The window-state
    // fallback stays for backwards compatibility with any older renderer
    // bundle that may still hit this channel without the parameter.
    safeHandle('get-recent-workspace-files', async (event, workspacePath?: string) => {
        let scope = workspacePath;

        if (!scope) {
            const window = BrowserWindow.fromWebContents(event.sender);
            if (!window) return [];

            const windowId = getWindowId(window);
            if (windowId === null) return [];

            const state = windowStates.get(windowId);
            if (!state || !state.workspacePath) return [];
            scope = state.workspacePath;
        }

        // Get recent files for this workspace from store
        const workspaceRecentFiles = getWorkspaceRecentFiles(scope);

        // Ensure it's an array before filtering
        if (!Array.isArray(workspaceRecentFiles)) {
            console.error('[WorkspaceHandlers] workspaceRecentFiles is not an array:', workspaceRecentFiles);
            return [];
        }

        // Filter to only existing files
        return workspaceRecentFiles.filter(filePath => existsSync(filePath)).slice(0, 20);
    });

    // Add to workspace recent files
    safeOn('add-to-workspace-recent-files', async (event, filePath: string) => {
        const window = BrowserWindow.fromWebContents(event.sender);
        if (!window) return;

        const windowId = getWindowId(window);
        if (windowId === null) return;

        const state = windowStates.get(windowId);
        if (!state || !state.workspacePath) return;

        addWorkspaceRecentFile(state.workspacePath, filePath);
    });

    // Get entire workspace state - no routing, no BS
    safeHandle('workspace:get-state', async (event, workspacePath: string) => {
        return getWorkspaceState(workspacePath);
    });

    // Update workspace state - takes partial update, merges atomically with deep merge
    safeHandle('workspace:update-state', async (event, workspacePath: string, updates: any) => {
        return updateWorkspaceState(workspacePath, (state) => {
            deepMerge(state, updates);
        });
    });

    // File operations for workspace files
    safeHandle('rename-file', async (event, oldPath: string, newName: string) => {

        try {
            const newPath = join(dirname(oldPath), newName);

            if (newPath !== oldPath && existsSync(newPath)) {
                let isSameFile = false;
                try {
                    const [oldStats, newStats] = await Promise.all([
                        stat(oldPath),
                        stat(newPath),
                    ]);
                    isSameFile = oldStats.dev === newStats.dev && oldStats.ino === newStats.ino;
                } catch {
                    isSameFile = false;
                }

                if (!isSameFile) {
                    return { success: false, error: 'File already exists' };
                }
            }

            // Stop watching before rename to prevent false delete detection
            for (const [windowId, state] of windowStates) {
                if (state?.filePath === oldPath) {
                    console.log('[RENAME] Stopping file watcher before rename for:', oldPath);
                    stopFileWatcher(windowId);
                }
            }

            await rename(oldPath, newPath);

            // Prevent autosave from recreating the file at the old path.
            // Lifecycle-bound: cleared via editor:released-deleted-path IPC
            // when no editor still holds the path AND a fresh load has been
            // observed. A 5-minute absolute fallback runs in WindowManager.
            markRecentlyDeleted(oldPath);

            // Update windows that have this file open
            for (const [windowId, state] of windowStates) {
                if (state?.filePath === oldPath) {
                    state.filePath = newPath;
                    // Update represented filename for macOS
                    const window = BrowserWindow.getAllWindows().find(w => w.id === windowId);
                    if (window) {
                        if (process.platform === 'darwin') {
                            window.setRepresentedFilename(newPath);
                        }
                        // Start watching the renamed file
                        console.log('[RENAME] Starting file watcher after rename for:', newPath);
                        startFileWatcher(window, newPath);
                    }
                }
            }

            // Notify all windows about the file rename
            BrowserWindow.getAllWindows().forEach(window => {
                window.webContents.send('file-renamed', { oldPath, newPath });
            });

            // Track file rename
            analytics.sendEvent('file_renamed', {
                fileType: getFileType(newPath)
            });

            return { success: true, newPath };
        } catch (error: any) {
            console.error('Error renaming file:', error);
            return { success: false, error: error.message };
        }
    });

    safeHandle('delete-file', async (event, filePath: string) => {

        try {
            const stats = await stat(filePath);
            const isDirectory = stats.isDirectory();

            // Compute syncId before trashing so we can remove from file index
            let deletedSyncId: string | null = null;
            if (!isDirectory && filePath.endsWith('.md')) {
              const window = BrowserWindow.fromWebContents(event.sender);
              const wId = window ? getWindowId(window) : null;
              const wState = wId !== null ? windowStates.get(wId) : null;
              if (wState?.workspacePath) {
                deletedSyncId = getSyncId(filePath, wState.workspacePath);
              }
            }

            // Move to system trash (Recycle Bin on Windows, Trash on macOS/Linux)
            // so the user can recover accidentally deleted files
            await shell.trashItem(filePath);

            if (!isDirectory) {
                // Prevent autosave from recreating the file. Lifecycle-bound:
                // cleared via editor:released-deleted-path IPC when no editor
                // still holds the path AND a fresh load has been observed.
                // A 5-minute absolute fallback runs in WindowManager.
                markRecentlyDeleted(filePath);

                // Remove from file index if it had a syncId
                if (deletedSyncId) {
                  removeFileFromIndex(deletedSyncId);
                }
            }

            // Track file deletion (only for files, not directories)
            if (!isDirectory) {
                analytics.sendEvent('file_deleted', {
                    fileType: getFileType(filePath),
                    source: 'workspace_tree'
                });
            }

            // Clear file path for windows that have this file open
            for (const [windowId, state] of windowStates) {
                if (state?.filePath === filePath) {
                    state.filePath = null;
                    state.documentEdited = false;
                }
            }

            // Notify all windows about the file deletion
            console.log('[MAIN] Sending file-deleted event for:', filePath);
            const windows = BrowserWindow.getAllWindows();
            console.log('[MAIN] Number of windows to notify:', windows.length);
            windows.forEach((window, index) => {
                console.log(`[MAIN] Sending file-deleted to window ${index}`);
                window.webContents.send('file-deleted', { filePath });
            });

            return { success: true };
        } catch (error: any) {
            console.error('Error deleting file:', error);
            return { success: false, error: error.message };
        }
    });

    // Renderer signals that an editor has fully released a previously-deleted
    // path AND observed a fresh `loadContent()` (so the path is "live" again).
    // We can safely drop the recentlyDeleted entry.
    safeOn('editor:released-deleted-path', (_event, filePath: string) => {
        if (typeof filePath === 'string' && filePath.length > 0) {
            clearRecentlyDeleted(filePath);
        }
    });

    // Move file/folder
    safeHandle('move-file', async (event, sourcePath: string, targetPath: string) => {

        try {
            // Check if source exists
            const sourceStats = await stat(sourcePath);

            // Check if target is a directory
            let destinationPath = targetPath;
            try {
                const targetStats = await stat(targetPath);
                if (targetStats.isDirectory()) {
                    // If target is a directory, move source into it
                    destinationPath = join(targetPath, basename(sourcePath));
                }
            } catch {
                // Target doesn't exist, use it as the new path
            }

            // Update windows that have this file open - BEFORE the move
            // This prevents the file watcher from detecting an unlink event
            if (!sourceStats.isDirectory()) {
                for (const [windowId, state] of windowStates) {
                    if (state?.filePath === sourcePath) {
                        // Stop watching the old file BEFORE moving
                        console.log('[MOVE] Stopping file watcher before move for:', sourcePath);
                        stopFileWatcher(windowId);
                    }
                }
            }

            // Perform the move
            await rename(sourcePath, destinationPath);

            // Prevent autosave from recreating the file at the old path.
            // Lifecycle-bound; see comment above markRecentlyDeleted.
            if (!sourceStats.isDirectory()) {
                markRecentlyDeleted(sourcePath);
            }

            // Update windows that have this file open - AFTER the move
            if (!sourceStats.isDirectory()) {
                for (const [windowId, state] of windowStates) {
                    if (state?.filePath === sourcePath) {
                        // Update the file path
                        state.filePath = destinationPath;

                        // Update represented filename for macOS
                        const window = BrowserWindow.getAllWindows().find(w => w.id === windowId);
                        if (window) {
                            if (process.platform === 'darwin') {
                                window.setRepresentedFilename(destinationPath);
                            }
                            // Start watching the new file
                            console.log('[MOVE] Starting file watcher after move for:', destinationPath);
                            startFileWatcher(window, destinationPath);
                        }
                    }
                }
            }

            // Notify all windows about the file move
            BrowserWindow.getAllWindows().forEach(window => {
                window.webContents.send('file-moved', { sourcePath, destinationPath });
            });

            return { success: true, newPath: destinationPath };
        } catch (error: any) {
            console.error('Error moving file:', error);
            return { success: false, error: error.message };
        }
    });

    // Copy file/folder
    safeHandle('copy-file', async (event, sourcePath: string, targetPath: string) => {

        try {
            // Check if source exists
            const sourceStats = await stat(sourcePath);

            // Check if target is a directory
            let destinationPath = targetPath;
            try {
                const targetStats = await stat(targetPath);
                if (targetStats.isDirectory()) {
                    // If target is a directory, copy source into it
                    let destName = basename(sourcePath);
                    destinationPath = join(targetPath, destName);

                    // Check if file already exists and generate unique name
                    let counter = 1;
                    const nameWithoutExt = basename(sourcePath, extname(sourcePath));
                    const ext = extname(sourcePath);

                    while (existsSync(destinationPath)) {
                        destName = `${nameWithoutExt} copy${counter > 1 ? ' ' + counter : ''}${ext}`;
                        destinationPath = join(targetPath, destName);
                        counter++;
                    }
                }
            } catch {
                // Target doesn't exist, use it as the new path
            }

            // Perform the copy
            await cp(sourcePath, destinationPath, { recursive: true });

            // Notify all windows about the file copy
            BrowserWindow.getAllWindows().forEach(window => {
                window.webContents.send('file-copied', { sourcePath, destinationPath });
            });

            return { success: true, newPath: destinationPath };
        } catch (error: any) {
            console.error('Error copying file:', error);
            return { success: false, error: error.message };
        }
    });

    safeHandle('workspace:open-file', async (event, options: { workspacePath: string; filePath: string }) => {
        try {
            const { workspacePath, filePath } = options;

            // Resolve workspace-relative paths (e.g. from git status) against workspacePath
            const absoluteFilePath = path.isAbsolute(filePath)
                ? filePath
                : workspacePath
                    ? path.join(workspacePath, filePath)
                    : filePath;

            // Send open-document event to the renderer to trigger handleWorkspaceFileSelect
            // which handles tab creation via switchWorkspaceFile (returns file content)
            const window = BrowserWindow.fromWebContents(event.sender);
            if (!window) {
                throw new Error('No window found for event sender');
            }
            window.webContents.send('open-document', { path: absoluteFilePath });

            return { success: true };
        } catch (error: any) {
            console.error('Error opening file in workspace:', error);
            return { success: false, error: error.message };
        }
    });

    safeHandle('open-in-default-app', async (event, filePath: string) => {
        try {
            // Open file in the OS default application
            const result = await shell.openPath(filePath);
            if (result) {
                // openPath returns an error string if it failed, empty string on success
                return { success: false, error: result };
            }
            return { success: true };
        } catch (error: any) {
            console.error('Error opening file in default app:', error);
            return { success: false, error: error.message };
        }
    });


    safeHandle('copy-to-clipboard', async (_event, text: string) => {
        clipboard.writeText(text);
        return { success: true };
    });

    safeHandle('read-from-clipboard', async () => {
        return { success: true, text: clipboard.readText() };
    });

    safeHandle('show-in-finder', async (event, filePath: string) => {

        try {
            shell.showItemInFolder(filePath);
            return { success: true };
        } catch (error: any) {
            console.error('Error showing in finder:', error);
            return { success: false, error: error.message };
        }
    });

    // Open file/folder in external editor
    safeHandle('open-in-external-editor', async (event, filePath: string) => {
        if (!filePath) {
            return { success: false, error: 'File path is required' };
        }

        const editorType = getAppSetting('externalEditorType') as string | undefined;
        const customPath = getAppSetting('externalEditorCustomPath') as string | undefined;

        if (!editorType || editorType === 'none') {
            return { success: false, error: 'No external editor configured' };
        }

        // Map editor type to command
        const editorCommands: Record<string, string> = {
            vscode: 'code',
            cursor: 'cursor',
            webstorm: 'webstorm',
            sublime: 'subl',
            vim: 'vim',
            nvim: 'nvim',
        };

        let command: string;
        if (editorType === 'custom') {
            if (!customPath) {
                return { success: false, error: 'Custom editor path not configured' };
            }
            command = customPath;
        } else {
            command = editorCommands[editorType];
            if (!command) {
                return { success: false, error: `Unknown editor type: ${editorType}` };
            }
        }

        try {
            // For terminal-based editors (vim, nvim), we need special handling
            const isTerminalEditor = editorType === 'vim' || editorType === 'nvim';

            if (isTerminalEditor && process.platform === 'darwin') {
                // On macOS, open terminal with the editor
                // Use osascript to open Terminal.app with the command
                const escapedPath = filePath.replace(/'/g, "'\\''");
                const script = `tell application "Terminal"
                    activate
                    do script "${command} '${escapedPath}'"
                end tell`;
                spawn('osascript', ['-e', script], {
                    detached: true,
                    stdio: 'ignore',
                }).unref();
            } else {
                // For GUI editors, spawn directly
                const child = spawn(command, [filePath], {
                    detached: true,
                    stdio: 'ignore',
                });
                child.unref();
            }

            // Track analytics
            const analytics = AnalyticsService.getInstance();
            const fileExt = extname(filePath).toLowerCase();
            const isDirectory = existsSync(filePath) && statSync(filePath).isDirectory();
            analytics.sendEvent('file_opened_in_external_editor', {
                editor_type: editorType,
                file_extension: isDirectory ? 'directory' : fileExt,
                is_directory: isDirectory,
            });

            return { success: true };
        } catch (error: any) {
            console.error('Error opening file in external editor:', error);
            return { success: false, error: error.message || 'Failed to open external editor' };
        }
    });

    // Plan Status Agent Session Integration
    safeHandle('plan-status:launch-agent-session', async (event, options: { workspacePath: string; planDocumentPath: string }) => {
        try {
            const { workspacePath, planDocumentPath } = options;

            // Find the workspace window for this workspace path
            let targetWindow: BrowserWindow | null = null;
            for (const [windowId, state] of windowStates) {
                if (state?.workspacePath === workspacePath && state.mode === 'workspace') {
                    const window = BrowserWindow.getAllWindows().find(w => getWindowId(w) === windowId);
                    if (window && !window.isDestroyed()) {
                        targetWindow = window;
                        break;
                    }
                }
            }

            // If no workspace window found, use the current window
            if (!targetWindow) {
                targetWindow = BrowserWindow.fromWebContents(event.sender);
            }

            if (!targetWindow) {
                console.error('[PlanStatus] No window found to launch agent session');
                return { success: false, error: 'No window found' };
            }

            // Switch to agent mode in the project window
            targetWindow.focus();
            targetWindow.webContents.send('set-content-mode', 'agent');

            // Insert the plan file reference into the agent input
            if (planDocumentPath) {
                targetWindow.webContents.send('agent:insert-plan-reference', planDocumentPath);
            }

            return { success: true, sessionId: null };
        } catch (error: any) {
            console.error('[PlanStatus] Error launching agent session:', error);
            return { success: false, error: error.message };
        }
    });

    safeHandle('plan-status:open-agent-session', async (event, options: { sessionId: string; workspacePath: string; planDocumentPath?: string }) => {
        try {
            const { sessionId, workspacePath, planDocumentPath } = options;

            // Find the workspace window for this workspace path
            let targetWindow: BrowserWindow | null = null;
            for (const [windowId, state] of windowStates) {
                if (state?.workspacePath === workspacePath && state.mode === 'workspace') {
                    const window = BrowserWindow.getAllWindows().find(w => getWindowId(w) === windowId);
                    if (window && !window.isDestroyed()) {
                        targetWindow = window;
                        break;
                    }
                }
            }

            // If no workspace window found, use the current window
            if (!targetWindow) {
                targetWindow = BrowserWindow.fromWebContents(event.sender);
            }

            if (!targetWindow) {
                console.error('[PlanStatus] No window found to open agent session');
                return { success: false, error: 'No window found' };
            }

            // Switch to agent mode in the project window
            targetWindow.focus();
            targetWindow.webContents.send('set-content-mode', 'agent');
            // TODO: Load the specific session ID once agent panel supports it
            // targetWindow.webContents.send('agent:load-session', sessionId);

            return { success: true };
        } catch (error: any) {
            console.error('[PlanStatus] Error opening agent session:', error);
            return { success: false, error: error.message };
        }
    });

    safeHandle('plan-status:notify-session-created', async (event, options: { sessionId: string; planDocumentPath: string }) => {
        try {
            const { sessionId, planDocumentPath } = options;

            // Notify all workspace windows about the new session
            BrowserWindow.getAllWindows().forEach(window => {
                if (!window.isDestroyed()) {
                    window.webContents.send('plan-status:agent-session-created', sessionId, planDocumentPath);
                }
            });

            return { success: true };
        } catch (error: any) {
            console.error('[PlanStatus] Error notifying session created:', error);
            return { success: false, error: error.message };
        }
    });

    // Agentic coding state has been moved to unified workspace state
    // Use workspace:get-state and workspace:update-state instead
}
