/**
 * Nimbalyst Monorepo Tailwind Configuration
 *
 * This is the shared Tailwind configuration for all packages in the monorepo.
 * Individual packages can extend this configuration as needed.
 *
 * Theme colors use CSS variables (--nim-*) which are defined in:
 * - /packages/runtime/src/editor/themes/NimbalystTheme.css (unified theme)
 */

import type { Config } from 'tailwindcss';

const config: Config = {
  content: [
    './packages/*/src/**/*.{ts,tsx,js,jsx}',
    './packages/extensions/*/src/**/*.{ts,tsx,js,jsx,html}',
    './packages/extensions/*/samples/**/*.html',
    './packages/extension-sdk-docs/examples/*/src/**/*.{ts,tsx,js,jsx}',
  ],
  darkMode: ['variant', '&:is([data-theme="dark"] *, [data-theme="crystal-dark"] *)'],
  theme: {
    extend: {
      colors: {
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
        'nim-on-primary': 'var(--nim-on-primary)',
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
      },
      backgroundColor: {
        // Shorthand background colors for common patterns
        nim: 'var(--nim-bg)',
        'nim-secondary': 'var(--nim-bg-secondary)',
        'nim-tertiary': 'var(--nim-bg-tertiary)',
        'nim-hover': 'var(--nim-bg-hover)',
        'nim-selected': 'var(--nim-bg-selected)',
        'nim-active': 'var(--nim-bg-active)',
        'nim-primary': 'var(--nim-primary)',
        'nim-primary-hover': 'var(--nim-primary-hover)',
      },
      textColor: {
        // Shorthand text colors for common patterns
        nim: 'var(--nim-text)',
        'nim-muted': 'var(--nim-text-muted)',
        'nim-faint': 'var(--nim-text-faint)',
        'nim-disabled': 'var(--nim-text-disabled)',
        'nim-link': 'var(--nim-link)',
        'nim-link-hover': 'var(--nim-link-hover)',
        'nim-primary': 'var(--nim-primary)',
        'nim-on-primary': 'var(--nim-on-primary)',
        'nim-success': 'var(--nim-success)',
        'nim-warning': 'var(--nim-warning)',
        'nim-error': 'var(--nim-error)',
        'nim-info': 'var(--nim-info)',
      },
      borderColor: {
        // Shorthand border colors
        nim: 'var(--nim-border)',
        'nim-focus': 'var(--nim-border-focus)',
        'nim-primary': 'var(--nim-primary)',
      },
      keyframes: {
        'bash-dot-pulse': {
          '0%, 60%, 100%': {
            transform: 'scale(1)',
            opacity: '0.4',
          },
          '30%': {
            transform: 'scale(1.2)',
            opacity: '1',
          },
        },
        'mockup-spin': {
          to: {
            transform: 'rotate(360deg)',
          },
        },
        'focus-flash': {
          '0%': {
            backgroundColor: 'var(--nim-bg)',
          },
          '50%': {
            backgroundColor: 'var(--nim-bg-hover)',
          },
          '100%': {
            backgroundColor: 'var(--nim-bg)',
          },
        },
      },
      animation: {
        'bash-dot-pulse': 'bash-dot-pulse 1.4s ease-in-out infinite',
        'mockup-spin': 'mockup-spin 0.8s linear infinite',
        'focus-flash': 'focus-flash 0.4s ease-out',
      },
    },
  },
  plugins: [],
};

export default config;
