/**
 * SettingsControlService
 *
 * Single writer for the Settings Control MCP server. All mutations from the
 * `nimbalyst-settings` MCP tools route through this service so the allow-list,
 * deny-list, rate-limit, and audit logging are enforced in exactly one place.
 *
 * Design rules:
 * - Only keys explicitly listed in `ALLOWED_APP_KEYS` / `ALLOWED_WORKSPACE_KEYS`
 *   are writable. Anything else throws.
 * - Sensitive keys (`DENIED_APP_KEYS`) are asserted-not-in-allowlist by a unit
 *   test so a future contributor can't accidentally add a secret to the
 *   allow-list.
 * - The service does not perform Stytch sign-in; if auth is required, tools
 *   return `requiresUserAction: 'stytch-signin'` so the agent can surface a
 *   clear next step to the user.
 */

import { existsSync, readdirSync } from 'fs';
import { mkdir } from 'fs/promises';
import path from 'path';
import { BrowserWindow } from 'electron';

import {
  addToRecentItems,
  clearPendingThemeFallback,
  getAppSetting,
  getDefaultAIModel as storeGetDefaultAIModel,
  getReleaseChannel as storeGetReleaseChannel,
  getSessionSyncConfig,
  getTheme as storeGetTheme,
  getWorkspaceState,
  isAnalyticsEnabled as storeIsAnalyticsEnabled,
  isSettingsAgentToolsDisabled,
  setAnalyticsEnabled as storeSetAnalyticsEnabled,
  setAppSetting,
  setDefaultAIModel as storeSetDefaultAIModel,
  setPreferredAgentLanguage,
  setSessionSyncConfig,
  setTheme as storeSetTheme,
  setWorkspaceTrusted,
  updateWorkspaceState,
  type AgentPermissionMode,
  type AppTheme,
  type SessionSyncConfig,
  type TrackerSyncModeSetting,
} from '../utils/store';
import * as StytchAuth from './StytchAuthService';
import { logger } from '../utils/logger';
import {
  startExtensionBackendModules,
  stopExtensionBackendModules,
  getDefaultBackendModuleLifecycleDeps,
} from '../extensions/backendModuleLifecycle';
import { FeatureUsageService, FEATURES } from './FeatureUsageService';
import { SessionNamingService } from './SessionNamingService';
import { updateNativeTheme, updateWindowTitleBars } from '../theme/ThemeManager';
import { createWindow, findWindowByWorkspace } from '../window/WindowManager';
import { getWorkspaceWindowState } from '../utils/store';
import { requestTrackerBackfillForWorkspace } from './TrackerSyncManager';

// ─── Allow / deny lists ─────────────────────────────────────────────

/**
 * Top-level app-store keys writable through this service. Each one maps to a
 * specific tool; we do not expose a generic key/value setter.
 */
export const ALLOWED_APP_KEYS = [
  'theme',
  'completionSoundEnabled',
  'osNotificationsEnabled',
  'spellcheckEnabled',
  'analyticsEnabled',
  'defaultAIModel',
  'preferredAgentLanguage',
  'sessionSync',
  'voiceMode',
  'alphaFeatures',
  'betaFeatures',
  'developerFeatures',
  'extensionSettings',
  'settingsAgentToolsDisabled',
] as const satisfies readonly string[];

/**
 * Keys this service must NEVER write. The companion unit test asserts that
 * every entry below is absent from ALLOWED_APP_KEYS. Adding a key here is a
 * one-liner; forgetting to add a new secret-bearing key is a bug we want to
 * catch in CI.
 */
export const DENIED_APP_KEYS = [
  'apiKeys',
  'globalApiKeys',
  'stytchAuth',
  'shareKeys',
] as const satisfies readonly string[];

/**
 * Workspace-scoped keys writable through this service.
 */
export const ALLOWED_WORKSPACE_KEYS = [
  'trackerSyncPolicies',
  'issueKeyPrefix',
  'agentPermissions',
] as const satisfies readonly string[];

// ─── Rate limit ─────────────────────────────────────────────────────

interface RateLimitBucket {
  windowStart: number;
  count: number;
}
const RATE_LIMIT_WINDOW_MS = 60_000;
const RATE_LIMIT_MAX = 30;
const rateLimitBuckets = new Map<string, RateLimitBucket>();

function rateLimit(sessionId: string): void {
  const bucket = rateLimitBuckets.get(sessionId);
  const now = Date.now();
  if (!bucket || now - bucket.windowStart > RATE_LIMIT_WINDOW_MS) {
    rateLimitBuckets.set(sessionId, { windowStart: now, count: 1 });
    return;
  }
  bucket.count += 1;
  if (bucket.count > RATE_LIMIT_MAX) {
    throw new Error(
      `Rate limit exceeded: more than ${RATE_LIMIT_MAX} settings writes in 60s for session ${sessionId}. Wait and retry.`,
    );
  }
}

// ─── Result type ─────────────────────────────────────────────────────

export interface SettingsToolResult<TBefore = unknown, TAfter = unknown> {
  ok: boolean;
  before?: TBefore;
  after?: TAfter;
  requiresUserAction?: 'stytch-signin' | 'confirm-overwrite' | 'developer-mode';
  message?: string;
}

// ─── Service ────────────────────────────────────────────────────────

export class SettingsControlService {
  private static instance: SettingsControlService | null = null;

  static getInstance(): SettingsControlService {
    if (!SettingsControlService.instance) {
      SettingsControlService.instance = new SettingsControlService();
    }
    return SettingsControlService.instance;
  }

  private audit(tool: string, sessionId: string, payload: Record<string, unknown>): void {
    logger.store.info(`[SettingsControl] ${tool}`, { sessionId, ...payload });
  }

  // ── Inspection ────────────────────────────────────────────────────

  getOverview(workspacePath: string | undefined): Record<string, unknown> {
    const sync = getSessionSyncConfig();
    const overview: Record<string, unknown> = {
      theme: storeGetTheme(),
      releaseChannel: storeGetReleaseChannel(),
      defaultAIModel: storeGetDefaultAIModel() ?? null,
      analyticsEnabled: storeIsAnalyticsEnabled(),
      completionSoundEnabled: getAppSetting<boolean>('completionSoundEnabled') ?? false,
      spellcheckEnabled: getAppSetting<boolean>('spellcheckEnabled') ?? true,
      preferredAgentLanguage: getAppSetting<string>('preferredAgentLanguage') ?? '',
      voiceMode: getAppSetting<unknown>('voiceMode') ?? null,
      sessionSync: sync
        ? {
            enabled: sync.enabled,
            enabledProjects: sync.enabledProjects ?? [],
            docSyncEnabledProjects: sync.docSyncEnabledProjects ?? [],
            environment: sync.environment ?? null,
          }
        : null,
      stytch: {
        authenticated: StytchAuth.isAuthenticated(),
        userEmail: StytchAuth.getUserEmail(),
        personalOrgId: StytchAuth.getPersonalOrgId(),
      },
      alphaFeatures: getAppSetting<Record<string, boolean>>('alphaFeatures') ?? {},
      betaFeatures: getAppSetting<Record<string, boolean>>('betaFeatures') ?? {},
      developerFeatures: getAppSetting<Record<string, boolean>>('developerFeatures') ?? {},
      developerMode: getAppSetting<boolean>('developerMode') ?? false,
      settingsAgentToolsDisabled: isSettingsAgentToolsDisabled(),
    };
    if (workspacePath) {
      const ws = getWorkspaceState(workspacePath);
      overview.workspace = {
        path: workspacePath,
        accountId: ws.accountId ?? null,
        trackerSyncPolicies: ws.trackerSyncPolicies ?? {},
        issueKeyPrefix: ws.issueKeyPrefix ?? null,
        sessionSyncEnabled: (sync?.enabledProjects ?? []).includes(workspacePath),
        docSyncEnabled: (sync?.docSyncEnabledProjects ?? []).includes(workspacePath),
        agentPermissionMode: ws.agentPermissions?.permissionMode ?? null,
      };
    }
    return overview;
  }

  // ── Workspace lifecycle ──────────────────────────────────────────

  async createWorkspace(
    sessionId: string,
    args: { targetPath: string; openAfterCreate?: boolean; force?: boolean },
  ): Promise<SettingsToolResult<null, { path: string; opened: boolean }>> {
    rateLimit(sessionId);
    const { targetPath, openAfterCreate = true, force = false } = args;
    if (!targetPath || !path.isAbsolute(targetPath)) {
      return { ok: false, message: 'targetPath must be an absolute path.' };
    }

    const exists = existsSync(targetPath);
    if (exists) {
      const entries = readdirSync(targetPath);
      const nonEmpty = entries.filter((e) => !e.startsWith('.DS_Store')).length > 0;
      if (nonEmpty && !force) {
        return {
          ok: false,
          requiresUserAction: 'confirm-overwrite',
          message: `Path ${targetPath} already exists and is non-empty. Ask the user to confirm, then retry with force: true.`,
        };
      }
    } else {
      await mkdir(targetPath, { recursive: true });
    }

    addToRecentItems('workspaces', targetPath, path.basename(targetPath));

    let opened = false;
    if (openAfterCreate) {
      this.openWorkspaceInternal(targetPath);
      opened = true;
    }

    this.audit('workspace_create', sessionId, { targetPath, opened });
    return { ok: true, after: { path: targetPath, opened } };
  }

  async openWorkspace(
    sessionId: string,
    args: { workspacePath: string },
  ): Promise<SettingsToolResult<null, { path: string }>> {
    rateLimit(sessionId);
    if (!args.workspacePath || !path.isAbsolute(args.workspacePath)) {
      return { ok: false, message: 'workspacePath must be an absolute path.' };
    }
    if (!existsSync(args.workspacePath)) {
      return { ok: false, message: `Path ${args.workspacePath} does not exist.` };
    }
    addToRecentItems('workspaces', args.workspacePath, path.basename(args.workspacePath));
    this.openWorkspaceInternal(args.workspacePath);
    this.audit('workspace_open', sessionId, { path: args.workspacePath });
    return { ok: true, after: { path: args.workspacePath } };
  }

  private openWorkspaceInternal(workspacePath: string): void {
    const existing = findWindowByWorkspace(workspacePath);
    if (existing && !existing.isDestroyed()) {
      existing.focus();
      return;
    }
    const savedState = getWorkspaceWindowState(workspacePath);
    createWindow(false, true, workspacePath, savedState?.bounds);
  }

  // ── Sync ─────────────────────────────────────────────────────────

  async setProjectSync(
    sessionId: string,
    args: {
      workspacePath: string;
      enableSessionSync?: boolean;
      enableDocumentSync?: boolean;
    },
  ): Promise<SettingsToolResult<SessionSyncConfig | null, SessionSyncConfig>> {
    rateLimit(sessionId);
    const { workspacePath, enableSessionSync, enableDocumentSync } = args;
    if (!workspacePath) {
      return { ok: false, message: 'workspacePath is required.' };
    }

    if (!StytchAuth.isAuthenticated()) {
      return {
        ok: false,
        requiresUserAction: 'stytch-signin',
        message:
          'Sync requires sign-in. Ask the user to sign in via Settings > Sync (or use the existing UI), then retry this tool.',
      };
    }

    const before: SessionSyncConfig | null = getSessionSyncConfig() ?? null;
    const base: SessionSyncConfig = before
      ? { ...before }
      : { enabled: false, serverUrl: '', enabledProjects: [] };

    const enabledProjects = new Set(base.enabledProjects ?? []);
    const docEnabled = new Set(base.docSyncEnabledProjects ?? []);

    if (enableSessionSync === true) {
      enabledProjects.add(workspacePath);
    } else if (enableSessionSync === false) {
      enabledProjects.delete(workspacePath);
    }

    if (enableDocumentSync === true) {
      docEnabled.add(workspacePath);
    } else if (enableDocumentSync === false) {
      docEnabled.delete(workspacePath);
    }

    // Mirror the IPC path: global sessionSync.enabled tracks whether any
    // project is selected. Without this, disabling the last project would
    // leave enabled=true and continue reinit under a logically empty config.
    const next: SessionSyncConfig = {
      ...base,
      enabled: enabledProjects.size > 0,
      enabledProjects: Array.from(enabledProjects),
      docSyncEnabledProjects: Array.from(docEnabled),
      personalOrgId: base.personalOrgId ?? (StytchAuth.getPersonalOrgId() ?? undefined),
      personalUserId: base.personalUserId ?? (StytchAuth.getPersonalUserId() ?? undefined),
    };

    setSessionSyncConfig(next);

    try {
      const { repositoryManager } = await import('./RepositoryManager');
      await repositoryManager.reinitializeSyncWithNewConfig();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logger.store.error('[SettingsControl] sync reinit failed; rolling back', error);
      setSessionSyncConfig(before ?? undefined);
      return {
        ok: false,
        before,
        after: next,
        message: `Failed to reinitialize sync, rolled back. ${message}`,
      };
    }

    this.audit('sync_set_for_project', sessionId, {
      workspacePath,
      enableSessionSync,
      enableDocumentSync,
    });
    return { ok: true, before, after: next };
  }

  // ── Appearance ───────────────────────────────────────────────────

  async setTheme(
    sessionId: string,
    args: { theme: string },
  ): Promise<SettingsToolResult<AppTheme, AppTheme>> {
    rateLimit(sessionId);
    const before = storeGetTheme();
    const next = args.theme as AppTheme;
    // Validate: built-in or `extensionId:themeId` form.
    const builtIn = new Set<string>(['dark', 'light', 'system', 'auto', 'crystal-dark']);
    if (!builtIn.has(next) && !next.includes(':')) {
      return {
        ok: false,
        message: `Unknown theme "${next}". Use a built-in (dark/light/system/auto/crystal-dark) or extension theme in the form extensionId:themeId.`,
      };
    }
    storeSetTheme(next);
    FeatureUsageService.getInstance().recordUsage(FEATURES.THEME_CHANGED);
    // Mirror the renderer-triggered `set-theme` IPC path: clear any pending
    // fallback banner, update native theme + window title bars, and broadcast
    // on `theme-change` (the channel the renderer's themeListeners subscribes
    // to). Sending `theme:changed` here had no listener, so the live UI never
    // updated.
    clearPendingThemeFallback();
    updateNativeTheme();
    this.broadcast('theme-change', next);
    updateWindowTitleBars();
    this.audit('appearance_set_theme', sessionId, { before, after: next });
    return { ok: true, before, after: next };
  }

  async setCompletionSound(
    sessionId: string,
    args: { enabled: boolean },
  ): Promise<SettingsToolResult<boolean, boolean>> {
    rateLimit(sessionId);
    const before = getAppSetting<boolean>('completionSoundEnabled') ?? false;
    setAppSetting('completionSoundEnabled', args.enabled);
    this.audit('appearance_set_completion_sound', sessionId, { before, after: args.enabled });
    return { ok: true, before, after: args.enabled };
  }

  async setSpellcheck(
    sessionId: string,
    args: { enabled: boolean },
  ): Promise<SettingsToolResult<boolean, boolean>> {
    rateLimit(sessionId);
    const before = getAppSetting<boolean>('spellcheckEnabled') ?? true;
    setAppSetting('spellcheckEnabled', args.enabled);
    // Apply to current sessions
    try {
      const { session } = await import('electron');
      session.defaultSession.setSpellCheckerEnabled(args.enabled);
    } catch {
      // Non-fatal: the persisted setting still applies on next launch.
    }
    this.audit('appearance_set_spellcheck', sessionId, { before, after: args.enabled });
    return { ok: true, before, after: args.enabled };
  }

  async setAnalytics(
    sessionId: string,
    args: { enabled: boolean },
  ): Promise<SettingsToolResult<boolean, boolean>> {
    rateLimit(sessionId);
    const before = storeIsAnalyticsEnabled();
    storeSetAnalyticsEnabled(args.enabled);
    this.audit('analytics_set_enabled', sessionId, { before, after: args.enabled });
    return { ok: true, before, after: args.enabled };
  }

  // ── AI defaults ──────────────────────────────────────────────────

  async setDefaultAIModel(
    sessionId: string,
    args: { providerModel: string },
  ): Promise<SettingsToolResult<string | null, string>> {
    rateLimit(sessionId);
    const before = storeGetDefaultAIModel() ?? null;
    if (!args.providerModel || !args.providerModel.includes(':')) {
      return {
        ok: false,
        message: `providerModel must be in the form "provider:model" (e.g. "claude-code:sonnet"). Got "${args.providerModel}".`,
      };
    }
    storeSetDefaultAIModel(args.providerModel);
    this.audit('ai_set_default_model', sessionId, { before, after: args.providerModel });
    return { ok: true, before, after: args.providerModel };
  }

  async setPreferredAgentLanguage(
    sessionId: string,
    args: { language: string },
  ): Promise<SettingsToolResult<string | undefined, string>> {
    rateLimit(sessionId);
    const before = getAppSetting<string>('preferredAgentLanguage');
    setPreferredAgentLanguage(args.language);
    // Also push into the runtime singleton so providers and prompt builders
    // pick up the change without a restart -- matches the IPC handler.
    SessionNamingService.getInstance().setLanguage(args.language);
    this.audit('ai_set_preferred_language', sessionId, { before, after: args.language });
    return { ok: true, before, after: args.language };
  }

  // ── Feature flags ────────────────────────────────────────────────

  async toggleFeature(
    sessionId: string,
    args: { bucket: 'alpha' | 'beta' | 'developer'; tag: string; enabled: boolean },
  ): Promise<SettingsToolResult<boolean | undefined, boolean>> {
    rateLimit(sessionId);
    const { bucket, tag, enabled } = args;
    const key =
      bucket === 'alpha'
        ? 'alphaFeatures'
        : bucket === 'beta'
          ? 'betaFeatures'
          : 'developerFeatures';

    if (bucket !== 'beta') {
      const devMode = getAppSetting<boolean>('developerMode') ?? false;
      if (!devMode) {
        return {
          ok: false,
          requiresUserAction: 'developer-mode',
          message: `Toggling ${bucket} features requires Developer Mode. Ask the user to enable it in Settings > Advanced.`,
        };
      }
    }

    const current = (getAppSetting<Record<string, boolean>>(key) ?? {}) as Record<string, boolean>;
    const before = current[tag];
    const next = { ...current, [tag]: enabled };
    setAppSetting(key, next);
    this.audit('features_toggle', sessionId, { bucket, tag, before, after: enabled });
    return { ok: true, before, after: enabled };
  }

  // ── Extensions ───────────────────────────────────────────────────

  async setExtensionEnabled(
    sessionId: string,
    args: { extensionId: string; enabled: boolean },
  ): Promise<SettingsToolResult<boolean | undefined, boolean>> {
    rateLimit(sessionId);
    const { extensionId, enabled } = args;
    if (!extensionId) {
      return { ok: false, message: 'extensionId is required.' };
    }
    const all =
      (getAppSetting<Record<string, { enabled: boolean; configuration?: Record<string, unknown> }>>(
        'extensionSettings',
      ) ?? {}) as Record<
        string,
        { enabled: boolean; configuration?: Record<string, unknown> }
      >;
    const before = all[extensionId]?.enabled;
    const next = {
      ...all,
      [extensionId]: { ...(all[extensionId] ?? {}), enabled },
    };
    setAppSetting('extensionSettings', next);
    this.audit('extension_set_enabled', sessionId, { extensionId, before, after: enabled });

    // Start/stop any backend modules the extension declares, mirroring the
    // Settings UI's IPC path (see ExtensionHandlers.ts 'extensions:set-enabled').
    // Without this, toggling via this MCP tool leaves a crashed or stale
    // backend module untouched. Fire-and-forget so the tool call returns
    // promptly (startModule awaits utility-process readiness, up to 15s).
    const lifecycleDeps = getDefaultBackendModuleLifecycleDeps();
    if (enabled) {
      void startExtensionBackendModules(extensionId, lifecycleDeps).catch((err) =>
        logger.main.error(`[SettingsControlService] backend-module start failed for ${extensionId}:`, err)
      );
    } else {
      void stopExtensionBackendModules(extensionId, lifecycleDeps).catch((err) =>
        logger.main.error(`[SettingsControlService] backend-module stop failed for ${extensionId}:`, err)
      );
    }

    return { ok: true, before, after: enabled };
  }

  // ── Trackers (workspace-scoped) ──────────────────────────────────

  async setTrackerSyncPolicy(
    sessionId: string,
    args: {
      workspacePath: string;
      trackerType: string;
      mode: TrackerSyncModeSetting;
    },
  ): Promise<
    SettingsToolResult<TrackerSyncModeSetting | undefined, TrackerSyncModeSetting>
  > {
    rateLimit(sessionId);
    const { workspacePath, trackerType, mode } = args;
    if (!workspacePath || !trackerType) {
      return { ok: false, message: 'workspacePath and trackerType are required.' };
    }
    if (!['local', 'shared', 'hybrid'].includes(mode)) {
      return { ok: false, message: `mode must be one of local, shared, hybrid. Got "${mode}".` };
    }
    let before: TrackerSyncModeSetting | undefined;
    updateWorkspaceState(workspacePath, (state) => {
      const existing = state.trackerSyncPolicies?.[trackerType];
      before = typeof existing === 'string' ? existing : existing?.mode;
      const policies = { ...(state.trackerSyncPolicies ?? {}) };
      policies[trackerType] = mode;
      state.trackerSyncPolicies = policies;
    });
    this.audit('tracker_set_sync_policy', sessionId, {
      workspacePath,
      trackerType,
      before,
      after: mode,
    });
    // Why: flipping from `local` to `shared`/`hybrid` for a workspace that
    // already has items means the user expects those items to start
    // appearing on their other devices. The tracker engine only knows what
    // was queued through it; nothing else triggers historical items to be
    // uploaded. Asking it to backfill here matches user expectation.
    if ((mode === 'shared' || mode === 'hybrid') && before !== mode) {
      requestTrackerBackfillForWorkspace(workspacePath).catch(err => {
        // Non-fatal: the engine's on-connect backfill will retry on next
        // restart. We log so a stuck setting is visible in main.log.
        logger.main.warn('[SettingsControlService] tracker backfill request failed for', workspacePath, err);
      });
    }
    return { ok: true, before, after: mode };
  }

  // ── Agent trust / permissions (workspace-scoped) ─────────────────

  async setWorkspaceTrust(
    sessionId: string,
    args: { workspacePath: string; trusted: boolean; mode?: 'ask' | 'allow-all' | 'bypass-all' },
  ): Promise<SettingsToolResult<AgentPermissionMode | undefined, AgentPermissionMode>> {
    rateLimit(sessionId);
    const { workspacePath, trusted, mode = 'ask' } = args;
    if (!workspacePath) {
      return { ok: false, message: 'workspacePath is required.' };
    }
    if (trusted && !['ask', 'allow-all', 'bypass-all'].includes(mode)) {
      return {
        ok: false,
        message: `mode must be one of: ask, allow-all, bypass-all. Got "${mode}".`,
      };
    }
    const before = getWorkspaceState(workspacePath).agentPermissions?.permissionMode;
    setWorkspaceTrusted(workspacePath, trusted, mode);
    const after = (trusted ? mode : null) as AgentPermissionMode;
    this.audit('workspace_set_trust', sessionId, {
      workspacePath,
      trusted,
      mode,
      before,
      after,
    });
    return { ok: true, before, after };
  }

  async setIssueKeyPrefix(
    sessionId: string,
    args: { workspacePath: string; prefix: string },
  ): Promise<SettingsToolResult<string | undefined, string>> {
    rateLimit(sessionId);
    const { workspacePath, prefix } = args;
    if (!workspacePath) {
      return { ok: false, message: 'workspacePath is required.' };
    }
    if (!/^[A-Z][A-Z0-9_-]{0,15}$/.test(prefix)) {
      return {
        ok: false,
        message:
          'prefix must be 1-16 chars, start with an uppercase letter, and use only A-Z, 0-9, _, -.',
      };
    }
    let before: string | undefined;
    updateWorkspaceState(workspacePath, (state) => {
      before = state.issueKeyPrefix;
      state.issueKeyPrefix = prefix;
    });
    this.audit('tracker_set_issue_key_prefix', sessionId, { workspacePath, before, after: prefix });
    return { ok: true, before, after: prefix };
  }

  // ── Broadcast helper ─────────────────────────────────────────────

  private broadcast(channel: string, payload: unknown): void {
    for (const win of BrowserWindow.getAllWindows()) {
      if (!win.isDestroyed()) {
        try {
          win.webContents.send(channel, payload);
        } catch {
          // ignore destroyed renderer
        }
      }
    }
  }
}
