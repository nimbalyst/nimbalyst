/**
 * Resolve the ripgrep binary Nimbalyst ships, for every main-process caller.
 * Spawning a bare `'rg'` instead depends on the user having ripgrep on PATH.
 */

import { app } from 'electron';
import fs, { existsSync } from 'fs';
import os from 'os';
import path from 'path';

// Cached for the lifetime of the process — search is called frequently and the
// binary does not move.
let cachedRgPath: string | null = null;

export function getRipgrepPath(): string {
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
            cachedRgPath = testPath;
            return testPath;
        }
    }

    // Fall back to system rg
    console.warn('[SEARCH] Could not find bundled ripgrep, falling back to system rg. Probed:', possibleRgPaths);
    cachedRgPath = 'rg';
    return 'rg';
}
