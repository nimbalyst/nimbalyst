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

/** Applies the theme before the first paint and follows the system setting after. */
export function initializeTheme(): void {
  const query = window.matchMedia('(prefers-color-scheme: dark)');
  apply(query.matches);
  query.addEventListener('change', (event) => apply(event.matches));
}
