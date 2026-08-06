/**
 * Theme Atoms
 *
 * Global theme state that all themed components can subscribe to.
 * Platform-specific code (Electron IPC, Capacitor) updates this atom,
 * and all subscribing components re-render.
 *
 * Key principle: Theme is one of the few cases where widespread re-rendering
 * is expected and correct - every themed component needs to repaint.
 * The atom approach gives components control over their own subscriptions,
 * unlike prop drilling where the parent decides what to re-render.
 */
/**
 * Available theme identifiers.
 * Only 'light' and 'dark' are true built-in themes.
 * Other themes (crystal-dark, solarized-light, etc.) are loaded from files.
 */
export type ThemeId = 'light' | 'dark' | (string & {});
/**
 * Theme color values for use in components.
 */
export interface ThemeColors {
    background: string;
    foreground: string;
    accent: string;
    border: string;
    editorBackground: string;
    editorForeground: string;
    syntaxKeyword: string;
    syntaxString: string;
    syntaxComment: string;
    syntaxVariable: string;
}
/**
 * Full theme object with metadata and colors.
 */
export interface Theme {
    id: ThemeId;
    name: string;
    isDark: boolean;
    colors: ThemeColors;
}
/**
 * Current theme ID atom.
 * Components subscribe to this to react to theme changes.
 */
export declare const themeIdAtom: import("jotai").PrimitiveAtom<ThemeId> & {
    init: ThemeId;
};
/**
 * Derived: full theme object.
 * Use this when you need more than just the theme ID.
 * For file-based themes not in the themes map, returns the appropriate
 * base theme (dark for themes with 'dark' in their name, light otherwise).
 */
export declare const themeAtom: import("jotai").Atom<Theme>;
/**
 * Derived: is current theme dark?
 * Useful for components that only care about light vs dark.
 * Defaults to true (dark) if theme is not found.
 */
export declare const isDarkThemeAtom: import("jotai").Atom<boolean>;
/**
 * Derived: theme colors only.
 * Use when you just need colors and don't care about other theme metadata.
 * Falls back to dark theme colors if theme is not found.
 */
export declare const themeColorsAtom: import("jotai").Atom<ThemeColors>;
/**
 * Action: set theme.
 * Called by platform-specific code when theme changes.
 */
export declare const setThemeAtom: import("jotai").WritableAtom<null, [themeId: ThemeId], void> & {
    init: null;
};
/**
 * Get the theme object by ID.
 * Useful outside of React context.
 */
export declare function getThemeById(id: ThemeId): Theme;
/**
 * Register custom theme.
 * Allows extensions to add their own themes.
 */
export declare function registerCustomTheme(theme: Theme): void;
