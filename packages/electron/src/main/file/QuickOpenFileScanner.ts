import { execFile } from 'child_process';
import { existsSync } from 'fs';
import * as path from 'path';
import { basename, dirname } from 'path';
import { promisify } from 'util';
import { getRipgrepPath } from '../services/ripgrepPath';
import { RIPGREP_EXCLUDE_ARGS_ARRAY } from '../utils/fileFilters';
import { listIgnoredNestedRepositories } from '../utils/gitUtils';

const execFileAsync = promisify(execFile);

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

