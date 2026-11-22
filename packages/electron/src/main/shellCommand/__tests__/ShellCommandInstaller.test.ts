// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { execFileSync } from 'child_process';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync, chmodSync } from 'fs';
import os from 'os';
import path from 'path';
import { PrivilegeCancelledError, ShellCommandInstaller } from '../ShellCommandInstaller';

const SHIM_SOURCE = path.resolve(__dirname, '../../../../resources/bin/nimbalyst');

let root: string;
let shimPath: string;
let installDir: string;

/** A minimal Nimbalyst.app whose executable records how it was launched. */
function makeBundle(name: string): string {
    const contents = path.join(root, name, 'Contents');
    mkdirSync(path.join(contents, 'Resources', 'bin'), { recursive: true });
    mkdirSync(path.join(contents, 'MacOS'), { recursive: true });
    const shim = path.join(contents, 'Resources', 'bin', 'nimbalyst');
    copyFileSync(SHIM_SOURCE, shim);
    chmodSync(shim, 0o755);
    const app = path.join(contents, 'MacOS', 'Nimbalyst');
    writeFileSync(app, `#!/bin/sh\n{ pwd; for a in "$@"; do echo "$a"; done; } > "${root}/launched.tmp"\nmv "${root}/launched.tmp" "${root}/launched"\n`);
    chmodSync(app, 0o755);
    return shim;
}

beforeEach(() => {
    root = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'nim-shell-command-')));
    shimPath = makeBundle('Nimbalyst.app');
    installDir = path.join(root, 'bin');
    mkdirSync(installDir);
});

afterEach(() => {
    rmSync(root, { recursive: true, force: true });
});

describe('ShellCommandInstaller', () => {
    it('installs a link that launches the bundled app with the shell directory and arguments', async () => {
        const installer = new ShellCommandInstaller({ shimPath, installDir });
        expect(await installer.getStatus()).toEqual({ state: 'not-installed', linkPath: path.join(installDir, 'nimbalyst') });

        const result = await installer.install();
        expect(result.ok).toBe(true);
        expect(result.status.state).toBe('installed');

        const project = path.join(root, 'project');
        mkdirSync(project);
        execFileSync(path.join(installDir, 'nimbalyst'), ['.'], { cwd: project });
        const deadline = Date.now() + 5000;
        while (!existsSync(path.join(root, 'launched')) && Date.now() < deadline) {
            await new Promise((resolve) => setTimeout(resolve, 20));
        }
        expect(readFileSync(path.join(root, 'launched'), 'utf-8').split('\n')).toEqual([project, '.', '']);

        expect((await installer.uninstall()).status.state).toBe('not-installed');
        expect(existsSync(path.join(installDir, 'nimbalyst'))).toBe(false);
    });

    it('never replaces or removes a nimbalyst command it did not create without consent', async () => {
        const foreign = path.join(installDir, 'nimbalyst');
        writeFileSync(foreign, '#!/bin/sh\necho mine\n');
        const installer = new ShellCommandInstaller({ shimPath, installDir });

        expect(await installer.getStatus()).toMatchObject({ state: 'foreign', target: null });
        expect((await installer.install()).ok).toBe(false);
        expect((await installer.uninstall()).ok).toBe(false);
        expect(readFileSync(foreign, 'utf-8')).toContain('echo mine');

        const replaced = await installer.install({ replaceForeign: true });
        expect(replaced.status.state).toBe('installed');
    });

    it('repoints a link left by another Nimbalyst copy', async () => {
        const oldShim = makeBundle('Old Nimbalyst.app');
        symlinkSync(oldShim, path.join(installDir, 'nimbalyst'));
        const installer = new ShellCommandInstaller({ shimPath, installDir });

        expect(await installer.getStatus()).toEqual({
            state: 'other-nimbalyst',
            linkPath: path.join(installDir, 'nimbalyst'),
            target: oldShim,
        });
        expect((await installer.install()).status.state).toBe('installed');
    });

    it('falls back to the administrator prompt when the directory is missing or not writable', async () => {
        const missingDir = path.join(root, 'usr', 'local', 'bin');
        const commands: string[] = [];
        const installer = new ShellCommandInstaller({
            shimPath,
            installDir: missingDir,
            runPrivileged: async (command) => {
                commands.push(command);
                execFileSync('/bin/sh', ['-c', command]);
            },
        });

        const result = await installer.install();
        expect(result.status.state).toBe('installed');
        expect(commands).toEqual([
            `mkdir -p '${missingDir}' && ln -sfn '${shimPath}' '${path.join(missingDir, 'nimbalyst')}'`,
        ]);
    });

    it('reports a cancelled administrator prompt as cancelled, not as an error', async () => {
        const installer = new ShellCommandInstaller({
            shimPath,
            installDir: path.join(root, 'missing'),
            runPrivileged: async () => {
                throw new PrivilegeCancelledError();
            },
        });

        expect(await installer.install()).toMatchObject({ ok: false, cancelled: true, status: { state: 'not-installed' } });
    });

    it('is unavailable without a bundled shim', async () => {
        const installer = new ShellCommandInstaller({ shimPath: null, unsupportedReason: 'dev build' });
        expect(await installer.getStatus()).toEqual({ state: 'unsupported', reason: 'dev build' });
        expect(await installer.install()).toMatchObject({ ok: false, error: 'dev build' });
    });
});
