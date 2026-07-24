# Walkthrough Guides & Help Content

The application includes a walkthrough guide system for feature discovery and contextual help.

## Key Concepts

- **HelpContent**: Centralized registry of help text in `packages/electron/src/renderer/help/HelpContent.ts`, keyed by `data-testid`
- **HelpTooltip**: Wrapper component that shows help on hover for any element with a `data-testid`
- **Walkthroughs**: Multi-step floating guides defined in `packages/electron/src/renderer/walkthroughs/definitions/`

## Adding Help Content

1. Add entry to `HelpContent.ts` with title, body, and optional keyboard shortcut
2. Add `data-testid` attribute to the target UI element
3. Wrap element with `<HelpTooltip testId="...">` for hover tooltip
4. Create a walkthrough definition if a multi-step guide is needed

## Two Display Patterns

1. **HelpTooltip wrapper** - For elements without existing tooltips
2. **Inline help icon** - For elements that already have their own popup (like context indicator)

## File Structure

```
packages/electron/src/renderer/
  help/
    HelpContent.ts     # Centralized registry of help text
    HelpTooltip.tsx    # Wrapper component for tooltips
    index.ts           # Exports
  walkthroughs/
    WalkthroughService.ts  # Core service logic
    types.ts               # Type definitions
    atoms.ts               # Jotai state atoms
    components/
      WalkthroughCallout.tsx
      WalkthroughProvider.tsx
    definitions/
      agent-welcome-intro.ts
      ai-sessions-button.ts
      attach-files-intro.ts
      context-window-intro.ts
      diff-mode-intro.ts
      file-tree-tools.ts
      files-scope-intro.ts
      git-commit-mode-intro.ts
      layout-controls-intro.ts
      model-picker-intro.ts
      navigation-intro.ts
      plan-mode-intro.ts
      session-quick-open-intro.ts
      index.ts
```

## HelpContent Entry Format

```typescript
// In HelpContent.ts
export const helpContent: Record<string, HelpEntry> = {
  'my-feature-button': {
    title: 'My Feature',
    body: 'Description of what this feature does and how to use it.',
    shortcut: 'Cmd+Shift+F',  // Optional keyboard shortcut
  },
};
```

## Walkthrough Definition Format

```typescript
// In walkthroughs/definitions/my-feature-intro.ts
export const myFeatureIntro: WalkthroughDefinition = {
  id: 'my-feature-intro',
  name: 'My Feature Introduction',
  steps: [
    {
      targetTestId: 'my-feature-button',
      title: 'Step 1: Click here',
      content: 'This is where you start...',
      position: 'right',
    },
    {
      targetTestId: 'my-feature-panel',
      title: 'Step 2: Configure',
      content: 'Now configure your settings...',
      position: 'bottom',
    },
  ],
};
```

## Using HelpTooltip

```tsx
import { HelpTooltip } from '@/help';

// Wrap any element that has a data-testid
<HelpTooltip testId="my-feature-button">
  <button data-testid="my-feature-button">
    My Feature
  </button>
</HelpTooltip>
```

## Testing

E2E tests for the walkthrough system are located at:
- `packages/electron/e2e/walkthroughs/walkthrough-system.spec.ts`

## Best Practices

1. Always add `data-testid` to elements that need help content
2. Keep help text concise and actionable
3. Include keyboard shortcuts when available
4. Test walkthroughs with the actual UI flow
5. Use position hints (`top`, `bottom`, `left`, `right`) that don't obscure the target element
