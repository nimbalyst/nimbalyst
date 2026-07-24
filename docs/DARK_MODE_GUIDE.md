# Dark Mode Support Guide

This guide explains how to properly implement dark mode support for components in Nimbalyst.

## Overview

Nimbalyst uses a unified theming system with CSS variables. All themes (including dark themes) are applied via the `--nim-*` CSS variables, which are set dynamically by the theme system.

For detailed theming documentation, see **[packages/electron/THEMING.md](/packages/electron/THEMING.md)**.

## Quick Start

### Use CSS Variables for All Colors

```css
/* Always use --nim-* variables - they automatically adapt to any theme */
.my-component {
  background-color: var(--nim-bg);
  color: var(--nim-text);
  border: 1px solid var(--nim-border);
}

.my-component:hover {
  background-color: var(--nim-bg-hover);
}

.my-button {
  background-color: var(--nim-primary);
  color: white;
}

.my-button:hover {
  background-color: var(--nim-primary-hover);
}
```

### No Theme-Specific Selectors Needed

With the unified theme system, you do NOT need to add separate selectors for dark themes. The CSS variables automatically get the correct values for each theme.

**Avoid this pattern:**
```css
/* BAD: Theme-specific selectors are not needed */
[data-theme="dark"] .my-component { ... }
[data-theme="crystal-dark"] .my-component { ... }
```

**Use this pattern instead:**
```css
/* GOOD: Just use CSS variables */
.my-component {
  background: var(--nim-bg);
  color: var(--nim-text);
}
```

### When You Need Dark-Specific Styling

In rare cases where you need truly different styling in dark mode (not just different colors), use the `.dark-theme` class which is applied to both dark and crystal-dark themes:

```css
/* Only use this for structural differences, not colors */
.dark-theme .my-icon {
  filter: invert(1);
}
```

## Available CSS Variables

See [THEMING.md](/packages/electron/THEMING.md) for the complete list of `--nim-*` variables.

Key variables:
- `--nim-bg`, `--nim-bg-secondary`, `--nim-bg-tertiary` - Backgrounds
- `--nim-text`, `--nim-text-muted`, `--nim-text-faint` - Text colors
- `--nim-border`, `--nim-border-focus` - Borders
- `--nim-primary`, `--nim-primary-hover` - Action/brand colors
- `--nim-success`, `--nim-error`, `--nim-warning` - Status colors

## Separate Electron Windows

Each Electron window (About, Session Manager, etc.) receives theme updates via IPC. The main window broadcasts theme changes, and each window applies the appropriate class.

For new windows, ensure they:
1. Listen for `theme-change` IPC events
2. Apply `dark-theme` class when theme is `dark` or `crystal-dark`
3. Set `data-theme` attribute for any legacy selectors

## Testing

Always test your component in:
1. Light theme
2. Dark theme
3. Crystal Dark theme (or any other dark theme variants)

Theme changes can be tested via Window > Theme menu.
