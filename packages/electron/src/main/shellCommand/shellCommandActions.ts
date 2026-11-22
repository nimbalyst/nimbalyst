import { app, BrowserWindow, dialog, type MessageBoxOptions } from 'electron';
import path from 'path';
import { safeHandle } from '../utils/ipcRegistry';
import { logger } from '../utils/logger';
import { ShellCommandInstaller, type ShellCommandResult, type ShellCommandStatus } from './ShellCommandInstaller';

/**
 * The app-menu and Settings entry points for the `nimbalyst` shell command.
 * Both run the same flow so the confirmations and messages cannot drift.
 */

let installer: ShellCommandInstaller | null = null;

function getInstaller(): ShellCommandInstaller {
    if (!installer) {
        const supported = process.platform === 'darwin' && app.isPackaged;
        installer = new ShellCommandInstaller({
            shimPath: supported ? path.join(process.resourcesPath, 'bin', 'nimbalyst') : null,
            unsupportedReason: process.platform !== 'darwin'
                ? 'The nimbalyst shell command can be installed from the app on macOS only.'
                : 'The nimbalyst shell command is only available in the packaged app.',
        });
    }
    return installer;
}

export function getShellCommandStatus(): Promise<ShellCommandStatus> {
    return getInstaller().getStatus();
}

function showMessage(parent: BrowserWindow | null, options: MessageBoxOptions) {
    return parent && !parent.isDestroyed()
        ? dialog.showMessageBox(parent, options)
        : dialog.showMessageBox(options);
}

export async function installShellCommandInteractive(parent: BrowserWindow | null): Promise<ShellCommandResult | null> {
    const status = await getInstaller().getStatus();
    if (status.state === 'unsupported') {
        await showMessage(parent, { type: 'info', message: 'Shell command unavailable', detail: status.reason });
        return null;
    }

    let replaceForeign = false;
    if (status.state === 'foreign') {
        const { response } = await showMessage(parent, {
            type: 'warning',
            message: `Replace the existing "nimbalyst" command?`,
            detail: `${status.linkPath} already exists${status.target ? ` and points to ${status.target}` : ''}. It was not installed by Nimbalyst.`,
            buttons: ['Replace', 'Cancel'],
            defaultId: 1,
            cancelId: 1,
        });
        if (response !== 0) return null;
        replaceForeign = true;
    }

    const result = await getInstaller().install({ replaceForeign });
    logger.main.info('[ShellCommand] install:', { ok: result.ok, state: result.status.state, error: result.ok ? undefined : result.error });
    if (result.ok) {
        await showMessage(parent, {
            type: 'info',
            message: 'Installed the "nimbalyst" command',
            detail: `Open a new terminal and run "nimbalyst ." to open the current folder in Nimbalyst.\n\nInstalled at ${linkPathOf(result.status)}.`,
        });
    } else if (!result.cancelled) {
        await showMessage(parent, { type: 'error', message: 'Could not install the "nimbalyst" command', detail: result.error });
    }
    return result;
}

export async function uninstallShellCommandInteractive(parent: BrowserWindow | null): Promise<ShellCommandResult | null> {
    const result = await getInstaller().uninstall();
    logger.main.info('[ShellCommand] uninstall:', { ok: result.ok, state: result.status.state, error: result.ok ? undefined : result.error });
    if (result.ok) {
        await showMessage(parent, { type: 'info', message: 'Removed the "nimbalyst" command' });
    } else if (!result.cancelled) {
        await showMessage(parent, { type: 'error', message: 'Could not remove the "nimbalyst" command', detail: result.error });
    }
    return result;
}

function linkPathOf(status: ShellCommandStatus): string {
    return 'linkPath' in status ? status.linkPath : '';
}

export function registerShellCommandHandlers(): void {
    safeHandle('shell-command:get-status', () => getShellCommandStatus());
    safeHandle('shell-command:install', async (event) => {
        await installShellCommandInteractive(BrowserWindow.fromWebContents(event.sender));
        return getShellCommandStatus();
    });
    safeHandle('shell-command:uninstall', async (event) => {
        await uninstallShellCommandInteractive(BrowserWindow.fromWebContents(event.sender));
        return getShellCommandStatus();
    });
}
