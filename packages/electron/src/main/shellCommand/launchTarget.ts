import path from 'path';
import { statSync } from 'fs';

/**
 * What the `nimbalyst` shell command (or any other launch with a path in argv)
 * asked the app to open: `nimbalyst .` names a folder, `nimbalyst notes.md` a
 * file. Flags, the `nimbalyst://` scheme and the Electron/Chromium switches
 * macOS and the dev runner add are not paths and are skipped.
 */
export type LaunchTarget =
    | { kind: 'directory'; path: string }
    | { kind: 'file'; path: string }
    | { kind: 'missing'; path: string };

export type PathKind = 'directory' | 'file' | null;

export function statPathKind(target: string): PathKind {
    try {
        const stats = statSync(target);
        if (stats.isDirectory()) return 'directory';
        if (stats.isFile()) return 'file';
        return null;
    } catch {
        return null;
    }
}

/**
 * Index of the first user argument in an argv. A packaged app's argv is
 * `[exe, ...args]`; a dev launch is `[electron, appPath, ...args]`.
 */
export function userArgsStart(isPackaged: boolean): number {
    return isPackaged ? 1 : 2;
}

/**
 * The first positional path in `args`, resolved against `cwd` (the shell's
 * directory, so `nimbalyst .` means the folder the user is in). Values that
 * belong to a flag (`--workspace <dir>`) are skipped; those flags are parsed
 * by the caller. Returns null when no positional path was given.
 */
export function resolveLaunchTarget(
    args: readonly string[],
    cwd: string,
    pathKind: (target: string) => PathKind = statPathKind,
): LaunchTarget | null {
    for (let i = 0; i < args.length; i++) {
        const arg = args[i];
        if (!arg) continue;
        if (FLAGS_WITH_VALUE.has(arg)) {
            i++;
            continue;
        }
        if (arg.startsWith('-') || arg.startsWith('nimbalyst://')) continue;

        const resolved = path.resolve(cwd, expandHome(arg));
        const kind = pathKind(resolved);
        if (kind === 'directory') return { kind: 'directory', path: resolved };
        if (kind === 'file') return { kind: 'file', path: resolved };
        return { kind: 'missing', path: resolved };
    }
    return null;
}

const FLAGS_WITH_VALUE = new Set(['--workspace', '--file', '--filter']);

function expandHome(arg: string): string {
    const home = process.env.HOME;
    if (!home) return arg;
    if (arg === '~') return home;
    if (arg.startsWith('~/')) return path.join(home, arg.slice(2));
    return arg;
}
