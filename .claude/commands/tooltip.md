---
packageVersion: 1.0.0
packageId: core
description: Add help content tooltips to existing UI elements.
---

Add help content tooltip to: {{arg1}}

## Overview

Add a HelpTooltip to a UI element so users see helpful context on hover. This command handles adding the HelpContent entry, wrapping the element with HelpTooltip, and avoiding duplicate tooltips.

## Reference Documentation

Read `docs/WALKTHROUGHS.md` for the complete guide on the help system architecture.

## Steps

### 1. Identify the Target Element

Find the UI element the user wants to add a tooltip to:
- Search for the component in the codebase
- Identify the specific button, control, or interactive element

### 2. Check for Existing `data-testid`

The element needs a `data-testid` attribute:
- **If it has one**: Use that ID for the HelpContent key
- **If it doesn't have one**: Add a descriptive `data-testid` following the naming convention:
  - Use kebab-case: `my-feature-button`, `settings-panel-toggle`
  - Be descriptive: `file-tree-filter-button` not `btn-1`
  - Match the element's purpose

### 3. Add HelpContent Entry

Add an entry to `packages/electron/src/renderer/help/HelpContent.ts`:

```typescript
'my-feature-button': {
  title: 'Feature Name',           // 2-5 words, describes what it is
  body: 'Description of what this feature does and why it is useful.',  // 1-2 sentences
  shortcut: KeyboardShortcuts.myFeature.action,  // Optional - only if there's a keyboard shortcut
},
```

Guidelines:
- **title**: 2-5 words, noun phrase describing what it is
- **body**: 1-2 sentences explaining what it does (not how to use it)
- **shortcut**: Reference from `KeyboardShortcuts` constants (optional)

### 4. Wrap with HelpTooltip

Import and wrap the element:

```tsx
import { HelpTooltip } from '../../help';

<HelpTooltip testId="my-feature-button">
  <button data-testid="my-feature-button" onClick={handleClick}>
    Feature
  </button>
</HelpTooltip>
```

### 5. Remove Duplicate `title` Attributes

**CRITICAL**: Check if the element has a `title` attribute - this creates duplicate tooltips!

- **Remove** the `title` attribute from the element
- **Keep** `aria-label` for accessibility (convert `title` to `aria-label` if needed)

```tsx
// BAD: Duplicate tooltips
<HelpTooltip testId="my-button">
  <button title="Click me" data-testid="my-button">Click</button>
</HelpTooltip>

// GOOD: No duplicate
<HelpTooltip testId="my-button">
  <button aria-label="Click me" data-testid="my-button">Click</button>
</HelpTooltip>
```

### 6. Handle Special Cases

#### Element already has its own tooltip/popup

For elements like dropdowns or popovers that have their own popup, use the inline help pattern instead:

```tsx
import { getHelpContent } from '../../help';

const helpContent = getHelpContent('my-feature-button');

// Inside your existing tooltip:
{helpContent && (
  <div className="tooltip-help-section">
    <div className="tooltip-help-title">{helpContent.title}</div>
    <div className="tooltip-help-body">{helpContent.body}</div>
  </div>
)}
```

#### Group of controls

For a group of related controls (like the LayoutControls), wrap the entire group with one HelpTooltip:

```tsx
<HelpTooltip testId="layout-controls">
  <div className="layout-controls" data-testid="layout-controls">
    <button aria-label="Option 1">...</button>
    <button aria-label="Option 2">...</button>
  </div>
</HelpTooltip>
```

### 7. Verify

- Check that the tooltip appears on hover after ~500ms delay
- Check that clicking the element hides the tooltip (5 second cooldown)
- Check that there's no native browser tooltip appearing alongside

## Files to Modify

1. `packages/electron/src/renderer/help/HelpContent.ts` - Add help content entry
2. The component file containing the target element - Add HelpTooltip wrapper

## Common Mistakes to Avoid

| Mistake | Solution |
| --- | --- |
| Leaving `title` attribute | Convert to `aria-label`, remove `title` |
| Hardcoding tooltip text | Always use HelpContent registry |
| Missing `data-testid` | Add descriptive `data-testid` to element |
| Wrapping element with existing popup | Use inline help pattern instead |
| Generic test IDs like `btn-1` | Use descriptive IDs like `file-tree-filter-button` |
