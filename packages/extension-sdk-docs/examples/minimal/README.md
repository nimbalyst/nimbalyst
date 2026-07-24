# Minimal Extension Example

This is the simplest possible Nimbalyst extension. It registers a custom editor for `.minimal` files.

## Structure

```
minimal/
  manifest.json      # Extension metadata
  package.json       # npm dependencies
  tsconfig.json      # TypeScript config
  vite.config.ts     # Build config
  src/
    index.ts         # Entry point
    MinimalEditor.tsx # Editor component
```

## Usage

1. Copy this folder to a new location
2. Run `npm install`
3. Ask Claude: "Build and install my extension from [path]"
4. Create a `.minimal` file to test

## Key Concepts

### manifest.json

Defines what your extension contributes:
- `customEditors` - Maps file patterns to components
- `component` value must match an export in `components`

### index.ts

Entry point that exports:
- `components` - Object mapping names to React components
- `activate()` - Called when extension loads
- `deactivate()` - Called when extension unloads

### MinimalEditor.tsx

Custom editor component that:
- Receives `host` via `EditorHostProps`
- Calls `host.loadContent()` on mount
- Calls `host.setDirty(true)` when the user edits
- Saves through `host.onSaveRequested()` / `host.saveContent()`

## Customizing

To adapt this example:

1. Change `id` in manifest.json to your unique ID
2. Update `filePatterns` for your file type
3. Rename component and update manifest `component` field
4. Add your editor logic to the component
