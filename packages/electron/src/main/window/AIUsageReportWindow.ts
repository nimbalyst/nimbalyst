import electron from 'electron';
import { join } from 'path';
import { getPreloadPath } from '../utils/appPaths';

const { app, BrowserWindow } = electron;

let usageReportWindow: electron.BrowserWindow | null = null;

export function createAIUsageReportWindow(): electron.BrowserWindow {
  // If window already exists, focus it
  if (usageReportWindow && !usageReportWindow.isDestroyed()) {
    usageReportWindow.focus();
    return usageReportWindow;
  }

  // Create the browser window
  usageReportWindow = new BrowserWindow({
    width: 1200,
    height: 800,
    show: false,
    autoHideMenuBar: true,
    title: 'AI Usage Report',
    webPreferences: {
      preload: getPreloadPath(),
      sandbox: false,
      contextIsolation: true,
    },
  });

  usageReportWindow.on('ready-to-show', () => {
    usageReportWindow?.show();
  });

  usageReportWindow.on('closed', () => {
    usageReportWindow = null;
  });

  // Load the usage report page
  if (!app.isPackaged && process.env['ELECTRON_RENDERER_URL']) {
    usageReportWindow.loadURL(`${process.env['ELECTRON_RENDERER_URL']}?mode=usage-report`);
  } else {
    // Note: Due to code splitting, __dirname is out/main/chunks/, not out/main/
    // Use app.getAppPath() to reliably find the renderer
    const appPath = app.getAppPath();
    let htmlPath: string;
    if (app.isPackaged) {
      htmlPath = join(appPath, 'out/renderer/index.html');
    } else if (appPath.includes('/out/main') || appPath.includes('\\out\\main')) {
      htmlPath = join(appPath, '../renderer/index.html');
    } else {
      htmlPath = join(appPath, 'out/renderer/index.html');
    }
    usageReportWindow.loadFile(htmlPath, {
      query: { mode: 'usage-report' },
    });
  }

  return usageReportWindow;
}

export function getAIUsageReportWindow(): electron.BrowserWindow | null {
  return usageReportWindow;
}

export function closeAIUsageReportWindow(): void {
  if (usageReportWindow && !usageReportWindow.isDestroyed()) {
    usageReportWindow.close();
  }
}
