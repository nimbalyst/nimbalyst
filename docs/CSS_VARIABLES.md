# CSS Variables Guide

This document is the canonical reference for the `--nim-*` CSS variable system used across all Nimbalyst packages and extensions.

## Core Principles

1. **Single Source of Truth**: All theme tokens are defined in `packages/runtime/src/editor/themes/NimbalystTheme.css` and consumed by every other package.
2. **Semantic Naming**: Variables describe purpose, not presentation (e.g., `--nim-bg-secondary`, not `--gray-200`).
3. **Theme Support**: All variables are redefined per built-in theme (`light`, `dark`, `crystal-dark`) and any custom themes contributed by extensions.
4. **No Hardcoded Colors**: Never hardcode colors — always use a variable or its Tailwind class equivalent.

## Variable Categories

### Backgrounds

```css
--nim-bg            /* Main content background */
--nim-bg-secondary  /* Sidebars, panels */
--nim-bg-tertiary   /* Nested panels, code blocks */
--nim-bg-hover      /* Hover state */
--nim-bg-selected   /* Selection state */
--nim-bg-active     /* Active/pressed state */
```

### Text

```css
--nim-text          /* Primary content text */
--nim-text-muted    /* Secondary/supporting text */
--nim-text-faint    /* Tertiary/hint text */
--nim-text-disabled /* Disabled state text */
```

### Borders

```css
--nim-border        /* Default borders */
--nim-border-focus  /* Focus ring */
```

### Interactive

```css
--nim-primary        /* Primary action / brand color */
--nim-primary-hover  /* Primary hover state */
--nim-link           /* Link text */
--nim-link-hover     /* Link hover */
```

### Status

```css
--nim-success  /* Success feedback */
--nim-warning  /* Warning feedback */
--nim-error    /* Error feedback */
--nim-info     /* Info feedback */
```

### Code

```css
--nim-code-bg      /* Code block background */
--nim-code-text    /* Code text color */
--nim-code-border  /* Code block border */
```

## Tailwind Equivalents

Every `--nim-*` variable is exposed as a Tailwind utility via the monorepo `tailwind.config.ts`:

| CSS Variable | Tailwind Class |
| --- | --- |
| `var(--nim-bg)` | `bg-nim` |
| `var(--nim-bg-secondary)` | `bg-nim-secondary` |
| `var(--nim-bg-tertiary)` | `bg-nim-tertiary` |
| `var(--nim-bg-hover)` | `bg-nim-hover` |
| `var(--nim-text)` | `text-nim` |
| `var(--nim-text-muted)` | `text-nim-muted` |
| `var(--nim-text-faint)` | `text-nim-faint` |
| `var(--nim-border)` | `border-nim` |
| `var(--nim-primary)` | `bg-nim-primary`, `text-nim-primary` |
| `var(--nim-success)` | `text-nim-success` |
| `var(--nim-warning)` | `text-nim-warning` |
| `var(--nim-error)` | `text-nim-error`, `border-nim-error` |
| `var(--nim-link)` | `text-nim-link` |

Prefer Tailwind classes in JSX. Use `var(--nim-*)` only in CSS files or when an arbitrary class like `bg-[var(--nim-bg)]` is unavoidable.

## Critical Rules

- **Never** use `--nim-primary` for container backgrounds. It's the action/brand color, reserved for buttons and interactive accents. Container backgrounds use `--nim-bg`, `--nim-bg-secondary`, or `--nim-bg-tertiary`.
- **Never** use the legacy variable names (`--surface-*`, `--text-primary`, `--accent-*`, `--primary-color`, `--*-color`). These were removed during the Tailwind migration. Use `--nim-*` instead.
- **Never** hardcode hex/rgb values for theme-dependent colors. Dynamic per-instance colors (e.g., user-chosen tag colors) are the only legitimate inline-style use.

## Theme Definitions

Built-in themes are defined in `packages/runtime/src/editor/themes/NimbalystTheme.css`. Extensions can register additional themes via `contributions.themes` in their manifest — see [EXTENSION_THEMING.md](./EXTENSION_THEMING.md).

## Related Documentation

- [THEMING.md](../packages/electron/THEMING.md) — Theming architecture and how themes are applied
- [UI_PATTERNS.md](./UI_PATTERNS.md) — Tailwind usage patterns, container queries, conditional classes
- [EXTENSION_THEMING.md](./EXTENSION_THEMING.md) — How extensions consume and contribute themes
