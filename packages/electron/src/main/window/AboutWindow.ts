import { app, BrowserWindow, nativeTheme } from 'electron';
import { join } from 'path';
import { getPreloadPath } from '../utils/appPaths';
import { getTheme } from '../utils/store';

let aboutWindow: BrowserWindow | null = null;

export function createAboutWindow() {
    if (aboutWindow && !aboutWindow.isDestroyed()) {
        aboutWindow.focus();
        return;
    }

    const currentTheme = getTheme();
    const isDarkTheme = nativeTheme.shouldUseDarkColors || currentTheme === 'dark' || currentTheme === 'crystal-dark';

    aboutWindow = new BrowserWindow({
        width: 650,
        height: 700,
        resizable: false,
        minimizable: false,
        maximizable: false,
        fullscreenable: false,
        title: 'About Nimbalyst',
        show: false,
        backgroundColor: isDarkTheme ? '#2d2d2d' : '#ffffff',
        titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'default',
        webPreferences: {
            preload: getPreloadPath(),
            nodeIntegration: false,
            contextIsolation: true,
            webviewTag: false
        }
    });

    // Load the about.html file
    // In production, the file is copied to the renderer output directory
    // In development, it's served by the dev server
    if (process.env['ELECTRON_RENDERER_URL']) {
        aboutWindow.loadURL(`${process.env['ELECTRON_RENDERER_URL']}/about.html`);
    } else {
        // Note: Due to code splitting, __dirname is out/main/chunks/, not out/main/
        // Use app.getAppPath() to reliably find the renderer
        const appPath = app.getAppPath();
        let htmlPath: string;
        if (app.isPackaged) {
            htmlPath = join(appPath, 'out/renderer/about.html');
        } else if (appPath.includes('/out/main') || appPath.includes('\\out\\main')) {
            htmlPath = join(appPath, '../renderer/about.html');
        } else {
            htmlPath = join(appPath, 'out/renderer/about.html');
        }
        aboutWindow.loadFile(htmlPath);
    }

    aboutWindow.once('ready-to-show', () => {
        aboutWindow?.show();
        // Send initial theme
        aboutWindow?.webContents.send('theme-change', currentTheme);
    });

    aboutWindow.on('closed', () => {
        aboutWindow = null;
    });
}

export function updateAboutWindowTheme() {
    if (aboutWindow && !aboutWindow.isDestroyed()) {
        const currentTheme = getTheme();
        const isDarkTheme = nativeTheme.shouldUseDarkColors || currentTheme === 'dark' || currentTheme === 'crystal-dark';
        aboutWindow.setBackgroundColor(isDarkTheme ? '#2a2a2a' : '#ffffff');
        aboutWindow.webContents.send('theme-change', currentTheme);
    }
}

export function getAboutWindow(): BrowserWindow | null {
    return aboutWindow;
}