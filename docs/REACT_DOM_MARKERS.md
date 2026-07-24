# React DOM Markers

This project uses Tailwind for styling, but we still require semantic DOM markers for important React UI.

## Why

- Utility-only class strings are hard to scan in browser developer tools.
- Stable semantic markers make it easier to jump from rendered DOM to the owning React component.
- `data-testid` selectors remain stable during styling refactors.
- Explicit debug metadata can power DOM-to-source tooling in Nimbalyst.

## Required Rules

### 1. Give meaningful component roots a semantic class

Use one stable semantic class on the topmost meaningful element rendered by the component.

```tsx
export function SessionCard() {
  return (
    <article className="session-card rounded-lg border bg-nim-secondary p-3">
      ...
    </article>
  );
}
```

Good semantic markers:

- `session-card`
- `tracker-sidebar`
- `settings-panel`
- `file-context-menu`

Avoid utility-only roots:

```tsx
export function SessionCard() {
  return (
    <article className="rounded-lg border bg-nim-secondary p-3">
      ...
    </article>
  );
}
```

### 2. Use `data-testid` for testing-critical elements

`data-testid` is for test selection, walkthroughs, and other automation hooks.

```tsx
<button
  className="session-restore-button inline-flex items-center gap-2"
  data-testid="session-restore-button"
>
  Restore
</button>
```

Do not use `data-testid` as a replacement for semantic class names. Use both when an element is important to both humans and tests.

### 3. Use optional debug metadata where it adds value

When a component is a major debugging target or is expected to participate in DOM-to-source tooling, add development-friendly metadata:

```tsx
<section
  className="tracker-sidebar flex h-full flex-col"
  data-component="TrackerSidebar"
  data-source="packages/electron/src/renderer/components/TrackerMode/TrackerSidebar.tsx"
>
  ...
</section>
```

These attributes are optional in general UI, but recommended for major shells, panels, cards, dialogs, and complex interactive components.

## Heuristics

Add a semantic root marker when the component:

- is exported and renders a meaningful layout container
- owns a panel, dialog, toolbar, sidebar, card, row, list, or popover
- is a frequent debugging or testing target
- has a DOM structure that would be hard to identify from Tailwind utilities alone

You usually do not need a semantic marker for:

- tiny leaf wrappers with no meaningful identity
- purely typographic spans
- fragments with no DOM root

## Naming

- Use kebab-case
- Base the name on the component or feature, not the visual style
- Prefer stable nouns over ephemeral descriptions

Good:

- `agent-session-panel`
- `workspace-sidebar`
- `session-kanban-column`

Bad:

- `blue-card`
- `rounded-header`
- `flex-gap-2-wrapper`

## Relationship Between Marker Types

- `className`: human-readable DOM structure and CSS/debugging anchor
- `data-testid`: automation and test selector anchor
- `data-component`: React component identity hint
- `data-source`: source file hint for editor/devtools integrations

For important UI, the preferred pattern is:

```tsx
<div
  className="settings-panel flex flex-col gap-3"
  data-testid="settings-panel"
  data-component="SettingsPanel"
>
  ...
</div>
```

## Review Checklist

Before finishing React UI work, check:

- Does the meaningful root element have a stable semantic class?
- Are important interactive elements labeled with `data-testid`?
- If this UI will be debugged often, should it also expose `data-component` or `data-source`?
- If Tailwind classes change later, will the DOM still be understandable?
