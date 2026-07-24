import * as fs from 'fs';
import * as path from 'path';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { app } from 'electron';
import { logger } from '../utils/logger';

const execFileAsync = promisify(execFile);

export function registerLinuxAppImageProtocolHandler(): void {
    if (process.platform !== 'linux' || !process.env.APPIMAGE) {
        return;
    }

    const appImagePath = process.env.APPIMAGE;

    for (const ch of appImagePath) {
        const code = ch.codePointAt(0) ?? 0;
        if (code < 0x20) {
            logger.main.warn('[LinuxProtocol] APPIMAGE path contains control characters; skipping desktop entry registration');
            return;
        }
    }

    const appsDir = process.env.XDG_DATA_HOME
        ? path.join(process.env.XDG_DATA_HOME, 'applications')
        : path.join(app.getPath('home'), '.local', 'share', 'applications');

    const desktopFilePath = path.join(appsDir, 'nimbalyst-url-handler.desktop');

    const escapedPath = appImagePath
        .replace(/\\/g, '\\\\')
        .replace(/"/g, '\\"')
        .replace(/`/g, '\\`')
        .replace(/\$/g, '\\$');

    const expectedExecLine = `Exec="${escapedPath}" %u`;

    try {
        if (fs.existsSync(desktopFilePath)) {
            const existing = fs.readFileSync(desktopFilePath, 'utf-8');
            const execLine = existing.split('\n').find(line => line.startsWith('Exec='));
            if (execLine && execLine === expectedExecLine) {
                logger.main.info('[LinuxProtocol] Desktop entry already up to date; skipping registration');
                return;
            }
        }
    } catch (err) {
        logger.main.warn('[LinuxProtocol] Failed to read existing desktop entry:', err);
    }

    const desktopEntry = [
        '[Desktop Entry]',
        'Name=Nimbalyst',
        expectedExecLine,
        'Type=Application',
        'Terminal=false',
        'MimeType=x-scheme-handler/nimbalyst;',
        'NoDisplay=true',
        '',
    ].join('\n');

    try {
        fs.mkdirSync(appsDir, { recursive: true });
        fs.writeFileSync(desktopFilePath, desktopEntry, 'utf-8');
        logger.main.info(`[LinuxProtocol] Wrote desktop entry to ${desktopFilePath}`);
    } catch (err) {
        logger.main.warn('[LinuxProtocol] Failed to write desktop entry:', err);
        return;
    }

    execFileAsync('update-desktop-database', [appsDir]).catch(err => {
        logger.main.warn('[LinuxProtocol] update-desktop-database failed (may be absent):', err);
    });

    execFileAsync('xdg-mime', ['default', 'nimbalyst-url-handler.desktop', 'x-scheme-handler/nimbalyst']).catch(err => {
        logger.main.warn('[LinuxProtocol] xdg-mime failed (may be absent):', err);
    });
}
