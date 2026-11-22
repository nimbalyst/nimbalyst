/**
 * Resolve the ripgrep binary Nimbalyst ships, for every main-process caller.
 * Spawning a bare `'rg'` instead depends on the user having ripgrep on PATH.
 */

import { spawn } from 'child_process';
import { app } from 'electron';
import fs, { existsSync } from 'fs';
import { createInterface } from 'readline';
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

/**
 * Streams ripgrep's stdout because a buffered `execFile` fails outright once
 * output passes `maxBuffer`. Return `false` from `onLine` to stop early.
 * Exit code 1 (nothing matched) resolves. Exit code 2 with output also
 * resolves: ripgrep reports an unreadable directory that way while still
 * listing the rest of the tree.
 */
export function streamRipgrepLines(args: string[], onLine: (line: string) => boolean): Promise<void> {
    return new Promise((resolve, reject) => {
        const rg = spawn(getRipgrepPath(), args, { stdio: ['ignore', 'pipe', 'pipe'] });
        let stopped = false;
        let sawOutput = false;
        let stderr = '';
        rg.stderr.setEncoding('utf8');
        rg.stderr.on('data', (chunk: string) => {
            if (stderr.length < 4096) stderr += chunk;
        });

        const lines = createInterface({ input: rg.stdout, crlfDelay: Infinity });
        lines.on('line', line => {
            // readline can still deliver lines buffered before close().
            if (stopped || !line) return;
            sawOutput = true;
            if (onLine(line) === false) {
                stopped = true;
                lines.close();
                rg.kill();
            }
        });

        rg.on('error', reject);
        rg.on('close', code => {
            if (stopped || code === 0 || code === 1) {
                resolve();
            } else if (code === 2 && sawOutput) {
                console.warn('[SEARCH] ripgrep skipped paths it could not read:', stderr.trim());
                resolve();
            } else {
                reject(new Error(`ripgrep exited with code ${code}: ${stderr.trim()}`));
            }
        });
    });
}
