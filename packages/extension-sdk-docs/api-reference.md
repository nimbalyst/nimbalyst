# API Reference

This document summarizes the main TypeScript exports from `@nimbalyst/extension-sdk`.

## Main Imports

```ts
import type {
  ExtensionContext,
  ExtensionManifest,
  ExtensionModule,
  EditorHostProps,
  ExtensionAITool,
  AIToolContext,
  ExtensionToolResult,
  PanelHostProps,
  SettingsPanelProps,
} from '@nimbalyst/extension-sdk';

import { REQUIRED_EXTERNALS, validateExtensionBundle } from '@nimbalyst/extension-sdk';
import { createExtensionConfig } from '@nimbalyst/extension-sdk/vite';

// Collaboration: per-extension Y.Doc content contract
import type { CollabContentAdapter } from '@nimbalyst/extension-sdk';
```

## Extension Entry Point

Your extension module can export any subset of these fields:

```ts
interface ExtensionModule {
  activate?: (context: ExtensionContext) => void | Promise<void>;
  deactivate?: () => void | Promise<void>;

  components?: Record<string, React.ComponentType<EditorHostProps>>;
  aiTools?: ExtensionAITool[];
  slashCommandHandlers?: Record<string, () => void>;

  nodes?: Record<string, unknown>;
  transformers?: Record<string, unknown>;
  lexicalExtensions?: Record<string, unknown>;
  hostComponents?: Record<string, React.ComponentType>;

  panels?: Record<string, PanelExport>;
  settingsPanel?: Record<string, React.ComponentType<SettingsPanelProps>>;
}
```

### Editor and Transcript Contribution Points

Extensions can contribute to the built-in markdown editor and transcript
renderer through four surfaces:

| Surface | Typical export style | Use for |
| --- | --- | --- |
| `setExtensionContributions()` | Usually declarative `nodes` / `transformers` / `slashCommands`; imperative fallback available | Slash-picker entries, markdown transformers, dynamic picker options |
| `setExtensionLexicalExtension()` | Usually declarative `lexicalExtensions`; imperative fallback available | Full Lexical extensions |
| `diffHandlerRegistry.register()` | Imperative | Diff behavior for custom node types |
| `setTranscriptMarkdownContributions()` | Usually from `hostComponents` | Transcript markdown plugins and widget rendering |

Preferred path:

- Declare `contributions.nodes`, `contributions.transformers`,
  `contributions.lexicalExtensions`, and `contributions.hostComponents`
  in `manifest.json`
- Export matching values from `module.nodes`, `module.transformers`,
  `module.lexicalExtensions`, and `module.hostComponents`
- Use the imperative runtime APIs only when registration must happen
  conditionally at activation time

```ts
export const nodes = { MermaidNode };
export const transformers = { MERMAID_TRANSFORMER };
export const lexicalExtensions = { MermaidLexicalExtension };
export const hostComponents = { TranscriptMermaidHost };

export async function activate() {
  diffHandlerRegistry.register(new MermaidDiffHandler());
}
```

See [contribution-points.md](./contribution-points.md) for the full
guide and code examples.

## `ExtensionContext`

Passed to `activate()` and available inside `AIToolContext.extensionContext`.

```ts
interface ExtensionContext {
  manifest: ExtensionManifest;
  extensionPath: string;
  services: ExtensionServices;
  subscriptions: Disposable[];
}
```

### `ExtensionServices`

```ts
interface ExtensionServices {
  filesystem: ExtensionFileSystemService;
  ui: ExtensionUIService;
  ai?: ExtensionAIService;
  configuration?: ExtensionConfigurationService;
  collab: ExtensionCollabService;
}
```

```ts
interface ExtensionFileSystemService {
  readFile(path: string): Promise<string>;
  /** Writes UTF-8 text or byte-exact binary content. */
  writeFile(path: string, content: string | Uint8Array): Promise<void>;
  fileExists(path: string): Promise<boolean>;
  findFiles(pattern: string): Promise<string[]>;
}

interface ExtensionUIService {
  showInfo(message: string): void;
  showWarning(message: string): void;
  showError(message: string): void;
}

interface ExtensionConfigurationService {
  get<T>(key: string, defaultValue?: T): T;
  update(key: string, value: unknown, scope?: 'user' | 'workspace'): Promise<void>;
  getAll(): Record<string, unknown>;
}
```

### `ExtensionAIService`

Available when `permissions.ai` is `true`. Provides AI tool registration and direct access to chat/completion models.

```ts
interface ExtensionAIService {
  // Register AI tools that Claude can call
  registerTool(tool: ExtensionAITool): Disposable;
  registerContextProvider(provider: ExtensionContextProvider): Disposable;

  // Session-backed prompt (creates a session in history)
  sendPrompt(options: {
    prompt: string;
    sessionName?: string;
    provider?: 'claude-code' | 'claude' | 'openai';
    model?: string;
  }): Promise<{ sessionId: string; response: string }>;

  // List available chat models (Claude, OpenAI, LM Studio)
  listModels(): Promise<ExtensionAIModel[]>;

  // Stateless chat completion (no session created)
  chatCompletion(options: ChatCompletionOptions): Promise<ChatCompletionResult>;

  // Streaming chat completion (no session created)
  chatCompletionStream(options: ChatCompletionStreamOptions): Promise<ChatCompletionStreamHandle>;
}
```

### Chat Completion Types

```ts
interface ExtensionAIModel {
  id: string;        // e.g. "claude:claude-sonnet-4-6-20250514"
  name: string;      // e.g. "Claude Sonnet 4.6"
  provider: string;  // "claude" | "openai" | "lmstudio"
}

interface ChatCompletionMessage {
  role: 'user' | 'assistant' | 'system';
  content: string;
}

interface ChatCompletionOptions {
  messages: ChatCompletionMessage[];
  model?: string;           // Model ID from listModels(). Provider default if omitted.
  maxTokens?: number;
  temperature?: number;     // 0-1
  systemPrompt?: string;    // Prepended as system message
  responseFormat?: ResponseFormat; // Constrain output format (JSON, JSON schema)
}

type ResponseFormat =
  | { type: 'text' }                                          // Default: plain text
  | { type: 'json_object' }                                   // Valid JSON output
  | { type: 'json_schema';                                    // JSON matching a schema
      schema: JSONSchema;
      name?: string;     // Optional schema name (default: 'response')
      strict?: boolean;  // default: true for OpenAI
    };

interface ChatCompletionResult {
  content: string;          // Assistant response
  model: string;            // Model that was used
  usage?: {
    inputTokens: number;
    outputTokens: number;
  };
}

interface ChatCompletionStreamChunk {
  type: 'text' | 'error' | 'done';
  content?: string;         // Text delta (when type is 'text')
  error?: string;           // Error message (when type is 'error')
}

interface ChatCompletionStreamOptions extends ChatCompletionOptions {
  onChunk: (chunk: ChatCompletionStreamChunk) => void;
}

interface ChatCompletionStreamHandle {
  abort(): void;                        // Cancel the stream
  result: Promise<ChatCompletionResult>; // Resolves on completion
}
```

## Custom Editors

Custom editors receive a single `host` prop. Use the `useEditorLifecycle` hook (from `@nimbalyst/extension-sdk`) to handle all lifecycle concerns.

### useEditorLifecycle Hook

```ts
import { useEditorLifecycle } from '@nimbalyst/extension-sdk';

function useEditorLifecycle<T = string>(
  host: EditorHost,
  options: UseEditorLifecycleOptions<T>
): UseEditorLifecycleResult<T>;
```

```ts
interface UseEditorLifecycleOptions<T> {
  applyContent: (content: T) => void;       // Push content into the editor
  getCurrentContent?: () => T;               // Pull content from the editor (omit for read-only)
  parse?: (raw: string) => T;                // Parse raw file string into editor format
  serialize?: (content: T) => string;        // Serialize editor format to string
  binary?: boolean;                          // Use loadBinaryContent() for binary files
  onLoaded?: () => void;                     // Called after initial load
  onExternalChange?: (content: T) => void;   // Called on external file changes (not echoes)
  onSave?: () => Promise<void>;              // Custom save flow (replaces default)
  onDiffRequested?: (config: DiffConfig) => void;  // Custom diff handling
  onDiffCleared?: () => Promise<void>;       // Custom diff cleanup
}

interface UseEditorLifecycleResult<T> {
  isLoading: boolean;                        // True until initial content loads
  error: Error | null;                       // Load error
  theme: string;                             // Current theme (reactive)
  markDirty: () => void;                     // Call on user edit
  isDirty: boolean;                          // Unsaved changes exist
  diffState: DiffState<T> | null;            // AI edit diff (null when inactive)
  toggleSourceMode: (() => void) | undefined;
  isSourceMode: boolean;
}

interface DiffState<T> {
  original: T;                               // Content before AI edit
  modified: T;                               // Content after AI edit
  tagId: string;                             // History tag ID
  sessionId: string;                         // AI session that made the edit
  accept: () => void;                        // Accept changes
  reject: () => void;                        // Revert to original
}
```

### EditorHost Interface

The `useEditorLifecycle` hook wraps this interface. You rarely need to use it directly.

```ts
interface EditorHostProps {
  host: EditorHost;
}
```

```ts
interface EditorHost {
  readonly filePath: string;
  readonly fileName: string;
  readonly theme: string;
  readonly isActive: boolean;
  readonly workspaceId?: string;
  readonly supportsSourceMode?: boolean;
  readonly storage: ExtensionStorage;

  onThemeChanged(callback: (theme: string) => void): () => void;

  loadContent(): Promise<string>;
  loadBinaryContent(): Promise<ArrayBuffer>;
  onFileChanged(callback: (newContent: string) => void): () => void;

  setDirty(isDirty: boolean): void;
  saveContent(content: string | ArrayBuffer): Promise<void>;
  onSaveRequested(callback: () => void): () => void;

  openHistory(): void;

  onDiffRequested?(callback: (config: DiffConfig) => void): () => void;
  reportDiffResult?(result: DiffResult): void;
  isDiffModeActive?(): boolean;
  onDiffCleared?(callback: () => void): () => void;

  toggleSourceMode?(): void;
  onSourceModeChanged?(callback: (isSourceMode: boolean) => void): () => void;
  isSourceModeActive?(): boolean;

  getConfig?<T>(key: string, defaultValue?: T): T;
  registerMenuItems(items: EditorMenuItem[]): void;
}
```

Supporting editor types:

```ts
interface EditorMenuItem {
  label: string;
  icon?: string;
  onClick: () => void;
}

interface DiffConfig {
  originalContent: string;
  modifiedContent: string;
  tagId: string;
  sessionId: string;
}

interface DiffResult {
  content: string;
  action: 'accept' | 'reject';
}
```

## AI Tools

```ts
interface ExtensionAITool {
  name: string;
  description: string;
  inputSchema?: JSONSchema;
  parameters?: JSONSchema; // legacy alias
  scope?: 'global' | 'editor';
  editorFilePatterns?: string[];
  access?: ExtensionAIToolAccess;
  readOnly?: boolean; // deprecated alias for editor-read compatibility
  handler: (
    params: Record<string, unknown>,
    context: AIToolContext
  ) => Promise<ExtensionToolResult>;
}
```

```ts
type ExtensionAIToolAccess =
  | { kind: 'filesystem' }   // no editor mount, no flush; reads/writes via services (default for compilers/analyzers)
  | { kind: 'editor-read' }  // host provides editorAPI, never flushes editor state
  | { kind: 'editor-write' }; // host provides editorAPI and commits after the tool via its conflict-aware save path
```

```ts
interface AIToolContext {
  workspacePath?: string;
  activeFilePath?: string;
  extensionContext: ExtensionContext;
  editorAPI?: unknown;
}
```

```ts
interface ExtensionToolResult {
  success: boolean;
  message?: string;
  data?: unknown;
  error?: string;
  extensionId?: string;
  toolName?: string;
  stack?: string;
  errorContext?: Record<string, unknown>;
}
```

### JSON Schema Types

```ts
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
  enum?: Array<string | number>;
  items?: JSONSchemaProperty;
  properties?: Record<string, JSONSchemaProperty>;
  required?: string[];
  default?: unknown;
}
```

## Panels

Panels are non-file-based extension UIs.

```ts
interface PanelExport {
  component: React.ComponentType<PanelHostProps>;
  gutterButton?: React.ComponentType<PanelGutterButtonProps>;
  settingsComponent?: React.ComponentType<PanelHostProps>;
}
```

```ts
interface PanelHostProps {
  host: PanelHost;
}

interface PanelHost {
  readonly panelId: string;
  readonly extensionId: string;
  readonly theme: string;
  readonly workspacePath: string;
  readonly isSettingsOpen: boolean;
  readonly ai?: PanelAIContext;
  readonly storage: ExtensionStorage;
  readonly data: ExtensionDataAccess;

  onThemeChanged(callback: (theme: string) => void): () => void;
  openFile(path: string): void;
  openPanel(panelId: string): void;
  close(): void;
  openSettings(): void;
  closeSettings(): void;
  exec(command: string, options?: ExecOptions): Promise<ExecResult>;
}
```

### `ExtensionDataAccess`

Read-only access to Nimbalyst's local PGLite database. Requires
`"nimbalyst-database-read"` in `permissions.catalog` on the manifest.

```ts
interface ExtensionDataAccess {
  // Run a read-only SQL query against the local PGLite database. The query
  // is wrapped in a `READ ONLY` transaction with a 5s statement_timeout, so
  // DML/DDL is rejected by the planner. Use `$1`, `$2`, ... placeholders.
  query<T = unknown>(sql: string, params?: unknown[]): Promise<T[]>;
}
```

Tables and columns are not part of any stable contract -- the surface is
intended for built-in extensions and will be redesigned when Nimbalyst's
storage layer ports to native SQLite. Pin to the host version you tested
against.

```ts
interface PanelAIContext {
  setContext(context: Record<string, unknown>): void;
  getContext(): Record<string, unknown>;
  clearContext(): void;
  notifyChange(event: string, data?: unknown): void;
  onContextChanged(callback: (context: Record<string, unknown>) => void): () => void;
}
```

```ts
interface SettingsPanelProps {
  storage: ExtensionStorage;
  theme: string;
  callBackendTool?: (toolName: string, args?: Record<string, unknown>) => Promise<unknown>;
  workspacePath?: string;
  projectTarget?:
    | { kind: 'workspace'; workspacePath: string }
    | { kind: 'organizationProject'; orgId: string; projectId: string };
}
```

`workspacePath` and `projectTarget` are present only for project-scoped `settingsRoutes` contributions. Application routes and nested `settingsPanel` components omit them.

## Extension Storage

`ExtensionStorage` is available to custom editors, panels, and settings panels.

```ts
interface ExtensionStorage {
  get<T>(key: string): T | undefined;
  set<T>(key: string, value: T): Promise<void>;
  delete(key: string): Promise<void>;

  getGlobal<T>(key: string): T | undefined;
  setGlobal<T>(key: string, value: T): Promise<void>;
  deleteGlobal(key: string): Promise<void>;

  getSecret(key: string): Promise<string | undefined>;
  setSecret(key: string, value: string): Promise<void>;
  deleteSecret(key: string): Promise<void>;
}
```

## Manifest Types

The manifest shape is defined by `ExtensionManifest` and `ExtensionContributions`.
See [Manifest Reference](./manifest-reference.md) for field-by-field guidance.

```ts
interface ExtensionManifest {
  id: string;
  name: string;
  version: string;
  description?: string;
  author?: string;
  main: string;
  styles?: string;
  apiVersion?: string;
  permissions?: ExtensionPermissions;
  contributions?: ExtensionContributions;
  requiredReleaseChannel?: 'stable' | 'alpha';
  defaultEnabled?: boolean;
}
```

```ts
interface ExtensionContributions {
  customEditors?: CustomEditorContribution[];
  fileIcons?: Record<string, string>;
  aiTools?: string[];
  newFileMenu?: NewFileMenuContribution[];
  commands?: CommandContribution[];
  slashCommands?: SlashCommandContribution[];
  nodes?: string[];
  transformers?: string[];
  lexicalExtensions?: string[];
  hostComponents?: string[];
  configuration?: ExtensionConfigurationContribution;
  claudePlugin?: ClaudePluginContribution;
  panels?: PanelContribution[];
  settingsPanel?: SettingsPanelContribution;
  settingsRoutes?: SettingsRouteContribution[];
  documentHeaders?: DocumentHeaderContribution[];
  themes?: ThemeContribution[];
  backendModules?: BackendModuleContribution[];
}
```

## Permissions and Backend Modules

> The catalog and shape are evolving -- pin to specific SDK versions while
> this stabilizes. See [permissions.md](./permissions.md) for the full
> manifest format, consent flow, and runtime choice guidance.

```ts
import type {
  BackendModuleContribution,
  BackendModuleRuntime,
  BackendModuleEnablement,
  ExtensionPermissionId,
  PermissionRiskTier,
} from '@nimbalyst/extension-sdk';

type BackendModuleRuntime = 'utility-process' | 'worker-thread';
type PermissionRiskTier = 'low' | 'elevated' | 'high';

type ExtensionPermissionId =
  | 'workspace-files'
  | 'nimbalyst-database-read'
  | 'nimbalyst-database-write'
  | 'secrets-read'
  | 'mcp-server-register';

interface BackendModuleEnablement {
  default: 'disabled';
  promptOn: 'firstUse';
  purpose: string;
}

interface BackendModuleContribution {
  id: string;
  entry: string;
  runtime: BackendModuleRuntime;
  permissions: ExtensionPermissionId[];
  enablement: BackendModuleEnablement;
}
```

Manifest cap (also exported as a constant):

```ts
import { MAX_BACKEND_MODULES_PER_EXTENSION } from '@nimbalyst/extension-sdk';
// 8
```

### Manifest Validation Helpers

```ts
import {
  validateBackendModules,
  assertBackendModulesValid,
  type BackendModuleValidationIssue,
} from '@nimbalyst/extension-sdk';

// Pure check -- returns the list of issues (empty = valid)
const issues = validateBackendModules(manifest.contributions?.backendModules);

// Convenience wrapper -- throws if any issues are found
assertBackendModulesValid(manifest.id, manifest.contributions?.backendModules);
```

`validateExtensionBundle()` already runs `validateBackendModules()` against
the manifest it reads from disk; call the helpers directly only if you are
validating a manifest you constructed in memory.

## Collaboration: `CollabContentAdapter`

The per-extension Y.Doc content contract. See [custom-editors.md](./custom-editors.md#making-your-editor-collaborative) for the full guide.

```ts
import type { Doc } from 'yjs';

interface CollabContentAdapter<TStructured = unknown> {
  documentType: string;
  fileExtensions: string[];
  mimeType?: string;
  layoutVersion: number;
  migrations?: CollabContentAdapterMigration[];

  isEmpty(yDoc: Doc): boolean;
  seedFromFile(yDoc: Doc, source: string | Uint8Array): void;
  applyFromFile(yDoc: Doc, source: string | Uint8Array): void;
  exportToFile(yDoc: Doc): string | Uint8Array;
  toPlainText(yDoc: Doc): string;

  // Optional: AI-write surface
  toStructured?(yDoc: Doc): TStructured;
  applyStructuredPatch?(yDoc: Doc, patch: unknown): void;

  // Optional: revision-history overrides (defaults use Y.encodeStateAsUpdateV2)
  exportRevisionSnapshot?(yDoc: Doc): Uint8Array;
  restoreRevisionSnapshot?(yDoc: Doc, bytes: Uint8Array): void;
}

interface CollabContentAdapterMigration {
  from: number;
  to: number;
  run(yDoc: Doc): void;
}
```

### Registration

Adapters are registered via the extension context, not via a global function. The host owns the registry; extensions only need the type.

```ts
interface ExtensionCollabService {
  registerContentAdapter(adapter: CollabContentAdapter): { dispose(): void };
}

// Usage from activate():
export async function activate(context: ExtensionContext) {
  context.services.collab.registerContentAdapter(MyAdapter);
}
```

The returned disposable is also tracked in `context.subscriptions`, so it unregisters automatically on `deactivate()`.

## Vite Helper

Use `createExtensionConfig()` to get the correct externalization and output shape for extensions.

```ts
import react from '@vitejs/plugin-react';
import { createExtensionConfig } from '@nimbalyst/extension-sdk/vite';

export default createExtensionConfig({
  entry: './src/index.tsx',
  plugins: [react()],
});
```

## Validation Helpers

```ts
import { validateExtensionBundle } from '@nimbalyst/extension-sdk';

const result = await validateExtensionBundle('/path/to/extension');
```

```ts
interface ValidationResult {
  valid: boolean;
  errors: string[];
  warnings: string[];
  manifest?: ExtensionManifest;
}
```

## Required Externals

`REQUIRED_EXTERNALS` exports the package names that must stay external in your build because Nimbalyst provides them at runtime.
