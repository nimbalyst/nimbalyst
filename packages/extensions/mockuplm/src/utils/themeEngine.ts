/**
 * MockupLM Theme Engine
 *
 * Provides runtime theme switching for mockup iframes by injecting
 * CSS custom properties. Mockups that use var(--mockup-*) variables
 * will update instantly without regenerating HTML.
 */

export type MockupTheme = 'light' | 'dark';

interface ThemeColors {
  bg: string;
  bgSecondary: string;
  bgTertiary: string;
  bgActive: string;
  text: string;
  textMuted: string;
  textFaint: string;
  textDisabled: string;
  border: string;
  borderSubtle: string;
  primary: string;
  primaryText: string;
  secondary: string;
  secondaryText: string;
  success: string;
  warning: string;
  error: string;
  codeBg: string;
  codeText: string;
  shadow: string;
}

const THEMES: Record<MockupTheme, ThemeColors> = {
  dark: {
    bg: '#2d2d2d',
    bgSecondary: '#1a1a1a',
    bgTertiary: '#3a3a3a',
    bgActive: '#4a4a4a',
    text: '#ffffff',
    textMuted: '#b3b3b3',
    textFaint: '#808080',
    textDisabled: '#666666',
    border: '#4a4a4a',
    borderSubtle: '#3a3a3a',
    primary: '#60a5fa',
    primaryText: '#ffffff',
    secondary: '#a78bfa',
    secondaryText: '#ffffff',
    success: '#4ade80',
    warning: '#fbbf24',
    error: '#ef4444',
    codeBg: '#1e1e1e',
    codeText: '#d4d4d4',
    shadow: 'rgba(0, 0, 0, 0.4)',
  },
  light: {
    bg: '#ffffff',
    bgSecondary: '#f9fafb',
    bgTertiary: '#f3f4f6',
    bgActive: '#e5e7eb',
    text: '#111827',
    textMuted: '#6b7280',
    textFaint: '#9ca3af',
    textDisabled: '#d1d5db',
    border: '#e5e7eb',
    borderSubtle: '#f3f4f6',
    primary: '#3b82f6',
    primaryText: '#ffffff',
    secondary: '#8b5cf6',
    secondaryText: '#ffffff',
    success: '#22c55e',
    warning: '#f59e0b',
    error: '#ef4444',
    codeBg: '#f9fafb',
    codeText: '#1f2937',
    shadow: 'rgba(0, 0, 0, 0.1)',
  },
};

/**
 * Generate a CSS stylesheet string with --mockup-* variables for the given theme.
 */
export function generateThemeCSS(theme: MockupTheme): string {
  const colors = THEMES[theme];
  return `:root {
  --mockup-bg: ${colors.bg};
  --mockup-bg-secondary: ${colors.bgSecondary};
  --mockup-bg-tertiary: ${colors.bgTertiary};
  --mockup-bg-active: ${colors.bgActive};
  --mockup-text: ${colors.text};
  --mockup-text-muted: ${colors.textMuted};
  --mockup-text-faint: ${colors.textFaint};
  --mockup-text-disabled: ${colors.textDisabled};
  --mockup-border: ${colors.border};
  --mockup-border-subtle: ${colors.borderSubtle};
  --mockup-primary: ${colors.primary};
  --mockup-primary-text: ${colors.primaryText};
  --mockup-secondary: ${colors.secondary};
  --mockup-secondary-text: ${colors.secondaryText};
  --mockup-success: ${colors.success};
  --mockup-warning: ${colors.warning};
  --mockup-error: ${colors.error};
  --mockup-code-bg: ${colors.codeBg};
  --mockup-code-text: ${colors.codeText};
  --mockup-shadow: ${colors.shadow};
}`;
}

/**
 * Inject or update theme CSS variables into a mockup iframe document.
 */
export function injectTheme(iframeDoc: Document, theme: MockupTheme): void {
  const STYLE_ID = 'nimbalyst-theme-vars';
  let styleEl = iframeDoc.getElementById(STYLE_ID) as HTMLStyleElement | null;
  if (!styleEl) {
    styleEl = iframeDoc.createElement('style');
    styleEl.id = STYLE_ID;
    iframeDoc.head.prepend(styleEl);
  }
  styleEl.textContent = generateThemeCSS(theme);
}

/**
 * Get the list of available theme names.
 */
export function getAvailableThemes(): MockupTheme[] {
  return Object.keys(THEMES) as MockupTheme[];
}
