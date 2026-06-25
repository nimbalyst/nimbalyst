/**
 * Static dependency injection for ClaudeCodeProvider.
 *
 * These fields and setters are called once at app startup by the Electron main process
 * to inject capabilities (ports, loaders, checkers) into the runtime package without
 * creating a direct dependency on Electron code.
 */

// ---- Type Definitions ----

export type McpConfigLoader = (workspacePath?: string) => Promise<Record<string, any>>;
export type ExtensionPluginsLoader = (workspacePath?: string) => Promise<Array<{ type: 'local'; path: string }>>;
export type ClaudeCodeSettingsLoader = () => Promise<{ projectCommandsEnabled: boolean; userCommandsEnabled: boolean }>;
export type ClaudeSettingsEnvLoader = () => Promise<Record<string, string>>;
export type ShellEnvironmentLoader = () => Record<string, string> | null;
export type AdditionalDirectoriesLoader = (workspacePath: string) => string[];
export type PatternSaver = (workspacePath: string, pattern: string) => Promise<void>;
export type PatternChecker = (workspacePath: string, pattern: string) => Promise<boolean>;
export type ImageCompressor = (
  buffer: Buffer,
  mimeType: string,
  options?: { targetSizeBytes?: number }
) => Promise<{ buffer: Buffer; mimeType: string; wasCompressed: boolean }>;
export type ExtensionFileTypesLoader = () => Set<string>;

// ---- Dependency Store ----

/**
 * Centralized store for all static dependencies injected from the Electron main process.
 * Access fields directly: `ClaudeCodeDeps.mcpServerPort`
 * Set fields via setters: `ClaudeCodeDeps.setMcpServerPort(port)`
 */
export const ClaudeCodeDeps = {
  // ---- Binary Configuration ----

  // Loader that reads the custom Claude Code executable path fresh from the settings store.
  // Re-read on each query so changes in the UI take effect without restart.
  // The workspace path is required: this provider only runs in the context of an open
  // workspace, and the loader uses it to resolve project-level overrides (with worktree
  // inheritance) before falling through to the global setting.
  customClaudeCodePathLoader: null as ((workspacePath: string) => string) | null,

  // ---- Internal MCP server enablement ----
  // Ports, kill-switches, extension/tracker loaders, and the per-launch bearer
  // token now live in the shared `mcpServerConfig` registry (configured once
  // from electron main via `configureMcpServers`). ClaudeCodeProvider builds its
  // McpConfigService via `getMcpConfigService`, passing only the provider-owned
  // config/env loaders below.

  // ---- Loaders ----

  // Returns merged user + workspace MCP servers
  mcpConfigLoader: null as McpConfigLoader | null,

  // Returns plugin paths from enabled extensions with Claude plugins
  // Accepts optional workspace path to include project-scoped CLI plugins
  extensionPluginsLoader: null as ExtensionPluginsLoader | null,

  // Returns settings for project/user commands
  claudeCodeSettingsLoader: null as ClaudeCodeSettingsLoader | null,

  // Returns env vars from ~/.claude/settings.json to pass directly to the SDK
  claudeSettingsEnvLoader: null as ClaudeSettingsEnvLoader | null,

  // Returns full env vars from user's login shell (e.g., AWS_*, NODE_EXTRA_CA_CERTS)
  // Ensures env vars are available even when launched from Dock/Finder
  shellEnvironmentLoader: null as ShellEnvironmentLoader | null,

  // Returns a PATH string that includes common CLI installation locations
  // (Homebrew, nvm, volta, etc.). The Claude Code SDK spawns stdio MCP
  // subprocesses (`npx`, `uvx`, `docker`) using options.env.PATH, and
  // Dock/Finder-launched Electron has a minimal PATH that omits those dirs.
  enhancedPathLoader: null as (() => string) | null,

  // Returns additional directories Claude should have access to based on workspace context
  // (e.g., SDK docs when working on an extension project)
  additionalDirectoriesLoader: null as AdditionalDirectoriesLoader | null,

  // ---- Security / Permissions ----

  // Writes tool patterns to .claude/settings.local.json when user approves with "Always"
  claudeSettingsPatternSaver: null as PatternSaver | null,

  // Checks if a pattern is in the allow list of .claude/settings.local.json
  claudeSettingsPatternChecker: null as PatternChecker | null,

  // ---- Feature Capabilities ----

  // Compresses images to fit within API limits before sending
  imageCompressor: null as ImageCompressor | null,

  // Returns file extensions that have custom editors registered via extensions
  // Used in planning mode to allow editing extension-registered file types (e.g., .mockup.html)
  extensionFileTypesLoader: null as ExtensionFileTypesLoader | null,

  // ---- Plan Tracking ----

  PLAN_TRACKING_DEFAULT: true as const,

  // When true, plans are saved to nimbalyst-local/plans/ with tracking frontmatter
  planTrackingEnabled: true,

  // ---- Default Model ----

  DEFAULT_MODEL: 'claude-code:opus-1m' as const,

  // ---- Setters ----
  // Called from electron main process at startup

  setCustomClaudeCodePathLoader(loader: ((workspacePath: string) => string) | null): void {
    this.customClaudeCodePathLoader = loader;
  },

  setMCPConfigLoader(loader: McpConfigLoader | null): void {
    this.mcpConfigLoader = loader;
  },

  setExtensionPluginsLoader(loader: ExtensionPluginsLoader | null): void {
    this.extensionPluginsLoader = loader;
  },

  setClaudeCodeSettingsLoader(loader: ClaudeCodeSettingsLoader | null): void {
    this.claudeCodeSettingsLoader = loader;
  },

  setClaudeSettingsEnvLoader(loader: ClaudeSettingsEnvLoader | null): void {
    this.claudeSettingsEnvLoader = loader;
  },

  setShellEnvironmentLoader(loader: ShellEnvironmentLoader | null): void {
    this.shellEnvironmentLoader = loader;
  },

  setEnhancedPathLoader(loader: (() => string) | null): void {
    this.enhancedPathLoader = loader;
  },

  setAdditionalDirectoriesLoader(loader: AdditionalDirectoriesLoader | null): void {
    this.additionalDirectoriesLoader = loader;
  },

  setClaudeSettingsPatternSaver(saver: PatternSaver | null): void {
    this.claudeSettingsPatternSaver = saver;
  },

  setClaudeSettingsPatternChecker(checker: PatternChecker | null): void {
    this.claudeSettingsPatternChecker = checker;
  },

  setImageCompressor(compressor: ImageCompressor | null): void {
    this.imageCompressor = compressor;
  },

  setExtensionFileTypesLoader(loader: ExtensionFileTypesLoader | null): void {
    this.extensionFileTypesLoader = loader;
  },

  setPlanTrackingEnabled(enabled: boolean): void {
    this.planTrackingEnabled = enabled;
  },
};
