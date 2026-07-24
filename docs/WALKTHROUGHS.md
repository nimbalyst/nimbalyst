# Walkthrough Guide System

This document explains how to create and maintain walkthrough guides and help content in Nimbalyst. The system provides contextual tooltips and multi-step guides to help users discover features.

## Current Walkthrough Inventory

| ID | Name | Steps | Screen | Priority | Trigger Condition |
| --- | --- | --- | --- | --- | --- |
| `agent-welcome-intro` | Agent Mode Welcome | 1 | agent | 50 | Session history is empty (first-time users) |
| `navigation-intro` | Navigation Introduction | 2 | any | 5 | Always available |
| `session-quick-open-intro` | Session Quick Open | 1 | agent | 12 | Session search button is visible (v2: covers @file and prompt search) |
| `diff-mode-intro` | Reviewing AI Changes | 2 | files | 15 | Diff approval bar is visible |
| `git-commit-mode-intro` | Git Commit Modes | 1 | agent | 15 | Commit mode toggle is visible (has changes) |
| `attach-files-intro` | Attach Files | 1 | agent | 18 | AI input is visible |
| `ai-sessions-button` | AI Sessions Button | 1 | files | 20 | AI sessions button visible, not in diff mode |
| `model-picker-intro` | Model Selection | 1 | agent | 20 | Model picker is visible |
| `files-scope-intro` | File Scope Modes | 1 | agent | 20 | Files scope dropdown is visible |
| `plan-mode-intro` | Plan Mode | 1 | agent | 22 | Mode toggle is visible |
| `context-window-intro` | Context Window | 1 | any | 25 | Context indicator is visible |
| `layout-controls-intro` | Layout Controls | 1 | agent | 35 | Layout controls visible with Files button enabled |
| `session-kanban-intro` | Session Kanban Board | 1 | agent | 18 | Kanban button is visible |
| `file-tree-tools` | File Tree Tools | 2 | files | 5 | Filter button is visible |
| `pr-review-mode-intro` | Pull Requests Mode | 1 | any | 8 | PR review gutter button is visible (project has a GitHub remote) |

## When Walkthroughs Appear

Walkthroughs are designed to be helpful without being intrusive. Here's how the system decides when to show them:

### Priority System

When multiple walkthroughs are eligible at the same time, only the **highest priority** one is shown. Priority is represented by a number - **higher numbers mean higher priority**.

For example, if a user enters Agent Mode for the first time with an empty session history:
- `agent-welcome-intro` (priority 50) would show first
- `navigation-intro` (priority 5) would wait

### Display Rules

1. **One at a time**: Only one walkthrough shows at a time. When you complete or dismiss it, another may appear if eligible.

2. **5-minute cooldown per mode**: After showing a walkthrough in Files Mode or Agent Mode, the system waits 5 minutes before showing another in that same mode. This prevents overwhelming users with back-to-back guides.

3. **Target must be visible**: Each walkthrough's target UI element must be present and visible on screen. For example, the "Diff Mode" walkthrough only appears when the diff approval bar is showing.

4. **No dialogs or overlays**: Walkthroughs pause when any modal dialog, toast, or overlay is visible.

5. **Once per user**: Each walkthrough shows only once. After a user completes or dismisses it, it won't appear again (unless they reset walkthroughs in Settings).

6. **Version updates**: If a walkthrough's `version` number is incremented, users who saw the old version will see the new one.

### Delay Before Showing

Each walkthrough has a delay (500ms to 3000ms) before appearing. This gives the UI time to settle after navigation and ensures the target element is fully rendered.

## Architecture Overview

The help system has two main components:

1. **HelpContent** - Centralized registry of help text keyed by `data-testid`
2. **Walkthroughs** - Multi-step floating guides that attach to UI elements

Both components share the same help content, ensuring consistency across tooltips and guides.

### File Structure

```
packages/electron/src/renderer/
  help/
    HelpContent.ts              # Central registry of help text
    HelpTooltip.tsx             # Hover tooltip component
    HelpTooltip.css             # Tooltip styles
    index.ts                    # Module exports
  walkthroughs/
    types.ts                    # Type definitions
    atoms.ts                    # Jotai atoms for state
    WalkthroughService.ts       # Target resolution, positioning
    definitions/
      index.ts                  # Export all walkthroughs
      agent-mode-intro.ts       # Example walkthrough
      ...
    components/
      WalkthroughProvider.tsx   # Context provider + trigger logic
      WalkthroughCallout.tsx    # Floating callout UI
      WalkthroughCallout.css    # Themed styles
```

## Adding Help Content

### Step 1: Add entry to HelpContent.ts

All help text lives in `packages/electron/src/renderer/help/HelpContent.ts`:

```typescript
export const HelpContent: Record<string, HelpEntry> = {
  // Key must match data-testid on the target element
  'my-feature-button': {
    title: 'Feature Name',           // Short title (2-5 words)
    body: 'Description of what this feature does and why it is useful.',
    shortcut: KeyboardShortcuts.myFeature.action,  // Optional
  },
};
```

Guidelines for help content:
- **title**: 2-5 words, describes what it is
- **body**: 1-2 sentences, explains what it does (not how to use it)
- **shortcut**: Reference from `KeyboardShortcuts` constants (optional)

### Step 2: Add data-testid to the target element

The target element needs a `data-testid` attribute matching the key in HelpContent:

```tsx
<button data-testid="my-feature-button" onClick={handleClick}>
  Feature
</button>
```

### Step 3: Choose a display pattern

There are two patterns for displaying help:

#### Pattern A: HelpTooltip wrapper

For elements that don't have their own tooltip:

```tsx
import { HelpTooltip } from '../../help';

<HelpTooltip testId="my-feature-button">
  <button data-testid="my-feature-button" onClick={handleClick} aria-label="Feature">
    Feature
  </button>
</HelpTooltip>
```

The tooltip appears on hover after a short delay, showing title, body, and keyboard shortcut.

**IMPORTANT: Remove the `title` attribute** from elements wrapped with `HelpTooltip`. The browser's native `title` tooltip will appear alongside the HelpTooltip, creating a duplicate. Use `aria-label` instead for accessibility.

#### Pattern B: Inline help icon

For elements that already have their own tooltip or popup (like the context indicator):

```tsx
import { getHelpContent } from '../../help';

const helpContent = getHelpContent('my-feature-button');

// Inside your existing tooltip:
{helpContent && (
  <button className="tooltip-help-button" onClick={() => setHelpExpanded(!helpExpanded)}>
    <MaterialSymbol icon="help" size={14} />
  </button>
)}
{helpExpanded && helpContent && (
  <div className="tooltip-help-section">
    <div className="tooltip-help-title">{helpContent.title}</div>
    <div className="tooltip-help-body">{helpContent.body}</div>
  </div>
)}
```

## Creating Walkthroughs

Walkthroughs are multi-step guides that highlight UI elements and provide contextual help.

**Before creating a walkthrough**, ensure that every target element:
1. Has a `HelpTooltip` wrapper (Pattern A above) so users get a hover tooltip too
2. Has the `title` attribute removed (to avoid duplicate tooltips)
3. Has a `data-testid` matching its HelpContent key

### Step 1: Create a walkthrough definition

Create a new file in `packages/electron/src/renderer/walkthroughs/definitions/`:

```typescript
// my-feature-intro.ts
import type { WalkthroughDefinition } from '../types';
import { getHelpContent } from '../../help';

const featureHelp = getHelpContent('my-feature-button')!;
const relatedHelp = getHelpContent('my-related-button')!;

export const myFeatureIntro: WalkthroughDefinition = {
  id: 'my-feature-intro',           // Unique ID
  name: 'My Feature Introduction',   // Display name
  version: 1,                        // Increment to re-show after updates
  trigger: {
    screen: 'files',                 // 'files' | 'agent' | '*'
    condition: () => {               // Optional: only show when condition is true
      return document.querySelector('[data-testid="my-feature-button"]') !== null;
    },
    delay: 2000,                     // Wait for UI to settle (ms)
    priority: 10,                    // Lower = higher priority
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

### Step 2: Register the walkthrough

Add the export to `definitions/index.ts`:

```typescript
import { myFeatureIntro } from './my-feature-intro';

export const walkthroughs: WalkthroughDefinition[] = [
  // ... existing walkthroughs
  myFeatureIntro,
];
```

### Walkthrough Definition Reference

```typescript
interface WalkthroughDefinition {
  id: string;                    // Unique identifier
  name: string;                  // Human-readable name
  version?: number;              // Increment to re-show to users who completed it
  trigger: {
    screen?: 'files' | 'agent' | '*';  // Which mode triggers it
    condition?: () => boolean;          // Additional condition
    delay?: number;                     // Delay before showing (ms)
    priority?: number;                  // Lower = higher priority (default: 10)
  };
  steps: WalkthroughStep[];
}

interface WalkthroughStep {
  id: string;
  target: {
    testId?: string;             // Preferred: data-testid attribute
    selector?: string;           // Fallback: CSS selector
  };
  title: string;
  body: string;
  shortcut?: string;             // From KeyboardShortcuts
  placement: 'top' | 'bottom' | 'left' | 'right';
  visibilityCondition?: () => boolean;  // Skip step if returns false
  action?: {                     // Optional action button
    label: string;
    onClick: () => void;
  };
}
```

## Testing Walkthroughs

### Dev Helpers

In development, `window.__walkthroughHelpers` provides debugging tools:

```javascript
// List all available walkthroughs
window.__walkthroughHelpers.listWalkthroughs()

// Start a specific walkthrough
window.__walkthroughHelpers.startWalkthrough('my-feature-intro')

// Dismiss current walkthrough
window.__walkthroughHelpers.dismissWalkthrough()

// Get current state
window.__walkthroughHelpers.getState()

// Reset all walkthrough progress
window.__walkthroughHelpers.resetState()
```

### E2E Tests

Walkthrough E2E tests are in `packages/electron/e2e/walkthroughs/`. Use the test helpers:

```typescript
import {
  waitForWalkthroughHelpers,
  resetWalkthroughState,
  startWalkthrough,
  clickWalkthroughNext,
  clickWalkthroughBack,
  verifyWalkthroughCompleted,
} from '../utils/testHelpers';

test('my walkthrough works', async ({ electronApp }) => {
  const window = await electronApp.firstWindow();

  await waitForWalkthroughHelpers(window);
  await resetWalkthroughState(window);

  await startWalkthrough(window, 'my-feature-intro');

  // Verify callout appears
  await expect(window.locator('.walkthrough-callout')).toBeVisible();

  // Take screenshot for visual verification
  await window.screenshot({ path: 'screenshots/my-walkthrough.png' });

  await clickWalkthroughNext(window);
  await verifyWalkthroughCompleted(window, 'my-feature-intro');
});
```

### Settings Integration

Users can enable/disable walkthroughs in Settings > Advanced:
- Toggle switch to enable/disable all guides
- Shows count of viewed guides (e.g., "3 of 6 viewed")
- Reset button to re-show all guides

## Analytics

Walkthroughs automatically track PostHog events:

| Event | When | Properties |
| --- | --- | --- |
| `walkthrough_started` | Guide begins | `walkthroughId`, `stepCount` |
| `walkthrough_step_viewed` | User advances | `walkthroughId`, `stepId`, `stepIndex` |
| `walkthrough_completed` | All steps done | `walkthroughId`, `stepCount` |
| `walkthrough_dismissed` | User dismisses | `walkthroughId`, `stepId`, `method` |

## Best Practices

### Help Content

1. **Be concise**: Users skim tooltips. Keep titles to 2-5 words, body to 1-2 sentences.
2. **Focus on "what" not "how"**: Describe what the feature does, not step-by-step instructions.
3. **Use consistent language**: Match terminology used elsewhere in the UI.
4. **Include shortcuts**: If there's a keyboard shortcut, always include it.

### Walkthroughs

1. **Keep them short**: 2-4 steps maximum. Users abandon long walkthroughs.
2. **Target discoverable features**: Focus on features users might miss, not obvious ones.
3. **Use appropriate triggers**: Don't interrupt users at bad times. Use `delay` and `condition`.
4. **Test visibility**: Ensure target elements are actually visible when the walkthrough triggers.
5. **Pull from HelpContent**: Always use `getHelpContent()` instead of hardcoding text.
6. **Always add HelpTooltip**: Every walkthrough target element must also have a `HelpTooltip` wrapper so users get a hover tooltip. Remove any `title` attribute from the element to avoid duplicate native + custom tooltips.

### Element Targeting

1. **Prefer data-testid**: More stable than CSS selectors.
2. **Use descriptive IDs**: `file-tree-filter-button` not `btn-1`.
3. **Keep IDs consistent**: Once added, don't change them (breaks walkthroughs).

### Help Content Registry

See `HelpContent.ts` for the full list. Current categories:

- **File Tree**: filter, quick open, new file/folder
- **Unified Header**: AI sessions, document history, table of contents
- **Diff Mode**: keep/revert buttons
- **Navigation**: back/forward buttons
- **View Modes**: files mode, agent mode
- **Session Management**: history, quick open, archive
- **AI Input**: input field, mode toggle, plan mode
- **Model & Context**: model picker, context indicator
- **Transcript Controls**: archive, search
- **Voice Mode**: toggle
- **Project Gutter**: permissions, theme, settings
- **Settings**: project/global tabs, walkthrough settings
- **Project Manager**: open, recent projects

## Planned Walkthroughs

These walkthroughs are planned for future implementation:

- `document-history` - Recovering previous versions
- `voice-mode-intro` - Using voice input
- `permissions-intro` - Agent tool permissions
- `keyboard-shortcuts` - Productivity shortcuts
- `project-settings` - Per-project configuration

## Troubleshooting

### Walkthrough doesn't appear

1. Check if the target element exists and has the correct `data-testid`
2. Check if the screen trigger matches the current mode
3. Check if the `condition` function returns true
4. Check if the walkthrough was already completed (use `resetState()` in dev tools)
5. Check browser console for errors

### Tooltip conflicts with existing popover

Use the "inline help icon" pattern instead of HelpTooltip wrapper. See ContextUsageDisplay for an example.

### Help text is cut off

Ensure the tooltip container has `white-space: normal` and `overflow-wrap: break-word`. The parent may have `white-space: nowrap` that needs to be overridden.

### Arrow doesn't point at target

The callout calculates `arrowOffset` when clamped to viewport bounds. If this isn't working, check that the target element's `getBoundingClientRect()` returns correct values.
