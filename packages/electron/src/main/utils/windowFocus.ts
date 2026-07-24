import { BrowserWindow } from 'electron';
import { logger } from './logger';

/**
 * Reliably gets the focused window using multiple detection methods.
 *
 * This is more reliable than just BrowserWindow.getFocusedWindow() which can
 * sometimes return stale results, especially when focus changes rapidly.
 *
 * @returns The focused window, or null if no window is focused
 */
export function getFocusedWindow(): BrowserWindow | null {
  const allWindows = BrowserWindow.getAllWindows();

  // Try multiple methods to find the truly focused window
  const getFocusedResult = BrowserWindow.getFocusedWindow();
  const isFocusedResults = allWindows.filter(w => !w.isDestroyed() && w.isFocused());

  // Use the most reliable focused window
  const focused = isFocusedResults.length === 1
    ? isFocusedResults[0]
    : getFocusedResult;

  if (!focused) {
    logger.menu.debug('[getFocusedWindow] No focused window found');
  }

  return focused;
}
