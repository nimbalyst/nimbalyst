/**
 * Light or dark from the system setting, written as the canonical `--nim-*`
 * variables every bundle component reads. The palette is the desktop's own
 * table, so a color means the same thing here as in the app.
 */
import { getBaseThemeColors } from '@nimbalyst/runtime-source/editor/themes/palette';

function apply(isDark: boolean): void {
  const root = document.documentElement;
  root.classList.remove('dark-theme', 'light-theme');
  root.classList.add(isDark ? 'dark-theme' : 'light-theme');
  root.setAttribute('data-theme', isDark ? 'dark' : 'light');
  for (const [key, value] of Object.entries(getBaseThemeColors(isDark))) {
    if (value && !key.startsWith('terminal-')) root.style.setProperty(`--nim-${key}`, value);
  }
  root.style.colorScheme = isDark ? 'dark' : 'light';
}

const themeListeners = new Set<(theme: 'dark' | 'light') => void>();

/** The reader's choice from the theme toggle; null follows the system. Kept for this tab only. */
let chosen: 'dark' | 'light' | null = null;

function applyAndNotify(isDark: boolean): void {
  apply(isDark);
  for (const listener of [...themeListeners]) listener(isDark ? 'dark' : 'light');
}

/** Applies the theme before the first paint and follows the system setting after, until the reader picks one. */
export function initializeTheme(): void {
  const query = window.matchMedia('(prefers-color-scheme: dark)');
  apply(query.matches);
  query.addEventListener('change', (event) => {
    if (chosen === null) applyAndNotify(event.matches);
  });
}

/** The theme toggle: light or dark from now on in this tab, editors included. */
export function setTheme(theme: 'dark' | 'light'): void {
  chosen = theme;
  applyAndNotify(theme === 'dark');
}

/** The theme name extension editors are given (`host.theme`). */
export function currentTheme(): 'dark' | 'light' {
  return document.documentElement.getAttribute('data-theme') === 'dark' ? 'dark' : 'light';
}

export function onThemeChange(listener: (theme: 'dark' | 'light') => void): () => void {
  themeListeners.add(listener);
  return () => themeListeners.delete(listener);
}
