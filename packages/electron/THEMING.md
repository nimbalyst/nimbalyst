# Theming Documentation

## Overview

Nimbalyst uses a unified theming system with CSS variables. The system supports:
- **Built-in themes**: Light, Dark, Crystal Dark
- **Extension themes**: Custom themes provided by extensions

For extension theme development, see [EXTENSION_THEMING.md](/docs/EXTENSION_THEMING.md).

## Critical Rules for Theming

### NEVER HARDCODE COLORS IN CSS FILES
All colors MUST use CSS variables. The theme system has two variable naming conventions:
- **Legacy**: `--surface-*`, `--text-*`, `--border-*`, `--accent-*` (defined in `PlaygroundEditorTheme.css`)
- **Unified**: `--nim-*` (defined in `NimbalystTheme.css`, recommended for new code)

### Single Source of Truth
Theme colors are defined in `/packages/runtime/src/editor/themes/`:
- `PlaygroundEditorTheme.css` - Legacy variable definitions
- `NimbalystTheme.css` - Unified `--nim-*` variable definitions (maps from legacy vars)

## Theme Architecture

### 1. Theme Definition Location
```
/packages/runtime/src/editor/themes/PlaygroundEditorTheme.css
```

This file contains ALL theme variable definitions for:
- Light theme (default :root)
- Dark theme (dark theme selectors)
- Crystal Dark theme (crystal-dark theme selectors)

### 2. How Themes are Applied

Themes are applied using BOTH CSS classes AND data-theme attributes on the root HTML element:

```javascript
// Correct theme application (as in GlobalSettings.tsx, SessionManager.tsx)
if (savedTheme === 'dark') {
  root.setAttribute('data-theme', 'dark');
  root.classList.add('dark-theme');
} else if (savedTheme === 'crystal-dark') {
  root.setAttribute('data-theme', 'crystal-dark');
  root.classList.add('crystal-dark-theme');
} else if (savedTheme === 'light') {
  root.setAttribute('data-theme', 'light');
  root.classList.add('light-theme');
}
```

### 3. CSS Variable Structure

#### Core Variables (defined in PlaygroundEditorTheme.css):
```css
/* Surfaces/Backgrounds */
--nim-bg: #ffffff;           /* Main content background */
--nim-bg-secondary: #f9fafb; /* Sidebar, panels */
--nim-bg-tertiary: #f3f4f6;  /* Hover states, subtle backgrounds */
--nim-bg-hover: #e5e7eb;     /* Hover state background */

/* Text */
--nim-text: #111827;         /* Main text */
--nim-text-muted: #6b7280;   /* Muted text */
--nim-text-faint: #9ca3af;   /* Very muted text */

/* Borders */
--nim-border: #e5e7eb;       /* Default borders */
--nim-border-focus: #3b82f6; /* Focus state borders */

/* Accent Colors */
--nim-primary: #3b82f6;        /* Primary actions, links */
--nim-primary-hover: #2563eb;  /* Primary hover */
--nim-link: #3b82f6;           /* Link color */

/* Status Colors */
--nim-success: #10b981;
--nim-error: #ef4444;
--nim-warning: #f59e0b;
--nim-info: #3b82f6;
```

### 4. Dark Theme Colors

The regular dark theme uses warm grays (#2d2d2d, #1a1a1a, #3a3a3a):

```css
:root.dark-theme {
    --surface-primary: #2d2d2d; /* NOT #0f172a (that's crystal-dark) */
    --surface-secondary: #1a1a1a;
    --surface-tertiary: #3a3a3a;
    /* ... */
}
```

The Crystal Dark theme uses Tailwind gray scale colors (#0f172a, #020617, #1e293b):

```css
:root.crystal-dark-theme {
    --surface-primary: #0f172a;
    --surface-secondary: #020617;
    --surface-tertiary: #1e293b;
    /* ... */
}
```

## Common Mistakes to Avoid

### ❌ WRONG: Hardcoding colors in component CSS
```css
/* NEVER DO THIS */
.my-component {
  background-color: #ffffff;
  color: #111827;
}
```

### ✅ CORRECT: Using CSS variables

```css
/* ALWAYS DO THIS */
.my-component {
    background-color: var(--nim-bg);
    color: var(--nim-text);
}
```

### ❌ WRONG: Defining theme colors in multiple places
```css
/* component.css - NEVER DO THIS */
:root {
  --my-bg-color: #ffffff;
}
.dark-theme {
  --my-bg-color: #1a1a1a;
}
```

### ✅ CORRECT: Using variables from PlaygroundEditorTheme.css

```css
/* component.css - ALWAYS DO THIS */
.my-component {
    background: var(--nim-bg); /* Defined in PlaygroundEditorTheme.css */
}
```

### ❌ WRONG: Using only data-theme attribute
```javascript
// INCOMPLETE - Won't work properly
root.setAttribute('data-theme', 'dark');
```

### ✅ CORRECT: Setting both attribute and class
```javascript
// ALWAYS SET BOTH
root.setAttribute('data-theme', 'dark');
root.classList.add('dark-theme');
```

## Adding New Components

When creating new components that need theming:

1. **NEVER** hardcode colors
2. **ALWAYS** use variables from PlaygroundEditorTheme.css
3. **NEVER** create new theme variable definitions in your component
4. If you need a new color variable, add it to PlaygroundEditorTheme.css for ALL themes

Example for a new component:

```css
/* NewComponent.css */
.new-component {
    background: var(--nim-bg);
    color: var(--nim-text);
    border: 1px solid var(--nim-border);
}

.new-component:hover {
    background: var(--nim-bg-secondary);
}

.new-component-title {
    color: var(--nim-text-muted);
}
```

## Testing Themes

Always test your component in all three themes:
1. Light theme
2. Dark theme (warm grays: #2d2d2d)
3. Crystal Dark theme (Tailwind grays: #0f172a)

Use the Window > Theme menu in the Electron app to switch between themes.

## Debugging Theme Issues

If a component shows wrong colors:

1. **Check for hardcoded colors**: Search the component's CSS for hex colors (#) or rgb values
2. **Verify variable usage**: Ensure all colors use var(--variable-name)
3. **Check theme application**: Verify the component sets both data-theme AND class name
4. **Inspect CSS cascade**: Use DevTools to see which styles are being applied
5. **Check PlaygroundEditorTheme.css imports**: Ensure PlaygroundEditorTheme.css is imported before component CSS

## The Golden Rule

**There is ONE and ONLY ONE place to define theme colors: `/packages/runtime/src/editor/themes/`**

The theme files are:
- `PlaygroundEditorTheme.css` - Legacy variables (`--surface-*`, `--text-*`, etc.)
- `NimbalystTheme.css` - Unified variables (`--nim-*`) that map from legacy vars

Everything else MUST reference these variables. No exceptions.

## Unified Theme System (Recommended for New Code)

The unified theme system uses `--nim-*` CSS variables and integrates with Tailwind CSS.

### CSS Variable Naming

| Unified (`--nim-*`) | Legacy | Description |
|---------------------|--------|-------------|
| `--nim-bg` | `--surface-primary` | Main background |
| `--nim-bg-secondary` | `--surface-secondary` | Sidebar, panels |
| `--nim-bg-tertiary` | `--surface-tertiary` | Nested backgrounds |
| `--nim-text` | `--text-primary` | Main text |
| `--nim-text-muted` | `--text-secondary` | Muted text |
| `--nim-border` | `--border-primary` | Default borders |
| `--nim-primary` | `--accent-primary` | Primary action color |

### Tailwind CSS Integration

The monorepo includes a shared Tailwind config (`/tailwind.config.ts`) with theme utilities:

```jsx
// Using Tailwind classes (recommended)
<div className="bg-nim text-nim border-nim-border">
  Content
</div>

// Equivalent CSS
<div style={{
  backgroundColor: 'var(--nim-bg)',
  color: 'var(--nim-text)',
  borderColor: 'var(--nim-border)'
}}>
  Content
</div>
```

### TypeScript Theme Types

The theme system includes TypeScript types in `@nimbalyst/runtime`:

```typescript
import { ThemeColors, ThemeId, getBaseThemeColors } from '@nimbalyst/runtime';

// Get base colors for a theme
const darkColors = getBaseThemeColors(true); // isDark = true
```

## Common Tailwind Migration Pitfalls

### Conditional Classes Don't Override

**CRITICAL: Tailwind does NOT override based on class order in the className string.**

```jsx
// WRONG: bg-transparent and bg-nim-primary both apply - whichever comes
// later in Tailwind's generated CSS "wins", not whichever is later in className
<button className={`bg-transparent ${isActive ? 'bg-nim-primary' : ''}`}>

// CORRECT: Use ternary to apply mutually exclusive class sets
<button className={`${isActive ? 'bg-nim-primary text-white' : 'bg-transparent text-nim-muted'}`}>
```

### Primary vs Background Colors

| Use Case | Wrong | Right |
|----------|-------|-------|
| Panel/container background | `bg-nim-primary` | `bg-nim` or `bg-nim-secondary` |
| Text color | `text-nim-primary` | `text-nim` |
| Button/action background | `bg-nim` | `bg-nim-primary` |

`--nim-primary` is the **brand/action color** (blue). Use it for buttons and interactive elements, NOT for container backgrounds.

### Modal/Dialog Sizing

```jsx
// WRONG: Percentage-based sizing can be affected by parent containers
<div className="w-[90%] h-[80%]">

// CORRECT: Use viewport units for fixed-position modals
<div className="w-[90vw] h-[80vh] max-w-[1200px] max-h-[800px]">
```

### CSS Files That Should NOT Be Deleted

Some CSS files must remain because they use:
- Classes applied via DOM manipulation (`classList.add()`)
- Vendor-prefixed pseudo-elements (`::-webkit-slider-thumb`)
- Complex selectors applied dynamically by Lexical nodes
- Styles for third-party components that don't support Tailwind

Examples:
- `CollapsiblePlugin/Collapsible.css` - Lexical `createDOM()` classes
- `KanbanBoardPlugin/Board.css` - Drag-and-drop DOM manipulation
- `StatusBarSlider.css` - Range input thumb styling
- Search highlight classes - Applied programmatically

## Extension Themes

Extensions can contribute custom themes. See [EXTENSION_THEMING.md](/docs/EXTENSION_THEMING.md) for details.

Users can select extension themes from the theme picker button in the navigation gutter.
