import { BrowserWindow, app, nativeTheme } from 'electron';
import { join } from 'path';
import { existsSync, readFileSync } from 'fs';
import { getBackgroundColor } from '../theme/ThemeManager';
import { getTheme, getThemeIsDark } from '../utils/store';

let splashWindow: BrowserWindow | null = null;

/**
 * Determine if the theme is dark (simplified version for splash screen).
 * Mirrors the logic in ThemeManager but kept local to avoid circular deps.
 */
function isDark(): boolean {
    const theme = getTheme();
    if (theme === 'light') return false;
    if (theme === 'dark') return true;
    if (theme === 'system') return nativeTheme.shouldUseDarkColors;
    // File-based themes
    return getThemeIsDark() ?? false;
}

/**
 * Get the app icon as a base64 data URL for embedding in the splash screen.
 */
function getIconDataUrl(): string | null {
    try {
        const iconPath = join(app.getAppPath(), 'icon.png');

        if (existsSync(iconPath)) {
            const iconData = readFileSync(iconPath);
            return `data:image/png;base64,${iconData.toString('base64')}`;
        }
    } catch {
        // Icon loading is best-effort
    }
    return null;
}

/**
 * Build inline HTML for the splash screen.
 * Icon is embedded as base64 data URL directly in the HTML.
 */
function buildSplashHTML(): string {
    const dark = isDark();
    const bg = dark ? '#1a1a1a' : '#ffffff';
    const textColor = dark ? '#e5e7eb' : '#374151';
    const subtextColor = dark ? '#9ca3af' : '#6b7280';
    const dotColor = dark ? '#6b7280' : '#9ca3af';
    const iconDataUrl = getIconDataUrl();

    const iconHtml = iconDataUrl
        ? `<img class="icon" src="${iconDataUrl}" alt="">`
        : '';

    return `<!DOCTYPE html>
<html>
<head>
<meta charset="UTF-8">
<style>
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body {
    background: ${bg};
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    height: 100vh;
    font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
    -webkit-app-region: drag;
    user-select: none;
    overflow: hidden;
  }
  .icon {
    width: 80px;
    height: 80px;
    margin-bottom: 24px;
    border-radius: 16px;
  }
  .title {
    font-size: 22px;
    font-weight: 600;
    color: ${textColor};
    letter-spacing: -0.3px;
    margin-bottom: 12px;
  }
  .status {
    font-size: 13px;
    color: ${subtextColor};
    display: flex;
    align-items: center;
    gap: 2px;
  }
  .dots {
    display: inline-flex;
    gap: 3px;
    margin-left: 2px;
  }
  .dot {
    width: 3px;
    height: 3px;
    border-radius: 50%;
    background: ${dotColor};
    animation: pulse 1.4s ease-in-out infinite;
  }
  .dot:nth-child(2) { animation-delay: 0.2s; }
  .dot:nth-child(3) { animation-delay: 0.4s; }
  @keyframes pulse {
    0%, 80%, 100% { opacity: 0.3; transform: scale(0.8); }
    40% { opacity: 1; transform: scale(1); }
  }
</style>
</head>
<body>
  ${iconHtml}
  <div class="title">Nimbalyst</div>
  <div class="status">Initializing<span class="dots"><span class="dot"></span><span class="dot"></span><span class="dot"></span></span></div>
</body>
</html>`;
}

/**
 * Show the splash screen. Should be called as early as possible in app.whenReady().
 * Returns the BrowserWindow so it can be closed later.
 */
export function showSplashScreen(): BrowserWindow | null {
    if (splashWindow && !splashWindow.isDestroyed()) {
        return splashWindow;
    }

    splashWindow = new BrowserWindow({
        width: 340,
        height: 300,
        resizable: false,
        frame: false,
        backgroundColor: getBackgroundColor(),
        show: false,
        center: true,
        skipTaskbar: true,
        alwaysOnTop: false,
        webPreferences: {
            nodeIntegration: false,
            contextIsolation: true,
            webviewTag: false,
        },
    });

    const html = buildSplashHTML();
    splashWindow.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`);

    splashWindow.once('ready-to-show', () => {
        if (splashWindow && !splashWindow.isDestroyed()) {
            // Use showInactive to avoid activating the app prematurely.
            // The splash has alwaysOnTop:true so it will be visible regardless.
            splashWindow.showInactive();
        }
    });

    splashWindow.on('closed', () => {
        splashWindow = null;
    });

    return splashWindow;
}

/**
 * Close the splash screen.
 */
export function closeSplashScreen(): void {
    if (!splashWindow || splashWindow.isDestroyed()) {
        splashWindow = null;
        return;
    }

    const win = splashWindow;
    splashWindow = null;

    // Brief delay before closing to avoid abrupt disappearance
    setTimeout(() => {
        if (!win.isDestroyed()) {
            win.close();
        }
    }, 200);
}

/**
 * Check if splash screen is currently showing.
 */
export function isSplashScreenVisible(): boolean {
    return splashWindow !== null && !splashWindow.isDestroyed();
}
