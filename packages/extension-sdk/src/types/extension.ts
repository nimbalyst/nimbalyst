/**
 * Core types for Nimbalyst extensions.
 */

import type { ComponentType } from 'react';
import type { EditorHostProps } from './editor';
import type {
  ExtensionStorage,
  PanelContribution,
  PanelExport,
  PanelGutterButtonProps,
  PanelHostProps,
  SettingsPanelContribution,
  SettingsPanelProps,
} from './panel';
import type { BackendModuleContribution, ExtensionPermissionId } from './permissions';
import type { MonacoThemeContribution, ThemeColors } from './theme';
import type { ExtensionCollabService } from './collab';
import type { TrackerImporterContribution } from './trackerImporter';

/**
 * Manifest validation rejects extensions declaring more than this many
 * backend modules, to keep the consent prompt manageable.
 */
export const MAX_BACKEND_MODULES_PER_EXTENSION = 8;

/**
 * Manifest validation rejects extensions declaring more than this many
 * AI agent providers, to keep the provider dropdown manageable and to
 * bound the registration cost on the host side.
 */
export const MAX_AGENT_PROVIDERS_PER_EXTENSION = 4;

/**
 * How a provider discovers the model list shown in the UI model picker.
 *
 * - `static`  -- the list is fixed at manifest time and lives in the
 *                contribution's `models` array. Use when the provider
 *                supports a small, stable set of models.
 * - `dynamic` -- the provider exposes a `listModels()` method on its
 *                protocol implementation. The host calls it lazily and
 *                caches the result for the session. Use when the set of
 *                models depends on user credentials or remote discovery.
 */
export type AiAgentProviderModelDiscovery = 'static' | 'dynamic';

/**
 * A single static model entry advertised by an agent provider. Used
 * only when `modelDiscovery` is `'static'`; dynamic providers populate
 * model metadata at runtime via `listModels()` on the protocol.
 */
export interface AiAgentProviderModel {
  /**
   * Stable model id passed back to the provider on each turn. Opaque
   * to the host; recorded in session history.
   */
  id: string;

  /** Human-readable label shown in the model picker. */
  name: string;

  /**
   * Whether this entry is the provider's default model selection.
   * Exactly zero or one entry per contribution should set this.
   */
  default?: boolean;
}

/**
 * Manifest contribution for an AI agent provider.
 *
 * An `AiAgentProviderContribution` makes an extension's coding-agent
 * implementation available as a selectable provider in Nimbalyst's
 * agentic coding session UI. The contribution is metadata only -- it
 * describes the provider's identity, capabilities, and supported
 * models -- while the protocol implementation lives in a backend
 * module referenced by `backendModuleId`.
 *
 * The host wires manifest entries to runtime providers at session
 * creation:
 *
 *   1. The user picks a provider from the agent-provider dropdown.
 *   2. The host looks up the matching `AiAgentProviderContribution`.
 *   3. The host loads `backendModuleId` (subject to the user having
 *      granted the backing `BackendModuleContribution`) and asks it
 *      for an `AgentProtocol` implementation.
 *   4. The host creates an `AgentProtocolHost` and hands it to the
 *      protocol implementation for the lifetime of the session.
 *
 * See `agents/AgentProtocolHost.ts` and the Phase 4 SDK design doc
 * for the runtime contract.
 */
export interface AiAgentProviderContribution {
  /**
   * Stable provider id unique within the extension (e.g.
   * `antigravity-gemini`). The host namespaces this with the
   * extension id when persisting session-provider links, so a value
   * unique within the extension is sufficient.
   */
  id: string;

  /** Human-readable name shown in the provider dropdown. */
  displayName: string;

  /**
   * Platform string surfaced in the provider details pane (e.g.
   * `Gemini`, `Claude`, `OpenAI`). Treated as display text only.
   */
  platform: string;

  /**
   * Id of the `BackendModuleContribution` (same extension) that
   * implements the `AgentProtocol` for this provider. The protocol
   * implementation is loaded from this module; the contribution is
   * hidden from the dropdown until the user has granted the module.
   */
  backendModuleId: string;

  /**
   * Whether the provider can resume an existing session by id.
   * Defaults to `false`. When `true`, the host may call
   * `protocol.resume(sessionId)` instead of `protocol.start(...)`.
   */
  supportsResume?: boolean;

  /**
   * Whether the provider can fork (clone) a session at a given
   * canonical event index into a new branch. Defaults to `false`.
   */
  supportsForking?: boolean;

  /**
   * Whether the provider accepts user-attached files (images,
   * documents) on a turn. Defaults to `false`.
   */
  supportsAttachments?: boolean;

  /** How model discovery is performed. */
  modelDiscovery: AiAgentProviderModelDiscovery;

  /**
   * Static model list. Used when `modelDiscovery` is `'static'`;
   * ignored when `modelDiscovery` is `'dynamic'` (the host calls
   * `listModels()` on the protocol instead). Validators may still
   * require a non-empty array when `modelDiscovery === 'static'`.
   */
  models: AiAgentProviderModel[];

  /**
   * Optional map of label to extension-relative path. Each entry
   * surfaces a bundled documentation file in the provider details
   * pane (e.g. built-in tool docs). The host treats values as opaque
   * paths and does not parse the files.
   */
  toolFileLinks?: Record<string, string>;

  /**
   * Material icon name shown next to `displayName` in the provider
   * dropdown. Optional; the host falls back to a generic agent icon.
   */
  icon?: string;

  /**
   * Component name (key in `ExtensionModule.settingsPanel`) for an
   * optional provider-specific settings panel. When present, the
   * host renders this panel under the provider entry in Settings.
   */
  settingsPanelComponent?: string;
}

/**
 * Extension manifest schema (manifest.json)
 */
export interface ExtensionManifest {
  /** Unique identifier (e.g., 'com.example.my-extension') */
  id: string;

  /** Display name */
  name: string;

  /** Semantic version */
  version: string;

  /** Brief description */
  description?: string;

  /** Author name or organization */
  author?: string;

  /** Path to main JS bundle (relative to manifest) */
  main: string;

  /** Path to CSS file (relative to manifest) */
  styles?: string;

  /** Minimum Nimbalyst API version required */
  apiVersion?: string;

  /** Permissions the extension requires */
  permissions?: ExtensionPermissions;

  /** What the extension contributes to Nimbalyst */
  contributions?: ExtensionContributions;

  /**
   * Minimum release channel required to see/use this extension.
   * - 'stable': Available to all users (default if not specified)
   * - 'alpha': Only visible to users on the alpha release channel
   */
  requiredReleaseChannel?: 'stable' | 'alpha';

  /**
   * Default enabled state for the extension.
   * - true: Extension is enabled by default when first discovered
   * - false: Extension is disabled by default until the user enables it
   */
  defaultEnabled?: boolean;

  /**
   * Marketplace metadata for publishing to the extension marketplace.
   * Only used when packaging extensions for distribution.
   */
  marketplace?: ExtensionMarketplaceMetadata;
}

/**
 * Marketplace metadata declared in manifest.json.
 * Used by the packaging pipeline to generate registry entries.
 */
export interface ExtensionMarketplaceMetadata {
  /** Categories for marketplace browsing (e.g., 'developer-tools', 'diagrams') */
  categories?: string[];

  /** Tags for search (e.g., 'csv', 'spreadsheet', 'data') */
  tags?: string[];

  /** Material icon name for marketplace card */
  icon?: string;

  /** Whether this extension should be featured in the marketplace */
  featured?: boolean;

  /** Short tagline for marketplace cards (e.g., "Visual CSV editing with formula support") */
  tagline?: string;

  /**
   * Rich description for the in-app detail view and as a baseline for the marketing website.
   * Supports markdown. Should cover what the extension does and why it's useful.
   */
  longDescription?: string;

  /** Key selling points shown as a bullet list in both in-app detail view and website */
  highlights?: string[];

  /** Human-readable file types this extension works with (e.g., [".csv", ".tsv"]) */
  fileTypes?: string[];

  /** GitHub repository URL */
  repositoryUrl?: string;

  /** Changelog text shown in extension details */
  changelog?: string;

  /**
   * Screenshots for the marketplace listing.
   * Each entry specifies a file to open and an alt text.
   * The screenshot pipeline captures these automatically.
   */
  screenshots?: MarketplaceScreenshot[];
}

export interface MarketplaceScreenshot {
  /** Alt text for the screenshot */
  alt: string;

  /**
   * Relative path to a dark-theme screenshot image bundled with the extension
   * (e.g., "screenshots/overview-dark.png").
   * This is the primary way external extensions provide screenshots.
   * If only one variant is provided, it will be used for both themes.
   */
  src?: string;

  /**
   * Relative path to a light-theme screenshot image bundled with the extension
   * (e.g., "screenshots/overview-light.png").
   * Optional -- if omitted, `src` is used for both themes.
   */
  srcLight?: string;

  /**
   * Relative path to a sample file to open for the screenshot.
   * Used by the automated screenshot pipeline (internal extensions).
   * The pipeline opens this file in Nimbalyst and captures the editor.
   */
  fileToOpen?: string;

  /**
   * Optional CSS selector to capture a specific element instead of the full editor.
   * Only used with fileToOpen by the automated pipeline.
   */
  selector?: string;
}

export interface ExtensionPermissions {
  /** Can read/write files */
  filesystem?: boolean;

  /** Can access AI services */
  ai?: boolean;

  /** Can make network requests */
  network?: boolean;

  /**
   * Catalog-based capability ids. Use this for capabilities defined in the
   * host's permission catalog (see ExtensionPermissionId). Required for any
   * panel/renderer extension that wants to call host APIs gated on a catalog
   * permission (e.g. `host.data.query` requires `nimbalyst-database-read`).
   *
   * Backend modules declare their own permissions on the module contribution;
   * this top-level array covers the panel/renderer surface.
   */
  catalog?: ExtensionPermissionId[];
}

export interface ExtensionContributions {
  /** Custom editors for specific file types */
  customEditors?: CustomEditorContribution[];

  /** Custom file icons keyed by glob pattern */
  fileIcons?: Record<string, string>;

  /** AI tools the extension provides (list of tool names) */
  aiTools?: string[];

  /** Entries to add to the New File menu */
  newFileMenu?: NewFileMenuContribution[];

  /** Named actions an extension exposes */
  commands?: CommandContribution[];

  /** Key bindings that map key combos to commands */
  keybindings?: KeybindingContribution[];

  /** Slash commands for AI chat */
  slashCommands?: SlashCommandContribution[];

  /** Lexical node exports contributed by the extension */
  nodes?: string[];

  /** Markdown transformers for Lexical */
  transformers?: string[];

  /**
   * `LexicalExtension` instances contributed by the extension (see
   * `@lexical/extension`). Names refer to exports on the module's
   * `lexicalExtensions` record. Each contributed extension is added to
   * the host editor's extension graph at construction time; toggling an
   * extension on or off rebuilds the editor instance.
   *
   * This is the supported path for shipping Lexical functionality from
   * an extension. Use `defineExtension` from `lexical` to build the
   * extension object.
   */
  lexicalExtensions?: string[];

  /** Components mounted by the host at app level */
  hostComponents?: string[];

  /** Extension configuration schema */
  configuration?: ExtensionConfigurationContribution;

  /** Claude Code plugin metadata */
  claudePlugin?: ClaudePluginContribution;

  /** Provider-neutral agent workflows exported to supported agent providers */
  agentWorkflows?: AgentWorkflowsContribution;

  /**
   * Non-file-based panels (e.g., database browser, deployment dashboard).
   * Panels integrate with the navigation gutter and can expose AI tools.
   */
  panels?: PanelContribution[];

  /**
   * Settings panel shown in the Settings screen under "Extensions" section.
   */
  settingsPanel?: SettingsPanelContribution;

  /**
   * Document headers that render above editors for matching file types.
   * Headers augment the editor without replacing it.
   */
  documentHeaders?: DocumentHeaderContribution[];

  /**
   * Custom themes that users can select.
   * Extensions can provide color themes that override the built-in themes.
   */
  themes?: ThemeContribution[];

  /**
   * Backend modules contributed by this extension.
   *
   * Each module runs in an isolated runtime (utility-process or worker-thread)
   * outside both Electron main and the renderer. Modules are inert until the
   * user grants their declared permissions via the first-use prompt.
   *
   * Capped at {@link MAX_BACKEND_MODULES_PER_EXTENSION} per extension.
   */
  backendModules?: BackendModuleContribution[];

  /**
   * External-source importers that pull items (GitHub issues, Linear issues,
   * ...) into the native tracker. Each importer's privileged work runs in a
   * backend module referenced by `backendModuleId`; the host owns the
   * create/merge path. See {@link TrackerImporterContribution}.
   */
  trackerImporters?: TrackerImporterContribution[];

  /**
   * AI agent providers contributed by this extension.
   *
   * Each entry registers a new agent-protocol provider (e.g. an
   * Antigravity/Gemini integration) that the user can pick from the
   * agent-provider dropdown in a coding session. The contribution
   * declares its identity and capabilities here; the protocol
   * implementation itself lives in a backend module referenced by
   * `backendModuleId`.
   *
   * Granting the backing backend module is the consent that lets the
   * provider run; an `aiAgentProviders` entry whose backend module has
   * not been granted is hidden from the dropdown rather than failing
   * at turn time.
   */
  aiAgentProviders?: AiAgentProviderContribution[];
}

/**
 * Configuration schema for extension settings.
 * Follows a JSON Schema-like structure for defining configurable properties.
 */
export interface ExtensionConfigurationContribution {
  /** Title displayed in settings panel */
  title?: string;

  /** Configuration properties */
  properties: Record<string, ConfigurationProperty>;
}

/**
 * A single configuration property that can be set by the user.
 */
export interface ConfigurationProperty {
  /** Property type */
  type: 'string' | 'number' | 'boolean' | 'array' | 'object';

  /** Default value */
  default?: unknown;

  /** Human-readable description */
  description?: string;

  /** Enum values for dropdown selection */
  enum?: (string | number)[];

  /** Human-readable labels for enum values */
  enumDescriptions?: string[];

  /**
   * Scope of the setting:
   * - 'user': Global setting
   * - 'workspace': Per-project setting
   * - 'both': Available in both scopes (workspace overrides user)
   */
  scope?: 'user' | 'workspace' | 'both';

  /** Order for display (lower = higher priority) */
  order?: number;

  /** Minimum value for numbers */
  minimum?: number;

  /** Maximum value for numbers */
  maximum?: number;

  /** Pattern for string validation (regex) */
  pattern?: string;

  /** Placeholder text for input fields */
  placeholder?: string;
}

/**
 * Claude Agent SDK plugin contribution.
 * Allows extensions to bundle Claude Code plugins that provide
 * slash commands, agents, skills, and hooks.
 */
export interface ClaudePluginContribution {
  /** Path to plugin directory relative to extension root */
  path: string;

  /** Human-readable name for settings UI */
  displayName: string;

  /** Description for settings UI */
  description?: string;

  /** Whether this plugin is enabled by default */
  enabledByDefault?: boolean;

  /** Commands provided by this plugin (for documentation/UI) */
  commands?: ClaudePluginCommand[];

  /** Agents provided by this plugin (for documentation/UI) */
  agents?: ClaudePluginAgent[];
}

export interface ClaudePluginCommand {
  /** Command name (without slash or namespace) */
  name: string;

  /** Human-readable description */
  description: string;
}

export interface ClaudePluginAgent {
  /** Agent name */
  name: string;

  /** Human-readable description */
  description: string;
}

/**
 * Provider-neutral agent workflow contribution.
 * The directory should contain `commands/` and/or `skills/` subdirectories
 * using the familiar Claude-compatible markdown formats.
 */
export interface AgentWorkflowsContribution {
  /** Path to the workflow root relative to extension root */
  path: string;

  /** Human-readable name for settings and diagnostics UI */
  displayName: string;

  /** Description for settings and diagnostics UI */
  description?: string;

  /** Whether these workflows are enabled by default */
  enabledByDefault?: boolean;
}

/**
 * New file menu contribution.
 */
export interface NewFileMenuContribution {
  /**
   * Identifier for the menu item. For `createFile` actions this is the file
   * extension with dot (e.g., '.csv') and is appended to the typed name. For
   * `openVirtualTab` actions it is just a unique key.
   */
  extension: string;

  /** Name shown in menu (rendered as "New {displayName}") */
  displayName: string;

  /** Material icon name */
  icon: string;

  /**
   * What selecting the item does. Defaults to `createFile`.
   * - `createFile`: prompts for a name and writes a file with `defaultContent`.
   * - `openVirtualTab`: opens a fileless editor tab at `<virtualScheme><id>`
   *   (no file on disk, no name prompt). The custom editor registered for that
   *   virtual prefix renders it.
   */
  action?: 'createFile' | 'openVirtualTab';

  /** Initial file content (for `createFile`). */
  defaultContent?: string;

  /**
   * For `openVirtualTab`: the `virtual://…/` prefix to open. A unique id (and a
   * `?title=` derived from displayName) is appended by the host.
   */
  virtualScheme?: string;
}

export interface CustomEditorContribution {
  /** Glob patterns for files this editor handles (e.g., ['*.csv', '*.tsv']) */
  filePatterns: string[];

  /** Display name shown in UI */
  displayName: string;

  /** Component name exported from the extension */
  component: string;

  /**
   * Whether this editor supports source mode (editing the raw file in Monaco).
   * When true, the host will provide a source-mode toggle.
   */
  supportsSourceMode?: boolean;

  /**
   * Whether this editor supports the host's AI diff review mode.
   * Defaults to false - must be explicitly set to true to enable.
   */
  supportsDiffMode?: boolean;

  /**
   * Whether to show the host-provided document header above the editor.
   * Defaults to true when omitted for backward compatibility.
   */
  showDocumentHeader?: boolean;

  /**
   * Whether this editor opts in to render inline in the agent transcript
   * when an AI edits a file it handles. The host renders the editor in a
   * read-only, click-to-activate frame. Defaults to false; extensions must
   * explicitly enable so heavyweight editors don't auto-instantiate for
   * every scrolled edit.
   */
  supportsTranscriptEmbed?: boolean;

  /**
   * Preferred height in pixels for the inline transcript embed. Only
   * applies when `supportsTranscriptEmbed` is true. Defaults to 360 when
   * omitted.
   */
  transcriptEmbedHeight?: number;

  /**
   * Declares whether this editor supports the host's collaborative
   * (Share-to-Team / multi-client real-time) flow.
   *
   * When `supported: true`, the host treats files of this type as eligible
   * for collaborative open: it stands up a `DocumentSyncProvider`,
   * populates `host.collaboration` on the EditorHost, and the editor
   * component is expected to call `useCollaborativeEditor` from
   * `@nimbalyst/extension-sdk` to wire its binding.
   *
   * `awarenessFields` is advisory metadata used for docs / debugging --
   * it does not gate runtime behaviour. List the extra awareness keys
   * (beyond the standard `user`, `pointer`, `selection`) your editor
   * publishes, e.g. `['selectedElementIds', 'tool']` for Excalidraw or
   * `['editingNodeId']` for Mindmap.
   */
  collaboration?: {
    supported: boolean;
    awarenessFields?: string[];
  };
}

export interface DocumentHeaderContribution {
  /** Unique identifier for this header (e.g., 'astro-frontmatter') */
  id: string;

  /** Glob patterns for files this header applies to (e.g., ['*.astro']) */
  filePatterns: string[];

  /** Display name shown in UI */
  displayName: string;

  /** Component name exported from the extension (key in module.components) */
  component: string;

  /** Priority for ordering (higher renders first, default 50) */
  priority?: number;
}

export interface CommandContribution {
  /** Unique command ID */
  id: string;

  /** Display name */
  title: string;
}

/**
 * Keybinding contribution that binds a key combo to a command.
 *
 * @example
 * ```json
 * { "key": "ctrl+shift+g", "command": "com.nimbalyst.git.git-log.toggle" }
 * ```
 *
 * Key format: modifier+key (all lowercase, modifiers: ctrl, shift, alt, cmd)
 * - `ctrl` — Ctrl on all platforms
 * - `cmd` — Cmd/Meta on macOS, Ctrl on Windows/Linux (same cross-platform semantics as built-ins)
 * - Modifiers can be combined: `ctrl+shift+g`, `cmd+alt+k`
 *
 * Toggle commands for panels are auto-registered as `${extensionId}.${panelId}.toggle`,
 * so you only need to declare the keybinding — no explicit command declaration required.
 */
export interface KeybindingContribution {
  /** Key combination (e.g., "ctrl+shift+g") */
  key: string;

  /** Full command ID to execute (e.g., "com.nimbalyst.git.git-log.toggle") */
  command: string;
}

export interface SlashCommandContribution {
  /** Unique command ID (namespaced, e.g., "myext.do-something") */
  id: string;

  /** Display title in the "/" menu */
  title: string;

  /** Optional description */
  description?: string;

  /** Material icon name */
  icon?: string;

  /** Search keywords */
  keywords?: string[];

  /** Handler function name exported from extension */
  handler: string;
}

/**
 * Theme contribution for extensions.
 * Extensions can provide custom color themes that users can select.
 */
export interface ThemeContribution {
  /** Unique theme ID within this extension (will be namespaced as extensionId:themeId) */
  id: string;

  /** Display name for the theme (shown in theme picker) */
  name: string;

  /** Whether this is a dark theme (determines base theme for fallbacks) */
  isDark: boolean;

  /**
   * Theme color values. Only include colors you want to override.
   * Missing colors will fall back to the appropriate base theme.
   */
  colors: ThemeColors;

  /**
   * Optional Monaco editor theme definition. When present, the runtime
   * registers a Monaco theme (via `monaco.editor.defineTheme`) using the
   * namespaced theme id and routes Monaco-backed editors to it whenever
   * this theme is active. When absent, Monaco-backed editors fall back to
   * the appropriate base Monaco theme (`vs` / `vs-dark`) based on
   * `isDark`.
   */
  monaco?: MonacoThemeContribution;
}

/**
 * The module interface that extensions export.
 */
export interface ExtensionModule {
  /** Called when extension is activated */
  activate?: (context: ExtensionContext) => void | Promise<void>;

  /** Called when extension is deactivated */
  deactivate?: () => void | Promise<void>;

  /** React components exported by the extension */
  components?: Record<string, ComponentType<EditorHostProps>>;

  /** AI tools the extension provides */
  aiTools?: ExtensionAITool[];

  /** Lexical nodes contributed by the extension */
  nodes?: Record<string, unknown>;

  /** Markdown transformers for Lexical */
  transformers?: Record<string, unknown>;

  /**
   * `LexicalExtension` instances exported by the extension module. Keys
   * match names listed in `contributions.lexicalExtensions`. Each value
   * should be the return value of `defineExtension(...)` from `lexical`.
   *
   * The host treats the values as opaque (`unknown`) at this layer so the
   * extension SDK does not have to pin a specific version of
   * `@lexical/extension`. The host validates and consumes them through
   * the editor's `LexicalExtensionComposer` pipeline.
   */
  lexicalExtensions?: Record<string, unknown>;

  /** Components that render inside the host editor */
  hostComponents?: Record<string, ComponentType>;

  /** Slash command handlers */
  slashCommandHandlers?: Record<string, () => void>;

  /**
   * Panel exports for non-file-based UIs.
   * Keys are panel IDs matching the `panels` contribution in manifest.json.
   */
  panels?: Record<string, PanelExport>;

  /**
   * Settings panel component for the Settings screen.
   * Keys match the `settingsPanel.component` in manifest.json.
   */
  settingsPanel?: Record<string, ComponentType<SettingsPanelProps>>;
}

/**
 * JSON Schema type for tool parameters.
 */
export interface JSONSchema {
  type: 'object' | 'array' | 'string' | 'number' | 'boolean' | 'null';
  properties?: Record<string, JSONSchemaProperty>;
  required?: string[];
  items?: JSONSchema;
  description?: string;
}

export interface JSONSchemaProperty {
  type: 'string' | 'number' | 'boolean' | 'array' | 'object' | 'null';
  description?: string;
  enum?: (string | number)[];
  items?: JSONSchemaProperty;
  properties?: Record<string, JSONSchemaProperty>;
  required?: string[];
  default?: unknown;
}

/**
 * AI tool definition from an extension.
 */
export interface ExtensionAITool {
  /** Unique name (use prefix.action format, e.g., 'csv.get_schema') */
  name: string;

  /** Description for the AI */
  description: string;

  /**
   * JSON Schema for tool parameters.
   * Use either 'inputSchema' (preferred) or 'parameters'.
   */
  inputSchema?: JSONSchema;

  /**
   * JSON Schema for tool parameters (legacy alias).
   * @deprecated Use inputSchema instead.
   */
  parameters?: JSONSchema;

  /**
   * Tool scope.
   * - 'global': Always available
   * - 'editor': Only available when a matching editor is active
   */
  scope?: 'global' | 'editor';

  /**
   * File patterns this tool applies to when scope is 'editor'.
   * If omitted, the host may inherit the extension's custom editor patterns.
   */
  editorFilePatterns?: string[];

  /** Handler function */
  handler: (
    params: Record<string, unknown>,
    context: AIToolContext
  ) => Promise<ExtensionToolResult>;
}

/**
 * Result returned from extension AI tool handlers.
 * Includes enhanced error details for debugging and diagnostics.
 */
export interface ExtensionToolResult {
  /** Whether the tool executed successfully */
  success: boolean;

  /** Human-readable result message (shown to AI) */
  message?: string;

  /** Structured data result */
  data?: unknown;

  /** Error message if success is false */
  error?: string;

  /** Extension ID that provided this tool (added during execution) */
  extensionId?: string;

  /** Tool name that was executed (added during execution) */
  toolName?: string;

  /** Stack trace if an error occurred (for debugging) */
  stack?: string;

  /** Additional context about the error (for debugging) */
  errorContext?: Record<string, unknown>;
}

/**
 * Services provided to extensions via the runtime context.
 */
export interface ExtensionServices {
  /** File system operations */
  filesystem: ExtensionFileSystemService;

  /** UI operations */
  ui: ExtensionUIService;

  /** AI services (only available if permissions.ai is true) */
  ai?: ExtensionAIService;

  /** Configuration service (only available if contributions.configuration is defined) */
  configuration?: ExtensionConfigurationService;

  /**
   * Collaboration service. Used by editors that ship a
   * CollabContentAdapter to plug into host-level operations on their
   * shared Y.Doc (re-upload, history, export, AI editing, search).
   * See `packages/extension-sdk-docs/custom-editors.md`.
   */
  collab: ExtensionCollabService;
}

/**
 * Context passed to the activate function.
 * This is the full context available at runtime.
 */
export interface ExtensionContext {
  /** The extension's manifest */
  manifest: ExtensionManifest;

  /** Absolute path to the extension's installation directory */
  extensionPath: string;

  /** Services available to the extension */
  services: ExtensionServices;

  /**
   * Array to add disposables to.
   * These will be cleaned up on deactivation.
   */
  subscriptions: Disposable[];
}

/**
 * Context passed to AI tool handlers.
 */
export interface AIToolContext {
  /** Path to the current workspace (may be undefined if no workspace is open) */
  workspacePath?: string;

  /** Path to the currently active file (may be undefined if no file is open) */
  activeFilePath?: string;

  /** The extension context for accessing services */
  extensionContext: ExtensionContext;

  /**
   * The editor's imperative API, if one was registered via host.registerEditorAPI().
   * This is populated automatically from the central registry when a tool targets
   * a file that has a mounted editor (visible or hidden).
   *
   * Cast to your extension's specific API type before using.
   */
  editorAPI?: unknown;
}

export interface ExtensionConfigurationService {
  /**
   * Get a configuration value.
   * Returns the workspace value if set, otherwise the user value, otherwise the default.
   */
  get<T>(key: string, defaultValue?: T): T;

  /**
   * Update a configuration value.
   * @param scope Which scope to update ('user' or 'workspace')
   */
  update(key: string, value: unknown, scope?: 'user' | 'workspace'): Promise<void>;

  /** Get all configuration values */
  getAll(): Record<string, unknown>;
}

export interface ExtensionFileSystemService {
  /** Read a file's contents */
  readFile(path: string): Promise<string>;

  /** Write content to a file */
  writeFile(path: string, content: string): Promise<void>;

  /** Check if a file exists */
  fileExists(path: string): Promise<boolean>;

  /** Find files matching a pattern */
  findFiles(pattern: string): Promise<string[]>;
}

export interface ExtensionUIService {
  /** Show an info message */
  showInfo(message: string): void;

  /** Show a warning message */
  showWarning(message: string): void;

  /** Show an error message */
  showError(message: string): void;
}

export interface ExtensionAIService {
  /** Register an AI tool */
  registerTool(tool: ExtensionAITool): Disposable;

  /** Register a context provider */
  registerContextProvider(provider: ExtensionContextProvider): Disposable;

  /** Send a prompt to the AI and get a response. Defaults to claude-code provider. Creates a session. */
  sendPrompt(options: {
    prompt: string;
    sessionName?: string;
    /** AI provider to use. Defaults to 'claude-code'. */
    provider?: 'claude-code' | 'claude' | 'openai';
    /** Model ID (e.g. 'claude-code:opus', 'claude-code:sonnet'). Uses provider default if omitted. */
    model?: string;
  }): Promise<{
    sessionId: string;
    response: string;
  }>;

  /**
   * List available chat models.
   * Returns models from enabled chat providers (Claude, OpenAI, LM Studio),
   * filtered to models the user has enabled in settings.
   */
  listModels(): Promise<ExtensionAIModel[]>;

  /**
   * Stateless chat completion. Sends messages to a model and returns the full response.
   * Does not create a session in the session history.
   */
  chatCompletion(options: ChatCompletionOptions): Promise<ChatCompletionResult>;

  /**
   * Streaming chat completion. Sends messages to a model and streams the response
   * token-by-token via the onChunk callback.
   * Does not create a session in the session history.
   */
  chatCompletionStream(options: ChatCompletionStreamOptions): Promise<ChatCompletionStreamHandle>;
}

/**
 * An AI model available for chat completions.
 */
export interface ExtensionAIModel {
  /** Full model ID (e.g. "claude:claude-sonnet-4-6-20250514") */
  id: string;
  /** Display name (e.g. "Claude Sonnet 4.6") */
  name: string;
  /** Provider type (e.g. "claude", "openai", "lmstudio") */
  provider: string;
}

/**
 * A message in a chat completion conversation.
 */
export interface ChatCompletionMessage {
  role: 'user' | 'assistant' | 'system';
  content: string;
}

/**
 * Options for a chat completion request.
 */
export interface ChatCompletionOptions {
  /** Conversation messages. At minimum, include one user message. */
  messages: ChatCompletionMessage[];
  /** Model ID from listModels(). Uses the first available model's default if omitted. */
  model?: string;
  /** Maximum tokens in the response. */
  maxTokens?: number;
  /** Sampling temperature (0-1). */
  temperature?: number;
  /** Convenience: prepended as a system message before the messages array. */
  systemPrompt?: string;
  /**
   * Response format constraint.
   * - `{ type: 'text' }` or omitted: plain text (default)
   * - `{ type: 'json_object' }`: model returns valid JSON
   * - `{ type: 'json_schema', schema: { ... } }`: model returns JSON matching the schema
   *
   * When using json_object or json_schema, include "respond in JSON" in your system prompt
   * or messages for best results.
   */
  responseFormat?: ResponseFormat;
}

/**
 * Response format constraint for chat completions.
 *
 * For json_schema, pass your JSON Schema object directly:
 *   `{ type: 'json_schema', schema: { type: 'object', properties: { ... } } }`
 *
 * You can optionally provide a name and strict flag:
 *   `{ type: 'json_schema', schema: { ... }, name: 'my_schema', strict: true }`
 */
export type ResponseFormat =
  | { type: 'text' }
  | { type: 'json_object' }
  | { type: 'json_schema'; schema: JSONSchema; name?: string; strict?: boolean };

/**
 * Result from a chat completion request.
 */
export interface ChatCompletionResult {
  /** The assistant's response text. */
  content: string;
  /** The model that was actually used. */
  model: string;
  /** Token usage, if available from the provider. */
  usage?: { inputTokens: number; outputTokens: number };
}

/**
 * A streaming chunk delivered via the onChunk callback.
 */
export interface ChatCompletionStreamChunk {
  type: 'text' | 'error' | 'done';
  content?: string;
  error?: string;
}

/**
 * Options for a streaming chat completion request.
 */
export interface ChatCompletionStreamOptions extends ChatCompletionOptions {
  /** Called for each streaming chunk (text deltas, errors, and completion signal). */
  onChunk: (chunk: ChatCompletionStreamChunk) => void;
}

/**
 * Handle returned from chatCompletionStream for controlling the stream.
 */
export interface ChatCompletionStreamHandle {
  /** Abort the in-flight stream. */
  abort(): void;
  /** Resolves when the stream completes with the full result. */
  result: Promise<ChatCompletionResult>;
}

export interface ExtensionContextProvider {
  /** Provider identifier */
  id: string;

  /** Priority (higher = earlier in context) */
  priority?: number;

  /** Generate context string */
  provideContext(): Promise<string>;
}

export interface Disposable {
  dispose(): void;
}

// ============================================================================
// Deprecated compatibility aliases
// ============================================================================

/**
 * @deprecated Use AIToolContext instead. This type has incorrect property names.
 */
export interface ToolContext {
  /** @deprecated Use activeFilePath instead */
  filePath?: string;

  /** @deprecated This property is not available. Use services.filesystem.readFile(). */
  fileContent?: string;

  /** Path to extension installation directory */
  extensionPath: string;
}

/**
 * @deprecated Use ExtensionToolResult for tool handlers.
 * This remains as a loose compatibility type for older internal extensions.
 */
export type ToolResult = ToolSuccessResult | ToolErrorResult;

/**
 * @deprecated Use ExtensionToolResult for tool handlers.
 */
export interface ToolSuccessResult {
  /** Any data to return to the AI */
  [key: string]: unknown;

  /** If present, updates the file content */
  newContent?: string;
}

/**
 * @deprecated Use ExtensionToolResult for tool handlers.
 */
export interface ToolErrorResult {
  error: string;
}

/**
 * @deprecated Use ExtensionAITool instead.
 */
export type AIToolDefinition = ExtensionAITool;

/**
 * @deprecated Use JSONSchemaProperty instead.
 */
export type JsonSchemaProperty = JSONSchemaProperty;

/**
 * @deprecated `fileIcons` now uses a Record<string, string> map in ExtensionContributions.
 */
export interface FileIconContribution {
  pattern: string;
  icon: string;
  color?: string;
}

/**
 * @deprecated Use `contributions.nodes` plus exported node classes instead.
 */
export interface LexicalNodeContribution {
  type: string;
  name: string;
  nodeClass: string;
}

/**
 * @deprecated Extensions should use host storage and service contracts instead.
 */
export type SettingsPanelStorage = ExtensionStorage;

/**
 * @deprecated Use PanelHostProps from './panel' instead.
 */
export type LegacyPanelHostProps = PanelHostProps;

/**
 * @deprecated Use PanelGutterButtonProps from './panel' instead.
 */
export type LegacyPanelGutterButtonProps = PanelGutterButtonProps;
