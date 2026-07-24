# Shared UI Patterns

These patterns apply across all packages (electron, runtime) that contain UI code.

## Responsive CSS: Use Container Queries

**Use `@container` queries, not `@media` queries** for responsive layouts. Since panels are resizable, viewport-based media queries don't respond to actual container width.

```css
.my-component {
  container-type: inline-size;
  container-name: my-component;
}

@container my-component (max-width: 500px) {
  .my-component-child {
    /* Styles when container is narrow */
  }
}
```

Container queries respond to the actual container width, making them work correctly with resizable panels and split views on both desktop and mobile.

## CSS Variables: Canonical Naming Reference

**CRITICAL: Always use the correct `--nim-*` variable names. These are the ONLY valid names:**

| Category | Variable Name | Usage | Tailwind Class |
| --- | --- | --- | --- |
| **Backgrounds** |  |  |  |
| Main background | `--nim-bg` | Primary content areas | `bg-nim` |
| Secondary background | `--nim-bg-secondary` | Sidebars, panels | `bg-nim-secondary` |
| Tertiary background | `--nim-bg-tertiary` | Nested panels | `bg-nim-tertiary` |
| Hover state | `--nim-bg-hover` | Interactive element hover | `bg-nim-hover` |
| Selected state | `--nim-bg-selected` | Selected items | `bg-nim-selected` |
| Active state | `--nim-bg-active` | Active/pressed state | `bg-nim-active` |
| **Text Colors** |  |  |  |
| Main text | `--nim-text` | Primary text content | `text-nim` |
| Muted text | `--nim-text-muted` | Secondary text | `text-nim-muted` |
| Faint text | `--nim-text-faint` | Tertiary/hint text | `text-nim-faint` |
| Disabled text | `--nim-text-disabled` | Disabled state | `text-nim-disabled` |
| **Borders** |  |  |  |
| Default border | `--nim-border` | Standard borders | `border-nim` |
| Focus border | `--nim-border-focus` | Focus states | `border-nim-focus` |
| **Primary/Brand** |  |  |  |
| Primary color | `--nim-primary` | Buttons, actions | `bg-nim-primary` |
| Primary hover | `--nim-primary-hover` | Button hover | `bg-nim-primary-hover` |
| **Links** |  |  |  |
| Link color | `--nim-link` | Hyperlinks | `text-nim-link` |
| Link hover | `--nim-link-hover` | Link hover state | `text-nim-link-hover` |
| **Status** |  |  |  |
| Success | `--nim-success` | Success states | `text-nim-success` |
| Warning | `--nim-warning` | Warning states | `text-nim-warning` |
| Error | `--nim-error` | Error states | `text-nim-error` |
| Info | `--nim-info` | Info states | `text-nim-info` |

**INCORRECT names that should NEVER be used:**
- `--nim-bg-primary` (use `--nim-bg`)
- `--nim-text-primary` (use `--nim-text`)
- `--nim-text-secondary` (use `--nim-text-muted`)
- `--nim-text-tertiary` (use `--nim-text-faint`)
- `--nim-accent` (use `--nim-primary`)
- `--nim-bg-surface` (use `--nim-bg-secondary`)

**Usage examples:**
```css
/* CSS */
.my-component {
  background-color: var(--nim-bg);
  color: var(--nim-text);
  border: 1px solid var(--nim-border);
}

.my-component:hover {
  background-color: var(--nim-bg-hover);
}
```

```tsx
/* Tailwind in TSX */
<div className="bg-nim text-nim border border-nim">
  <button className="bg-nim-primary text-white hover:bg-nim-primary-hover">
    Action
  </button>
</div>

/* Arbitrary values in TSX (when Tailwind class doesn't exist) */
<div className="bg-[var(--nim-bg)] text-[var(--nim-text)]">
```

## Tailwind Conditional Classes Pattern

**CRITICAL: Tailwind does NOT override based on class order in className string.**

When using conditional classes for states like active/selected, you MUST use a ternary that applies mutually exclusive class sets:

```tsx
// WRONG: Both bg-transparent and bg-nim-primary will be applied,
// and Tailwind's CSS order in the stylesheet determines which wins
<button className={`bg-transparent text-nim-muted hover:bg-nim-hover ${isActive ? 'bg-nim-primary text-white' : ''}`}>

// CORRECT: Use ternary to apply one set or the other
<button className={`cursor-pointer transition-all ${isActive ? 'bg-nim-primary text-white hover:bg-nim-primary-hover' : 'bg-transparent text-nim-muted hover:bg-nim-hover'}`}>
```

This pattern is essential for:
- Navigation buttons (active/inactive states)
- Toggle buttons (on/off states)
- Selection states (selected/unselected)
- Any component with mutually exclusive visual states

## Common Tailwind Class Misuse

| Wrong | Right | Reason |
| --- | --- | --- |
| `bg-nim-primary` for containers | `bg-nim` | Primary is for buttons/actions, not backgrounds |
| `text-nim-primary` for text | `text-nim` | Primary is the brand color, nim is for text |
| `bg-nim-primary` for panels | `bg-nim-secondary` | Use background hierarchy for panels |
| `w-[90%] h-[80%]` for modals | `w-[90vw] h-[80vh]` | Use viewport units for fixed-position modals |

## Text Selection: Default to Non-Selectable

The app defaults to `user-select: none` on the `#root` container and all descendants (via `:where(#root, #root *)`). This prevents awkward text selection on UI chrome (buttons, sidebar items, headers).

**Content areas must opt-in to selection:**
- Use `select-text` (Tailwind) or `user-select: text` (CSS) on content that users should be able to select/copy
- Editor content areas (Lexical, Monaco, terminals) handle selection internally - no action needed

**Where to allow selection:**
- Editor content (handled automatically by editors)
- AI chat message bodies (not headers, avatars, or metadata)
- Code blocks and terminal output in transcripts
- Error messages users might copy
- Diff line content (not line numbers or markers)

**Never allow selection on:**
- Buttons, tabs, navigation items
- Panel headers and toolbars
- Sidebar items (file tree, session list)
- Status indicators and badges
- Line numbers, diff markers

**Extension developers:** Custom editors and panels inherit `user-select: none` from the app root. Add `select-text` to your content areas where selection is appropriate.

| Anti-Pattern | Problem | Solution |
| --- | --- | --- |
| Forgetting `select-text` on content | Users can't copy text | Add `select-text` to content wrappers |
| `select-text` on entire component | Headers/buttons become selectable | Only apply to content, not chrome |
| `select-none` on every element | Redundant, clutters code | Let global default handle it |
