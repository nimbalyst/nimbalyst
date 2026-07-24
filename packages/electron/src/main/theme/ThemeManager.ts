import { BrowserWindow, nativeTheme } from 'electron';
import { getTheme, getThemeIsDark } from '../utils/store';

/**
 * Determine if the current theme is dark.
 * Only 'light' and 'dark' are true built-in themes.
 * For file-based themes, uses the stored isDark value from theme metadata.
 */
function isCurrentThemeDark(currentTheme: string): boolean {
    // Built-in themes
    if (currentTheme === 'light') return false;
    if (currentTheme === 'dark') return true;

    // System theme - check OS preference
    if (currentTheme === 'system') {
        return nativeTheme.shouldUseDarkColors;
    }

    // For file-based themes (crystal-dark, solarized-light, etc.), use stored isDark value
    // The isDark value is stored when the theme is selected
    return getThemeIsDark() ?? currentTheme.includes('dark');
}

// Function to update native theme
export function updateNativeTheme() {
    const currentTheme = getTheme();

    // Map to system/dark/light for nativeTheme
    let desired: 'system' | 'dark' | 'light';
    if (currentTheme === 'system') {
        desired = 'system';
    } else if (isCurrentThemeDark(currentTheme)) {
        desired = 'dark';
    } else {
        desired = 'light';
    }

    // Only set when it actually changes to avoid spurious 'updated' events
    if (nativeTheme.themeSource !== desired) {
        nativeTheme.themeSource = desired;
    }
}

// Function to update window title bar colors based on theme
export function updateWindowTitleBars() {
    const currentTheme = getTheme();
    const isDarkTheme = isCurrentThemeDark(currentTheme);

    // Do NOT touch nativeTheme.themeSource here to avoid triggering
    // nativeTheme 'updated' recursively. Only adjust window visuals.

    // Title bar colors for light and dark modes
    // For file-based themes, we use generic light/dark colors
    const titleBarColors = {
        dark: { color: '#1a1a1a', symbolColor: '#ffffff' },
        light: { color: '#ffffff', symbolColor: '#374151' }
    };

    // Select appropriate colors based on whether theme is dark or light
    const titleBarColor = isDarkTheme ? titleBarColors.dark : titleBarColors.light;
    const backgroundColor = isDarkTheme ? '#1a1a1a' : '#ffffff';

    // Update all windows
    BrowserWindow.getAllWindows().forEach(window => {
        // Update background color
        window.setBackgroundColor(backgroundColor);

        // Update title bar overlay on Windows/Linux
        if (process.platform !== 'darwin' && window.setTitleBarOverlay) {
          try {
            window.setTitleBarOverlay(titleBarColor);
          } catch (error) {
            console.error('Error setting title bar overlay:', error);
          }
        }

        // Send theme-change event to all windows
        // Each window's renderer listens to this and updates its own UI
        window.webContents.send('theme-change', currentTheme);
    });
}

// Get title bar colors for current theme
export function getTitleBarColors() {
    const isDarkTheme = isCurrentThemeDark(getTheme());

    const titleBarColors = {
        dark: { color: '#1a1a1a', symbolColor: '#ffffff' },
        light: { color: '#ffffff', symbolColor: '#374151' }
    };

    return isDarkTheme ? titleBarColors.dark : titleBarColors.light;
}

// Get background color for current theme
// Note: For file-based themes, the actual --nim-bg may differ from this initial color.
// This is used for the window background before the renderer loads.
export function getBackgroundColor() {
    const isDarkTheme = isCurrentThemeDark(getTheme());
    return isDarkTheme ? '#1a1a1a' : '#ffffff';
}
