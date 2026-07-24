---
description: Create a new Nimbalyst extension project from a starter scaffold
allowed_tools:
  - Read
  - Write
  - Edit
  - Glob
  - Bash
---

# /new-extension Command

Scaffolds a new Nimbalyst extension project from a neutral starter scaffold and creates a development plan for user review before implementation begins.

## Workflow

This command follows a **plan-first approach**:

1. **Scaffold** - Create base project files (manifest, package.json, configs)
2. **Plan** - Generate a README.md with development plan for review
3. **Wait** - User reviews plan, answers questions, approves approach
4. **Implement** - Only after approval, build the actual extension code

**IMPORTANT**: Do NOT immediately implement the full extension. Create the scaffold and plan first, then STOP and wait for user feedback.

## Usage

```
/new-extension <path> <name> [file-patterns]
```

### Arguments

- `<path>` - Directory path where the extension should be created
- `<name>` - Human-readable name for the extension (e.g., "3D Model Viewer")
- `[file-patterns]` - (Optional) Comma-separated file patterns (e.g., `*.obj,*.stl`)

Legacy form still works:

```
/new-extension <template> <path> <name> [file-patterns]
```

### Examples

```
/new-extension ~/extensions/obj-viewer "OBJ Viewer" *.obj
/new-extension ~/my-todo-extension "Todo List Editor" *.todo
/new-extension ~/code-metrics "Code Metrics"
```

## Step 1: Create Project Scaffold

Create these base files only:

### manifest.json

```json
{
  "id": "com.nimbalyst.<extension-name>",
  "name": "<Extension Name>",
  "version": "0.1.0",
  "description": "<Brief description - will be refined in planning>",
  "main": "dist/index.js",
  "apiVersion": "1.0.0",
  "permissions": {},
  "contributions": {}
}
```

`apiVersion` is currently optional but recommended.

### package.json

```json
{
  "name": "<extension-id>",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "scripts": {
    "build": "vite build"
  },
  "dependencies": {
    "react": "^18.2.0"
  },
  "devDependencies": {
    "@nimbalyst/extension-sdk": "^0.1.0",
    "@types/react": "^18.2.0",
    "typescript": "^5.0.0",
    "vite": "^7.1.12"
  }
}
```

### tsconfig.json

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

### vite.config.ts

```typescript
import { defineConfig } from 'vite';
import { createExtensionConfig } from '@nimbalyst/extension-sdk/vite';

export default defineConfig(createExtensionConfig({
  entry: './src/index.ts',
}));
```

### src/index.ts (minimal placeholder)

```typescript
// Extension entry point - implementation pending plan approval

export const components = {};

export function activate() {
  console.log('Extension activated');
}

export function deactivate() {
  console.log('Extension deactivated');
}
```

## Step 2: Create Development Plan (README.md)

After creating the scaffold, generate a comprehensive README.md that serves as the development plan. This is the most important output - it should help clarify requirements before any coding begins.

### README.md Template

```markdown
# <Extension Name>

> Development plan - please review and provide feedback before implementation begins.

## Overview

<Brief description of what this extension will do>

## Open Questions

Before building, I need clarification on:

1. **<Question about core functionality>**
   - Option A: ...
   - Option B: ...
   - Your preference?

2. **<Question about UI/UX>**
   - ...

3. **<Question about file format or data>**
   - ...

4. **<Question about edge cases>**
   - ...

## Proposed Features

### Core Features (v0.1.0)
- [ ] <Feature 1>
- [ ] <Feature 2>
- [ ] <Feature 3>

### Nice to Have (Future)
- [ ] <Future feature 1>
- [ ] <Future feature 2>

## Design Mockups

<If this is a visual extension, consider creating mockup files>

Would you like me to create a `.mockup.html` file to visualize the UI before building?

- [ ] Yes, create a mockup first
- [ ] No, proceed with implementation

## Technical Approach

### File Format
<Description of how files will be parsed/stored>

### Component Structure
<High-level description of React components>

### AI Tools (if applicable)
<What AI tools will be provided and what they'll do>

## Implementation Checklist

### Phase 1: Basic Structure
- [ ] Set up manifest.json with contributions
- [ ] Create main editor component
- [ ] Implement file parsing
- [ ] Implement file serialization
- [ ] Basic styling with theme variables

### Phase 2: Core Functionality
- [ ] <Specific feature implementation>
- [ ] <Another feature>
- [ ] Error handling

### Phase 3: Polish
- [ ] Keyboard shortcuts
- [ ] Undo/redo support
- [ ] Performance optimization for large files

### Phase 4: AI Integration (if needed)
- [ ] Define AI tools
- [ ] Implement tool handlers
- [ ] Test with Claude

## Next Steps

Please review this plan and:
1. Answer the open questions above
2. Confirm or modify the feature list
3. Let me know if you want mockups first
4. Say "approved" or "proceed" when ready to start implementation

---
*This plan was generated by the Extension Developer Kit. Edit as needed.*
```

## Step 3: STOP and Wait

After creating the scaffold and README.md:

1. **Tell the user** the project has been scaffolded
2. **Point them to README.md** to review the development plan
3. **Ask them to review** and provide feedback
4. **Do NOT start implementing** until they approve

Example response after scaffolding:

> I've created the extension scaffold at `<path>` with:
> - `manifest.json` - Extension metadata
> - `package.json` - Dependencies
> - `tsconfig.json` - TypeScript config
> - `vite.config.ts` - Build config
> - `src/index.ts` - Placeholder entry point
> - `README.md` - **Development plan for your review**
>
> Please open `README.md` and:
> 1. Review the proposed features
> 2. Answer the open questions
> 3. Let me know if you'd like mockups before implementation
> 4. Say "approved" when ready to proceed
>
> I'll wait for your feedback before writing any implementation code.

## Reference: Manifest Contributions

When updating the manifest during implementation, use these schemas:

### customEditors

```json
"customEditors": [
  {
    "filePatterns": ["*.ext"],
    "displayName": "My Editor",
    "component": "MyEditorComponent"
  }
]
```

### newFileMenu

```json
"newFileMenu": [
  {
    "extension": ".ext",
    "displayName": "My File Type",
    "icon": "description",
    "defaultContent": "# New file\n"
  }
]
```

**Required fields**: `extension`, `displayName`, `icon`, `defaultContent`
**Do NOT use `label`** - use `displayName` instead.

### fileIcons

```json
"fileIcons": {
  "*.ext": "icon_name"
}
```

### aiTools

```json
"aiTools": ["myext.tool_name", "myext.another_tool"]
```

## Reference: CSS Theme Variables

| Variable | Purpose |
| --- | --- |
| `--nim-bg` | Main background |
| `--nim-bg-secondary` | Toolbar/panel background |
| `--nim-bg-tertiary` | Nested element background |
| `--nim-bg-hover` | Hover state background |
| `--nim-text` | Main text color |
| `--nim-text-muted` | Muted text |
| `--nim-border` | Main borders |
| `--nim-primary` | Accent/brand color |

## Reference: useEditorLifecycle Hook

Use the `useEditorLifecycle` hook from `@nimbalyst/extension-sdk` to handle all editor lifecycle concerns. It replaces manual `useEffect` subscriptions for loading, saving, file watching, echo detection, dirty state, diff mode, and theme tracking.

```tsx
import { useRef } from 'react';
import { useEditorLifecycle } from '@nimbalyst/extension-sdk';
import type { EditorHostProps } from '@nimbalyst/extension-sdk';

export function MyEditor({ host }: EditorHostProps) {
  const dataRef = useRef<MyData>(defaultData);

  const { isLoading, error, theme, markDirty, diffState } = useEditorLifecycle(host, {
    applyContent: (data: MyData) => { dataRef.current = data; },
    getCurrentContent: () => dataRef.current,
    parse: (raw) => JSON.parse(raw),        // raw file string -> editor format
    serialize: (data) => JSON.stringify(data), // editor format -> file string
  });

  if (isLoading) return <div>Loading...</div>;
  return <MyEditorUI data={dataRef.current} onChange={markDirty} />;
}
```

The hook uses pull/push callbacks -- content **never** lives in React state:
- **`applyContent`**: push content INTO the editor (on load, external change)
- **`getCurrentContent`**: pull content FROM the editor (on save)

Additional options: `binary` (for binary files), `onLoaded`, `onExternalChange`, `onSave` (custom save flow), `onDiffRequested` / `onDiffCleared` (custom diff handling).

`@nimbalyst/runtime` is provided by the host at runtime -- do NOT add it to package.json dependencies.

## Key Principles

1. **Plan first, code later** - Always create README.md plan before implementation
2. **Ask questions** - If requirements are unclear, add them to Open Questions
3. **Suggest mockups** - For visual extensions, offer to create mockup.html files
4. **Incremental approval** - Get buy-in on approach before writing complex code
5. **Feature scope** - Start with core features, list nice-to-haves separately
