/**
 * Theme Context for Rexical
 *
 * This module provides theme information by reading from the DOM's data-theme attribute.
 * The actual theme is controlled at the app level (electron/capacitor) via CSS variables.
 *
 * Components that need to know if they're in dark mode can use useTheme().
 * The theme CSS variables (--nim-*) are automatically available via CSS.
 */

import type { JSX, ReactNode } from 'react';
import { useEffect, useState, useSyncExternalStore } from 'react';

export type Theme = 'light' | 'dark' | (string & {});
export type ThemeConfig = 'light' | 'dark' | 'auto' | (string & {});

/**
 * Get the current theme from the DOM's data-theme attribute.
 */
function getThemeFromDOM(): Theme {
  if (typeof document === 'undefined') {
    return 'light';
  }
  const dataTheme = document.documentElement.getAttribute('data-theme');
  if (dataTheme === 'dark' || dataTheme === 'crystal-dark') {
    return dataTheme;
  }
  // Check class as fallback
  if (document.documentElement.classList.contains('dark-theme')) {
    return 'dark';
  }
  if (document.documentElement.classList.contains('crystal-dark-theme')) {
    return 'crystal-dark';
  }
  return 'light';
}

/**
 * Subscribe to theme changes via MutationObserver on the document element.
 */
function subscribeToThemeChanges(callback: () => void): () => void {
  if (typeof document === 'undefined' || typeof MutationObserver === 'undefined') {
    return () => {};
  }

  const observer = new MutationObserver((mutations) => {
    for (const mutation of mutations) {
      if (
        mutation.type === 'attributes' &&
        (mutation.attributeName === 'data-theme' || mutation.attributeName === 'class')
      ) {
        callback();
        break;
      }
    }
  });

  observer.observe(document.documentElement, {
    attributes: true,
    attributeFilter: ['data-theme', 'class'],
  });

  return () => observer.disconnect();
}

/**
 * Hook to get the current theme from the DOM.
 * Automatically updates when the theme changes.
 *
 * @returns Object with theme and isDark properties
 */
export function useTheme(): { theme: Theme; isDark: boolean; toggleTheme: () => void; setTheme: (theme: Theme) => void } {
  const theme = useSyncExternalStore(
    subscribeToThemeChanges,
    getThemeFromDOM,
    () => 'light' as Theme // Server-side fallback
  );

  const isDark = theme === 'dark' || theme === 'crystal-dark';

  // toggleTheme and setTheme are no-ops - theme is controlled at app level
  const toggleTheme = () => {
    console.warn('[rexical] toggleTheme is deprecated - theme is controlled at app level');
  };

  const setTheme = (_theme: Theme) => {
    console.warn('[rexical] setTheme is deprecated - theme is controlled at app level');
  };

  return { theme, isDark, toggleTheme, setTheme };
}

/**
 * @deprecated ThemeProvider is no longer needed. Theme is read from DOM.
 * This is kept for backwards compatibility but does nothing.
 */
export function ThemeProvider({ children }: { children: ReactNode; initialTheme?: ThemeConfig }): JSX.Element {
  return <>{children}</>;
}
