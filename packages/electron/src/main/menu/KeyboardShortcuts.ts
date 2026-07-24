/**
 * Centralized keyboard shortcuts for the application (Main Process)
 * Imports from shared constants and converts to Electron accelerator format
 */

import {
  KeyboardShortcuts as SharedShortcuts,
  getElectronAccelerator
} from '../../shared/KeyboardShortcuts';

// Convert all shortcuts to Electron accelerator format
function convertShortcuts<T extends Record<string, any>>(shortcuts: T): T {
  const result = {} as T;
  for (const [key, value] of Object.entries(shortcuts)) {
    if (typeof value === 'string') {
      result[key as keyof T] = getElectronAccelerator(value) as T[keyof T];
    } else if (typeof value === 'object' && value !== null) {
      result[key as keyof T] = convertShortcuts(value) as T[keyof T];
    } else {
      result[key as keyof T] = value;
    }
  }
  return result;
}

export const KeyboardShortcuts = convertShortcuts(SharedShortcuts);

/**
 * Get a human-readable description of a keyboard shortcut
 */
export function getShortcutDescription(shortcut: string): string {
  return shortcut
    .replace('CmdOrCtrl', process.platform === 'darwin' ? 'Cmd' : 'Ctrl')
    .replace('Command', 'Cmd')
    .replace('Control', 'Ctrl')
    .replace('Alt', process.platform === 'darwin' ? 'Option' : 'Alt')
    .replace('+', ' + ');
}
