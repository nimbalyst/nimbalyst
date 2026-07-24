# State Persistence Migration Safety

**CRITICAL: Persisted state may be missing fields added after it was saved.**

When loading state from disk (electron-store, workspace state, etc.), old persisted data may be missing fields that were added to interfaces later. This causes runtime errors like `Cannot read properties of undefined` when code assumes fields exist.

## The Problem

```typescript
// BAD: Assumes field exists - crashes on old persisted data
const config = await loadConfig();
const trimmed = config.newField.trim();  // TypeError if newField undefined

// BAD: Spread-only merge loses default for missing fields
const config = { ...loadedConfig };  // newField is undefined if not in persisted data
```

## The Solution: Always Merge with Defaults

Every persisted state interface needs:
1. A `createDefault*()` function with all field defaults
2. An `init*()` function that merges loaded data with defaults

```typescript
// GOOD: Define defaults for all fields
const defaultConfig: Config = {
  existingField: 'value',
  newField: '',           // Added later - needs default
  optionalArray: [],      // Arrays need explicit defaults too
};

// GOOD: Merge with defaults on load
async function initConfig(): Promise<Config> {
  const loaded = await loadFromDisk();
  if (loaded) {
    return {
      existingField: loaded.existingField ?? defaultConfig.existingField,
      newField: loaded.newField ?? defaultConfig.newField,
      optionalArray: loaded.optionalArray ?? defaultConfig.optionalArray,
    };
  }
  return defaultConfig;
}
```

## Pattern Examples in Codebase

**Workspace State** (`packages/electron/src/main/utils/store.ts`):
- Uses `normalizeWorkspaceState()` which deep-merges with `createDefaultWorkspaceState()`
- New fields automatically get defaults if added to `createDefaultWorkspaceState()`

**Workstream State** (`packages/electron/src/renderer/store/atoms/workstreamState.ts`):
- Uses `deepMergeWorkstreamState()` to merge persisted data with `createDefaultState()`
- Auto-merges any field present in source, preserving defaults for missing fields

**App Settings** (`packages/electron/src/renderer/store/atoms/appSettings.ts`):
- Each settings domain has explicit `??` defaults in its `init*()` function
- Example: `enabled: loaded.enabled ?? defaultConfig.enabled`

## Checklist When Adding New Persisted Fields

1. Add the field to the interface
2. Add a default value in the `createDefault*()` or `default*` constant
3. Ensure the `init*()` function uses `??` to provide the default
4. If using deep merge, verify it handles the new field automatically
5. Consider: what happens if a user with old data loads this new code?

## Anti-Patterns to Avoid

| Anti-Pattern | Problem | Solution |
| --- | --- | --- |
| `loaded.field` without default | Crashes on old data | Use `loaded.field ?? default` |
| `{ ...loaded }` without merge | Missing fields are undefined | Merge with full default object |
| Manual field enumeration | Forget to add new fields | Use automatic deep merge |
| Optional fields without `[]` | Array methods fail on undefined | Default to `[]` |

## Key Files

- `packages/electron/src/main/utils/store.ts` - Workspace state persistence
- `packages/electron/src/renderer/store/atoms/appSettings.ts` - App settings persistence
- `packages/electron/src/renderer/store/atoms/workstreamState.ts` - Workstream state persistence
- `packages/electron/src/main/ipc/WorkspaceHandlers.ts` - IPC handlers for workspace state
