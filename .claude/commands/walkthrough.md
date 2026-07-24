---
packageVersion: 1.0.0
packageId: core
description: Create a guided walkthrough for a feature or workflow.
---

Create a walkthrough guide for: {{arg1}}

## Overview

Create a multi-step walkthrough that highlights UI elements and guides users through a feature. Walkthroughs appear as floating callouts attached to UI elements.

## Reference Documentation

Read `docs/WALKTHROUGHS.md` for the complete guide on the walkthrough system architecture, including trigger configuration, step definitions, and testing.

## Steps

### 1. Understand the Feature

Identify what feature or workflow the walkthrough should cover:
- What is the user trying to accomplish?
- What UI elements are involved?
- What's the logical order of steps?

### 2. Ensure HelpContent Exists

**Walkthroughs should pull content from HelpContent** - never hardcode text.

For each step target, check if HelpContent exists:
- Look in `packages/electron/src/renderer/help/HelpContent.ts`
- If missing, add it first (use `/tooltip` command or add manually)

### 3. Ensure Target Elements Have `data-testid`

Each step needs to target a UI element. Check that targets have `data-testid`:
- **If missing**: Add a descriptive `data-testid` to the element
- Use kebab-case: `my-feature-button`, `settings-panel-toggle`
- Be descriptive and stable (don't change these IDs once added)

### 4. Create Walkthrough Definition

Create a new file in `packages/electron/src/renderer/walkthroughs/definitions/`:

```typescript
// my-feature-intro.ts
import type { WalkthroughDefinition } from '../types';
import { getHelpContent } from '../../help';

// Pull content from HelpContent registry
const featureHelp = getHelpContent('my-feature-button')!;
const relatedHelp = getHelpContent('my-related-button')!;

export const myFeatureIntro: WalkthroughDefinition = {
  id: 'my-feature-intro',           // Unique ID (kebab-case)
  name: 'My Feature Introduction',   // Human-readable name
  version: 1,                        // Increment to re-show after updates
  trigger: {
    screen: 'agent',                 // 'files' | 'agent' | '*'
    condition: () => {               // Optional: only show when condition is true
      return document.querySelector('[data-testid="my-feature-button"]') !== null;
    },
    delay: 2000,                     // Wait for UI to settle (ms)
    priority: 10,                    // Lower = higher priority (default: 10)
  },
  steps: [
    {
      id: 'step-1',
      target: { testId: 'my-feature-button' },  // Target by data-testid
      title: featureHelp.title,                  // From HelpContent
      body: featureHelp.body,
      shortcut: featureHelp.shortcut,
      placement: 'right',                        // 'top' | 'bottom' | 'left' | 'right'
    },
    {
      id: 'step-2',
      target: { testId: 'my-related-button' },
      title: relatedHelp.title,
      body: relatedHelp.body,
      placement: 'bottom',
      visibilityCondition: () => {              // Optional: skip if not visible
        return document.querySelector('[data-testid="my-related-button"]') !== null;
      },
    },
  ],
};
```

### 5. Register the Walkthrough

Add the export to `packages/electron/src/renderer/walkthroughs/definitions/index.ts`:

```typescript
import { myFeatureIntro } from './my-feature-intro';

export const walkthroughs: WalkthroughDefinition[] = [
  // ... existing walkthroughs
  myFeatureIntro,
];
```

### 6. Update Documentation

**IMPORTANT**: Keep the walkthrough inventory up to date in `docs/WALKTHROUGHS.md`.

Update the inventory table near the top of the file with the new walkthrough:

| ID | Name | Steps | Screen | Priority | Trigger Condition |
| --- | --- | --- | --- | --- | --- |
| ... existing entries ... |
| `my-feature-intro` | My Feature Introduction | 2 | agent | 10 | Feature button is visible |

The inventory table is the single source of truth for all walkthroughs. It includes:
- **ID**: The unique identifier used in code
- **Name**: Human-readable name for analytics/menus
- **Steps**: Number of steps in the walkthrough
- **Screen**: Which mode triggers it (files, agent, or any)
- **Priority**: Higher number = higher priority (shows first when multiple are eligible)
- **Trigger Condition**: Plain-English description of when it appears

### 7. Test the Walkthrough

Use dev helpers in the browser console:

```javascript
// Reset state to see walkthrough again
window.__walkthroughHelpers.resetState()

// Start the specific walkthrough
window.__walkthroughHelpers.startWalkthrough('my-feature-intro')

// Check current state
window.__walkthroughHelpers.getState()
```

## Definition Reference

### WalkthroughDefinition

| Field | Type | Description |
| --- | --- | --- |
| `id` | string | Unique identifier (kebab-case) |
| `name` | string | Human-readable display name |
| `version` | number | Increment to re-show to users who completed it |
| `trigger.screen` | 'files' \| 'agent' \| '*' | Which mode triggers it |
| `trigger.condition` | () => boolean | Additional condition (optional) |
| `trigger.delay` | number | Delay before showing in ms (optional) |
| `trigger.priority` | number | Lower = higher priority, default 10 |
| `steps` | WalkthroughStep[] | Array of steps |

### WalkthroughStep

| Field | Type | Description |
| --- | --- | --- |
| `id` | string | Unique step identifier |
| `target.testId` | string | Target element's data-testid (preferred) |
| `target.selector` | string | CSS selector fallback |
| `title` | string | Step title (from HelpContent) |
| `body` | string | Step description (from HelpContent) |
| `shortcut` | string | Keyboard shortcut (optional) |
| `placement` | 'top' \| 'bottom' \| 'left' \| 'right' | Callout position |
| `visibilityCondition` | () => boolean | Skip step if returns false (optional) |
| `action` | { label, onClick } | Action button (optional) |

## Best Practices

### Content

- **Keep it short**: 2-4 steps maximum. Users abandon long walkthroughs.
- **Focus on discovery**: Highlight features users might miss, not obvious ones.
- **Pull from HelpContent**: Never hardcode text - use `getHelpContent()`.

### Targeting

- **Prefer data-testid**: More stable than CSS selectors.
- **Use descriptive IDs**: `file-tree-filter-button` not `btn-1`.
- **Don't change IDs**: Once added, IDs should remain stable.

### Triggers

- **Don't interrupt**: Use appropriate `delay` and `condition` to avoid bad timing.
- **Test visibility**: Ensure target elements exist when walkthrough triggers.
- **Consider priority**: Lower priority number = shows first.

## Files to Modify

1. `packages/electron/src/renderer/help/HelpContent.ts` - Ensure entries exist for all steps
2. Component files - Add `data-testid` attributes if missing
3. `packages/electron/src/renderer/walkthroughs/definitions/[name].ts` - New walkthrough definition
4. `packages/electron/src/renderer/walkthroughs/definitions/index.ts` - Register walkthrough
5. `docs/WALKTHROUGHS.md` - Update inventory table

## Common Mistakes

| Mistake | Solution |
| --- | --- |
| Hardcoding step text | Use `getHelpContent()` to pull from registry |
| Missing `data-testid` on targets | Add descriptive `data-testid` to elements |
| Too many steps | Keep to 2-4 steps maximum |
| Walkthrough doesn't appear | Check trigger condition, screen, and target visibility |
| Callout points wrong way | Verify target's `getBoundingClientRect()` is correct |
