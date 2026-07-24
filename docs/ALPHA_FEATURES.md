# Alpha Features System

This document describes how to work with the alpha features system in Nimbalyst.

## Overview

Alpha features are individually toggleable experimental features. They are available to **all users regardless of release channel** and default to disabled — each user opts in per feature in the relevant settings panel. This system ensures that:

1. All alpha features are **explicitly registered** in a central location
2. Features can be toggled **independently** without code changes
3. Type safety prevents typos when checking feature availability
4. Each feature has a toggle in its natural settings location (e.g. Voice Mode in the Voice Mode panel, agent-mode features in the Agent Features panel)

## Adding a New Alpha Feature

To add a new alpha feature to the system:

### 1. Register the Feature

Add your feature to `/packages/electron/src/shared/alphaFeatures.ts`:

```typescript
export const ALPHA_FEATURES: readonly AlphaFeatureDefinition[] = [
  // ... existing features ...
  {
    tag: 'my-new-feature',           // Unique identifier (kebab-case)
    name: 'My New Feature',          // Display name in settings
    description: 'Description of what this feature does.',
    icon: 'star',                    // Optional Material Symbol icon name
  },
] as const;
```

**Important:** The `tag` is the unique identifier that will be used throughout the codebase. Use kebab-case (e.g., `'my-feature'`, not `'myFeature'` or `'MyFeature'`).

### 2. Use the Feature in Your Code

#### Option A: Using the `useAlphaFeature` Hook (Recommended for Components)

```tsx
import { useAlphaFeature } from '../../hooks/useAlphaFeature';

function MyComponent() {
  const isEnabled = useAlphaFeature('my-new-feature');

  if (!isEnabled) {
    return null; // or show fallback UI
  }

  return <MyExperimentalFeature />;
}
```

#### Option B: Using the Atom Directly

```tsx
import { alphaFeatureEnabledAtom } from '../../store/atoms/appSettings';
import { useAtomValue } from 'jotai';

function MyComponent() {
  const isEnabledAtom = alphaFeatureEnabledAtom('my-new-feature');
  const isEnabled = useAtomValue(isEnabledAtom);

  if (!isEnabled) {
    return null;
  }

  return <MyExperimentalFeature />;
}
```

#### Option C: Async Check (Outside React Components)

```typescript
import { window } from 'electron';
import type { AlphaFeatureTag } from '@nimbalyst/shared/alphaFeatures';

async function checkFeature(tag: AlphaFeatureTag): Promise<boolean> {
  const features = await window.electronAPI.invoke('alpha-features:get');
  return features[tag] ?? false;
}

// Usage
const isEnabled = await checkFeature('my-new-feature');
```

## Feature Registry

The feature registry is located at `/packages/electron/src/shared/alphaFeatures.ts` and contains all available alpha features.

### Current Features

See `ALPHA_FEATURES` in `/packages/electron/src/shared/alphaFeatures.ts` for the live list. Features that have their own dedicated settings panel (e.g. Voice Mode, OpenCode, GitHub Copilot) are not in the registry — they expose their own enable toggle directly.

## How It Works

### Storage

Alpha feature flags are stored in the electron-store as a flat record keyed by tag, e.g.:

```typescript
{
  alphaFeatures: {
    'blitz': true,
    'super-loops': false,
    'collaboration': true,
  }
}
```

Missing entries default to `false`. The release channel does not affect feature availability — channel only controls which auto-update stream the user pulls from.

### Type Safety

The `AlphaFeatureTag` type is automatically derived from the registry, so TypeScript will prevent typos when calling `useAlphaFeature`:

```typescript
// ✅ Correct
const enabled = useAlphaFeature('collaboration');

// ❌ Type error - typo
const enabled = useAlphaFeature('collab');
```

### Surfacing the Toggle

Add the toggle wherever it belongs naturally:

- Agent-mode behaviors (super-loops, blitz, meta-agent) appear in the **Agent Features** settings panel
- Collaboration toggle lives at the top of the **Account & Sync** panel
- Features with their own panel (Voice Mode, OpenCode, Copilot) expose their own enable toggle directly and are not in the alpha registry

## Best Practices

1. **Use kebab-case for tags**: `'my-feature'` not `'myFeature'`
2. **Provide clear descriptions**: Users should understand what the feature does
3. **Keep tags short and descriptive**: `'voice-mode'` is better than `'enable-voice-interaction-mode'`
4. **Test with feature disabled**: Ensure your code handles the case where the feature is disabled
5. **Use the hook**: Prefer `useAlphaFeature` over direct atom access for better readability

## Migration Guide

If you have existing code that checks `releaseChannel === 'alpha'`, migrate it to use a per-feature flag — channel must not gate features:

### Before

```tsx
const releaseChannel = useAtomValue(releaseChannelAtom);

if (releaseChannel === 'alpha') {
  return <ExperimentalThing />;
}
```

### After

```tsx
const isEnabled = useAlphaFeature('experimental-thing');

if (isEnabled) {
  return <ExperimentalThing />;
}
```

## Validation

The system includes validation to catch unregistered feature tags during development:

```typescript
import { validateAlphaFeatureTags } from '@nimbalyst/shared/alphaFeatures';

const result = validateAlphaFeatureTags(['blitz', 'super-loops', 'unknown-tag']);
if (!result.valid) {
  console.warn('Unknown feature tags:', result.unknown);
  // Output: Unknown feature tags: ['unknown-tag']
}
```
