import path from 'path';
import { promises as fsp } from 'fs';
import { execFile } from 'child_process';

/**
 * Installs the `nimbalyst` shell command as a symlink from a directory on PATH
 * to `Contents/Resources/bin/nimbalyst` inside the app bundle (macOS only).
 * Linking into the bundle means the command updates with the app and always
 * launches the copy it came from. Opt-in: nothing is installed until the user
 * asks from the app menu or Settings.
 */

export const SHELL_COMMAND_NAME = 'nimbalyst';
export const DEFAULT_INSTALL_DIR = '/usr/local/bin';

/** Any Nimbalyst copy's shim, so a link left by a moved or older app counts as ours. */
const SHIM_SUFFIX = path.join('Contents', 'Resources', 'bin', SHELL_COMMAND_NAME);

export type ShellCommandStatus =
    | { state: 'unsupported'; reason: string }
    /** Nothing at the link path. */
    | { state: 'not-installed'; linkPath: string }
    /** The link points at this app's shim. */
    | { state: 'installed'; linkPath: string }
    /** The link points at another Nimbalyst copy's shim (moved, renamed or older app). */
    | { state: 'other-nimbalyst'; linkPath: string; target: string }
    /** Something that is not Nimbalyst owns the name. Replacing it needs the user's say-so. */
    | { state: 'foreign'; linkPath: string; target: string | null };

export type ShellCommandResult =
    | { ok: true; status: ShellCommandStatus }
    | { ok: false; cancelled: boolean; error?: string; status: ShellCommandStatus };

export interface ShellCommandFs {
    lstat(target: string): Promise<{ isSymbolicLink(): boolean }>;
    readlink(target: string): Promise<string>;
    symlink(source: string, linkPath: string): Promise<void>;
    unlink(target: string): Promise<void>;
}

/** Runs a shell command with administrator rights after the OS password prompt. */
export type PrivilegedRunner = (shellCommand: string) => Promise<void>;

export class PrivilegeCancelledError extends Error {
    constructor() {
        super('The administrator prompt was cancelled');
    }
}

export interface ShellCommandInstallerOptions {
    /** Path of this app's shim; null when this build has none (dev, non-macOS). */
    shimPath: string | null;
    unsupportedReason?: string;
    installDir?: string;
    fs?: ShellCommandFs;
    runPrivileged?: PrivilegedRunner;
}

export class ShellCommandInstaller {
    private readonly shimPath: string | null;
    private readonly unsupportedReason: string;
    private readonly linkPath: string;
    private readonly fs: ShellCommandFs;
    private readonly runPrivileged: PrivilegedRunner;

    constructor(options: ShellCommandInstallerOptions) {
        this.shimPath = options.shimPath;
        this.unsupportedReason = options.unsupportedReason ?? 'The shell command is not available in this build.';
        this.linkPath = path.join(options.installDir ?? DEFAULT_INSTALL_DIR, SHELL_COMMAND_NAME);
        this.fs = options.fs ?? fsp;
        this.runPrivileged = options.runPrivileged ?? runWithMacAdminPrompt;
    }

    async getStatus(): Promise<ShellCommandStatus> {
        if (!this.shimPath) return { state: 'unsupported', reason: this.unsupportedReason };

        let isLink: boolean;
        try {
            isLink = (await this.fs.lstat(this.linkPath)).isSymbolicLink();
        } catch (error) {
            if (errorCode(error) === 'ENOENT') return { state: 'not-installed', linkPath: this.linkPath };
            throw error;
        }
        if (!isLink) return { state: 'foreign', linkPath: this.linkPath, target: null };

        const raw = await this.fs.readlink(this.linkPath);
        const target = path.resolve(path.dirname(this.linkPath), raw);
        if (target === this.shimPath) return { state: 'installed', linkPath: this.linkPath };
        if (target.endsWith(path.sep + SHIM_SUFFIX)) {
            return { state: 'other-nimbalyst', linkPath: this.linkPath, target };
        }
        return { state: 'foreign', linkPath: this.linkPath, target };
    }

    /**
     * Point the command at this app. Replaces a link to another Nimbalyst copy
     * freely; replaces anything else only with `replaceForeign`, which the
     * caller sets after asking the user.
     */
    async install(options: { replaceForeign?: boolean } = {}): Promise<ShellCommandResult> {
        const before = await this.getStatus();
        if (before.state === 'unsupported') {
            return { ok: false, cancelled: false, error: before.reason, status: before };
        }
        if (before.state === 'installed') return { ok: true, status: before };
        if (before.state === 'foreign' && !options.replaceForeign) {
            return { ok: false, cancelled: false, error: `${before.linkPath} already exists`, status: before };
        }

        const shimPath = this.shimPath!;
        const exists = before.state !== 'not-installed';
        try {
            if (exists) await this.fs.unlink(this.linkPath);
            await this.fs.symlink(shimPath, this.linkPath);
        } catch (error) {
            // /usr/local/bin is root-owned on a fresh Mac, and missing entirely
            // on Apple silicon Macs that never had Homebrew installed there.
            if (!needsPrivilege(error)) return this.failure(error);
            const dir = path.dirname(this.linkPath);
            try {
                await this.runPrivileged(
                    `mkdir -p ${shellQuote(dir)} && ln -sfn ${shellQuote(shimPath)} ${shellQuote(this.linkPath)}`,
                );
            } catch (privilegedError) {
                return this.failure(privilegedError);
            }
        }
        return this.verify('installed');
    }

    /** Remove the command, but only when it is a Nimbalyst link; never someone else's file. */
    async uninstall(): Promise<ShellCommandResult> {
        const before = await this.getStatus();
        if (before.state === 'unsupported') {
            return { ok: false, cancelled: false, error: before.reason, status: before };
        }
        if (before.state === 'not-installed') return { ok: true, status: before };
        if (before.state === 'foreign') {
            return {
                ok: false,
                cancelled: false,
                error: `${before.linkPath} is not a Nimbalyst command, so it was left in place`,
                status: before,
            };
        }

        try {
            await this.fs.unlink(this.linkPath);
        } catch (error) {
            if (!needsPrivilege(error)) return this.failure(error);
            try {
                await this.runPrivileged(`rm -f ${shellQuote(this.linkPath)}`);
            } catch (privilegedError) {
                return this.failure(privilegedError);
            }
        }
        return this.verify('not-installed');
    }

    private async verify(expected: ShellCommandStatus['state']): Promise<ShellCommandResult> {
        const status = await this.getStatus();
        if (status.state === expected) return { ok: true, status };
        return {
            ok: false,
            cancelled: false,
            error: `Expected ${this.linkPath} to be ${expected}, found ${status.state}`,
            status,
        };
    }

    private async failure(error: unknown): Promise<ShellCommandResult> {
        const status = await this.getStatus().catch(
            (): ShellCommandStatus => ({ state: 'unsupported', reason: 'Could not read the command state' }),
        );
        if (error instanceof PrivilegeCancelledError) return { ok: false, cancelled: true, status };
        return { ok: false, cancelled: false, error: error instanceof Error ? error.message : String(error), status };
    }
}

function errorCode(error: unknown): string | undefined {
    return (error as NodeJS.ErrnoException | undefined)?.code;
}

function needsPrivilege(error: unknown): boolean {
    const code = errorCode(error);
    return code === 'EACCES' || code === 'EPERM' || code === 'ENOENT';
}

export function shellQuote(value: string): string {
    return `'${value.replace(/'/g, `'\\''`)}'`;
}

function appleScriptString(value: string): string {
    return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

/** macOS's standard administrator password prompt, via osascript. */
export const runWithMacAdminPrompt: PrivilegedRunner = (shellCommand) =>
    new Promise((resolve, reject) => {
        const script = `do shell script ${appleScriptString(shellCommand)} with administrator privileges`;
        execFile('osascript', ['-e', script], (error, _stdout, stderr) => {
            if (!error) return resolve();
            // -128 is AppleScript's "User canceled."
            if (/-128\b/.test(stderr) || /-128\b/.test(error.message)) return reject(new PrivilegeCancelledError());
            reject(new Error(stderr.trim() || error.message));
        });
    });
