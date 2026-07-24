/**
 * Nimbalyst Tailwind CSS Preset for Extensions
 *
 * This preset provides the Nimbalyst theme colors and utilities for use in extensions.
 * Extensions that use Tailwind CSS should extend this preset to ensure consistent
 * theming with the host application.
 *
 * @example
 * ```ts
 * // tailwind.config.ts
 * import { nimbalystPreset } from '@nimbalyst/extension-sdk/tailwind';
 *
 * export default {
 *   presets: [nimbalystPreset],
 *   content: ['./src/**\/*.{ts,tsx}'],
 * };
 * ```
 */

import type { Config } from 'tailwindcss';

/**
 * Nimbalyst theme color configuration for Tailwind CSS.
 * These map to the --nim-* CSS variables defined by the host application.
 */
export const nimbalystColors = {
  // Nimbalyst theme colors - conventional naming that matches CSS/Tailwind mental models
  nim: {
    // Backgrounds (use: bg-nim, bg-nim-secondary, etc.)
    DEFAULT: 'var(--nim-bg)',
    secondary: 'var(--nim-bg-secondary)',
    tertiary: 'var(--nim-bg-tertiary)',
    hover: 'var(--nim-bg-hover)',
    selected: 'var(--nim-bg-selected)',
    active: 'var(--nim-bg-active)',
  },
  'nim-text': {
    // Text (use: text-nim-text, text-nim-text-muted, etc.)
    DEFAULT: 'var(--nim-text)',
    muted: 'var(--nim-text-muted)',
    faint: 'var(--nim-text-faint)',
    disabled: 'var(--nim-text-disabled)',
  },
  'nim-border': {
    // Borders (use: border-nim-border, border-nim-border-focus)
    DEFAULT: 'var(--nim-border)',
    focus: 'var(--nim-border-focus)',
  },
  'nim-primary': {
    // Primary action color (use: bg-nim-primary, text-nim-primary)
    DEFAULT: 'var(--nim-primary)',
    hover: 'var(--nim-primary-hover)',
  },
  'nim-link': {
    // Links (use: text-nim-link)
    DEFAULT: 'var(--nim-link)',
    hover: 'var(--nim-link-hover)',
  },
  // Status colors
  'nim-success': 'var(--nim-success)',
  'nim-warning': 'var(--nim-warning)',
  'nim-error': 'var(--nim-error)',
  'nim-info': 'var(--nim-info)',
};

/**
 * Shorthand background color utilities for common patterns.
 */
export const nimbalystBackgroundColors = {
  nim: 'var(--nim-bg)',
  'nim-secondary': 'var(--nim-bg-secondary)',
  'nim-tertiary': 'var(--nim-bg-tertiary)',
  'nim-hover': 'var(--nim-bg-hover)',
  'nim-selected': 'var(--nim-bg-selected)',
  'nim-active': 'var(--nim-bg-active)',
  'nim-primary': 'var(--nim-primary)',
  'nim-primary-hover': 'var(--nim-primary-hover)',
};

/**
 * Shorthand text color utilities for common patterns.
 */
export const nimbalystTextColors = {
  nim: 'var(--nim-text)',
  'nim-muted': 'var(--nim-text-muted)',
  'nim-faint': 'var(--nim-text-faint)',
  'nim-disabled': 'var(--nim-text-disabled)',
  'nim-link': 'var(--nim-link)',
  'nim-link-hover': 'var(--nim-link-hover)',
  'nim-primary': 'var(--nim-primary)',
  'nim-success': 'var(--nim-success)',
  'nim-warning': 'var(--nim-warning)',
  'nim-error': 'var(--nim-error)',
  'nim-info': 'var(--nim-info)',
};

/**
 * Shorthand border color utilities.
 */
export const nimbalystBorderColors = {
  nim: 'var(--nim-border)',
  'nim-focus': 'var(--nim-border-focus)',
  'nim-primary': 'var(--nim-primary)',
};

/**
 * Nimbalyst Tailwind CSS preset.
 *
 * Use this preset in your extension's tailwind.config.ts to get access
 * to the Nimbalyst theme colors and utilities.
 *
 * @example
 * ```ts
 * // tailwind.config.ts
 * import { nimbalystPreset } from '@nimbalyst/extension-sdk/tailwind';
 *
 * export default {
 *   presets: [nimbalystPreset],
 *   content: ['./src/**\/*.{ts,tsx}'],
 * };
 * ```
 */
export const nimbalystPreset: Config = {
  content: [],
  darkMode: ['class', '[data-theme="dark"], [data-theme="crystal-dark"]'],
  theme: {
    extend: {
      colors: nimbalystColors,
      backgroundColor: nimbalystBackgroundColors,
      textColor: nimbalystTextColors,
      borderColor: nimbalystBorderColors,
    },
  },
  plugins: [],
};

export default nimbalystPreset;
