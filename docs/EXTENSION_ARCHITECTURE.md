# Extension Architecture

**The extension system is the foundation for all future development.** Every editor type and file handler will ultimately be provided through extensions, creating a cohesive, pluggable lifecycle for all content types.

## What Extensions Provide

Extensions can contribute:
- **Custom Editors**: Full editor implementations for specific file types (Monaco for code, RevoGrid for CSV/spreadsheets, Excalidraw for diagrams, DataModelLM for visual data modeling, mockup editors, etc.)
- **File Type Handlers**: Associate file extensions with specific editors
- **AI Tools via MCP**: Expose functionality to AI agents through the Model Context Protocol
- **Custom UI Components**: Panels, widgets, and tool call renderers

## Current Editor Types

Nimbalyst supports diverse editor types beyond traditional text:
- **Lexical** (`.md`, `.txt`): Rich text markdown editing with tables, images, code blocks
- **Monaco** (`.ts`, `.js`, `.json`, etc.): Full VS Code-style code editing with syntax highlighting, intellisense
- **RevoGrid** (`.csv`): Spreadsheet-style editing with formulas, sorting, filtering
- **Excalidraw** (`.excalidraw`): Whiteboard-style diagrams and drawings
- **DataModelLM** (`.datamodel`): Visual Prisma schema editor
- **Mockup Editor** (`.mockup.html`): Visual HTML mockup creation

## EditorHost Contract

All editors (including built-in ones) communicate through the `EditorHost` interface, ensuring consistent lifecycle management:

```typescript
interface EditorHost {
  loadContent(): Promise<string>;      // Load file content on mount
  saveContent(content: string): void;  // Save when user saves
  setDirty(dirty: boolean): void;      // Track unsaved changes
  onFileChanged(callback): void;       // Handle external file changes
  onSaveRequested(callback): void;     // Subscribe to save events
  onThemeChanged(callback): void;      // Subscribe to theme changes
  onDiffRequested?(callback): void;    // AI edit diff mode
  onDiffCleared?(callback): void;      // Diff mode dismissed
}
```

This contract ensures that extensions integrate seamlessly with tabs, dirty indicators, file watching, and AI edit streaming regardless of the underlying editor technology.

## useEditorLifecycle Hook (Recommended)

The `useEditorLifecycle` hook replaces all manual `EditorHost` subscription boilerplate with a single hook call. **All new custom editors should use this hook.**

```typescript
import { useEditorLifecycle } from '@nimbalyst/runtime';
import type { EditorHostProps } from '@nimbalyst/extension-sdk';

function MyEditor({ host }: EditorHostProps) {
  const editorRef = useRef<MyEditorAPI>(null);

  const { isLoading, error, theme, markDirty, diffState } = useEditorLifecycle(host, {
    applyContent: (parsed) => editorRef.current?.load(parsed),
    getCurrentContent: () => editorRef.current?.getData() ?? defaultValue,
    parse: (raw) => JSON.parse(raw),
    serialize: (data) => JSON.stringify(data),
  });

  return isLoading ? <Loading /> : <MyEditorComponent ref={editorRef} onChange={markDirty} />;
}
```

The hook handles:
- **Loading**: Calls `host.loadContent()` on mount, provides `isLoading` and `error` state
- **Saving**: Subscribes to `host.onSaveRequested()`, pulls content via `getCurrentContent`, serializes, and saves
- **Echo detection**: Ignores file change notifications caused by our own saves
- **External file changes**: Calls `applyContent` when the file changes on disk (not from our save)
- **Theme**: Tracks theme changes reactively
- **Diff mode**: Parses AI edit diffs and provides `diffState` with `accept`/`reject` callbacks
- **Source mode**: Tracks source mode toggle state

Content state **never** lives in this hook or in React state. The hook interacts with the editor through pull/push callbacks:
- `applyContent`: push content INTO the editor (load, external change)
- `getCurrentContent`: pull content FROM the editor (save)

This design works for all editor architectures:
- **Library-managed** (Excalidraw, Three.js): callbacks talk to the library's imperative API via refs
- **Store-managed** (Mindmap, DatamodelLM): callbacks talk to a Zustand store
- **Read-only** (PDF, SQLite): only `applyContent`, no `getCurrentContent`

### Advanced: Custom Save and Diff Overrides

For editors with specialized needs (async content extraction, cell-level diff), the hook provides override options:

```typescript
useEditorLifecycle(host, {
  applyContent: (content) => { /* ... */ },
  onSave: async () => {
    // Custom save flow (e.g., async serialization from RevoGrid)
    const content = await gridOps.toCSV();
    await host.saveContent(content);
  },
  onDiffRequested: (config) => {
    // Custom diff rendering (e.g., cell-level CSV diff with phantom rows)
  },
  onDiffCleared: async () => {
    // Custom diff cleanup
  },
});
```

## Shared Editor Components

Extensions can use the host's built-in editors instead of bundling their own. These are provided through the `@nimbalyst/runtime` externals system with zero bundle size impact.

### Available Components

| Component | Import | Use Case |
| --- | --- | --- |
| `MonacoEditor` | `import { MonacoEditor } from '@nimbalyst/runtime'` | Syntax-highlighted code editing with EditorHost integration |
| `MarkdownEditor` | `import { MarkdownEditor } from '@nimbalyst/runtime'` | Full Nimbalyst rich text markdown editor (Lexical-based) with toolbar, image handling, and EditorHost integration |

Both components accept an `EditorHost` as their primary prop and handle all lifecycle integration (loading, saving, dirty state, file changes) automatically.

The `MarkdownEditor` provided to extensions is pre-configured with Nimbalyst platform features:
- Toolbar enabled by default
- Image double-click opens in default app
- Image drag triggers native drag
- Respects `host.readOnly` for disabling editing

### Usage: Full File Editor

Use when your extension registers a custom editor that delegates to Monaco or Markdown:

```tsx
import { MonacoEditor } from '@nimbalyst/runtime';
import type { EditorHostProps } from '@nimbalyst/extension-sdk';

export const ConfigEditor = ({ host }: EditorHostProps) => {
  return <MonacoEditor host={host} fileName={host.fileName} />;
};
```

### Usage: Embedded Read-Only Panel

Use `createReadOnlyHost` from the SDK to embed an editor within a larger custom editor:

```tsx
import { MonacoEditor } from '@nimbalyst/runtime';
import { createReadOnlyHost } from '@nimbalyst/extension-sdk';

export const MyEditor = ({ host }: EditorHostProps) => {
  const [code, setCode] = useState('');

  const previewHost = useMemo(() => createReadOnlyHost(code, {
    fileName: 'preview.tsx',
    theme: host.theme,
  }), [code, host.theme]);

  return (
    <div style={{ display: 'flex', height: '100%' }}>
      <div style={{ flex: 1 }}>{/* Custom editor UI */}</div>
      <div style={{ flex: 1 }}>
        <MonacoEditor host={previewHost} fileName="preview.tsx" />
      </div>
    </div>
  );
};
```

### Type Imports

For type checking, import prop types from the extension SDK:

```typescript
import type {
  MonacoEditorProps,
  MonacoEditorConfig,
  MarkdownEditorProps,
  MarkdownEditorConfig,
} from '@nimbalyst/extension-sdk';
```

### Notes

- These components are already loaded by the host -- extensions get a reference to the same instance, not a copy
- Theme changes propagate automatically through `EditorHost.onThemeChanged`
- The `MarkdownEditor` is a configured wrapper that includes Nimbalyst platform integrations. Extensions can override defaults via the `config` prop
- Diff mode and collaboration are not available when using these editors in extensions (coupled to TabEditor internals)

## Extension Contract

Extensions receive `EditorHost` and must:
- Use `useEditorLifecycle` hook (recommended) or manually subscribe to host events
- Own all internal state -- content NEVER in React state for complex editors
- Call `saveContent()` when save requested
- Handle external file changes (hook does this automatically)
- NEVER depend on parent re-rendering them

## Contributing Lexical Extensions

Extensions can extend the built-in Lexical (rich-text) editor by
shipping their own `LexicalExtension` instances. The editor reads them
from the runtime store and includes them in its extension graph;
toggling an extension rebuilds the editor instance.

### Manifest

Declare the names of the `LexicalExtension` exports in your manifest:

```json
{
  "contributions": {
    "lexicalExtensions": ["MyEmojiExtension", "MyCommandPaletteExtension"]
  }
}
```

### Module exports

Export each named extension from your extension's `lexicalExtensions`
map. The SDK re-exports `defineExtension` / `configExtension` /
`declarePeerDependency` from `@lexical/extension` so extensions don't
need a direct dependency on the Lexical packages:

```ts
import { defineExtension } from '@nimbalyst/extension-sdk';
import { $insertNodes, COMMAND_PRIORITY_EDITOR, createCommand } from 'lexical';

const INSERT_EMOJI_COMMAND = createCommand('INSERT_EMOJI');

export const MyEmojiExtension = defineExtension({
  name: 'my-extension/emoji',
  register: (editor) =>
    editor.registerCommand(
      INSERT_EMOJI_COMMAND,
      () => {
        editor.update(() => {
          $insertNodes([/* ... */]);
        });
        return true;
      },
      COMMAND_PRIORITY_EDITOR,
    ),
});

export default {
  lexicalExtensions: {
    MyEmojiExtension,
  },
};
```

### What a Lexical extension can do

- **Register node classes** via `defineExtension({ nodes: [...] })`. The
  Lexical builder resolves them topologically; no other registration is
  needed.
- **Register commands, listeners, transforms** in `register(editor)`.
  Returning a cleanup function disposes them when the editor tears
  down.
- **Depend on other extensions** via `dependencies: [...]` and
  `configExtension(other, { ... })` to override config.

### Contributing markdown transformers and slash-picker entries

These contributions don't fit cleanly into the `LexicalExtension` shape
and use a parallel runtime store. The SDK exposes
`setExtensionContributions(sourceName, { userCommands, markdownTransformers })`
for extensions that need to add slash-picker entries or markdown
import/export transformers. Publish from your extension's activation
function:

```ts
import { setExtensionContributions } from '@nimbalyst/runtime';

setExtensionContributions('my-extension', {
  userCommands: [
    {
      title: 'Insert Emoji',
      description: 'Insert an emoji at the cursor',
      icon: 'emoji_emotions',
      keywords: ['emoji', 'icon'],
      command: INSERT_EMOJI_COMMAND,
    },
  ],
  markdownTransformers: [EMOJI_TRANSFORMER],
});
```

See `packages/runtime/src/editor/extensions/README.md` for the full
runtime-side contract, including how renderer-side React UI plugins
(typeahead menus, dialog hosts) register through
`registerExtensionEditorComponent`.

## AI Completion API

Extensions with `permissions.ai: true` can call AI chat/completion models directly. This is a stateless API -- no sessions are created in the session history.

### Available Methods

```typescript
// List models the user has enabled (Claude, OpenAI, LM Studio)
const models = await services.ai.listModels();
// => [{ id: "claude:claude-sonnet-4-6-...", name: "Claude Sonnet 4.6", provider: "claude" }, ...]

// Non-streaming completion
const result = await services.ai.chatCompletion({
  messages: [{ role: 'user', content: 'Summarize this text: ...' }],
  model: models[0].id,       // optional, uses provider default if omitted
  systemPrompt: 'Be concise', // optional, prepended as system message
  temperature: 0.7,           // optional
  maxTokens: 1024,            // optional
});
// => { content: "Here is a summary...", model: "claude-sonnet-4-6-...", usage: { inputTokens: 50, outputTokens: 30 } }

// Streaming completion
const handle = await services.ai.chatCompletionStream({
  messages: [{ role: 'user', content: 'Write a poem' }],
  onChunk: (chunk) => {
    if (chunk.type === 'text') appendToUI(chunk.content);
    if (chunk.type === 'error') showError(chunk.error);
    // chunk.type === 'done' signals completion
  },
});
// Abort if needed: handle.abort();
const finalResult = await handle.result;
```

### Key Points

- **Chat providers only**: Claude, OpenAI, and LM Studio. Agent providers (Claude Code, Codex) are not available through this API.
- **Model selection**: Pass a model `id` from `listModels()`, or omit to use the first available provider's default.
- **Multi-turn**: Pass multiple messages with alternating `user`/`assistant` roles for conversation context.
- **No sessions**: These completions are stateless and do not appear in session history. Use the existing `sendPrompt()` if you need session tracking.
- **Streaming abort**: The `ChatCompletionStreamHandle.abort()` method cancels the in-flight request.

### Types

All types are exported from `@nimbalyst/extension-sdk`:

| Type | Description |
|------|-------------|
| `ExtensionAIModel` | Model descriptor: `id`, `name`, `provider` |
| `ChatCompletionMessage` | Message: `role` (`user`/`assistant`/`system`), `content` |
| `ChatCompletionOptions` | Request: `messages`, `model?`, `maxTokens?`, `temperature?`, `systemPrompt?` |
| `ChatCompletionResult` | Response: `content`, `model`, `usage?` |
| `ChatCompletionStreamChunk` | Stream chunk: `type` (`text`/`error`/`done`), `content?`, `error?` |
| `ChatCompletionStreamOptions` | Extends options with `onChunk` callback |
| `ChatCompletionStreamHandle` | Stream control: `abort()`, `result` promise |

## Extension Development

When working on extensions in `packages/extensions/`:
- Use `mcp__nimbalyst-extension-dev__extension_reload` to rebuild and reload extensions
- Use `mcp__nimbalyst-extension-dev__extension_get_logs` to check for errors
- Use `mcp__nimbalyst-extension-dev__extension_get_status` to verify extension state
- **Never use manual `npm run build`** - always use the MCP tools for extension builds

## Marketplace Screenshots

Extensions can include screenshots for the in-app marketplace and marketing website. Add a `screenshots` array to the `marketplace` section of `manifest.json`:

```json
{
  "marketplace": {
    "screenshots": [
      {
        "alt": "Description of what the screenshot shows",
        "src": "screenshots/my-extension-dark.png",
        "srcLight": "screenshots/my-extension-light.png"
      }
    ]
  }
}
```

**Fields:**
- `src` (string) - Relative path to a dark-theme screenshot image bundled with the extension. If only one variant is provided, it is used for both themes.
- `srcLight` (string, optional) - Relative path to a light-theme screenshot. When provided, the in-app marketplace and website automatically show the correct variant based on the user's theme.
- `fileToOpen` (string) - Relative path to a sample file for the automated screenshot pipeline (internal extensions only).
- `selector` (string) - CSS selector to capture a specific element (used with `fileToOpen`).
- `alt` (string) - Alt text describing the screenshot.

External extension developers should place their screenshots in a `screenshots/` directory and reference them via `src` and optionally `srcLight`. The `fileToOpen` and `selector` fields are used by Nimbalyst's internal Playwright-based screenshot pipeline and can be ignored by external developers.

## Testing Extensions

Nimbalyst provides a Playwright-based testing system that runs against the live running app via CDP (Chrome DevTools Protocol). This enables both AI agents and human developers to test extensions without launching a separate Electron instance.

### Quick Start

```typescript
// tests/basics.spec.ts
import { test, expect, extensionEditor } from '@nimbalyst/extension-sdk/testing';

test('editor loads data', async ({ page }) => {
  const editor = extensionEditor(page, 'com.nimbalyst.my-extension');
  await expect(editor.locator('.header')).toBeVisible();
  await expect(editor.locator('.data-row')).toHaveCount(10);
});
```

### How It Works

1. Nimbalyst dev mode enables `--remote-debugging-port=9222`
2. The `@nimbalyst/extension-sdk/testing` fixture connects to the running app via `chromium.connectOverCDP()`
3. The fixture uses `testInfo.file` to find the window whose `workspacePath` is an ancestor of the test file — this correctly targets the right window even when multiple projects are open
4. Tests get the real `page` object — full Playwright API (locators, assertions, interactions, screenshots)
5. Tests are NOT sandboxed — they can interact with the entire Nimbalyst UI, not just the extension

### Multi-Window Support

When multiple Nimbalyst windows are open (e.g. different projects), the test fixture automatically finds the correct one by matching the test file's path against each window's workspace path. This means:

- **Always use `@nimbalyst/extension-sdk/testing`** — never write your own CDP connection boilerplate
- **Never hardcode workspace paths** — the fixture handles window matching automatically
- **External extensions work too** — a test file at `/my-project/tests/foo.spec.ts` will match the Nimbalyst window open on `/my-project/`

For test files that live outside any workspace (e.g. inline scripts created by `extension_test_run`), the fixture falls back to the first available Nimbalyst window. The `extension_test_run` MCP tool handles this by baking the workspace path into the generated test.

### MCP Tools for Agent-Driven Testing

| Tool | Description |
| --- | --- |
| `extension_test_run` | Run inline Playwright scripts or `.spec.ts` files. Inline scripts get a `page` already connected to the correct window. Test files should import from `@nimbalyst/extension-sdk/testing`. |
| `extension_test_open_file` | Open a file and wait for extension editor to mount |
| `extension_test_ai_tool` | Call extension tool handlers directly |

**For agents writing test files**: import from `@nimbalyst/extension-sdk/testing` — `NODE_PATH` is set automatically so imports resolve even for external extension projects.

### Data Attributes for Targeting

The host infrastructure sets stable attributes on extension containers:

| Context | Attributes |
| --- | --- |
| Custom editor | `data-extension-id`, `data-file-path` |
| Panel | `data-extension-id`, `data-panel` |

Use the SDK helpers to scope locators:

```typescript
import { extensionEditor, extensionPanel } from '@nimbalyst/extension-sdk/testing';

const editor = extensionEditor(page, 'com.nimbalyst.csv', '/path/to/data.csv');
const panel = extensionPanel(page, 'com.nimbalyst.git', 'git-log');
```

### Testing AI Tools

```typescript
import { callExtensionTool } from '@nimbalyst/extension-sdk/testing';

const result = await callExtensionTool(page, 'excalidraw.get_elements', {});
expect(result.success).toBe(true);
```

### Playwright Extension Panel

The Playwright extension panel in Nimbalyst supports multiple test configs. It auto-detects extension tests by scanning `packages/extensions/*/tests/*.spec.ts` and creates separate config profiles for each extension. The panel shows all discovered tests in a merged tree, grouped by config when multiple configs are active. A dropdown in the toolbar lets you select which config to run.

### Design Document

See [extension-live-test-infrastructure.md](../design/Extensions/extension-live-test-infrastructure.md) for the full architecture and implementation details.

## Related Documentation

- [FILE_TYPE_HANDLING.md](./FILE_TYPE_HANDLING.md) - How file types are associated with editors
- [EXTENSION_PANELS.md](./EXTENSION_PANELS.md) - Creating custom panels
- [EXTENSION_THEMING.md](./EXTENSION_THEMING.md) - Theming extensions
