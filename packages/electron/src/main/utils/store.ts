import Store from 'electron-store';
import { execSync } from 'child_process';
import { existsSync } from 'fs';
import * as path from 'path';
import { RecentItem, SessionState, SessionWindow } from '../types';
import { logger } from './logger';
import { type EffortLevel, parseEffortLevel } from '@nimbalyst/runtime/ai/server/effortLevels';
import type { OnboardingConfig } from '../../shared/types/workspace';
import { DEFAULT_ONBOARDING_CONFIG } from '../../shared/types/workspace';
import { AlphaFeatureTag, getDefaultAlphaFeatures, ALPHA_FEATURES } from '../../shared/alphaFeatures';
import { DeveloperFeatureTag, getDefaultDeveloperFeatures, DEVELOPER_FEATURES } from '../../shared/developerFeatures';
import { BetaFeatureTag, getDefaultBetaFeatures, enableAllBetaFeatures as enableAllBetaFeaturesUtil, BETA_FEATURES } from '../../shared/betaFeatures';
import { normalizeCodexProviderConfig, omitModelsField } from '@nimbalyst/runtime/ai/server/utils/modelConfigUtils';

// Theme can be a built-in theme or an extension theme ID (format: "extensionId:themeId")
export type AppTheme = 'dark' | 'light' | 'system' | 'auto' | 'crystal-dark' | string;
export type { SessionState, SessionWindow } from '../types';

export type CompletionSoundType = 'chime' | 'bell' | 'pop' | 'alert' | 'custom' | 'none';
export type ReleaseChannel = 'stable' | 'alpha';
export type PreferredTerminalShell = 'auto' | 'pwsh' | 'powershell' | 'git-bash' | 'wsl' | 'cmd';
export type WorkspaceFileTreeFilter = 'all' | 'markdown' | 'known' | 'git-uncommitted' | 'git-worktree' | 'ai-read' | 'ai-written';
export type TrackerSyncModeSetting = 'local' | 'shared' | 'hybrid';
export interface TrackerSyncPolicySetting {
  mode: TrackerSyncModeSetting;
  scope?: 'project' | 'workspace';
}

/**
 * Extension settings stored per extension.
 * Tracks enabled state and extension-specific configuration.
 */
export interface ExtensionSettings {
  /** Whether the extension is enabled */
  enabled: boolean;
  /** Whether the Claude Agent SDK plugin is enabled (if extension has one) */
  claudePluginEnabled?: boolean;
  /** Whether provider-neutral agent workflows are enabled (if extension has them) */
  agentWorkflowsEnabled?: boolean;
  /** Extension-specific configuration values (user scope) */
  configuration?: Record<string, unknown>;
}

interface AppStoreSchema {
  theme: AppTheme;
  themeIsDark?: boolean; // Whether the current theme is dark (used for extension themes)
  // Set when the active theme disappeared (extension uninstalled/disabled or
  // file removed) and the runtime fell back to a base theme. Cleared when the
  // user explicitly applies a theme or dismisses the banner in the Themes panel.
  pendingThemeFallback?: { missingId: string; appliedId: string };
  recent: {
    workspaces: RecentItem[];
    documents: RecentItem[];
  };
  openWorkspaces: Array<{ path: string; windowId?: number }>;
  sessionState?: SessionState;
  loggerConfig?: unknown;
  // Community popup tracking
  launchCount?: number;
  discordInvitationDismissed?: boolean;
  communityPopupDismissed?: boolean;
  completedSessionCount?: number;
  completedSessionsWithTools?: number;
  // Sound notifications
  completionSoundEnabled?: boolean;
  completionSoundType?: CompletionSoundType;
  // Absolute path (inside userData/custom-sounds) of the user-supplied
  // completion sound file, used when completionSoundType === 'custom'.
  completionSoundCustomPath?: string;
  // Completion sound volume as a percentage of system volume (0-100).
  completionSoundVolume?: number;
  // OS notifications
  osNotificationsEnabled?: boolean;
  // Release channel
  releaseChannel?: ReleaseChannel;
  // Default AI model for new sessions (format: "provider:model" e.g., "claude-code:sonnet")
  defaultAIModel?: string;
  // Default GitHub CLI account login for PR review. A per-project
  // override lives on WorkspaceState.prReviewGhAccountOverride.
  prReviewDefaultGhAccount?: string;
  // Analytics
  analyticsEnabled?: boolean;
  // User onboarding
  userRole?: string; // The user's selected role (or 'skipped' if permanently dismissed)
  userEmail?: string; // Optional email provided during onboarding
  referralSource?: string; // Where user heard about Nimbalyst
  onboardingNextPrompt?: number; // Timestamp for when to show onboarding again (if deferred)
  unifiedOnboardingCompleted?: boolean; // Unified 3-step onboarding completed (separate from old onboarding)
  // Developer mode - enables git worktrees, terminal, and dev-specific features
  developerMode?: boolean;
  // Custom Editors
  mockupLMEnabled?: boolean; // Enable MockupLM custom editor
  // First launch Claude Code installation detection (only checked once ever)
  claudeCodeInstallationChecked?: boolean;
  // Feature walkthrough shown on first launch
  featureWalkthroughCompleted?: boolean;
  // Worktree onboarding modal shown
  worktreeOnboardingShown?: boolean;
  // Extension project capability intro shown
  extensionProjectIntroShown?: boolean;
  // Extension settings (enabled/disabled state and configuration)
  extensionSettings?: Record<string, ExtensionSettings>;
  // Global-scope privileged-extension capability grants ("Enable for all workspaces").
  // Workspace-scope grants live on WorkspaceState.extensionPermissionGrants.
  // See packages/electron/src/main/extensions/permissionGrantStore.ts for the
  // canonical read/write API. Keep this as an opaque list to keep electron-store
  // migrations simple; the store module owns the shape and indexing.
  extensionPermissionGrantsGlobal?: PersistedPermissionGrant[];
  // Claude Code settings
  claudeCode?: {
    // Enable project-level commands (.claude/commands/ in workspace)
    projectCommandsEnabled?: boolean;
    // Enable user-level commands (~/.claude/commands/)
    userCommandsEnabled?: boolean;
    // Advanced: route the Claude CLI's API traffic through a custom upstream
    // before it reaches Anthropic. The observation proxy forwards `/v1/messages`
    // here (a base path like `/anthropic` is honored) instead of straight to
    // api.anthropic.com — enabling user-supplied middleware (token-compression,
    // gateways, caching, observability). Empty/unset = direct to Anthropic.
    // SECURITY: the target receives the CLI's subscription OAuth token + prompt
    // content, so only loopback hosts are accepted (see setClaudeCodeApiUpstreamUrl).
    apiUpstreamUrl?: string;
  };
  // OpenAI Codex settings
  openaiCodex?: {
    // Which codex transport to use for new sessions. 'app-server' (default)
    // drives `codex app-server --listen stdio://` directly via JSON-RPC v2,
    // which provides full unified-diff text per file_change for deterministic
    // pre-edit baselines. 'sdk' is the legacy `codex exec --experimental-json`
    // path retained as an escape hatch.
    transport?: 'sdk' | 'app-server';
  };
  // Unified agent workflow registry source settings
  agentWorkflowSources?: {
    workspaceClaudeCompatibilityEnabled?: boolean;
    includeProjectClaudeSources?: boolean;
    includeUserClaudeSources?: boolean;
    extensionWorkflowsEnabled?: boolean;
  };
  // Provider-specific workflow export settings
  agentWorkflowExports?: {
    codexEnabled?: boolean;
    claudeGeneratedExtensionWorkflowsEnabled?: boolean;
  };
  // Extension Development Kit (EDK) - enables MCP tools for building/reloading extensions
  extensionDevToolsEnabled?: boolean;
  // Kill-switch for the `nimbalyst-settings` MCP server that lets agents change Nimbalyst
  // settings. Default false (MCP enabled). Set true from Settings > Advanced to disable.
  settingsAgentToolsDisabled?: boolean;
  // Share encryption keys: maps sessionId -> base64 AES-256 key (for re-sharing with stable URLs)
  shareKeys?: Record<string, string>;
  // Share expiration preference: number of days (1, 7, 30). Max 30 days.
  shareExpirationDays?: number;
  // Session Sync (optional device sync)
  sessionSync?: {
    enabled: boolean;
    serverUrl: string; // e.g., 'ws://localhost:8790' or 'wss://sync.nimbalyst.com'
    enabledProjects?: string[]; // List of workspace paths enabled for sync
    // Dev-only: override environment (defaults to 'production' even in dev builds)
    environment?: 'development' | 'production';
  };
  // Stytch Auth Configuration (project ID and public token only - secret stored in keychain)
  stytchAuth?: {
    projectId: string;
    publicToken: string;
  };
  // Auto-update suppression (when user dismisses an update)
  updateDismissedVersion?: string;
  updateDismissedAt?: number;
  // Voice Mode settings
  voiceMode?: {
    enabled: boolean; // Master toggle for voice mode feature
    voice?: 'marin' | 'cedar'; // OpenAI voice selection
    autoCommitAudio?: boolean; // Auto-commit audio on speech pause (VAD)
    showTranscription?: boolean; // Show live transcription in UI
  };
  // Preferred language for the agent (currently used for AI-generated session
  // names). BCP-47 code or common name, e.g. "ja", "Japanese", "en", "fr".
  // Empty/undefined means no preference -- the agent picks based on the
  // conversation language.
  preferredAgentLanguage?: string;
  // Walkthrough guide system state
  walkthroughs?: WalkthroughState;
  // First-open tracking for editor types (for walkthrough triggers)
  editorFirstOpens?: {
    excalidraw?: boolean;
    mockup?: boolean;
    spreadsheet?: boolean;
    datamodel?: boolean;
  };
  // System spellchecker (enabled by default, applies to all editors and text inputs)
  spellcheckEnabled?: boolean;
  // System tray icon
  showTrayIcon?: boolean;
  // Advanced: V8 heap memory limit in MB (default: 4096 = 4GB)
  // Increase if you experience OOM crashes with large sessions
  maxHeapSizeMB?: number;
  // Alpha feature flags - individual control over alpha features
  // Uses Record<AlphaFeatureTag, boolean> for dynamic feature registration
  alphaFeatures?: Record<AlphaFeatureTag, boolean>;
  // Beta feature flags - user-visible beta features that can be individually toggled
  betaFeatures?: Record<BetaFeatureTag, boolean>;
  // Whether to automatically enable all new beta features
  enableAllBetaFeatures?: boolean;
  // Developer feature flags - features only available in developer mode
  // Each feature can be individually toggled when developer mode is enabled
  developerFeatures?: Record<DeveloperFeatureTag, boolean>;
  // Document history settings
  historyMaxAgeDays?: number; // Max age in days before snapshots are cleaned up (default: 30)
  historyMaxSnapshots?: number; // Max snapshots per file (default: 250)
  // Preferred interactive terminal shell on Windows. 'auto' uses detection priority.
  preferredTerminalShell?: PreferredTerminalShell;
  // Last known app version (for migrations)
  lastKnownVersion?: string;
  // One-shot migration flag: plain fable default bumped to fable-1m (NIM-827)
  fableDefaultMigratedTo1m?: boolean;
  // Extension marketplace install tracking
  marketplaceInstalls?: Record<string, MarketplaceInstallRecord>;
  // Multi-project rail: opt-in flag to host multiple projects in a single
  // window. When false (default), each project still gets its own window.
  multiProjectMode?: boolean;
  // Workspace paths currently warm in the multi-project rail, in display
  // order. Empty when multiProjectMode is off or before the user adds any.
  openProjects?: string[];
  // Path of the project currently visible in the rail. Restored on launch
  // so the user lands on the same project.
  activeProjectPath?: string | null;
  // When true, the rail rehydrates with the projects that were warm at
  // last app close. When false (default), the rail starts empty and is
  // seeded only with the project the user picks from the launch screen
  // — additional projects must be added explicitly.
  restorePreviousProjectsOnLaunch?: boolean;
}

/**
 * Tracks marketplace-installed extensions (not built-in ones).
 * Keyed by extension ID in the store.
 */
export interface MarketplaceInstallRecord {
  extensionId: string;
  version: string;
  installedAt: string;
  updatedAt: string;
  downloadUrl: string;
  checksum: string;
  source: 'marketplace' | 'github-url';
  githubUrl?: string;
  // Populated only when source === 'github-url'. Differentiates the two
  // GitHub install paths and carries enough metadata for a future "check
  // GitHub Releases for newer versions" flow.
  githubReleaseTag?: string;
  githubReleaseAssetName?: string;
  githubInstallMethod?: 'release-asset' | 'clone-source';
}

/**
 * State for the walkthrough guide system.
 * Tracks which walkthroughs have been shown, completed, or dismissed.
 */
export interface WalkthroughState {
  /** Master toggle for all walkthroughs (default: true) */
  enabled: boolean;
  /** Walkthrough IDs that were completed (user finished all steps) */
  completed: string[];
  /** Walkthrough IDs that were dismissed (user skipped) */
  dismissed: string[];
  /** History of walkthrough interactions for analytics/rate limiting */
  history?: Record<string, WalkthroughHistory>;
  /** Per-mode timestamps for cooldown tracking (5 min between walkthroughs per mode) */
  lastShownAtByMode?: {
    files?: number;
    agent?: number;
  };
}

export interface WalkthroughHistory {
  /** Timestamp when walkthrough was first shown */
  shownAt: number;
  /** Timestamp when walkthrough was completed (if applicable) */
  completedAt?: number;
  /** Timestamp when walkthrough was dismissed (if applicable) */
  dismissedAt?: number;
  /** Version of the walkthrough that was shown */
  version?: number;
}

export interface TabState {
  id: string;
  filePath: string;
  fileName: string;
  isDirty: boolean;
  isPinned: boolean;
  isVirtual?: boolean;
  lastSaved?: string;
}

export interface TabManagerState {
  tabs: TabState[];
  activeTabId: string | null;
  tabOrder: string[];
  closedTabs?: TabState[]; // History of recently closed tabs for reopening
}

export interface WorkspaceAIPanelState {
  collapsed: boolean;
  width: number;
  currentSessionId?: string;
  draftInput?: string;
  // Planning mode toggle for AI sidebar (Claude Code safety)
  planningModeEnabled?: boolean;
  // User-set prompt box height (null = auto-size)
  promptBoxHeight?: number | null;
}

export interface NavigationHistoryState {
  history: Array<{ tabId: string; timestamp: number }>;
  currentIndex: number;
}

/**
 * Per-provider override settings for project-level configuration.
 * Values of `undefined` mean "inherit from global settings".
 * Explicit values override the global setting.
 */
export interface ProviderOverride {
  /** Override enabled state: true = force enabled, false = force disabled, undefined = inherit */
  enabled?: boolean;
  /** Override selected models (if provided, replaces global model selection) */
  models?: string[];
  /** Override default model for this provider */
  defaultModel?: string;
  /** Project-specific API key (optional, overrides global key) */
  apiKey?: string;
}

/**
 * Project-level AI provider overrides.
 * Allows projects to customize AI settings without affecting global configuration.
 *
 * Use cases:
 * - Disable a provider for a specific project
 * - Enable a provider only for certain projects
 * - Use different models per project
 * - Use project-specific API keys (e.g., client-provided keys)
 */
export interface AIProviderOverrides {
  /** Override default provider for this project */
  defaultProvider?: string;
  /** Override the path to a custom Claude Code executable for this project.
   * Absent (undefined) means "inherit the global value"; any string set here is
   * used as-is and overrides the global setting. To remove an existing override,
   * delete the field rather than setting it to an empty string. */
  customClaudeCodePath?: string;
  /** Per-provider overrides */
  providers?: Record<string, ProviderOverride>;
}

export interface SessionHistoryLayout {
  width: number;
  collapsed: boolean;
  collapsedGroups: string[];
  sortOrder?: 'updated' | 'created';
}

/**
 * Permission mode for the workspace
 * - null: Workspace not trusted (show trust toast)
 * - 'ask': Smart permissions - prompt for new patterns, remember choices
 * - 'allow-all': Auto-approve file edits, follow Claude Code settings for Bash
 * - 'bypass-all': Auto-approve all tool calls without any prompts (dangerous)
 */
export type AgentPermissionMode = 'ask' | 'allow-all' | 'bypass-all' | null;

/**
 * Agent permissions stored per workspace.
 *
 * Only stores the trust mode - all tool/URL patterns are now managed by
 * Claude Code's native settings files (.claude/settings.json and .claude/settings.local.json).
 * We are just a UI on top of Claude's permission system.
 *
 * Trust is determined by permissionMode:
 * - null: Not trusted (show trust toast)
 * - 'ask', 'allow-all', or 'bypass-all': Trusted
 */
export interface AgentPermissions {
  /** Permission mode: null=untrusted, 'ask'=smart permissions, 'allow-all'=auto-approve edits, 'bypass-all'=auto-approve everything */
  permissionMode: AgentPermissionMode;
  /**
   * Opt-in (issue #628): when true, "Allow All" (bypass-all) routes agent-mode
   * Claude Code sessions through the SDK auto-mode classifier instead of
   * bypassing every operation. Undefined/false = literal allow-all.
   */
  allowAllUsesClassifier?: boolean;
}

export interface AgenticCodingWindowState {
  bounds?: { width: number; height: number; x?: number; y?: number };
  devToolsOpen?: boolean;
  sessionHistoryLayout?: SessionHistoryLayout;
}

// Re-export OnboardingConfig for convenience
export type { OnboardingConfig } from '../../shared/types/workspace';

/**
 * Workspace state stored per workspace path.
 *
 * CRITICAL: Workspace and Agentic Coding windows share the same workspace path but maintain
 * separate tab states to prevent cross-contamination:
 * - `tabs`: Stores tab state for the main workspace window
 * - `agenticTabs`: Stores tab state for the agentic coding window
 *
 * The IPC handlers in WorkspaceHandlers.ts route get/save operations to the correct field
 * based on the window's mode (workspace vs agentic-coding).
 */
/**
 * File scope mode for the Files Edited sidebar in agent mode.
 * - current-changes: Show only files with uncommitted git changes (default)
 * - session-files: Show all files touched in this session/workstream
 * - all-changes: Show all uncommitted files in the repository
 */
export type AgentFileScopeMode = 'current-changes' | 'session-files' | 'all-changes';

export interface WorkspaceState {
  workspacePath: string;
  windowState?: SessionWindow;
  // only when separate agentic coding window is open
  agenticCodingWindowState?: AgenticCodingWindowState;
  // Active content mode (files/agent/plan/tracker/settings)
  activeMode?: string;
  sidebarWidth: number;
  recentDocuments: string[];
  tabs: TabManagerState; // Tab state for workspace window
  agenticTabs?: TabManagerState; // Tab state for agentic coding window (separate storage)
  aiPanel: WorkspaceAIPanelState;
  navigationHistory?: NavigationHistoryState;
  // Onboarding configuration
  onboarding?: OnboardingConfig;
  // File tree filter state
  fileTreeFilter?: WorkspaceFileTreeFilter;
  // File tree icons visibility
  showFileIcons?: boolean;
  // AI provider overrides for this project
  aiProviderOverrides?: AIProviderOverrides;
  // Extension configuration for this project (extensionId -> key -> value)
  extensionConfiguration?: Record<string, Record<string, unknown>>;
  // Agent permissions for this project (allowed/denied patterns, trust status)
  agentPermissions?: AgentPermissions;
  // Worktree session mode preferences (per agentic session)
  agentWorktreeSessionModes?: Record<string, 'agent' | 'files'>;
  // Diff tree view settings (file gutter grouping)
  diffTreeGroupByDirectory?: boolean;
  // FileGutter collapsed state per type ('referenced' | 'edited')
  fileGutterCollapsed?: { referenced?: boolean; edited?: boolean };
  // Workstream state (per-workstream UI state for agent mode)
  workstreamStates?: Record<string, unknown>;
  // Agent mode file scope mode (shared across all sessions in workspace)
  agentFileScopeMode?: AgentFileScopeMode;
  // Collab mode tree state (expanded folders and local placeholder folders)
  collabTree?: {
    expandedFolders: string[];
    customFolders: string[];
    // Folder path most recently used as the destination for "Share to Team".
    // Pre-selected on next share so users don't re-pick the same folder.
    lastSharedFolder?: string;
  };
  collabPendingUpdates?: Record<string, {
    mergedUpdateBase64: string;
    updatedAt: number;
  }>;
  trackerSyncPolicies?: Record<string, TrackerSyncModeSetting | TrackerSyncPolicySetting>;
  // Per-project opt-out for agent tracker tools. When false, McpConfigService
  // omits the `nimbalyst-trackers` MCP server so the agent gets no tracker_*
  // tools in this project. Defaults to enabled (undefined === true).
  trackersEnabled?: boolean;
  // Issue key prefix for tracker items (e.g., "NIM", "APP"). Used for local-only trackers.
  // For synced trackers, the prefix is stored server-side in TrackerRoom metadata.
  issueKeyPrefix?: string;
  // Account identity bound to this workspace (personalOrgId).
  // Set once when the workspace is first synced. Different workspaces can use different accounts.
  // Defaults to the primary account if not set.
  accountId?: string;
  // Hidden gutter buttons (navigation sidebar)
  hiddenGutterButtons?: string[];
  // Tracker automation override for this project (undefined fields inherit from global)
  trackerAutomationOverride?: {
    enabled?: boolean;
    autoCloseOnCommit?: boolean;
  };
  // PR review: gh CLI account login override for this project. When set, it
  // wins over the global AppStoreSchema.prReviewDefaultGhAccount.
  prReviewGhAccountOverride?: string;
  // Privileged extension capability grants scoped to this workspace.
  // Global-scope grants live on AppStoreSchema.extensionPermissionGrantsGlobal.
  // See packages/electron/src/main/extensions/permissionGrantStore.ts for the
  // canonical read/write API.
  extensionPermissionGrants?: PersistedPermissionGrant[];
  lastUpdated: number;
}

/**
 * Persisted shape of a single permission grant row.
 * Mirrors the grant store data model from the plan:
 *   keyed by (extensionId, moduleId, permissionId, scope)
 * Workspace-scope rows live in WorkspaceState; global rows live in AppStoreSchema.
 */
export interface PersistedPermissionGrant {
  extensionId: string;
  moduleId: string;
  permissionId: string;
  scope: 'workspace' | 'global';
  /** Workspace path - present for workspace scope, omitted for global */
  workspacePath?: string;
  grantedAt: number;
  grantedBy: 'user';
  permissionVersion: number;
}

// Lazy-initialized stores to avoid reading userData path at module load time.
// This allows bootstrap.ts to set a custom userData path before stores are created.
// The stores are created on first access via getAppStore() and getWorkspaceStore().
let _appStore: Store<AppStoreSchema> | null = null;
let _workspaceStore: Store<Record<string, WorkspaceState>> | null = null;

function getAppStore(): Store<AppStoreSchema> {
  if (!_appStore) {
    const platform = process.platform;
    try {
      _appStore = new Store<AppStoreSchema>({
        name: 'app-settings',
        clearInvalidConfig: true,
        defaults: {
          theme: 'system',
          recent: {
            workspaces: [],
            documents: [],
          },
          openWorkspaces: [],
          analyticsEnabled: true, // Default to enabled
        },
      });
      console.log('[Store] App store initialized at:', _appStore.path);
    } catch (error) {
      console.error('[Store] Failed to initialize app store:', error);

      // Platform-specific diagnostics
      if (platform === 'linux') {
        console.error('[Store] Linux store init failed. Check:');
        console.error('  - File permissions in config directory');
        console.error('  - XDG_CONFIG_HOME environment variable');
        console.error('  - SELinux/AppArmor policies');
        console.error('  - Disk space available');
      }

      throw new Error(`Failed to initialize app store: ${(error as Error).message}`);
    }
  }
  return _appStore;
}

function getWorkspaceStore(): Store<Record<string, WorkspaceState>> {
  if (!_workspaceStore) {
    _workspaceStore = new Store<Record<string, WorkspaceState>>({
      name: 'workspace-settings',
      clearInvalidConfig: true,
      defaults: {},
    });
    // Log the store path on initialization for debugging
    console.log('[Store] workspaceStore path:', _workspaceStore.path);
  }
  return _workspaceStore;
}

const DEFAULT_TAB_MANAGER_STATE: TabManagerState = {
  tabs: [],
  activeTabId: null,
  tabOrder: [],
  closedTabs: [],
};

const DEFAULT_AI_PANEL_STATE: WorkspaceAIPanelState = {
  collapsed: false,
  width: 350,
  planningModeEnabled: true,
};

function workspaceKey(workspacePath: string): string {
  if (!workspacePath) {
    throw new Error('[store] workspacePath is required');
  }
  // Normalize the path to ensure consistent storage keys:
  // 1. Use path.normalize to handle . and .. segments
  // 2. Remove trailing slashes to ensure consistent keys
  const normalized = path.normalize(workspacePath).replace(/\/+$/, '');
  const base64 = Buffer.from(normalized).toString('base64url');
  return `ws:${base64}`;
}

/**
 * Deep merge utility for workspace state.
 * Recursively merges source into target, replacing primitives and arrays.
 */
function deepMerge<T extends Record<string, any>>(target: T, source: any): T {
  if (!source || typeof source !== 'object') {
    return target;
  }

  for (const key in source) {
    if (Object.prototype.hasOwnProperty.call(source, key)) {
      const sourceValue = source[key];
      const targetValue = (target as any)[key];

      // If both are plain objects (not arrays, not null), merge recursively
      if (
        sourceValue &&
        typeof sourceValue === 'object' &&
        !Array.isArray(sourceValue) &&
        targetValue &&
        typeof targetValue === 'object' &&
        !Array.isArray(targetValue)
      ) {
        deepMerge(targetValue, sourceValue);
      } else if (sourceValue !== undefined) {
        // Replace primitives, arrays, and null values
        (target as any)[key] = sourceValue;
      }
    }
  }

  return target;
}

/**
 * Create default workspace state for a given path.
 */
function createDefaultWorkspaceState(workspacePath: string): WorkspaceState {
  return {
    workspacePath,
    windowState: undefined,
    agenticCodingWindowState: undefined,
    activeMode: undefined,
    sidebarWidth: 240,
    recentDocuments: [],
    tabs: { ...DEFAULT_TAB_MANAGER_STATE },
    agenticTabs: undefined,
    aiPanel: { ...DEFAULT_AI_PANEL_STATE },
    navigationHistory: undefined,
    onboarding: undefined,
    fileTreeFilter: undefined,
    showFileIcons: undefined,
    aiProviderOverrides: undefined,
    extensionConfiguration: undefined,
    agentPermissions: undefined,
    agentWorktreeSessionModes: undefined,
    diffTreeGroupByDirectory: undefined,
    fileGutterCollapsed: undefined,
    workstreamStates: undefined,
    collabTree: {
      expandedFolders: [],
      customFolders: [],
    },
    collabPendingUpdates: {},
    lastUpdated: Date.now(),
  };
}

/**
 * Normalize raw workspace state from storage.
 *
 * Uses deep merge to automatically preserve all fields - no need to manually
 * list every field. New fields added to WorkspaceState will automatically
 * flow through as long as they have a default in createDefaultWorkspaceState.
 *
 * When adding new fields to WorkspaceState:
 * 1. Add the field to the WorkspaceState interface
 * 2. Add a default value in createDefaultWorkspaceState()
 * That's it - no step 3 needed anymore.
 */
function normalizeWorkspaceState(raw: any, wsPath: string): WorkspaceState {
  // Start with defaults
  const state = createDefaultWorkspaceState(wsPath);

  if (!raw) {
    return state;
  }

  // Deep merge raw data - this automatically preserves all fields
  deepMerge(state, raw);

  // Ensure workspacePath is set correctly (in case raw had a different value)
  state.workspacePath = wsPath;

  // Validate/constrain specific fields that need it
  if (Array.isArray(state.recentDocuments)) {
    state.recentDocuments = state.recentDocuments.slice(0, 50);
  }

  // Ensure tabs has required structure
  if (!state.tabs || typeof state.tabs !== 'object') {
    state.tabs = { ...DEFAULT_TAB_MANAGER_STATE };
  } else {
    state.tabs.tabs = Array.isArray(state.tabs.tabs) ? state.tabs.tabs : [];
    state.tabs.tabOrder = Array.isArray(state.tabs.tabOrder) ? state.tabs.tabOrder : [];
    state.tabs.closedTabs = Array.isArray(state.tabs.closedTabs) ? state.tabs.closedTabs : [];
  }

  // Ensure aiPanel has required structure
  if (!state.aiPanel || typeof state.aiPanel !== 'object') {
    state.aiPanel = { ...DEFAULT_AI_PANEL_STATE };
  }

  // Ensure lastUpdated is set
  if (!state.lastUpdated) {
    state.lastUpdated = Date.now();
  }

  return state;
}

/**
 * Deep clone workspace state using structuredClone.
 *
 * This replaces the old manual cloning that required updating 3 places
 * (interface, normalizeWorkspaceState, cloneWorkspaceState) every time
 * a field was added - which caused silent data loss bugs.
 *
 * structuredClone handles all fields automatically.
 */
function cloneWorkspaceState(state: WorkspaceState): WorkspaceState {
  return structuredClone(state);
}

function ensureWorkspaceState(path: string): WorkspaceState {
  const key = workspaceKey(path);
  const raw = getWorkspaceStore().get(key);
  const normalized = normalizeWorkspaceState(raw, path);
  if (!raw) {
    getWorkspaceStore().set(key, cloneWorkspaceState(normalized));
  }
  return normalized;
}

function persistWorkspaceState(path: string, state: WorkspaceState): WorkspaceState {
  const key = workspaceKey(path);
  const next = cloneWorkspaceState({ ...state, lastUpdated: Date.now() });
  getWorkspaceStore().set(key, next);
  return next;
}

function sortRecentItems(items: RecentItem[]): RecentItem[] {
  return [...items].sort((a, b) => (b.timestamp || 0) - (a.timestamp || 0));
}

function getRecentKey(type: 'workspaces' | 'documents'): `recent.workspaces` | `recent.documents` {
  return type === 'workspaces' ? 'recent.workspaces' : 'recent.documents';
}

function getRecentLimit(type: 'workspaces' | 'documents'): number {
  // No limit for workspaces - track all projects user has opened
  // Keep limit for documents to avoid unbounded growth
  return type === 'workspaces' ? Infinity : 50;
}

// Export store instance for backward compatibility.
// This is a getter that returns the lazy-initialized store.
// Callers use it as `store.get()` / `store.set()`.
export const store = {
  get get() { return getAppStore().get.bind(getAppStore()); },
  get set() { return getAppStore().set.bind(getAppStore()); },
  get delete() { return getAppStore().delete.bind(getAppStore()); },
  get path() { return getAppStore().path; },
  get store() { return getAppStore().store; },
};

export function getRecentItems(type: 'workspaces' | 'documents'): RecentItem[] {
  const key = getRecentKey(type);
  const items = getAppStore().get(key, []) as RecentItem[];
  if (!Array.isArray(items)) {
    logger.store.warn(`[store] Recent ${type} payload not array, resetting`, items);
    getAppStore().set(key, []);
    return [];
  }
  return sortRecentItems(items);
}

export function addToRecentItems(type: 'workspaces' | 'documents', path: string, name: string, maxItems: number = getRecentLimit(type)) {
  const key = getRecentKey(type);
  const items = getRecentItems(type);
  const filtered = items.filter(item => item.path !== path);
  filtered.unshift({ path, name, timestamp: Date.now() });
  getAppStore().set(key, filtered.slice(0, maxItems));
}

export function clearRecentItems(type: 'workspaces' | 'documents') {
  const key = getRecentKey(type);
  getAppStore().set(key, []);
}

export function getSessionState(): SessionState | undefined {
  return getAppStore().get('sessionState');
}

export function saveSessionState(state: SessionState): void {
  getAppStore().set('sessionState', { ...state, lastUpdated: state.lastUpdated ?? Date.now() });
}

export function clearSessionState(): void {
  getAppStore().delete('sessionState');
}

export function getTheme(): AppTheme {
  return getAppStore().get('theme');
}

export function setTheme(theme: AppTheme, isDark?: boolean): void {
  getAppStore().set('theme', theme);
  // Store isDark for extension themes so main process knows how to style title bars
  if (isDark !== undefined) {
    getAppStore().set('themeIsDark', isDark);
  }
}

export function getThemeIsDark(): boolean | undefined {
  return getAppStore().get('themeIsDark');
}

export function getPendingThemeFallback(): { missingId: string; appliedId: string } | undefined {
  return getAppStore().get('pendingThemeFallback');
}

export function setPendingThemeFallback(value: { missingId: string; appliedId: string }): void {
  getAppStore().set('pendingThemeFallback', value);
}

export function clearPendingThemeFallback(): void {
  getAppStore().delete('pendingThemeFallback');
}

// getThemeSync resolves 'system'/'auto' to the actual theme for the renderer.
// This prevents flash by ensuring renderer gets 'dark' or 'light', not 'system'.
// Preserves the persisted theme ID for built-in, filesystem, and extension
// themes so callers that own the extension theme registry (the main workspace
// renderer's useTheme.ts) can apply the correct theme.
export function getThemeSync(): AppTheme {
  const { nativeTheme } = require('electron');
  const storedTheme = getAppStore().get('theme');

  // Resolve system/auto to actual theme based on OS preference
  if (storedTheme === 'system' || storedTheme === 'auto') {
    return nativeTheme.shouldUseDarkColors ? 'dark' : 'light';
  }

  return storedTheme;
}

// getResolvedThemeSync collapses any persisted theme (built-in, system,
// filesystem, or extension-contributed) into a renderer-applicable base
// theme: 'dark' | 'light' | 'crystal-dark'. Used by callers that cannot
// consult the in-renderer extension theme registry (the project picker /
// WorkspaceManager window and the flash-prevention script in index.html).
export function getResolvedThemeSync(): AppTheme {
  const { nativeTheme } = require('electron');
  const storedTheme = getAppStore().get('theme');

  if (storedTheme === 'system' || storedTheme === 'auto') {
    return nativeTheme.shouldUseDarkColors ? 'dark' : 'light';
  }

  // Built-in themes the renderer knows how to render directly.
  if (storedTheme === 'dark' || storedTheme === 'light' || storedTheme === 'crystal-dark') {
    return storedTheme;
  }

  // Extension / filesystem theme. Callers that do not load the extension
  // theme registry cannot resolve the theme's isDark themselves; fall back
  // to the flag persisted alongside the theme ID by setTheme().
  const isDark = getAppStore().get('themeIsDark');
  if (typeof isDark === 'boolean') {
    return isDark ? 'dark' : 'light';
  }

  // Last resort for themes persisted before themeIsDark existed: follow OS.
  return nativeTheme.shouldUseDarkColors ? 'dark' : 'light';
}

export const setThemeSync = setTheme;

export function getWorkspaceState(workspacePath: string): WorkspaceState {
  return cloneWorkspaceState(ensureWorkspaceState(workspacePath));
}

export function setWorkspaceState(workspacePath: string, state: WorkspaceState): WorkspaceState {
  return cloneWorkspaceState(persistWorkspaceState(workspacePath, state));
}

export function updateWorkspaceState(
  workspacePath: string,
  updater: (state: WorkspaceState) => void | WorkspaceState
): WorkspaceState {
  const current = ensureWorkspaceState(workspacePath);
  const draft = cloneWorkspaceState(current);
  const result = updater(draft) || draft;
  return cloneWorkspaceState(persistWorkspaceState(workspacePath, result));
}

export function getWorkspaceRecentFiles(workspacePath: string): string[] {
  return getWorkspaceState(workspacePath).recentDocuments;
}

export function addWorkspaceRecentFile(workspacePath: string, filePath: string): void {
  updateWorkspaceState(workspacePath, state => {
    state.recentDocuments = [filePath, ...state.recentDocuments.filter(path => path !== filePath)].slice(0, 50);
  });
}

export function getWorkspaceTabState(workspacePath: string): TabManagerState & { navigationHistory?: any } {
  const workspace = getWorkspaceState(workspacePath);
  const tabs = workspace.tabs;

  // Filter out tabs for files that no longer exist (unless they're virtual)
  const validTabs = tabs.tabs.filter(tab => {
    if (tab.isVirtual || tab.filePath.startsWith('virtual://')) {
      return true; // Keep virtual tabs
    }
    const exists = existsSync(tab.filePath);
    if (!exists) {
      console.log('[getWorkspaceTabState] Filtering out non-existent file:', tab.filePath);
    }
    return exists;
  });

  // Get valid tab IDs for filtering
  const validTabIds = new Set(validTabs.map(tab => tab.id));

  // Filter tab order to only include valid tabs
  const validTabOrder = tabs.tabOrder.filter(id => validTabIds.has(id));

  // Clear active tab if it was removed
  const validActiveTabId = tabs.activeTabId && validTabIds.has(tabs.activeTabId)
    ? tabs.activeTabId
    : null;

  return {
    tabs: validTabs.map(tab => ({ ...tab })),
    activeTabId: validActiveTabId,
    tabOrder: validTabOrder,
    navigationHistory: workspace.navigationHistory
  };
}

export function saveWorkspaceTabState(workspacePath: string, state: TabManagerState & { navigationHistory?: any }): void {
  updateWorkspaceState(workspacePath, workspace => {
    workspace.tabs = {
      tabs: state.tabs.map(tab => ({ ...tab })),
      activeTabId: state.activeTabId,
      tabOrder: [...state.tabOrder],
    };
    // Save navigation history if provided
    if ('navigationHistory' in state) {
      workspace.navigationHistory = state.navigationHistory;
    }
  });
}

export function clearWorkspaceTabState(workspacePath: string): void {
  updateWorkspaceState(workspacePath, workspace => {
    workspace.tabs = { ...DEFAULT_TAB_MANAGER_STATE };
    // Also clear navigation history when clearing tabs
    delete workspace.navigationHistory;
  });
}

export function getWorkspaceNavigationHistory(workspacePath: string): NavigationHistoryState | undefined {
  return getWorkspaceState(workspacePath).navigationHistory;
}

export function saveWorkspaceNavigationHistory(workspacePath: string, navigationHistory: NavigationHistoryState): void {
  updateWorkspaceState(workspacePath, workspace => {
    workspace.navigationHistory = navigationHistory;
  });
}

export function getWorkspaceWindowState(workspacePath: string): SessionWindow | undefined {
  return getWorkspaceState(workspacePath).windowState;
}

export function saveWorkspaceWindowState(workspacePath: string, windowState: SessionWindow): void {
  updateWorkspaceState(workspacePath, workspace => {
    workspace.windowState = { ...windowState };
  });
}

export function clearWorkspaceWindowState(workspacePath: string): void {
  updateWorkspaceState(workspacePath, workspace => {
    delete workspace.windowState;
  });
}

// Agentic Coding Window State Management
export function getAgenticCodingWindowState(workspacePath: string): AgenticCodingWindowState | undefined {
  return getWorkspaceState(workspacePath).agenticCodingWindowState;
}

export function saveAgenticCodingWindowState(workspacePath: string, state: AgenticCodingWindowState): void {
  updateWorkspaceState(workspacePath, workspace => {
    workspace.agenticCodingWindowState = { ...state };
  });
}

export function clearAgenticCodingWindowState(workspacePath: string): void {
  updateWorkspaceState(workspacePath, workspace => {
    delete workspace.agenticCodingWindowState;
  });
}

export function getAIChatState(workspacePath: string): WorkspaceAIPanelState {
  const { aiPanel } = getWorkspaceState(workspacePath);
  return { ...aiPanel };
}

/**
 * Get tab state for the agentic coding window.
 *
 * IMPORTANT: This retrieves the `agenticTabs` field, NOT the regular `tabs` field.
 * This separation ensures that:
 * 1. Agentic window tabs (AI chat sessions) don't mix with workspace tabs (files)
 * 2. Opening/closing the agentic window doesn't affect workspace tab state
 * 3. Each window maintains its own independent tab history
 *
 * Called by WorkspaceHandlers.ts when window mode is 'agentic-coding'.
 */
export function getAgenticTabState(workspacePath: string): TabManagerState {
  const workspace = getWorkspaceState(workspacePath);
  return workspace.agenticTabs ?? { ...DEFAULT_TAB_MANAGER_STATE };
}

/**
 * Save tab state for the agentic coding window.
 *
 * IMPORTANT: This saves to the `agenticTabs` field, NOT the regular `tabs` field.
 * This prevents the agentic window from overwriting workspace tab state.
 *
 * Called by WorkspaceHandlers.ts when window mode is 'agentic-coding'.
 */
export function saveAgenticTabState(workspacePath: string, state: TabManagerState): void {
  updateWorkspaceState(workspacePath, workspace => {
    workspace.agenticTabs = {
      tabs: state.tabs.map(tab => ({ ...tab })),
      activeTabId: state.activeTabId,
      tabOrder: [...state.tabOrder],
    };
  });
}

// File Tree Filter State Management
export function getFileTreeFilter(workspacePath: string): WorkspaceFileTreeFilter {
  return getWorkspaceState(workspacePath).fileTreeFilter ?? 'all';
}

export function saveFileTreeFilter(workspacePath: string, filter: WorkspaceFileTreeFilter): void {
  updateWorkspaceState(workspacePath, workspace => {
    workspace.fileTreeFilter = filter;
  });
}

// Diff Tree View State Management
export function getDiffTreeGroupByDirectory(workspacePath: string): boolean {
  return getWorkspaceState(workspacePath).diffTreeGroupByDirectory ?? false;
}

export function saveDiffTreeGroupByDirectory(workspacePath: string, groupByDirectory: boolean): void {
  updateWorkspaceState(workspacePath, workspace => {
    workspace.diffTreeGroupByDirectory = groupByDirectory;
  });
}

// Agent File Scope Mode Management
export function getAgentFileScopeMode(workspacePath: string): AgentFileScopeMode {
  // Default to 'current-changes' (Uncommitted Session Edits)
  return getWorkspaceState(workspacePath).agentFileScopeMode ?? 'current-changes';
}

export function saveAgentFileScopeMode(workspacePath: string, mode: AgentFileScopeMode): void {
  updateWorkspaceState(workspacePath, workspace => {
    workspace.agentFileScopeMode = mode;
  });
}

// AI Provider Override State Management
export function getAIProviderOverrides(workspacePath: string): AIProviderOverrides | undefined {
  const overrides = getWorkspaceState(workspacePath).aiProviderOverrides;
  return normalizeAIProviderOverrides(overrides);
}

/**
 * Lazily-opened `ai-settings` electron-store (where provider API keys live —
 * `apiKeys`). Separate from the `app-settings` store exported as `store`.
 */
let _aiSettingsStore: Store<Record<string, unknown>> | null = null;
function getAiSettingsStore(): Store<Record<string, unknown>> {
  if (!_aiSettingsStore) {
    _aiSettingsStore = new Store<Record<string, unknown>>({ name: 'ai-settings' });
  }
  return _aiSettingsStore;
}

/**
 * Resolve a provider API key from EXPLICIT settings only — a per-workspace
 * project override if present, else the global `ai-settings` `apiKeys[providerId]`.
 * NEVER reads `process.env` (CLAUDE.md no-implicit-env-key rule). Returns null
 * when not configured. Mirrors `AIService.getApiKeyForProvider` so the
 * backend-module `getApiKey` broker hands an extension engine the same key the
 * AI providers use (the key lives in `ai-settings`, NOT `app-settings`).
 */
export function getProviderApiKeyFromSettings(
  providerId: string,
  workspacePath?: string
): string | null {
  if (workspacePath) {
    const overrideKey = getAIProviderOverrides(workspacePath)?.providers?.[providerId]?.apiKey;
    if (typeof overrideKey === 'string' && overrideKey.length > 0) {
      return overrideKey;
    }
  }
  const apiKeys = getAiSettingsStore().get('apiKeys') as Record<string, string> | undefined;
  const key = apiKeys?.[providerId];
  return typeof key === 'string' && key.length > 0 ? key : null;
}

export function saveAIProviderOverrides(workspacePath: string, overrides: AIProviderOverrides | undefined): void {
  const normalizedOverrides = normalizeAIProviderOverrides(overrides);
  updateWorkspaceState(workspacePath, workspace => {
    workspace.aiProviderOverrides = normalizedOverrides;
  });
}

export function clearAIProviderOverrides(workspacePath: string): void {
  updateWorkspaceState(workspacePath, workspace => {
    delete workspace.aiProviderOverrides;
  });
}

// Tracker Automation Override State Management
export type TrackerAutomationSettings = {
  enabled: boolean;
  autoCloseOnCommit: boolean;
};

export type TrackerAutomationOverride = Partial<TrackerAutomationSettings>;

export function getTrackerAutomationOverride(workspacePath: string): TrackerAutomationOverride | undefined {
  return getWorkspaceState(workspacePath).trackerAutomationOverride;
}

export function saveTrackerAutomationOverride(workspacePath: string, override: TrackerAutomationOverride | undefined): void {
  updateWorkspaceState(workspacePath, workspace => {
    workspace.trackerAutomationOverride = override;
  });
}

/** Merge global tracker automation settings with project-level overrides */
export function getEffectiveTrackerAutomation(
  globalSettings: TrackerAutomationSettings,
  workspacePath?: string,
): TrackerAutomationSettings {
  if (!workspacePath) return globalSettings;
  const override = getTrackerAutomationOverride(workspacePath);
  if (!override) return globalSettings;
  return {
    enabled: override.enabled ?? globalSettings.enabled,
    autoCloseOnCommit: override.autoCloseOnCommit ?? globalSettings.autoCloseOnCommit,
  };
}

// PR review gh-account selection. Global default in app-settings,
// per-project override in workspace state; resolver returns override ?? default.
export function getPrReviewDefaultGhAccount(): string | undefined {
  return getAppStore().get('prReviewDefaultGhAccount');
}

export function setPrReviewDefaultGhAccount(login: string | undefined): void {
  const store = getAppStore();
  if (login) {
    store.set('prReviewDefaultGhAccount', login);
  } else {
    store.delete('prReviewDefaultGhAccount');
  }
}

export function getPrReviewGhAccountOverride(workspacePath: string): string | undefined {
  return getWorkspaceState(workspacePath).prReviewGhAccountOverride;
}

export function savePrReviewGhAccountOverride(workspacePath: string, login: string | undefined): void {
  updateWorkspaceState(workspacePath, workspace => {
    workspace.prReviewGhAccountOverride = login;
  });
}

/** Resolve the effective gh account for a workspace: override ?? global default. */
export function getEffectiveGhAccount(workspacePath?: string): string | undefined {
  if (workspacePath) {
    const override = getPrReviewGhAccountOverride(workspacePath);
    if (override) return override;
  }
  return getPrReviewDefaultGhAccount();
}

export function normalizeAIProviderOverrides(overrides: AIProviderOverrides | undefined): AIProviderOverrides | undefined {
  if (!overrides || typeof overrides !== 'object') {
    return overrides;
  }

  const providers = overrides.providers;
  if (!providers || typeof providers !== 'object') {
    return overrides;
  }

  const normalizedProviders = normalizeCodexProviderConfig(providers);
  const codexConfig = normalizedProviders['openai-codex'];

  // Drop an empty codex config entry (artifact of UI clearing the override).
  if (codexConfig && Object.keys(codexConfig).length === 0) {
    const { 'openai-codex': _removed, ...restProviders } = normalizedProviders;
    if (Object.keys(restProviders).length === 0) {
      const { providers: _unusedProviders, ...restOverrides } = overrides;
      // Spreading the input keeps own-but-undefined keys (e.g. an explicit
      // `customClaudeCodePath: undefined` from a "clear override" save), which
      // would prevent the empty-overrides check below from collapsing the
      // object back to `undefined`.
      if (restOverrides.customClaudeCodePath === undefined) {
        delete restOverrides.customClaudeCodePath;
      }
      return Object.keys(restOverrides).length > 0 ? restOverrides : undefined;
    }
    return { ...overrides, providers: restProviders };
  }

  return {
    ...overrides,
    providers: normalizedProviders,
  };
}

// Community popup shown state for current process launch (non-persisted)
let communityPopupShownThisLaunch = false;

export function markCommunityPopupShown(): void {
  communityPopupShownThisLaunch = true;
}

export function wasCommunityPopupShownThisLaunch(): boolean {
  return communityPopupShownThisLaunch;
}

// Discord / community popup management
export function incrementLaunchCount(): number {
  const current = getAppStore().get('launchCount', 0);
  const next = current + 1;
  getAppStore().set('launchCount', next);
  return next;
}

export function getLaunchCount(): number {
  return getAppStore().get('launchCount', 0);
}

export function isClaudeCodeWindowsWarningDismissed(): boolean {
  return getAppStore().get('claudeCodeWindowsWarningDismissed', false);
}

export function dismissClaudeCodeWindowsWarning(): void {
  getAppStore().set('claudeCodeWindowsWarningDismissed', true);
}

export function shouldShowClaudeCodeWindowsWarning(): boolean {
  const isWindows = process.platform === 'win32';
  const dismissed = isClaudeCodeWindowsWarningDismissed();
  return isWindows && !dismissed;
}

export function isRosettaWarningDismissed(): boolean {
  return getAppStore().get('rosettaWarningDismissed', false);
}

export function dismissRosettaWarning(): void {
  getAppStore().set('rosettaWarningDismissed', true);
}

export function shouldShowRosettaWarning(): boolean {
  if (process.platform !== 'darwin') return false;
  if (isRosettaWarningDismissed()) return false;
  try {
    const result = execSync('sysctl -n sysctl.proc_translated', {
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'ignore'],
    }).trim();
    return result === '1';
  } catch {
    return false;
  }
}

export function isDiscordInvitationDismissed(): boolean {
  return getAppStore().get('discordInvitationDismissed', false);
}

export function isCommunityPopupDismissed(): boolean {
  return getAppStore().get('communityPopupDismissed', false);
}

export function dismissCommunityPopup(): void {
  getAppStore().set('communityPopupDismissed', true);
}

export function dismissDiscordInvitation(): void {
  getAppStore().set('discordInvitationDismissed', true);
  dismissCommunityPopup();
}

export function getCompletedSessionCount(): number {
  return getAppStore().get('completedSessionCount', 0);
}

export function incrementCompletedSessionCount(): number {
  const current = getCompletedSessionCount();
  const next = current + 1;
  getAppStore().set('completedSessionCount', next);
  return next;
}

export function getCompletedSessionsWithTools(): number {
  return getAppStore().get('completedSessionsWithTools', 0);
}

export function incrementCompletedSessionsWithTools(): number {
  const current = getCompletedSessionsWithTools();
  const next = current + 1;
  getAppStore().set('completedSessionsWithTools', next);
  return next;
}

export function shouldShowCommunityPopup(): boolean {
  if (process.env.PLAYWRIGHT === '1') return false;
  const dismissed = isCommunityPopupDismissed();
  if (dismissed) return false;
  const completedSessionsWithTools = getCompletedSessionsWithTools();
  if (completedSessionsWithTools >= 3) return true;
  const launchCount = getLaunchCount();
  if (launchCount >= 5) return true;
  return false;
}

/** @deprecated Use shouldShowCommunityPopup instead */
export function shouldShowDiscordInvitation(): boolean {
  return shouldShowCommunityPopup();
}

// System Tray Settings
export function isShowTrayIcon(): boolean {
  return getAppStore().get('showTrayIcon', true);
}

export function setShowTrayIcon(show: boolean): void {
  getAppStore().set('showTrayIcon', show);
}

// Completion Sound Settings
export function isCompletionSoundEnabled(): boolean {
  return getAppStore().get('completionSoundEnabled', true);
}

export function setCompletionSoundEnabled(enabled: boolean): void {
  getAppStore().set('completionSoundEnabled', enabled);
}

export function getCompletionSoundType(): CompletionSoundType {
  return getAppStore().get('completionSoundType', 'chime');
}

export function setCompletionSoundType(soundType: CompletionSoundType): void {
  getAppStore().set('completionSoundType', soundType);
}

export function getCompletionSoundCustomPath(): string | undefined {
  return getAppStore().get('completionSoundCustomPath');
}

export function setCompletionSoundCustomPath(soundPath: string | undefined): void {
  if (soundPath) {
    getAppStore().set('completionSoundCustomPath', soundPath);
  } else {
    getAppStore().delete('completionSoundCustomPath');
  }
}

/**
 * Completion sound volume as a percentage of system volume (0-100).
 * Defaults to 100 (full volume) so existing users hear no change.
 */
export function getCompletionSoundVolume(): number {
  return clampVolumePercent(getAppStore().get('completionSoundVolume', 100));
}

export function setCompletionSoundVolume(volumePercent: number): void {
  getAppStore().set('completionSoundVolume', clampVolumePercent(volumePercent));
}

/** Clamp an arbitrary input to a valid 0-100 integer percentage. */
function clampVolumePercent(value: unknown): number {
  const n = typeof value === 'number' && Number.isFinite(value) ? value : 100;
  return Math.min(100, Math.max(0, Math.round(n)));
}

// OS Notifications Settings
export function isOSNotificationsEnabled(): boolean {
  return getAppStore().get('osNotificationsEnabled', true);
}

export function setOSNotificationsEnabled(enabled: boolean): void {
  getAppStore().set('osNotificationsEnabled', enabled);
}

export function isNotifyWhenFocusedEnabled(): boolean {
  return getAppStore().get('notifyWhenFocused', false);
}

export function setNotifyWhenFocusedEnabled(enabled: boolean): void {
  getAppStore().set('notifyWhenFocused', enabled);
}

// Session Blocked Notifications - notify when session needs user input
export function isSessionBlockedNotificationsEnabled(): boolean {
  return getAppStore().get('sessionBlockedNotificationsEnabled', true);
}

export function setSessionBlockedNotificationsEnabled(enabled: boolean): void {
  getAppStore().set('sessionBlockedNotificationsEnabled', enabled);
}

// Release Channel Settings
export function getReleaseChannel(): ReleaseChannel {
  // Allow env override for testing (set via NIMBALYST_RELEASE_CHANNEL=alpha)
  const envChannel = process.env.NIMBALYST_RELEASE_CHANNEL;
  if (envChannel === 'alpha' || envChannel === 'stable') {
    return envChannel;
  }
  return getAppStore().get('releaseChannel', 'stable');
}

export function setReleaseChannel(channel: ReleaseChannel): void {
  getAppStore().set('releaseChannel', channel);
}

// User Onboarding
export interface OnboardingState {
  userRole?: string;
  userEmail?: string;
  referralSource?: string;
  onboardingNextPrompt?: number;
  onboardingCompleted?: boolean;
  unifiedOnboardingCompleted?: boolean;
}

export function getOnboardingState(): OnboardingState {
  return {
    userRole: getAppStore().get('userRole'),
    userEmail: getAppStore().get('userEmail'),
    referralSource: getAppStore().get('referralSource'),
    onboardingNextPrompt: getAppStore().get('onboardingNextPrompt'),
    onboardingCompleted: getAppStore().get('onboardingCompleted'),
    unifiedOnboardingCompleted: getAppStore().get('unifiedOnboardingCompleted')
  };
}

export function updateOnboardingState(state: Partial<OnboardingState>): void {
  if (state.userRole !== undefined) {
    getAppStore().set('userRole', state.userRole);
  }
  if (state.userEmail !== undefined) {
    getAppStore().set('userEmail', state.userEmail);
  }
  if (state.referralSource !== undefined) {
    getAppStore().set('referralSource', state.referralSource);
  }
  if (state.onboardingNextPrompt !== undefined) {
    getAppStore().set('onboardingNextPrompt', state.onboardingNextPrompt);
  }
  if (state.onboardingCompleted !== undefined) {
    getAppStore().set('onboardingCompleted', state.onboardingCompleted);
  }
  if (state.unifiedOnboardingCompleted !== undefined) {
    getAppStore().set('unifiedOnboardingCompleted', state.unifiedOnboardingCompleted);
  }
}

// Developer Mode Settings
export function isDeveloperMode(): boolean {
  return getAppStore().get('developerMode', false);
}

export function setDeveloperMode(enabled: boolean): void {
  getAppStore().set('developerMode', enabled);
}

// Default AI Model Settings
export function getDefaultAIModel(): string | undefined {
  return getAppStore().get('defaultAIModel');
}

export function setDefaultAIModel(model: string): void {
  getAppStore().set('defaultAIModel', model);
}

// Default Effort Level Settings (Opus 4.6 adaptive reasoning)
export function getDefaultEffortLevel(): EffortLevel | undefined {
  const stored = getAppStore().get('defaultEffortLevel');
  if (!stored) return undefined;
  return parseEffortLevel(stored);
}

export function setDefaultEffortLevel(level: EffortLevel): void {
  getAppStore().set('defaultEffortLevel', level);
}

// Analytics Settings
export function isAnalyticsEnabled(): boolean {
  try {
    const enabled = getAppStore().get('analyticsEnabled', true); // Default to enabled
    return enabled;
  } catch (error) {
    console.error('[Store] Failed to read analyticsEnabled from store:', error);
    // Fail open - default to enabled if we can't read the store
    // This ensures analytics works even if store is temporarily unavailable
    return true;
  }
}

export function setAnalyticsEnabled(enabled: boolean): void {
  getAppStore().set('analyticsEnabled', enabled);
}

// MockupLM Settings
export function isMockupLMEnabled(): boolean {
  return getAppStore().get('mockupLMEnabled', true); // Default to enabled
}

export function setMockupLMEnabled(enabled: boolean): void {
  getAppStore().set('mockupLMEnabled', enabled);
}

// First Launch Claude Code Installation Check
// This flag ensures we only check once ever, on the very first app launch
export function hasCheckedClaudeCodeInstallation(): boolean {
  return getAppStore().get('claudeCodeInstallationChecked', false);
}

export function markClaudeCodeInstallationChecked(): void {
  getAppStore().set('claudeCodeInstallationChecked', true);
}

// Session Sync Settings
// Authentication is handled by StytchAuthService (JWT), encryption key by CredentialService
export interface SessionSyncConfig {
  enabled: boolean;
  serverUrl: string;
  enabledProjects?: string[];
  docSyncEnabledProjects?: string[]; // workspace paths enabled for document sync (alpha only)
  // Dev-only: override environment (defaults to 'production' even in dev builds)
  environment?: 'development' | 'production';
  // Minutes before user is considered idle (for mobile push suppression). Default: 5
  idleTimeoutMinutes?: number;
  // Persisted sync identity -- which personal org/user to use for sync room IDs.
  // Set when sync is enabled or pairing happens. Survives logout/re-login so that
  // login order doesn't affect which index room sessions sync to.
  personalOrgId?: string;
  personalUserId?: string;
  // DEPRECATED: migrated to preventSleepMode
  preventSleepWhenSyncing?: boolean;
  // Prevent system sleep while sync is active (uses Electron powerSaveBlocker).
  // 'off' = no sleep prevention, 'always' = always prevent, 'pluggedIn' = only when on AC power.
  preventSleepMode?: 'off' | 'always' | 'pluggedIn';
}

// Stytch Auth Configuration (stored separately from session sync)
export interface StytchAuthConfig {
  projectId: string;
  publicToken: string;
  // Secret key is stored in secure storage, not in this config
}

export function getSessionSyncConfig(): SessionSyncConfig | undefined {
  return getAppStore().get('sessionSync');
}

export function setSessionSyncConfig(config: SessionSyncConfig | undefined): void {
  if (config) {
    getAppStore().set('sessionSync', config);
  } else {
    getAppStore().delete('sessionSync');
  }
}

// Stytch Auth Configuration
export function getStytchAuthConfig(): StytchAuthConfig | undefined {
  return getAppStore().get('stytchAuth');
}

export function setStytchAuthConfig(config: StytchAuthConfig | undefined): void {
  if (config) {
    getAppStore().set('stytchAuth', config);
  } else {
    getAppStore().delete('stytchAuth');
  }
}

// Feature Walkthrough Settings
export function isFeatureWalkthroughCompleted(): boolean {
  return getAppStore().get('featureWalkthroughCompleted', false);
}

export function setFeatureWalkthroughCompleted(completed: boolean): void {
  getAppStore().set('featureWalkthroughCompleted', completed);
}

// Worktree Onboarding Settings
export function isWorktreeOnboardingShown(): boolean {
  return getAppStore().get('worktreeOnboardingShown', false);
}

export function setWorktreeOnboardingShown(shown: boolean): void {
  getAppStore().set('worktreeOnboardingShown', shown);
}

// Extension Project Intro Settings
export function isExtensionProjectIntroShown(): boolean {
  return getAppStore().get('extensionProjectIntroShown', false);
}

export function setExtensionProjectIntroShown(shown: boolean): void {
  getAppStore().set('extensionProjectIntroShown', shown);
}

// Extension Settings Management
export function getExtensionSettings(): Record<string, ExtensionSettings> {
  return getAppStore().get('extensionSettings', {});
}

export function setExtensionSettings(settings: Record<string, ExtensionSettings>): void {
  getAppStore().set('extensionSettings', settings);
}

/**
 * Get whether an extension is enabled.
 *
 * @param extensionId - The extension ID to check
 * @param defaultEnabled - The manifest's defaultEnabled value (undefined means true).
 *                         Only used if the user hasn't explicitly set a preference.
 * @returns Whether the extension should be enabled
 */
export function getExtensionEnabled(extensionId: string, defaultEnabled?: boolean): boolean {
  const settings = getExtensionSettings();
  // If user has explicitly set a preference, use it
  if (settings[extensionId]?.enabled !== undefined) {
    return settings[extensionId].enabled;
  }
  // Otherwise use manifest default (true if not specified)
  return defaultEnabled !== false;
}

export function setExtensionEnabled(extensionId: string, enabled: boolean): void {
  const settings = getExtensionSettings();
  if (!settings[extensionId]) {
    settings[extensionId] = { enabled };
  } else {
    settings[extensionId].enabled = enabled;
  }
  setExtensionSettings(settings);
}

export function getClaudePluginEnabled(extensionId: string): boolean | undefined {
  const settings = getExtensionSettings();
  // Returns undefined if not explicitly set (to allow manifest default)
  return settings[extensionId]?.claudePluginEnabled;
}

export function setClaudePluginEnabled(extensionId: string, enabled: boolean): void {
  const settings = getExtensionSettings();
  if (!settings[extensionId]) {
    settings[extensionId] = { enabled: true, claudePluginEnabled: enabled };
  } else {
    settings[extensionId].claudePluginEnabled = enabled;
  }
  setExtensionSettings(settings);
}

export function getAgentWorkflowsEnabled(extensionId: string): boolean | undefined {
  const settings = getExtensionSettings();
  return settings[extensionId]?.agentWorkflowsEnabled;
}

export function setAgentWorkflowsEnabled(extensionId: string, enabled: boolean): void {
  const settings = getExtensionSettings();
  if (!settings[extensionId]) {
    settings[extensionId] = { enabled: true, agentWorkflowsEnabled: enabled };
  } else {
    settings[extensionId].agentWorkflowsEnabled = enabled;
  }
  setExtensionSettings(settings);
}

// Privileged extension capability grants (global scope only).
// Workspace-scope grants live on WorkspaceState.extensionPermissionGrants.
// See packages/electron/src/main/extensions/permissionGrantStore.ts for the
// canonical read/write API; consumers should not touch electron-store here
// directly.

export function getExtensionPermissionGrantsGlobal(): PersistedPermissionGrant[] {
  return getAppStore().get('extensionPermissionGrantsGlobal', []);
}

export function setExtensionPermissionGrantsGlobal(
  rows: PersistedPermissionGrant[]
): void {
  getAppStore().set('extensionPermissionGrantsGlobal', rows);
}

// Claude Code settings
export function getClaudeCodeSettings(): {
  projectCommandsEnabled: boolean;
  userCommandsEnabled: boolean;
  apiUpstreamUrl?: string;
} {
  const settings = getAppStore().get('claudeCode', {});
  return {
    projectCommandsEnabled: settings.projectCommandsEnabled ?? true,
    userCommandsEnabled: settings.userCommandsEnabled ?? true,
    apiUpstreamUrl: settings.apiUpstreamUrl,
  };
}

/**
 * Whether a custom Claude API upstream URL is well-formed AND loopback-bound.
 * The Claude CLI's requests carry the user's subscription OAuth token + full
 * prompt content; routing them to a non-loopback host would hand that to a
 * remote third party, so we hard-restrict to loopback (127.0.0.0/8, localhost,
 * ::1). Returns false for anything else (incl. unparseable input).
 */
export function isValidClaudeCodeApiUpstreamUrl(url: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return false;
  const host = parsed.hostname.replace(/^\[|\]$/g, ''); // strip IPv6 brackets
  return host === 'localhost' || host === '::1' || /^127(?:\.\d{1,3}){3}$/.test(host);
}

/**
 * The configured custom upstream for the Claude CLI observation proxy, or
 * undefined when unset/blank/invalid (→ proxy talks directly to Anthropic). We
 * re-validate on read so a value that somehow bypassed the setter (hand-edited
 * store, downgraded build) can never silently route OAuth traffic off-box.
 */
export function getClaudeCodeApiUpstreamUrl(): string | undefined {
  const raw = getAppStore().get('claudeCode', {}).apiUpstreamUrl?.trim();
  if (!raw) return undefined;
  if (!isValidClaudeCodeApiUpstreamUrl(raw)) {
    logger.main.warn(`[store] Ignoring non-loopback claudeCode.apiUpstreamUrl: ${raw}`);
    return undefined;
  }
  return raw;
}

/**
 * Persist (or clear, with empty string) the custom Claude API upstream URL.
 * Throws on a non-empty value that isn't a valid loopback http(s) URL so the
 * caller (settings IPC) surfaces the error instead of saving a footgun.
 */
export function setClaudeCodeApiUpstreamUrl(url: string): void {
  const trimmed = url.trim();
  const current = getAppStore().get('claudeCode', {});
  if (!trimmed) {
    getAppStore().set('claudeCode', { ...current, apiUpstreamUrl: undefined });
    return;
  }
  if (!isValidClaudeCodeApiUpstreamUrl(trimmed)) {
    throw new Error(
      'Claude API upstream URL must be a loopback http(s) URL (e.g. http://127.0.0.1:8787/anthropic).',
    );
  }
  getAppStore().set('claudeCode', { ...current, apiUpstreamUrl: trimmed });
}

export function setClaudeCodeProjectCommandsEnabled(enabled: boolean): void {
  const current = getAppStore().get('claudeCode', {});
  getAppStore().set('claudeCode', { ...current, projectCommandsEnabled: enabled });
  const workflowSources = getAppStore().get('agentWorkflowSources', {});
  getAppStore().set('agentWorkflowSources', {
    ...workflowSources,
    workspaceClaudeCompatibilityEnabled: true,
    includeProjectClaudeSources: enabled,
  });
}

export function setClaudeCodeUserCommandsEnabled(enabled: boolean): void {
  const current = getAppStore().get('claudeCode', {});
  getAppStore().set('claudeCode', { ...current, userCommandsEnabled: enabled });
  const workflowSources = getAppStore().get('agentWorkflowSources', {});
  getAppStore().set('agentWorkflowSources', {
    ...workflowSources,
    workspaceClaudeCompatibilityEnabled: true,
    includeUserClaudeSources: enabled,
  });
}

export interface AgentWorkflowSourceSettings {
  workspaceClaudeCompatibilityEnabled: boolean;
  includeProjectClaudeSources: boolean;
  includeUserClaudeSources: boolean;
  extensionWorkflowsEnabled: boolean;
}

export interface AgentWorkflowExportSettings {
  codexEnabled: boolean;
  claudeGeneratedExtensionWorkflowsEnabled: boolean;
}

export function getAgentWorkflowSourceSettings(): AgentWorkflowSourceSettings {
  const configured = getAppStore().get('agentWorkflowSources', {});
  const claudeSettings = getAppStore().get('claudeCode', {});
  return {
    workspaceClaudeCompatibilityEnabled: configured.workspaceClaudeCompatibilityEnabled ?? false,
    includeProjectClaudeSources: configured.includeProjectClaudeSources ?? claudeSettings.projectCommandsEnabled ?? false,
    includeUserClaudeSources: configured.includeUserClaudeSources ?? claudeSettings.userCommandsEnabled ?? false,
    extensionWorkflowsEnabled: configured.extensionWorkflowsEnabled ?? false,
  };
}

export function getAgentWorkflowExportSettings(): AgentWorkflowExportSettings {
  const configured = getAppStore().get('agentWorkflowExports', {});
  return {
    codexEnabled: configured.codexEnabled ?? false,
    claudeGeneratedExtensionWorkflowsEnabled: configured.claudeGeneratedExtensionWorkflowsEnabled ?? false,
  };
}

export function setAgentWorkflowSourceSettings(
  updates: Partial<AgentWorkflowSourceSettings>
): AgentWorkflowSourceSettings {
  const current = getAppStore().get('agentWorkflowSources', {});
  const next = { ...current, ...updates };
  getAppStore().set('agentWorkflowSources', next);
  return getAgentWorkflowSourceSettings();
}

export function setAgentWorkflowExportSettings(
  updates: Partial<AgentWorkflowExportSettings>
): AgentWorkflowExportSettings {
  const current = getAppStore().get('agentWorkflowExports', {});
  const next = { ...current, ...updates };
  getAppStore().set('agentWorkflowExports', next);
  return getAgentWorkflowExportSettings();
}

// Extension Development Kit (EDK) Settings
export function isExtensionDevToolsEnabled(): boolean {
  return getAppStore().get('extensionDevToolsEnabled', false); // Default to disabled
}

export function setExtensionDevToolsEnabled(enabled: boolean): void {
  getAppStore().set('extensionDevToolsEnabled', enabled);
}

// Settings Control MCP kill-switch. The MCP is on by default; flipping this
// to true makes McpConfigService omit `nimbalyst-settings` from the agent's
// MCP config.
export function isSettingsAgentToolsDisabled(): boolean {
  return getAppStore().get('settingsAgentToolsDisabled', false);
}

export function setSettingsAgentToolsDisabled(disabled: boolean): void {
  getAppStore().set('settingsAgentToolsDisabled', disabled);
}

// Per-project agent tracker-tools opt-out. The `nimbalyst-trackers` MCP server
// is on by default; flipping this off makes McpConfigService omit it for this
// workspace so the agent gets no tracker_* tools. Default true (undefined).
export function isTrackersAgentToolsEnabled(workspacePath: string): boolean {
  return getWorkspaceState(workspacePath).trackersEnabled ?? true;
}

export function setTrackersAgentToolsEnabled(workspacePath: string, enabled: boolean): void {
  updateWorkspaceState(workspacePath, (state) => {
    state.trackersEnabled = enabled;
  });
}

export function getExtensionConfiguration(extensionId: string): Record<string, unknown> {
  const settings = getExtensionSettings();
  return settings[extensionId]?.configuration ?? {};
}

export function setExtensionConfiguration(
  extensionId: string,
  key: string,
  value: unknown
): void {
  const settings = getExtensionSettings();
  if (!settings[extensionId]) {
    settings[extensionId] = { enabled: true };
  }
  if (!settings[extensionId].configuration) {
    settings[extensionId].configuration = {};
  }
  settings[extensionId].configuration[key] = value;
  setExtensionSettings(settings);
}

export function setExtensionConfigurationBulk(
  extensionId: string,
  configuration: Record<string, unknown>
): void {
  const settings = getExtensionSettings();
  if (!settings[extensionId]) {
    settings[extensionId] = { enabled: true };
  }
  settings[extensionId].configuration = { ...configuration };
  setExtensionSettings(settings);
}

// Workspace-level extension configuration
export function getWorkspaceExtensionConfiguration(
  workspacePath: string,
  extensionId: string
): Record<string, unknown> {
  const workspace = getWorkspaceState(workspacePath);
  return workspace.extensionConfiguration?.[extensionId] ?? {};
}

export function setWorkspaceExtensionConfiguration(
  workspacePath: string,
  extensionId: string,
  key: string,
  value: unknown
): void {
  updateWorkspaceState(workspacePath, (state) => {
    if (!state.extensionConfiguration) {
      state.extensionConfiguration = {};
    }
    if (!state.extensionConfiguration[extensionId]) {
      state.extensionConfiguration[extensionId] = {};
    }
    state.extensionConfiguration[extensionId][key] = value;
  });
}

export function setWorkspaceExtensionConfigurationBulk(
  workspacePath: string,
  extensionId: string,
  configuration: Record<string, unknown>
): void {
  updateWorkspaceState(workspacePath, (state) => {
    if (!state.extensionConfiguration) {
      state.extensionConfiguration = {};
    }
    state.extensionConfiguration[extensionId] = { ...configuration };
  });
}

// Agent Permission State Management
export function getAgentPermissions(workspacePath: string): AgentPermissions | undefined {
  const key = workspaceKey(workspacePath);
  const workspaceName = workspacePath.split('/').pop() || workspacePath;
  const permissions = getWorkspaceState(workspacePath).agentPermissions;
  // console.log(`[Store:${workspaceName}] getAgentPermissions:`, {
  //   workspacePath,
  //   key,
  //   storePath: getWorkspaceStore().path,
  //   hasPermissions: !!permissions,
  //   permissionMode: permissions?.permissionMode,
  // });
  return permissions;
}

export function saveAgentPermissions(workspacePath: string, permissions: AgentPermissions): void {
  updateWorkspaceState(workspacePath, (state) => {
    state.agentPermissions = {
      permissionMode: permissions.permissionMode,
      // Preserve the "Allow All" classifier opt-in (issue #628). Without this the
      // field is dropped on every save and the toggle never sticks.
      ...(permissions.allowAllUsesClassifier !== undefined && {
        allowAllUsesClassifier: permissions.allowAllUsesClassifier,
      }),
    };
  });
}

export function isWorkspaceTrusted(workspacePath: string): boolean {
  return getWorkspaceState(workspacePath).agentPermissions?.permissionMode !== null &&
         getWorkspaceState(workspacePath).agentPermissions?.permissionMode !== undefined;
}

export function setWorkspaceTrusted(workspacePath: string, trusted: boolean, mode: 'ask' | 'allow-all' | 'bypass-all' = 'ask'): void {
  updateWorkspaceState(workspacePath, (state) => {
    const existing = state.agentPermissions;
    state.agentPermissions = {
      permissionMode: trusted ? mode : null,
      // Preserve the "Allow All" classifier opt-in across trust toggles (issue #628).
      ...(existing?.allowAllUsesClassifier !== undefined && {
        allowAllUsesClassifier: existing.allowAllUsesClassifier,
      }),
    };
  });
}

// Walkthrough Guide System State Management

const DEFAULT_WALKTHROUGH_STATE: WalkthroughState = {
  enabled: true,
  completed: [],
  dismissed: [],
  history: {},
};

/**
 * Get the current walkthrough state.
 * Returns default state if none exists (enabled by default).
 */
export function getWalkthroughState(): WalkthroughState {
  const state = getAppStore().get('walkthroughs');
  if (!state) {
    return { ...DEFAULT_WALKTHROUGH_STATE };
  }
  return {
    enabled: state.enabled ?? true,
    completed: state.completed ?? [],
    dismissed: state.dismissed ?? [],
    history: state.history ?? {},
  };
}

/**
 * Enable or disable all walkthroughs globally.
 */
export function setWalkthroughsEnabled(enabled: boolean): void {
  const current = getWalkthroughState();
  getAppStore().set('walkthroughs', { ...current, enabled });
}

/**
 * Check if walkthroughs are enabled globally.
 */
export function isWalkthroughsEnabled(): boolean {
  return getWalkthroughState().enabled;
}

/**
 * Mark a walkthrough as completed (user finished all steps).
 */
export function markWalkthroughCompleted(walkthroughId: string, version?: number): void {
  const current = getWalkthroughState();
  const completed = current.completed.includes(walkthroughId)
    ? current.completed
    : [...current.completed, walkthroughId];

  const history = {
    ...current.history,
    [walkthroughId]: {
      ...current.history?.[walkthroughId],
      shownAt: current.history?.[walkthroughId]?.shownAt ?? Date.now(),
      completedAt: Date.now(),
      version,
    },
  };

  getAppStore().set('walkthroughs', { ...current, completed, history });
}

/**
 * Mark a walkthrough as dismissed (user skipped/closed it).
 */
export function markWalkthroughDismissed(walkthroughId: string, version?: number): void {
  const current = getWalkthroughState();
  const dismissed = current.dismissed.includes(walkthroughId)
    ? current.dismissed
    : [...current.dismissed, walkthroughId];

  const history = {
    ...current.history,
    [walkthroughId]: {
      ...current.history?.[walkthroughId],
      shownAt: current.history?.[walkthroughId]?.shownAt ?? Date.now(),
      dismissedAt: Date.now(),
      version,
    },
  };

  getAppStore().set('walkthroughs', { ...current, dismissed, history });
}

/**
 * Record that a walkthrough was shown (for analytics).
 */
export function recordWalkthroughShown(walkthroughId: string, version?: number, mode?: 'files' | 'agent'): void {
  const current = getWalkthroughState();
  const now = Date.now();

  const history = {
    ...current.history,
    [walkthroughId]: {
      ...current.history?.[walkthroughId],
      shownAt: now,
      version,
    },
  };

  // Update per-mode cooldown timestamp
  const lastShownAtByMode = mode ? {
    ...current.lastShownAtByMode,
    [mode]: now,
  } : current.lastShownAtByMode;

  getAppStore().set('walkthroughs', { ...current, history, lastShownAtByMode });
}

/**
 * Check if a walkthrough should be shown.
 * Returns false if disabled globally, already completed, or already dismissed.
 */
export function shouldShowWalkthrough(walkthroughId: string, version?: number): boolean {
  const state = getWalkthroughState();

  // Globally disabled
  if (!state.enabled) return false;

  // Newer versions should re-show even if the previous version was dismissed
  // or completed. History tracks the last version the user saw.
  if (version !== undefined && state.history?.[walkthroughId]?.version !== undefined) {
    if (state.history[walkthroughId].version !== version) {
      return true;
    }
  }

  // Already completed or dismissed
  if (state.completed.includes(walkthroughId)) return false;
  if (state.dismissed.includes(walkthroughId)) return false;

  return true;
}

/**
 * Reset all walkthrough state (for testing/debugging).
 */
export function resetWalkthroughState(): void {
  getAppStore().set('walkthroughs', { ...DEFAULT_WALKTHROUGH_STATE });
}

/**
 * Reset only tip state (entries with 'tip-' prefix) without affecting walkthroughs.
 */
export function resetTipState(): void {
  const current = getWalkthroughState();
  getAppStore().set('walkthroughs', {
    ...current,
    completed: current.completed.filter((id) => !id.startsWith('tip-')),
    dismissed: current.dismissed.filter((id) => !id.startsWith('tip-')),
    history: Object.fromEntries(
      Object.entries(current.history ?? {}).filter(([id]) => !id.startsWith('tip-'))
    ),
  });
}

/**
 * Check if an editor type has been opened before
 */
export function hasOpenedEditor(editorType: 'excalidraw' | 'mockup' | 'spreadsheet' | 'datamodel'): boolean {
  const firstOpens = getAppStore().get('editorFirstOpens') ?? {};
  return firstOpens[editorType] ?? false;
}

/**
 * Mark an editor type as opened
 */
export function markEditorOpened(editorType: 'excalidraw' | 'mockup' | 'spreadsheet' | 'datamodel'): void {
  const firstOpens = getAppStore().get('editorFirstOpens') ?? {};
  getAppStore().set('editorFirstOpens', { ...firstOpens, [editorType]: true });
}

// Generic App Settings (for extension storage and other dynamic keys)

/**
 * Get a generic app setting by key.
 * Used by extension storage to persist global data.
 */
export function getAppSetting<T>(key: string): T | undefined {
  return getAppStore().get(key as keyof AppStoreSchema) as T | undefined;
}

/**
 * Set a generic app setting by key.
 * Used by extension storage to persist global data.
 */
export function setAppSetting<T>(key: string, value: T): void {
  getAppStore().set(key as keyof AppStoreSchema, value as any);
}

// Preferred Agent Language
// Preferred language for the agent. Currently used to steer the auto-generated
// session name. Empty/undefined means no preference -- the agent picks based
// on the conversation language.

/**
 * Get the preferred agent language.
 * Returns undefined when no preference is set.
 */
export function getPreferredAgentLanguage(): string | undefined {
  const value = getAppStore().get('preferredAgentLanguage');
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

/**
 * Set the preferred agent language.
 * Pass undefined or empty string to clear the preference.
 */
export function setPreferredAgentLanguage(language: string | undefined): void {
  if (language && language.trim().length > 0) {
    getAppStore().set('preferredAgentLanguage', language.trim());
  } else {
    getAppStore().delete('preferredAgentLanguage');
  }
}

// V8 Heap Memory Limit
// Default is 4096MB (4GB). Increase if experiencing OOM crashes with large sessions.

/**
 * Get the configured V8 heap memory limit in MB.
 * Returns undefined if not explicitly set (uses V8 default).
 */
export function getMaxHeapSizeMB(): number | undefined {
  return getAppStore().get('maxHeapSizeMB');
}

/**
 * Set the V8 heap memory limit in MB.
 * Changes take effect on next app restart.
 * @param sizeMB Memory limit in megabytes (e.g., 4096 for 4GB, 8192 for 8GB)
 */
export function setMaxHeapSizeMB(sizeMB: number | undefined): void {
  if (sizeMB !== undefined && sizeMB > 0) {
    getAppStore().set('maxHeapSizeMB', sizeMB);
  } else {
    getAppStore().delete('maxHeapSizeMB');
  }
}

// Alpha Feature Flags
// Individual opt-in toggles, available to all users regardless of release channel.
// Uses dynamic registration from alphaFeatures registry.

/**
 * Get the alpha feature flags.
 * Returns all registered features merged with stored values; missing entries default to false.
 */
export function getAlphaFeatures(): Record<AlphaFeatureTag, boolean> {
  const stored = getAppStore().get('alphaFeatures');
  const defaults = getDefaultAlphaFeatures();

  if (!stored) {
    return defaults;
  }

  // Merge stored values with defaults so newly-registered features default to off
  // and removed features fall away.
  const merged = { ...defaults };
  for (const feature of ALPHA_FEATURES) {
    if (feature.tag in stored) {
      merged[feature.tag] = stored[feature.tag];
    }
  }
  return merged;
}

/**
 * Set the alpha feature flags.
 * @param features Object containing feature flags (partial updates supported)
 */
export function setAlphaFeatures(features: Record<AlphaFeatureTag, boolean>): void {
  // Merge with existing features to preserve other settings
  const current = getAlphaFeatures();
  const merged = { ...current, ...features };
  getAppStore().set('alphaFeatures', merged);
}

// Beta Feature Flags
// User-visible beta features that can be individually toggled in Settings > Advanced > Beta Features

/**
 * Get whether "Enable All Beta Features" is turned on.
 */
export function getEnableAllBetaFeatures(): boolean {
  return getAppStore().get('enableAllBetaFeatures') ?? false;
}

/**
 * Set whether "Enable All Beta Features" is turned on.
 */
export function setEnableAllBetaFeatures(enabled: boolean): void {
  getAppStore().set('enableAllBetaFeatures', enabled);
}

/**
 * Get the beta feature flags.
 * Returns all feature flags with defaults for any missing values.
 *
 * If "Enable All Beta Features" is turned on, new features are automatically enabled.
 */
export function getBetaFeatures(): Record<BetaFeatureTag, boolean> {
  const stored = getAppStore().get('betaFeatures');
  const enableAll = getEnableAllBetaFeatures();

  if (!stored) {
    return getDefaultBetaFeatures();
  }

  // Ensure all registered features exist in stored object (for new features added later)
  for (const feature of BETA_FEATURES) {
    if (!(feature.tag in stored)) {
      // If "Enable All Beta Features" is on, enable new features automatically
      stored[feature.tag] = enableAll ? true : false;
    }
  }

  return stored;
}

/**
 * Set the beta feature flags.
 * @param features Object containing feature flags (partial updates supported)
 */
export function setBetaFeatures(features: Record<BetaFeatureTag, boolean>): void {
  const current = getBetaFeatures();
  const merged = { ...current, ...features };
  getAppStore().set('betaFeatures', merged);
}

// Developer Feature Flags
// Features only available when developer mode is enabled
// Uses dynamic registration from developerFeatures registry

/**
 * Get the developer feature flags.
 * Returns all feature flags with defaults for any missing values.
 * All features are enabled by default when developer mode is on.
 */
export function getDeveloperFeatures(): Record<DeveloperFeatureTag, boolean> {
  const stored = getAppStore().get('developerFeatures');

  if (!stored) {
    // All developer features enabled by default
    return getDefaultDeveloperFeatures();
  }

  // Merge stored values with defaults to handle new features added after initial storage
  const defaults = getDefaultDeveloperFeatures();

  // Ensure all registered features exist in stored object (for new features added later)
  for (const feature of DEVELOPER_FEATURES) {
    if (!(feature.tag in stored)) {
      stored[feature.tag] = defaults[feature.tag];
    }
  }

  return stored;
}

/**
 * Set the developer feature flags.
 * @param features Object containing feature flags (partial updates supported)
 */
export function setDeveloperFeatures(features: Record<DeveloperFeatureTag, boolean>): void {
  // Merge with existing features to preserve other settings
  const current = getDeveloperFeatures();
  const merged = { ...current, ...features };
  getAppStore().set('developerFeatures', merged);
}

/**
 * Check if a developer feature is available.
 * Feature is available if developer mode is enabled AND the specific feature is enabled.
 */
export function isDeveloperFeatureAvailable(tag: DeveloperFeatureTag): boolean {
  const developerMode = isDeveloperMode();
  if (!developerMode) {
    return false;
  }
  const features = getDeveloperFeatures();
  return features[tag] ?? false;
}

// ============================================================================
// MIGRATIONS
// ============================================================================

/**
 * Compare two semantic version strings.
 * Returns true if versionA <= versionB.
 */
function versionLessThanOrEqual(versionA: string, versionB: string): boolean {
  const parseVersion = (v: string) => {
    const parts = v.split('.').map(Number);
    return { major: parts[0] || 0, minor: parts[1] || 0, patch: parts[2] || 0 };
  };

  const a = parseVersion(versionA);
  const b = parseVersion(versionB);

  if (a.major !== b.major) return a.major < b.major;
  if (a.minor !== b.minor) return a.minor < b.minor;
  return a.patch <= b.patch;
}

/**
 * Run app migrations based on version changes.
 * Should be called once during app startup.
 */
// Extension Marketplace Install Tracking

export function getMarketplaceInstalls(): Record<string, MarketplaceInstallRecord> {
  return getAppStore().get('marketplaceInstalls', {});
}

export function getMarketplaceInstall(extensionId: string): MarketplaceInstallRecord | undefined {
  return getMarketplaceInstalls()[extensionId];
}

export function addMarketplaceInstall(record: MarketplaceInstallRecord): void {
  const installs = getMarketplaceInstalls();
  installs[record.extensionId] = record;
  getAppStore().set('marketplaceInstalls', installs);
}

export function removeMarketplaceInstall(extensionId: string): void {
  const installs = getMarketplaceInstalls();
  delete installs[extensionId];
  getAppStore().set('marketplaceInstalls', installs);
}

export function updateMarketplaceInstall(extensionId: string, updates: Partial<MarketplaceInstallRecord>): void {
  const installs = getMarketplaceInstalls();
  if (installs[extensionId]) {
    installs[extensionId] = { ...installs[extensionId], ...updates };
    getAppStore().set('marketplaceInstalls', installs);
  }
}

// Multi-Project Rail Settings
// `multiProjectMode` is the opt-in toggle that lets users open several
// projects in a single window via the project rail. The `openProjects` list
// and `activeProjectPath` are restored on launch so the rail rehydrates.

export function getMultiProjectMode(): boolean {
  return getAppStore().get('multiProjectMode', false);
}

export function setMultiProjectMode(enabled: boolean): void {
  getAppStore().set('multiProjectMode', enabled);
}

export function getOpenProjectPaths(): string[] {
  const stored = getAppStore().get('openProjects', []);
  return Array.isArray(stored) ? stored : [];
}

export function setOpenProjectPaths(paths: string[]): void {
  getAppStore().set('openProjects', paths);
}

export function getActiveProjectPath(): string | null {
  return getAppStore().get('activeProjectPath', null);
}

export function setActiveProjectPath(path: string | null): void {
  getAppStore().set('activeProjectPath', path);
}

export function getRestorePreviousProjectsOnLaunch(): boolean {
  return getAppStore().get('restorePreviousProjectsOnLaunch', false);
}

export function setRestorePreviousProjectsOnLaunch(enabled: boolean): void {
  getAppStore().set('restorePreviousProjectsOnLaunch', enabled);
}

export function runMigrations(currentVersion: string): void {
  const lastKnownVersion = getAppStore().get('lastKnownVersion');

  // Missing lastKnownVersion means user is upgrading from <= 0.52.10
  // (versions before we started tracking lastKnownVersion)
  const isUpgradingFromOldVersion = !lastKnownVersion;

  // One-shot, version-independent migration (NIM-827): plain `fable` defaults
  // become `fable-1m`. Claude Code windows plain `fable` at 200k and gates the
  // 1M window behind `fable[1m]`; the original Fable picker row predated
  // `fable-1m`, so users who picked it were silently on 200k and hit "Prompt
  // is too long" as soon as a large skill loaded. Flag-guarded (not
  // version-gated) so it also fires on dev builds where the version doesn't
  // change; a user who later deliberately re-picks plain Fable stays on it.
  if (!getAppStore().get('fableDefaultMigratedTo1m')) {
    const currentDefault = getAppStore().get('defaultAIModel');
    if (currentDefault === 'claude-code:fable' || currentDefault === 'claude-code-cli:fable') {
      const migrated = `${currentDefault}-1m`;
      logger.store.info(`[Migrations] Migrating default model from ${currentDefault} to ${migrated}`);
      getAppStore().set('defaultAIModel', migrated);
    }
    getAppStore().set('fableDefaultMigratedTo1m', true);
  }

  // Same version - no migration needed
  if (!isUpgradingFromOldVersion && lastKnownVersion === currentVersion) {
    return;
  }

  logger.store.info('[Migrations] Running migrations from', lastKnownVersion || '(unknown/<=0.52.10)', 'to', currentVersion);

  // Migration: Auto-switch users from claude-code:opus to claude-code:opus-1m (1M context)
  // Only runs once — on first upgrade to a version with this migration.
  // New users get opus-1m by default; this migrates existing users who had opus selected.
  if (isUpgradingFromOldVersion || versionLessThanOrEqual(lastKnownVersion, '0.56.7')) {
    const currentDefault = getAppStore().get('defaultAIModel');
    if (currentDefault === 'claude-code:opus') {
      logger.store.info('[Migrations] Migrating default model from claude-code:opus to claude-code:opus-1m');
      getAppStore().set('defaultAIModel', 'claude-code:opus-1m');
    }
  }

  // Update last known version
  getAppStore().set('lastKnownVersion', currentVersion);
  logger.store.info('[Migrations] Migrations complete, version updated to:', currentVersion);
}
