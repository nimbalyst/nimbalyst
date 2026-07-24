# Extension Theming Guide

This document explains how to create custom themes for Nimbalyst using the extension system.

## Overview

Extensions can contribute custom color themes that users can select from the theme picker. Extension themes are layered on top of a base theme (light or dark), allowing you to override only the colors you want to change.

## Quick Start

To add themes to your extension, add a `themes` array to your `manifest.json`:

```json
{
  "id": "my-extension",
  "name": "My Extension",
  "version": "1.0.0",
  "main": "dist/index.js",
  "contributions": {
    "themes": [
      {
        "id": "my-dark-theme",
        "name": "My Dark Theme",
        "isDark": true,
        "colors": {
          "bg": "#1a1a2e",
          "primary": "#e94560",
          "text": "#eaeaea"
        }
      }
    ]
  }
}
```

No JavaScript code is required for theme-only contributions.

## Manifest-only theme extensions

If your extension only contributes themes (no editors, AI tools, panels, plugins, etc.), you can ship it as a **manifest-only extension** -- no `main` field, no `dist/`, no compiled JavaScript. The runtime treats the package as inert except for the theme registration.

```json
{
  "id": "com.example.theme-pack",
  "name": "Theme Pack",
  "version": "1.0.0",
  "contributions": {
    "themes": [
      { "id": "ocean", "name": "Ocean", "isDark": true, "colors": { "primary": "#0aa5cd" } },
      { "id": "forest", "name": "Forest", "isDark": true, "colors": { "primary": "#2da44e" } }
    ]
  }
}
```

That's the entire extension -- a single `manifest.json` in a directory. No build step required. The marketplace packaging accepts this shape; the dev-tools manifest validator no longer flags missing `main` for theme-only extensions.

## Namespacing & ID collisions

Theme IDs are namespaced as `extensionId:themeId` at runtime so two extensions can declare the same `id` without conflict. Extension `com.acme.themes` declaring `id: "dracula"` becomes `com.acme.themes:dracula` in the registry; another extension declaring `id: "dracula"` becomes `<their-id>:dracula`. Both appear independently in the Themes panel.

If your extension declares two themes with the same `id` in its own manifest, validation fails and the extension does not load.

If a filesystem theme bundle already uses an ID like `solarized-dark`, an extension that also declares `solarized-dark` is fine -- namespacing keeps them distinct.

## Color derivation

Beyond merging your overrides on top of the base theme, the runtime *derives* missing domain-specific colors from your overrides so tables, code blocks, scrollbars, and the terminal stay consistent with your palette. The derivations (in `packages/runtime/src/editor/themes/registry.ts`) include:

- **Tables**: `table-header` from `bg-secondary`, `table-cell` from `bg`, `table-stripe` from `bg-tertiary`, `table-border` from `border`.
- **Code blocks**: `code-bg` from `bg-secondary`, `code-text` from `text`, `code-border` from `border`, `code-gutter` from `bg-tertiary`.
- **Toolbar**: `toolbar-bg` from `bg`, `toolbar-border` from `border`, `toolbar-hover` from `bg-hover`.
- **Scrollbar**: `scrollbar-thumb` from `text-faint`, `scrollbar-thumb-hover` from `text-muted`.
- **Quote**: `quote-text` from `text-muted`, `quote-border` from `border`.
- **Terminal**: `terminal-bg` from `bg-secondary`, `terminal-fg` from `text`, `terminal-cursor` from `primary`, `terminal-selection` from `bg-selected`. ANSI red/green/yellow/blue derive from `error` / `success` / `warning` / `info` respectively.

If you want full control over any derived value, set the domain-specific key explicitly and the derivation step is skipped for that key.

## What happens when a theme disappears

If the user has applied an extension theme and then disables or uninstalls the extension (or an update removes the theme), the runtime falls back to a base theme:

- The fallback uses the missing theme's `isDark` value to pick `light` or `dark`.
- An inline banner appears at the top of the **Themes** panel naming the missing ID and the applied fallback. It stays until the user dismisses it or applies a different theme.
- Re-enabling the extension does **not** auto-restore the theme. The user has to apply it manually.

Disable and uninstall are treated identically.

## Theme Structure

Each theme contribution has the following properties:

| Property | Type | Required | Description |
|----------|------|----------|-------------|
| `id` | string | Yes | Unique identifier within your extension (e.g., `"my-dark-theme"`) |
| `name` | string | Yes | Display name shown in the theme picker |
| `isDark` | boolean | Yes | Whether this is a dark theme (determines base fallback colors) |
| `colors` | object | Yes | Partial color overrides (see available colors below) |
| `monaco` | object | No | Optional Monaco editor theme. When present, code editors honor the extension's syntax-highlighting palette. See [Monaco Theme Contribution](#monaco-theme-contribution). |

## Available Color Keys

You can override any of these color keys. Missing colors will fall back to the appropriate base theme (light or dark).

### Backgrounds
- `bg` - Main background color
- `bg-secondary` - Secondary background (sidebars, panels)
- `bg-tertiary` - Tertiary background (nested elements)
- `bg-hover` - Hover state background
- `bg-selected` - Selected item background
- `bg-active` - Active/pressed state background

### Text
- `text` - Primary text color
- `text-muted` - Secondary/muted text
- `text-faint` - Tertiary/faint text
- `text-disabled` - Disabled text

### Borders
- `border` - Default border color
- `border-focus` - Focus ring/outline color

### Primary (Brand/Action)
- `primary` - Primary action color (buttons, links)
- `primary-hover` - Primary color on hover

### Links
- `link` - Link text color
- `link-hover` - Link color on hover

### Status Colors
- `success` - Success state color
- `warning` - Warning state color
- `error` - Error state color
- `info` - Info state color

## CSS Variables

Extension themes work by setting CSS variables on the document root. The naming convention uses the `--nim-` prefix:

```css
--nim-bg
--nim-bg-secondary
--nim-text
--nim-primary
/* etc. */
```

If you're writing CSS in your extension, you can reference these variables:

```css
.my-component {
  background-color: var(--nim-bg);
  color: var(--nim-text);
  border: 1px solid var(--nim-border);
}
```

## Tailwind CSS Integration

If your extension uses Tailwind CSS, you can use the Nimbalyst preset from the extension SDK:

### Using the Nimbalyst Tailwind Preset

```typescript
// tailwind.config.ts
import { nimbalystPreset } from '@nimbalyst/extension-sdk/tailwind';

export default {
  presets: [nimbalystPreset],
  content: ['./src/**/*.{ts,tsx}'],
};
```

This gives you access to theme-aware utility classes:

```jsx
// Using Tailwind classes
<div className="bg-nim text-nim border-nim-border">
  Content
</div>

// With variants
<button className="bg-nim-primary hover:bg-nim-primary-hover text-white">
  Click me
</button>

// Status colors
<span className="text-nim-error">Error message</span>
<span className="text-nim-success">Success!</span>
```

### Available Tailwind Utilities

Background colors:
- `bg-nim`, `bg-nim-secondary`, `bg-nim-tertiary`
- `bg-nim-hover`, `bg-nim-selected`, `bg-nim-active`
- `bg-nim-primary`, `bg-nim-primary-hover`

Text colors:
- `text-nim`, `text-nim-muted`, `text-nim-faint`, `text-nim-disabled`
- `text-nim-link`, `text-nim-link-hover`
- `text-nim-primary`, `text-nim-success`, `text-nim-warning`, `text-nim-error`, `text-nim-info`

Border colors:
- `border-nim`, `border-nim-focus`, `border-nim-primary`

## Example: Complete Theme

Here's a complete example of a "Nord" inspired dark theme:

```json
{
  "id": "nord-dark",
  "name": "Nord Dark",
  "isDark": true,
  "colors": {
    "bg": "#2e3440",
    "bg-secondary": "#3b4252",
    "bg-tertiary": "#434c5e",
    "bg-hover": "rgba(255, 255, 255, 0.05)",
    "bg-selected": "rgba(136, 192, 208, 0.15)",
    "bg-active": "#4c566a",
    "text": "#eceff4",
    "text-muted": "#d8dee9",
    "text-faint": "#a3b1c4",
    "text-disabled": "#6b7a8f",
    "border": "#4c566a",
    "border-focus": "#88c0d0",
    "primary": "#88c0d0",
    "primary-hover": "#8fbcbb",
    "link": "#81a1c1",
    "link-hover": "#88c0d0",
    "success": "#a3be8c",
    "warning": "#ebcb8b",
    "error": "#bf616a",
    "info": "#5e81ac"
  }
}
```

## Monaco Theme Contribution

By default, extension themes only style the UI shell (sidebars, panels, buttons) via `--nim-*` CSS variables. Monaco-backed editors (code files, JSON, etc.) fall back to the built-in `vs` or `vs-dark` theme based on `isDark`.

To style the editor surface itself -- syntax token colors, gutter, line numbers, the editor background -- add an optional `monaco` block to your theme contribution. The runtime registers it as a real Monaco theme via `monaco.editor.defineTheme()` under the namespaced id `extensionId:themeId`, and code editors switch to it when the user activates the theme.

### Schema

```json
{
  "monaco": {
    "base": "vs-dark",
    "inherit": true,
    "rules": [
      { "token": "comment", "foreground": "6272a4", "fontStyle": "italic" },
      { "token": "keyword", "foreground": "ff79c6" },
      { "token": "string",  "foreground": "f1fa8c" }
    ],
    "colors": {
      "editor.background": "#282a36",
      "editor.foreground": "#f8f8f2",
      "editorLineNumber.foreground": "#6272a4",
      "editor.selectionBackground": "#44475a"
    }
  }
}
```

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `base` | `"vs" \| "vs-dark" \| "hc-black" \| "hc-light"` | Yes | Built-in Monaco theme to inherit from |
| `inherit` | boolean | No (default `true`) | Whether unspecified rules/colors inherit from `base` |
| `rules` | array | Yes | Syntax token rules. Each rule is `{ token, foreground?, background?, fontStyle? }`. Colors are hex strings WITHOUT a leading `#` (Monaco convention). `fontStyle` accepts space-separated `italic`, `bold`, `underline`. |
| `colors` | object | Yes | Map of Monaco color ids (e.g. `"editor.background"`) to color strings. Full color id list: <https://github.com/microsoft/vscode/blob/main/src/vs/editor/common/core/editorColorRegistry.ts>. |

### Token list

Monaco's standard tokens include: `comment`, `keyword`, `string`, `number`, `type`, `class`, `function`, `variable`, `constant`, `parameter`, `punctuation`, `operator`, plus language-scoped variants (e.g. `keyword.js`, `string.escape.html`). See <https://microsoft.github.io/monaco-editor/typedoc/interfaces/editor.ITokenThemeRule.html>.

### Full example (Dracula)

```json
{
  "id": "dracula",
  "name": "Dracula",
  "isDark": true,
  "colors": {
    "bg": "#282a36",
    "bg-secondary": "#1e1f29",
    "text": "#f8f8f2",
    "primary": "#bd93f9",
    "border": "#44475a"
  },
  "monaco": {
    "base": "vs-dark",
    "inherit": true,
    "rules": [
      { "token": "comment", "foreground": "6272a4", "fontStyle": "italic" },
      { "token": "keyword", "foreground": "ff79c6" },
      { "token": "string", "foreground": "f1fa8c" },
      { "token": "number", "foreground": "bd93f9" },
      { "token": "type", "foreground": "8be9fd", "fontStyle": "italic" },
      { "token": "function", "foreground": "50fa7b" },
      { "token": "variable", "foreground": "f8f8f2" },
      { "token": "constant", "foreground": "bd93f9" }
    ],
    "colors": {
      "editor.background": "#282a36",
      "editor.foreground": "#f8f8f2",
      "editor.selectionBackground": "#44475a",
      "editor.lineHighlightBackground": "#44475a55",
      "editorCursor.foreground": "#f8f8f0",
      "editorLineNumber.foreground": "#6272a4",
      "editorLineNumber.activeForeground": "#f8f8f2"
    }
  }
}
```

### What happens when the Monaco block is omitted

The extension theme still paints the UI shell, but Monaco-backed editors fall back to `vs` (when `isDark: false`) or `vs-dark` (when `isDark: true`). No editor crash; just no custom syntax palette.

### Disabling or uninstalling an extension that contributed a Monaco theme

The same fallback rules as for UI themes apply (see "What happens when a theme disappears" above). When the extension that contributed a Monaco theme is disabled or uninstalled:

- The runtime theme registry drops the namespaced theme id, and `getMonacoTheme()` stops returning that id -- Monaco-backed editors fall back to `vs` / `vs-dark` based on the missing theme's `isDark`.
- Note that `monaco.editor.defineTheme()` does not expose an explicit "undefine" API. The theme definition stays cached inside Monaco for the lifetime of the renderer window, but nothing routes editors to it once the registry entry is gone. Re-enabling the extension re-registers the definition under the same id (Monaco overwrites the cached entry).

Re-enabling the extension does not auto-restore the active theme selection; the user has to apply it manually.

## Theme Selection

Users can select themes from the theme picker button in the navigation gutter. Extension themes appear in a separate section below the built-in themes (Light, Dark, Crystal Dark) with an "Extension" badge.

## Best Practices

1. **Use the `isDark` flag correctly** - This determines which base theme colors are used for any colors you don't override.

2. **Test contrast ratios** - Ensure text remains readable against backgrounds. Aim for WCAG AA compliance (4.5:1 for normal text).

3. **Override related colors together** - If you change `bg`, consider also changing `bg-secondary` and `bg-tertiary` for visual consistency.

4. **Test all UI states** - Check hover, selected, active, and disabled states look good with your colors.

5. **Use semantic colors** - Don't use `error` for non-error states or `success` for non-success states.

## Debugging

If your theme isn't appearing:

1. Check that `requiredReleaseChannel` isn't set to a channel higher than your build
2. Verify the extension is enabled in Settings > Extensions
3. Check the browser console for any loading errors
4. Ensure `isDark` is a boolean (not a string)

To inspect applied theme variables, open DevTools and examine the `<html>` element's inline styles when an extension theme is active.
