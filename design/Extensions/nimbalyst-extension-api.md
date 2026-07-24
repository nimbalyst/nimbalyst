# Nimbalyst Extension API Reference

This document provides the TypeScript API definitions for the Nimbalyst Extension System. These types are the actual implementation from `packages/runtime/src/extensions/types.ts`.

## Implementation Status

| Feature | Status | Notes |
| --- | --- | --- |
| Extension Manifest | Implemented | Full validation on load |
| Custom Editors | Implemented | Via `contributions.customEditors` |
| AI Tools | Implemented | Integrated with Claude Code MCP |
| New File Menu | Implemented | Via `contributions.newFileMenu` |
| File Icons | Implemented | Via `contributions.fileIcons` |
| AI Diff Mode | Implemented | Via `diffState` prop and `CustomEditorCapabilities` |
| Host Callbacks | Implemented | Via `onRegisterCallbacks` for structured communication |
| Permissions | Partial | Declared but not fully enforced |
| Commands | Not implemented | Planned |
| Menu contributions | Not implemented | Planned |
| Settings | Not implemented | Planned |
| Database | Not implemented | Planned |

## Extension Manifest (manifest.json)

The manifest is a JSON file that declares extension capabilities.

```typescript
interface ExtensionManifest {
  /** Unique extension identifier (reverse domain notation) */
  id: string;  // e.g., "com.nimbalyst.datamodellm"

  /** Human-readable name */
  name: string;

  /** Semantic version */
  version: string;  // e.g., "1.0.0"

  /** Brief description */
  description?: string;

  /** Author name or organization */
  author?: string;

  /** Path to main JS entry point (relative to extension root) */
  main: string;  // e.g., "dist/index.js"

  /** Path to CSS styles (relative to extension root) */
  styles?: string;  // e.g., "dist/index.css"

  /** Minimum Nimbalyst API version required */
  apiVersion?: string;

  /** Permissions the extension needs */
  permissions?: ExtensionPermissions;

  /** What the extension contributes to Nimbalyst */
  contributions?: ExtensionContributions;
}

interface ExtensionPermissions {
  /** Access to read/write files in workspace */
  filesystem?: boolean;

  /** Access to AI services and tool registration */
  ai?: boolean;

  /** Access to network (for future use) */
  network?: boolean;
}

interface ExtensionContributions {
  /** Custom editor registrations */
  customEditors?: CustomEditorContribution[];

  /** AI tools the extension provides (names only, actual tools in module) */
  aiTools?: string[];

  /** File icons by pattern */
  fileIcons?: Record<string, string>;

  /** New file menu contributions */
  newFileMenu?: NewFileMenuContribution[];

  /** Commands (future) */
  commands?: CommandContribution[];
}
```

## Custom Editor Contribution

Extensions can register custom editors for specific file types:

```typescript
interface CustomEditorContribution {
  /** File patterns this editor handles (glob patterns) */
  filePatterns: string[];  // e.g., ["*.prisma", "*.datamodel"]

  /** Display name shown in UI */
  displayName: string;

  /** Component name to look up in module's `components` export */
  component: string;  // e.g., "DatamodelLMEditor"
}
```

## New File Menu Contribution

Extensions can add items to the "New File" menu:

```typescript
interface NewFileMenuContribution {
  /** File extension (e.g., ".prisma") */
  extension: string;

  /** Display name in menu */
  displayName: string;

  /** Material icon name */
  icon: string;

  /** Default content for new files */
  defaultContent: string;
}
```

## Extension Module

The extension's main JS file must export specific symbols:

```typescript
interface ExtensionModule {
  /** Called when extension is activated */
  activate?: (context: ExtensionContext) => Promise<void> | void;

  /** Called when extension is deactivated */
  deactivate?: () => Promise<void> | void;

  /** React components exported by the extension */
  components?: Record<string, ComponentType<CustomEditorComponentProps>>;

  /** AI tools exported by the extension */
  aiTools?: ExtensionAITool[];
}
```

### Example Extension Module

```typescript
// src/index.tsx
import { MyEditor } from './components/MyEditor';
import { myTools } from './aiTools';

export async function activate(context: ExtensionContext) {
  console.log('Extension activated');
}

export async function deactivate() {
  console.log('Extension deactivated');
}

export const components = {
  MyEditor,
};

export const aiTools = myTools;
```

## Custom Editor Component Props

Props passed to custom editor components:

```typescript
interface CustomEditorComponentProps {
  /** Absolute path to the file being edited */
  filePath: string;

  /** File name without path */
  fileName: string;

  /** Initial file content as string */
  initialContent: string;

  /** Current theme */
  theme: 'light' | 'dark' | 'crystal-dark';

  /** Whether this editor is the active/focused one */
  isActive: boolean;

  /** Workspace identifier (if in a workspace) */
  workspaceId?: string;

  /** Called when content changes (for dirty tracking) */
  onContentChange?: () => void;

  /** Called when dirty state changes */
  onDirtyChange?: (isDirty: boolean) => void;

  /** Register a function to get current content (for saving) */
  onGetContentReady?: (getContentFn: () => string) => void;

  /** Open document history dialog */
  onViewHistory?: () => void;

  /** Trigger document rename */
  onRenameDocument?: () => void;

  // ============================================================================
  // Advanced API (for editors that support AI diff mode)
  // ============================================================================

  /**
   * Register host callbacks when editor mounts.
   * Editors should call this once on mount with their implementation.
   */
  onRegisterCallbacks?: (callbacks: CustomEditorHostCallbacks) => void;

  /**
   * Called when editor unmounts - clean up host registration.
   */
  onUnregisterCallbacks?: () => void;

  /**
   * Diff mode state for editors that support diff visualization.
   * Only provided if the editor declared supportsDiffMode capability.
   * When active, the editor should show a visual diff between baseline and target.
   */
  diffState?: CustomEditorDiffState;

  /**
   * Called when user accepts the diff (keeps the AI's changes).
   * Only relevant when diffState.isActive is true.
   */
  onAcceptDiff?: () => void;

  /**
   * Called when user rejects the diff (reverts to baseline).
   * Only relevant when diffState.isActive is true.
   */
  onRejectDiff?: () => void;

  /**
   * Callback to reload content from disk.
   * Called when file changes externally and editor should refresh.
   */
  onReloadContent?: (callback: (newContent: string) => void) => void;
}
```

## AI Diff Mode Support

Custom editors can opt-in to showing visual diffs when AI agents edit their files. This requires implementing a few additional interfaces.

### Diff State

When an AI agent edits a file, the host provides diff state to editors that support it:

```typescript
interface CustomEditorDiffState {
  /** Whether diff mode is currently active */
  isActive: boolean;

  /** Pre-edit content (the baseline before AI changes) */
  baseline: string;

  /** AI's proposed content (what's now on disk) */
  target: string;

  /** History tag ID for tracking this diff */
  tagId: string;

  /** AI session ID that made the edit */
  sessionId: string;
}
```

### Editor Capabilities

Editors declare their capabilities so the host knows what features to enable:

```typescript
interface CustomEditorCapabilities {
  /** Can serialize content to/from string (default: true) */
  supportsTextContent?: boolean;

  /** Can handle binary data */
  supportsBinaryContent?: boolean;

  /** Can show before/after diff visualization */
  supportsDiffMode?: boolean;

  /** Can handle incremental content streaming */
  supportsStreaming?: boolean;

  /** Has internal undo/redo stack */
  supportsUndo?: boolean;

  /** Supports find/replace operations */
  supportsSearch?: boolean;
}
```

### Host Callbacks

Editors register callbacks that the host uses to interact with them:

```typescript
interface CustomEditorHostCallbacks {
  /** Report that the editor is fully loaded and ready */
  reportReady: () => void;

  /** Report an error during loading or operation */
  reportError: (error: Error) => void;

  /** Get current content for saving (replaces onGetContentReady pattern) */
  getContent: () => string | null;

  /** Get binary content for saving (for binary editors) */
  getBinaryContent?: () => ArrayBuffer | null;

  /** Report editor capabilities (call once on mount) */
  reportCapabilities?: (capabilities: CustomEditorCapabilities) => void;
}
```

### Example: Diff Mode Implementation

Here's how a custom editor can implement diff mode support:

```typescript
function MyCustomEditor({
  filePath,
  initialContent,
  diffState,
  onAcceptDiff,
  onRejectDiff,
  onRegisterCallbacks,
  onUnregisterCallbacks,
  onGetContentReady,
}: CustomEditorComponentProps) {
  const [content, setContent] = useState(initialContent);

  // Register with host on mount
  useEffect(() => {
    // Register capabilities and callbacks
    onRegisterCallbacks?.({
      reportReady: () => console.log('Editor ready'),
      reportError: (error) => console.error('Editor error:', error),
      getContent: () => content,
      reportCapabilities: (caps) => {
        // Tell host we support diff mode
        caps({ supportsDiffMode: true, supportsTextContent: true });
      },
    });

    // Also register content getter for legacy API
    onGetContentReady?.(() => content);

    return () => {
      onUnregisterCallbacks?.();
    };
  }, [content, onRegisterCallbacks, onUnregisterCallbacks, onGetContentReady]);

  // Render diff view when in diff mode
  if (diffState?.isActive) {
    return (
      <div className="diff-view">
        <div className="diff-header">
          <span>AI made changes to this file</span>
          <button onClick={onAcceptDiff}>Accept</button>
          <button onClick={onRejectDiff}>Reject</button>
        </div>
        <DiffViewer
          oldContent={diffState.baseline}
          newContent={diffState.target}
        />
      </div>
    );
  }

  // Normal editing view
  return (
    <MyEditorComponent
      content={content}
      onChange={setContent}
    />
  );
}
```

## Extension Context

Context provided to extensions when they activate:

```typescript
interface ExtensionContext {
  /** The extension's manifest */
  manifest: ExtensionManifest;

  /** Absolute path to the extension's root directory */
  extensionPath: string;

  /** Services provided by the host */
  services: ExtensionServices;

  /** Disposables to clean up on deactivation */
  subscriptions: Disposable[];
}

interface ExtensionServices {
  /** File system operations */
  filesystem: ExtensionFileSystemService;

  /** UI operations */
  ui: ExtensionUIService;

  /** AI operations (if permitted) */
  ai?: ExtensionAIService;
}

interface ExtensionFileSystemService {
  readFile(path: string): Promise<string>;
  writeFile(path: string, content: string): Promise<void>;
  fileExists(path: string): Promise<boolean>;
  findFiles(pattern: string): Promise<string[]>;
}

interface ExtensionUIService {
  showInfo(message: string): void;
  showWarning(message: string): void;
  showError(message: string): void;
}

interface ExtensionAIService {
  registerTool(tool: ExtensionAITool): Disposable;
  registerContextProvider(provider: ExtensionContextProvider): Disposable;
}
```

## AI Tools

Extensions can expose AI tools that are available to Claude Code via MCP:

```typescript
interface ExtensionAITool {
  /** Tool name (should be namespaced, e.g., "datamodellm.create_entity") */
  name: string;

  /** Human-readable description shown to AI */
  description: string;

  /** JSON Schema for tool parameters */
  parameters: JSONSchema;

  /**
   * Tool scope - determines when the tool is available:
   * - 'global': Always available in MCP
   * - 'editor': Only available when a matching editor is active
   * Defaults to 'editor' for backwards compatibility
   */
  scope?: 'global' | 'editor';

  /**
   * File patterns this tool applies to (for editor-scoped tools).
   * Uses glob patterns like ["*.prisma"].
   * If not specified for editor-scoped tools, inherits from the extension's
   * customEditors contribution.
   */
  editorFilePatterns?: string[];

  /** Tool execution handler */
  handler: (
    params: Record<string, unknown>,
    context: AIToolContext
  ) => Promise<ExtensionToolResult>;
}

interface AIToolContext {
  /** Absolute path to current workspace */
  workspacePath?: string;

  /** Absolute path to currently active file */
  activeFilePath?: string;

  /** Extension context for accessing services */
  extensionContext: ExtensionContext;
}

interface ExtensionToolResult {
  /** Whether the tool executed successfully */
  success: boolean;

  /** Human-readable result message for AI */
  message?: string;

  /** Structured data result */
  data?: unknown;

  /** Error message if success is false */
  error?: string;
}

interface JSONSchema {
  type: 'object' | 'array' | 'string' | 'number' | 'boolean' | 'null';
  properties?: Record<string, JSONSchemaProperty>;
  required?: string[];
  items?: JSONSchema;
  description?: string;
}

interface JSONSchemaProperty {
  type: 'string' | 'number' | 'boolean' | 'array' | 'object' | 'null';
  description?: string;
  enum?: (string | number)[];
  items?: JSONSchemaProperty;
  properties?: Record<string, JSONSchemaProperty>;
  required?: string[];
  default?: unknown;
}
```

### Example AI Tool

```typescript
// aiTools.ts
export const aiTools = [
  {
    name: 'get_schema',
    description: `Get the current data model schema. Use this to understand
the existing entities and relationships before making changes.`,
    parameters: {
      type: 'object' as const,
      properties: {},
    },
    handler: async (
      _params: Record<string, never>,
      context: { activeFilePath?: string }
    ) => {
      const store = getStore(context.activeFilePath);
      if (!store) {
        return {
          success: false,
          error: 'No active data model editor found.',
        };
      }

      const state = store.getState();
      return {
        success: true,
        message: `Found ${state.entities.length} entities.`,
        data: {
          entities: state.entities.map(e => ({
            name: e.name,
            fields: e.fields,
          })),
        },
      };
    },
  },
];
```

## AI Tools Bridge

The `ExtensionAIToolsBridge` connects extension tools to Claude Code:

```typescript
// packages/runtime/src/extensions/ExtensionAIToolsBridge.ts

// Get all tools in MCP format (serializable)
function getMCPToolDefinitions(): MCPToolDefinition[];

// Execute a tool by name (called from MCP server)
async function executeExtensionTool(
  toolName: string,
  args: Record<string, unknown>,
  context: { workspacePath?: string; activeFilePath?: string }
): Promise<ExtensionToolResult>;

// Register tools from a loaded extension
function registerExtensionTools(extension: LoadedExtension): void;

// Unregister tools from an extension
function unregisterExtensionTools(extensionId: string): void;
```

Tools are automatically namespaced with the extension ID to avoid conflicts (e.g., `datamodellm.get_schema`).

## Platform Service

The `ExtensionPlatformService` abstracts platform-specific operations:

```typescript
interface ExtensionPlatformService {
  /** Get the directory where user extensions are installed */
  getExtensionsDirectory(): Promise<string>;

  /** List all subdirectories in a directory */
  listDirectories(dirPath: string): Promise<string[]>;

  /** Read a file as text */
  readFile(filePath: string): Promise<string>;

  /** Write content to a file */
  writeFile(filePath: string, content: string): Promise<void>;

  /** Check if a file exists */
  fileExists(filePath: string): Promise<boolean>;

  /** Load a JavaScript module from the given path */
  loadModule(modulePath: string): Promise<ExtensionModule>;

  /** Inject CSS styles into the document */
  injectStyles(css: string): () => void;

  /** Resolve a relative path from an extension's root */
  resolvePath(extensionPath: string, relativePath: string): string;

  /** Get files matching a glob pattern in a directory */
  findFiles(dirPath: string, pattern: string): Promise<string[]>;
}
```

The Electron implementation handles import transformation to use host dependencies:

```typescript
// ElectronExtensionPlatformService transforms imports like:
// import React from 'react'
// to:
// const React = window.__nimbalyst_extensions['react']
```

## Extension Loader

The `ExtensionLoader` manages extension lifecycle:

```typescript
class ExtensionLoader {
  /** Discover all extensions in the extensions directory */
  async discoverExtensions(): Promise<DiscoveredExtension[]>;

  /** Load an extension from a discovered extension */
  async loadExtension(discovered: DiscoveredExtension): Promise<ExtensionLoadResult>;

  /** Unload an extension by ID */
  async unloadExtension(extensionId: string): Promise<void>;

  /** Enable a loaded extension */
  enableExtension(extensionId: string): void;

  /** Disable a loaded extension without unloading it */
  disableExtension(extensionId: string): void;

  /** Get all loaded extensions */
  getLoadedExtensions(): LoadedExtension[];

  /** Get a loaded extension by ID */
  getExtension(extensionId: string): LoadedExtension | undefined;

  /** Get all custom editor contributions from loaded extensions */
  getCustomEditors(): Array<{
    extensionId: string;
    contribution: CustomEditorContribution;
    component: React.ComponentType<unknown>;
  }>;

  /** Get all AI tools from loaded extensions */
  getAITools(): Array<{
    extensionId: string;
    tool: ExtensionAITool;
  }>;

  /** Get all new file menu contributions */
  getNewFileMenuContributions(): Array<{
    extensionId: string;
    contribution: NewFileMenuContribution;
  }>;

  /** Find a custom editor for a given file extension */
  findEditorForExtension(fileExtension: string): {
    extensionId: string;
    contribution: CustomEditorContribution;
    component: React.ComponentType<unknown>;
  } | undefined;

  /** Subscribe to extension changes */
  subscribe(listener: () => void): () => void;

  /** Unload all extensions */
  async unloadAll(): Promise<void>;
}

interface LoadedExtension {
  manifest: ExtensionManifest;
  module: ExtensionModule;
  context: ExtensionContext;
  disposeStyles?: () => void;
  enabled: boolean;
  dispose(): Promise<void>;
}

interface DiscoveredExtension {
  path: string;
  manifest: ExtensionManifest;
}

type ExtensionLoadResult =
  | { success: true; extension: LoadedExtension }
  | { success: false; error: string; manifestPath?: string };
```

### Global Instance

```typescript
// Get the global ExtensionLoader instance
function getExtensionLoader(): ExtensionLoader;

// Initialize extensions by discovering and loading all
async function initializeExtensions(): Promise<void>;
```

## Application Initialization

```typescript
// In the Electron renderer, during app initialization:

// 1. Set up the platform service
import { setExtensionPlatformService } from '@nimbalyst/runtime/extensions';
import { ExtensionPlatformServiceImpl } from './extensions/ExtensionPlatformServiceImpl';

setExtensionPlatformService(new ExtensionPlatformServiceImpl());

// 2. Initialize extensions (discovers and loads all)
import { initializeExtensions, getExtensionLoader } from '@nimbalyst/runtime/extensions';

await initializeExtensions();

// 3. Initialize the AI tools bridge
import { initializeExtensionAIToolsBridge } from '@nimbalyst/runtime/extensions';

initializeExtensionAIToolsBridge();

// 4. Get custom editors for a file
const loader = getExtensionLoader();
const editor = loader.findEditorForExtension('.prisma');
if (editor) {
  // Render the extension's custom editor component
  <editor.component
    filePath={filePath}
    fileName={fileName}
    initialContent={content}
    theme={theme}
    isActive={true}
    onDirtyChange={setIsDirty}
    onGetContentReady={(fn) => getContentRef.current = fn}
  />
}

// 5. Get new file menu items from extensions
const newFileItems = loader.getNewFileMenuContributions();
// Add to "New File" dropdown menu
```

## Example: DatamodelLM Extension

DatamodelLM is the first extension built on this system. Here's its actual implementation:

### manifest.json

```json
{
  "id": "com.nimbalyst.datamodellm",
  "name": "DatamodelLM",
  "version": "1.0.0",
  "description": "AI-assisted data modeling with visual entity-relationship diagrams",
  "author": "Nimbalyst",
  "main": "dist/index.js",
  "styles": "dist/index.css",
  "apiVersion": "1.0.0",
  "permissions": {
    "filesystem": true,
    "ai": true
  },
  "contributions": {
    "customEditors": [
      {
        "filePatterns": ["*.prisma"],
        "displayName": "Data Model Editor",
        "component": "DatamodelLMEditor"
      }
    ],
    "aiTools": [
      "datamodellm.get_schema",
      "datamodellm.capture_screenshot"
    ],
    "fileIcons": {
      "*.prisma": "database"
    },
    "newFileMenu": [
      {
        "extension": ".prisma",
        "displayName": "Data Model",
        "icon": "database",
        "defaultContent": "// @nimbalyst {...}\n\ndatasource db {\n  provider = \"postgresql\"\n  url      = env(\"DATABASE_URL\")\n}\n"
      }
    ]
  }
}
```

### index.tsx (Entry Point)

```typescript
import './styles.css';
import { DatamodelLMEditor } from './components/DatamodelLMEditor';
import { aiTools as datamodelAITools } from './aiTools';

export async function activate(context: unknown) {
  console.log('[DatamodelLM] Extension activated');
}

export async function deactivate() {
  console.log('[DatamodelLM] Extension deactivated');
}

export const components = {
  DatamodelLMEditor,
};

export const aiTools = datamodelAITools;
```

### aiTools.ts (AI Tools)

```typescript
const activeStores = new Map<string, DataModelStoreApi>();

export function registerEditorStore(filePath: string, store: DataModelStoreApi): void {
  activeStores.set(filePath, store);
}

export function unregisterEditorStore(filePath: string): void {
  activeStores.delete(filePath);
}

function getStore(filePath?: string): DataModelStoreApi | null {
  if (filePath && activeStores.has(filePath)) {
    return activeStores.get(filePath)!;
  }
  if (activeStores.size === 1) {
    return activeStores.values().next().value;
  }
  return null;
}

export const aiTools = [
  {
    name: 'get_schema',
    description: `Get the current data model schema. Use this to understand the existing entities and relationships before making changes.

Example usage:
- "What tables exist?"
- "Show me the current schema"
- "What fields does User have?"`,
    parameters: {
      type: 'object' as const,
      properties: {},
    },
    handler: async (
      _params: Record<string, never>,
      context: { activeFilePath?: string }
    ) => {
      const store = getStore(context.activeFilePath);
      if (!store) {
        return {
          success: false,
          error: 'No active data model editor found. Please open a .prisma file first.',
        };
      }

      const state = store.getState();
      const { entities, relationships, database } = state;

      return {
        success: true,
        message: `Found ${entities.length} entities and ${relationships.length} relationships.`,
        data: {
          database,
          entities: entities.map(e => ({
            name: e.name,
            fields: e.fields.map(f => ({
              name: f.name,
              type: f.dataType,
              isPrimaryKey: f.isPrimaryKey,
              isForeignKey: f.isForeignKey,
            })),
          })),
          relationships: relationships.map(r => ({
            from: `${r.sourceEntityName}.${r.sourceFieldName || 'id'}`,
            to: `${r.targetEntityName}.${r.targetFieldName || 'id'}`,
            type: r.type,
          })),
        },
      };
    },
  },

  {
    name: 'capture_screenshot',
    description: `Capture a screenshot of the current data model diagram.`,
    parameters: {
      type: 'object' as const,
      properties: {},
    },
    handler: async (
      _params: Record<string, never>,
      context: { activeFilePath?: string }
    ) => {
      const store = getStore(context.activeFilePath);
      if (!store) {
        return {
          success: false,
          error: 'No active data model editor found.',
        };
      }

      return {
        success: true,
        message: 'Screenshot capture requested.',
        captureScreenshot: true,
        data: {
          filePath: context.activeFilePath,
          entityCount: store.getState().entities.length,
        },
      };
    },
  },
];
```

### vite.config.ts (Build Configuration)

```typescript
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  build: {
    lib: {
      entry: 'src/index.tsx',
      formats: ['es'],
      fileName: 'index',
    },
    outDir: 'dist',
    rollupOptions: {
      external: [
        'react',
        'react-dom',
        'react/jsx-runtime',
        'react/jsx-dev-runtime',
        'zustand',
        '@xyflow/react',
      ],
    },
    cssCodeSplit: false,
  },
});
```

## Helper Types

```typescript
interface Disposable {
  dispose(): void;
}

interface CommandContribution {
  /** Unique command ID */
  id: string;

  /** Display name */
  title: string;

  /** Optional keyboard shortcut */
  keybinding?: string;
}

interface ExtensionContextProvider {
  /** Provider identifier */
  id: string;

  /** Priority (higher = earlier in context) */
  priority?: number;

  /** Generate context string */
  provideContext(): Promise<string>;
}
```

## Security Considerations

Extensions currently run with full renderer process privileges. See the [extension-system-security-review.md](./extension-system-security-review.md) for details on:

- Current trust model (full trust)
- IPC access concerns
- Permission enforcement status
- Recommended security roadmap

## Future API Additions (Planned)

The following APIs are designed but not yet implemented:

- **Menu contributions**: Register items in application menus
- **Command palette**: Add commands to the command palette
- **Database access**: SQL queries for extension data storage
- **Settings panels**: Extension-specific settings UI
- **Context providers**: Layer extension context into AI prompts
- **Editor extensions**: Lexical nodes and markdown transformers

## References

- Implementation: `packages/runtime/src/extensions/`
- DatamodelLM Extension: `packages/extensions/datamodellm/`
- Platform Service: `packages/electron/src/renderer/extensions/`
- Security Review: `design/Extensions/extension-system-security-review.md`
