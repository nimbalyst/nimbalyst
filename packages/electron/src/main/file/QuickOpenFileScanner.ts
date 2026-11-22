import { existsSync } from 'fs';
import * as path from 'path';
import { basename, dirname } from 'path';
import { streamRipgrepLines } from '../services/ripgrepPath';
import { QUICKOPEN_FILE_TYPE_ARGS, RIPGREP_EXCLUDE_ARGS_ARRAY } from '../utils/fileFilters';
import { listIgnoredNestedRepositories } from '../utils/gitUtils';

// Binary file extensions to exclude from QuickOpen results
// Note: Images are NOT excluded - Nimbalyst can display them
// Note: PDFs are NOT excluded - extensions may add support
// Note: .mp4 is NOT excluded - the media viewer extension opens it
const BINARY_EXTENSIONS = new Set([
    // Audio/Video
    '.mp3', '.avi', '.mov', '.wmv', '.flac', '.wav', '.ogg', '.webm', '.mkv',
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

const CONTENT_SEARCH_MAX_FILES = 50;

async function runRipgrepFiles(rootPath: string, options?: { noIgnore?: boolean }): Promise<string[]> {
    const rgArgs = [
        '--files',
        '--hidden',  // Include dotfiles like .gitignore
        ...(options?.noIgnore ? ['--no-ignore'] : []),
        ...RIPGREP_EXCLUDE_ARGS_ARRAY,
        rootPath
    ];

    const files: string[] = [];
    await streamRipgrepLines(rgArgs, line => {
        if (line.trim()) files.push(path.normalize(line));
        return true;
    });
    return files;
}

/**
 * Quick-open index for one root: every file, plus every directory on the way
 * to one. Built per root rather than per workspace so attaching or detaching a
 * folder only reindexes that folder.
 */
export async function buildQuickOpenCacheForRoot(
    rootPath: string,
): Promise<Array<{ path: string; name: string; type: 'file' | 'directory' }>> {
    const files = await findWorkspaceFiles(rootPath);
    const cache: Array<{ path: string; name: string; type: 'file' | 'directory' }> = [];

    // Extract unique directories from file paths
    const dirs = new Set<string>();
    for (const file of files) {
        // Walk up the directory tree from each file
        let dir = dirname(file);
        while (dir.length > rootPath.length) {
            if (dirs.has(dir)) break; // Already seen this dir and its parents
            dirs.add(dir);
            dir = dirname(dir);
        }
    }

    for (const dir of dirs) {
        cache.push({ path: dir, name: basename(dir).toLowerCase(), type: 'directory' });
    }
    for (const file of files) {
        cache.push({ path: file, name: basename(file).toLowerCase(), type: 'file' });
    }

    return cache;
}

// Cross-platform file finder using ripgrep --files.
// Respects .gitignore for the general workspace scan, but explicitly includes
// nimbalyst-local/ so local plan files remain mentionable in @ typeahead, and
// clones nested in the root, which the root's ignore rules usually hide (#1449).
// Each clone is scanned under its own ignore rules.
export async function findWorkspaceFiles(dir: string): Promise<string[]> {
    const baseFiles = await runRipgrepFiles(dir);
    const nimbalystLocalPath = path.join(dir, NIMBALYST_LOCAL_DIRNAME);
    const extraFiles = existsSync(nimbalystLocalPath)
      ? await runRipgrepFiles(nimbalystLocalPath, { noIgnore: true })
      : [];
    const nestedRepoFiles: string[] = [];
    for (const repo of await listIgnoredNestedRepositories(dir)) {
        nestedRepoFiles.push(...await runRipgrepFiles(repo));
    }

    return Array.from(new Set([...baseFiles, ...extraFiles, ...nestedRepoFiles]))
        .filter(file => {
            // Filter out binary files by extension
            const ext = path.extname(file).toLowerCase();
            return !BINARY_EXTENSIONS.has(ext);
        });
}

/**
 * The directories a content search names on the ripgrep command line: the
 * workspace roots plus the clones their ignore rules hide (#1449), each once.
 * ripgrep searches a directory named explicitly even when an enclosing repo
 * ignores it, and a clone the user also attached as a root is not searched twice.
 */
export async function listContentSearchRoots(roots: string[]): Promise<string[]> {
    const nested = await Promise.all(roots.map(root => listIgnoredNestedRepositories(root)));
    return Array.from(new Set([...roots, ...nested.flat()].map(dir => path.resolve(dir))));
}

export interface ContentSearchResult {
    path: string;
    isContentMatch: true;
    matches: Array<{ line: number; text: string; start: number; end: number }>;
}

// ripgrep's --json output groups each file's matches together, so stopping at
// the first match in file N+1 keeps every match from the first N files.
export async function searchFileContent(
    roots: string[],
    query: string,
    { typeArgs = QUICKOPEN_FILE_TYPE_ARGS, maxFiles = CONTENT_SEARCH_MAX_FILES }: { typeArgs?: string[]; maxFiles?: number } = {},
): Promise<ContentSearchResult[]> {
    const rgArgs = [
        ...typeArgs,
        '-i',
        '--json',
        ...RIPGREP_EXCLUDE_ARGS_ARRAY,
        query,
        // ripgrep takes N search roots directly, so a multi-root
        // workspace is one invocation, not one per root.
        ...roots,
    ];

    const resultsByFile = new Map<string, ContentSearchResult>();
    await streamRipgrepLines(rgArgs, line => {
        try {
            const item = JSON.parse(line);
            if (item.type !== 'match') return true;
            const filePath = item.data.path.text;
            let result = resultsByFile.get(filePath);
            if (!result) {
                if (resultsByFile.size >= maxFiles) return false;
                result = { path: path.normalize(filePath), isContentMatch: true, matches: [] };
                resultsByFile.set(filePath, result);
            }
            result.matches.push({
                line: item.data.line_number,
                text: item.data.lines.text.trim(),
                start: item.data.submatches[0]?.start || 0,
                end: item.data.submatches[0]?.end || item.data.lines.text.length,
            });
        } catch {
            // Skip invalid JSON lines and non-UTF-8 paths (reported as path.bytes)
        }
        return true;
    });
    return Array.from(resultsByFile.values());
}

