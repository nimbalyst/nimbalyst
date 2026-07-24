# Getting Started with Nimbalyst Extensions

This guide walks you through creating your first Nimbalyst extension. By the end, you'll have a working extension that registers a custom editor for `.hello` files.

## Recommended: Create It From Inside Nimbalyst

The intended workflow is to scaffold and iterate on extensions from inside Nimbalyst:

1. Enable Extension Dev Tools in Settings > Advanced
2. Use `File > New Extension Project` or `Developer > New Extension Project`
3. Or ask Claude to run `/new-extension minimal ~/my-first-extension "Hello Editor"`
4. Ask Claude to build and install it with `extension_build` and `extension_install`
5. Use `extension_reload` while iterating

The rest of this guide shows the manual scaffold path if you prefer to create the project yourself.

## Prerequisites

1. **Enable Extension Dev Tools** - Go to Settings > Advanced and enable "Extension Dev Tools"
2. **Node.js 18+** - Required for building extensions

## Step 1: Create the Project

Create a new directory for your extension:

```bash
mkdir my-first-extension
cd my-first-extension
npm init -y
```

## Step 2: Install Dependencies

```bash
npm install --save-dev typescript vite @nimbalyst/extension-sdk
npm install react
```

## Step 3: Create the Manifest

Create `manifest.json` - this tells Nimbalyst about your extension:

```json
{
  "id": "com.example.hello-editor",
  "name": "Hello Editor",
  "version": "1.0.0",
  "description": "A simple custom editor for .hello files",
  "main": "dist/index.js",
  "apiVersion": "1.0.0",
  "contributions": {
    "customEditors": [
      {
        "filePatterns": ["*.hello"],
        "displayName": "Hello Editor",
        "component": "HelloEditor"
      }
    ],
    "newFileMenu": [
      {
        "extension": ".hello",
        "displayName": "Hello File",
        "icon": "description",
        "defaultContent": "Hello, World!"
      }
    ]
  }
}
```

`apiVersion` is currently optional but recommended.

## Step 4: Create the Vite Config

Create `vite.config.ts`:

```typescript
import { defineConfig } from 'vite';
import { createExtensionConfig } from '@nimbalyst/extension-sdk/vite';

export default defineConfig(
  createExtensionConfig({
    entry: './src/index.ts',
  })
);
```

## Step 5: Create the TypeScript Config

Create `tsconfig.json`:

```json
{
  "compilerOptions": {
    "target": "ES2020",
    "module": "ESNext",
    "moduleResolution": "bundler",
    "jsx": "react-jsx",
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "declaration": true,
    "outDir": "dist",
    "rootDir": "src"
  },
  "include": ["src/**/*"]
}
```

## Step 6: Create the Extension Entry Point

Create `src/index.ts`:

```typescript
import type { ExtensionContext } from '@nimbalyst/extension-sdk';
import { HelloEditor } from './HelloEditor';

// Export components that the manifest references
export const components = {
  HelloEditor,
};

// Called when the extension is loaded
export function activate(context: ExtensionContext) {
  console.log('Hello Editor extension activated!');
}

// Called when the extension is unloaded
export function deactivate() {
  console.log('Hello Editor extension deactivated');
}
```

## Step 7: Create the Editor Component

Create `src/HelloEditor.tsx`:

```tsx
import React, { useRef, useReducer } from 'react';
import { useEditorLifecycle } from '@nimbalyst/extension-sdk';
import type { EditorHostProps } from '@nimbalyst/extension-sdk';

export function HelloEditor({ host }: EditorHostProps) {
  const textRef = useRef('');
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const [, forceRender] = useReducer((x) => x + 1, 0);

  const { isLoading, error, markDirty } = useEditorLifecycle(host, {
    applyContent: (content: string) => {
      textRef.current = content;
      if (textareaRef.current) {
        textareaRef.current.value = content;
      }
      forceRender();
    },
    getCurrentContent: () => textRef.current,
  });

  const handleChange = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
    textRef.current = e.target.value;
    markDirty();
  };

  if (error) return <div style={{ padding: '20px' }}>Error: {error.message}</div>;
  if (isLoading) return <div style={{ padding: '20px' }}>Loading...</div>;

  return (
    <div style={{
      padding: '20px',
      height: '100%',
      display: 'flex',
      flexDirection: 'column'
    }}>
      <h2 style={{ marginBottom: '10px' }}>Hello Editor</h2>
      <p style={{ color: 'var(--nim-text-muted)', marginBottom: '10px' }}>
        Editing: {host.filePath}
      </p>
      <textarea
        ref={textareaRef}
        defaultValue={textRef.current}
        onChange={handleChange}
        style={{
          flex: 1,
          padding: '10px',
          fontSize: '16px',
          fontFamily: 'monospace',
          backgroundColor: 'var(--nim-bg-secondary)',
          color: 'var(--nim-text)',
          border: '1px solid var(--nim-border)',
          borderRadius: '4px',
          resize: 'none'
        }}
      />
    </div>
  );
}
```

**Key points:**
- `useEditorLifecycle` handles loading, saving, file watching, echo detection, and dirty state
- `applyContent` pushes content into the editor (on load, external changes)
- `getCurrentContent` pulls content from the editor (on save)
- Call `markDirty()` when the user edits -- the hook manages `host.setDirty()` for you
- Content lives in a ref, not React state -- the textarea uses `defaultValue`

## Step 8: Add Build Script

Update your `package.json` to add a build script:

```json
{
  "scripts": {
    "build": "vite build"
  }
}
```

## Step 9: Build and Install

Now ask Claude to build and install your extension:

> "Build and install my extension from ~/my-first-extension"

Claude will use the `extension_build` and `extension_install` tools to compile and load your extension.

## Step 10: Test It

1. Create a new file with the `.hello` extension
2. Your custom editor should appear instead of the default text editor
3. Make changes and save - they persist to the file

## Next Steps

- Add styling with a `styles.css` file
- Add AI tools so Claude can interact with your editor
- Add a toolbar with actions
- Handle more complex file formats
- Extend the built-in markdown editor or transcript renderer with
  [contribution-points.md](./contribution-points.md)

See the [custom-editors.md](./custom-editors.md) guide for more advanced editor development.

## Troubleshooting

### Extension doesn't load

1. Check the console for errors (View > Toggle Developer Tools)
2. Verify your `manifest.json` has a valid `id` field
3. Make sure `dist/index.js` exists after building

### Editor doesn't appear for file type

1. Check that `filePatterns` in the manifest matches your file extension
2. Verify the `component` name matches what you export in `components`

### Changes don't appear after editing

Ask Claude to reload the extension:

> "Reload my hello-editor extension"

This will rebuild and hot-reload without restarting Nimbalyst.
