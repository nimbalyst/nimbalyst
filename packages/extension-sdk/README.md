# `@nimbalyst/extension-sdk`

Build Nimbalyst extensions with a stable TypeScript contract and Vite helpers.

This package provides:

- Shared extension types such as `ExtensionContext`, `EditorHostProps`, and `ExtensionAITool`
- `createExtensionConfig()` for the required extension build setup
- `validateExtensionBundle()` for bundle and manifest validation
- Tailwind helpers for extension styling

## Install

```bash
npm install --save-dev @nimbalyst/extension-sdk typescript vite
```

If your extension renders React UI, also install:

```bash
npm install react react-dom
npm install --save-dev @vitejs/plugin-react
```

## Vite Setup

```ts
import react from '@vitejs/plugin-react';
import { createExtensionConfig } from '@nimbalyst/extension-sdk/vite';

export default createExtensionConfig({
  entry: './src/index.tsx',
  plugins: [react()],
});
```

## Custom Editor Example

Use the `useEditorLifecycle` hook to handle all editor lifecycle concerns (loading, saving, echo detection, file watching, diff mode, theme):

```tsx
import { useRef } from 'react';
import { useEditorLifecycle, type EditorHostProps } from '@nimbalyst/extension-sdk';

export function ExampleEditor({ host }: EditorHostProps) {
  const dataRef = useRef<MyData>(defaultData);

  const { isLoading, markDirty, theme } = useEditorLifecycle(host, {
    applyContent: (data: MyData) => { dataRef.current = data; },
    getCurrentContent: () => dataRef.current,
    parse: (raw) => JSON.parse(raw),
    serialize: (data) => JSON.stringify(data),
  });

  if (isLoading) return <div>Loading...</div>;
  return <MyEditorUI data={dataRef.current} onChange={markDirty} />;
}

export const components = {
  ExampleEditor,
};
```

See the [custom editors guide](packages/extension-sdk-docs/custom-editors.md) for architecture patterns and advanced options.

## Shared Editor Components

Extensions can use the host's built-in `MonacoEditor` (code) and `MarkdownEditor` (rich text) instead of bundling their own. These are provided at runtime via the externals system with zero bundle size impact. The `MarkdownEditor` is pre-configured with toolbar, image handling, and other Nimbalyst platform features.

```tsx
import { MonacoEditor } from '@nimbalyst/runtime';
import type { EditorHostProps } from '@nimbalyst/extension-sdk';

// Use as a full file editor
export const MyCodeEditor = ({ host }: EditorHostProps) => {
  return <MonacoEditor host={host} fileName={host.fileName} />;
};
```

For embedded read-only panels, use `createReadOnlyHost`:

```tsx
import { MonacoEditor } from '@nimbalyst/runtime';
import { createReadOnlyHost } from '@nimbalyst/extension-sdk';

const previewHost = createReadOnlyHost(code, {
  fileName: 'preview.tsx',
  theme: host.theme,
});

<MonacoEditor host={previewHost} fileName="preview.tsx" />
```

Type imports for props: `MonacoEditorProps`, `MonacoEditorConfig`, `MarkdownEditorProps`, `MarkdownEditorConfig` from `@nimbalyst/extension-sdk`.

## Tracker References

Custom editors and panels can link their own data to tracker items without
querying Nimbalyst's internal tracker store. Persist only the reference keys
returned by the picker; chips resolve live metadata and open the item through
the host's contextual navigation.

```tsx
import {
  TrackerReferenceChip,
  TrackerReferencePicker,
} from '@nimbalyst/extension-sdk';

<TrackerReferencePicker
  value={trackerRefs}
  onChange={setTrackerRefs}
  disabled={host.readOnly}
/>

{trackerRefs.map(referenceKey => (
  <TrackerReferenceChip
    key={referenceKey}
    referenceKey={referenceKey}
    variant="compact"
  />
))}
```

The picker supports single or multiple selection, search, unresolved keys, and
read-only mutation state. `TrackerReferenceChip` supports `default` and
`compact` variants; both retain live preview and navigation behavior.

## AI Tool Example

```ts
import type {
  ExtensionAITool,
  ExtensionToolResult,
} from '@nimbalyst/extension-sdk';

export const aiTools: ExtensionAITool[] = [
  {
    name: 'example.describe_file',
    description: 'Describe the active file',
    scope: 'editor',
    inputSchema: {
      type: 'object',
      properties: {},
    },
    handler: async (_args, context): Promise<ExtensionToolResult> => {
      const filePath = context.activeFilePath;
      if (!filePath) {
        return { success: false, error: 'No active file.' };
      }

      const content = await context.extensionContext.services.filesystem.readFile(filePath);
      return {
        success: true,
        data: {
          filePath,
          length: content.length,
        },
      };
    },
  },
];
```

## Manifest Notes

- `apiVersion` is currently optional but recommended.
- `contributions.aiTools` must be an array of tool-name strings, not full tool objects.
- `contributions.fileIcons` must be an object map such as `{ "*.csv": "table" }`.

## Docs

- Getting started: `packages/extension-sdk-docs/getting-started.md`
- Manifest reference: `packages/extension-sdk-docs/manifest-reference.md`
- API reference: `packages/extension-sdk-docs/api-reference.md`
- Examples: `packages/extension-sdk-docs/examples/`

## Release Checks

From the monorepo root:

```bash
npm run extension-sdk:check-public
```
