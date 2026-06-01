import { BrowserWindow, safeStorage, session } from 'electron';
import { safeHandle, safeOn } from '../utils/ipcRegistry';
import * as os from 'os';
import * as fs from 'fs';
import * as path from 'path';
import { app } from 'electron';
import {
    getWorkspaceState, updateWorkspaceState,
    getTheme, getThemeSync, getResolvedThemeSync,
    isCompletionSoundEnabled, setCompletionSoundEnabled,
    getCompletionSoundType, setCompletionSoundType, CompletionSoundType,
    getReleaseChannel, setReleaseChannel, ReleaseChannel,
    getRecentItems,
    getDefaultAIModel, setDefaultAIModel,
    getDefaultEffortLevel, setDefaultEffortLevel,
    isAnalyticsEnabled, setAnalyticsEnabled,
    getSessionSyncConfig, setSessionSyncConfig, SessionSyncConfig,
    isExtensionDevToolsEnabled, setExtensionDevToolsEnabled,
    getAppSetting, setAppSetting,
    getAlphaFeatures, setAlphaFeatures,
    getBetaFeatures, setBetaFeatures,
    getEnableAllBetaFeatures, setEnableAllBetaFeatures,
    getDeveloperFeatures, setDeveloperFeatures, isDeveloperFeatureAvailable,
    isShowTrayIcon,
    getDebugFlags, setDebugFlags, type DebugFlags,
    setPreferredAgentLanguage,
    getMultiProjectMode, setMultiProjectMode,
    getOpenProjectPaths, setOpenProjectPaths,
    getActiveProjectPath, setActiveProjectPath,
    getRestorePreviousProjectsOnLaunch, setRestorePreviousProjectsOnLaunch,
    getOnboardingState, updateOnboardingState,
    isDeveloperMode, setDeveloperMode,
    isFeatureWalkthroughCompleted, setFeatureWalkthroughCompleted,
    isWorktreeOnboardingShown, setWorktreeOnboardingShown,
    getClaudeCodeSettings,
    setClaudeCodeProjectCommandsEnabled, setClaudeCodeUserCommandsEnabled,
    getAgentWorkflowSourceSettings, getAgentWorkflowExportSettings,
    setAgentWorkflowSourceSettings, setAgentWorkflowExportSettings,
} from '../utils/store';
import { getEnhancedPath } from '../services/CLIManager';
import { logger } from '../utils/logger';
import { SessionNamingService } from '../services/SessionNamingService';
import { SoundNotificationService } from '../services/SoundNotificationService';
import { autoUpdaterService } from '../services/autoUpdater';
import type { OnboardingState } from '../utils/store';
import { getCredentials, resetCredentials, generateQRPairingPayload, isUsingSecureStorage } from '../services/CredentialService';
import { onSyncStatusChange, updateSleepPrevention } from '../services/SyncManager';
import * as StytchAuth from '../services/StytchAuthService';
import { getRestartSignalPath } from '../utils/appPaths';
import { TrayManager } from '../tray/TrayManager';
import { STYTCH_CONFIG } from '@nimbalyst/runtime';
import { type EffortLevel, parseEffortLevel } from '@nimbalyst/runtime/ai/server/effortLevels';

// Track if we've subscribed to sync status changes
let syncStatusListenerSetup = false;

// Track if Stytch has been initialized
let stytchInitialized = false;

/**
 * Ensure Stytch is initialized based on current sync config.
 * This is called lazily when any Stytch IPC is invoked.
 */
function ensureStytchInitialized(): void {
    if (stytchInitialized) return;

    const config = STYTCH_CONFIG.live;

    logger.main.info('[SettingsHandlers] Lazy-initializing Stytch');

    StytchAuth.initializeStytchAuth({
        projectId: config.projectId,
        publicToken: config.publicToken,
        apiBase: config.apiBase,
    });

    stytchInitialized = true;
}

/**
 * Get the local network IP address (for LAN access from mobile devices)
 */
function getLocalNetworkIP(): string | null {
    const interfaces = os.networkInterfaces();
    for (const name of Object.keys(interfaces)) {
        const iface = interfaces[name];
        if (!iface) continue;
        for (const info of iface) {
            // Skip internal (loopback) and non-IPv4 addresses
            if (info.internal || info.family !== 'IPv4') continue;
            // Return the first non-internal IPv4 address
            return info.address;
        }
    }
    return null;
}

export function registerSettingsHandlers() {
    // Generic app settings get/set (for extension storage)
    safeHandle('app-settings:get', (_event, key: string) => {
        return getAppSetting(key);
    });

    safeHandle('app-settings:set', (_event, key: string, value: unknown) => {
        setAppSetting(key, value);
    });

    // Spellcheck toggle - controls Chromium's built-in spellchecker for all windows
    safeHandle('spellcheck:set-enabled', (_event, enabled: boolean) => {
        session.defaultSession.setSpellCheckerEnabled(enabled);
        setAppSetting('spellcheckEnabled', enabled);
    });

    // Preferred agent language. Persists to the electron-store and pushes
    // the new value into the runtime so providers pick it up on the next turn.
    safeHandle('preferred-agent-language:set', (_event, language: unknown) => {
        const value = typeof language === 'string' ? language : undefined;
        setPreferredAgentLanguage(value);
        SessionNamingService.getInstance().setLanguage(value);
    });

    safeHandle('preferred-agent-language:get', () => {
        return getAppSetting<string>('preferredAgentLanguage') ?? '';
    });

    safeHandle('session-progress-naming:get', () => {
        const current = getAppSetting<{ enabled?: boolean; cadenceTurns?: number; titleTemplate?: string }>('sessionProgressNaming');
        const template = typeof current?.titleTemplate === 'string' ? current.titleTemplate.trim() : '';
        return {
            enabled: current?.enabled === true,
            cadenceTurns: Number.isFinite(Number(current?.cadenceTurns))
                ? Math.max(1, Math.min(50, Math.round(Number(current?.cadenceTurns))))
                : 10,
            titleTemplate: template.includes('{name}') ? template.slice(0, 200) : '',
        };
    });

    safeHandle('session-progress-naming:set', (_event, config: unknown) => {
        const raw = (config && typeof config === 'object')
            ? config as { enabled?: unknown; cadenceTurns?: unknown; titleTemplate?: unknown }
            : {};
        const rawTemplate = typeof raw.titleTemplate === 'string' ? raw.titleTemplate.trim() : '';
        const normalized = {
            enabled: raw.enabled === true,
            cadenceTurns: Number.isFinite(Number(raw.cadenceTurns))
                ? Math.max(1, Math.min(50, Math.round(Number(raw.cadenceTurns))))
                : 10,
            titleTemplate: rawTemplate.includes('{name}') ? rawTemplate.slice(0, 200) : '',
        };
        setAppSetting('sessionProgressNaming', normalized);
        SessionNamingService.getInstance().setSessionProgressNaming(normalized);
        return normalized;
    });

    // Get the enhanced PATH that Nimbalyst uses for spawning processes
    // This includes custom user paths, detected paths, and common system paths
    safeHandle('environment:get-enhanced-path', () => {
        return getEnhancedPath();
    });

    // ============================================================
    // Extension Secrets Storage (using safeStorage)
    // Keys are namespaced: nimbalyst:extensionId:key
    // ============================================================

    const SECRETS_DIR = 'extension-secrets';

    function getSecretsDir(): string {
        const userDataPath = app.getPath('userData');
        const secretsDir = path.join(userDataPath, SECRETS_DIR);
        if (!fs.existsSync(secretsDir)) {
            fs.mkdirSync(secretsDir, { recursive: true });
        }
        return secretsDir;
    }

    function getSecretFilePath(key: string): string {
        // Sanitize key to be filesystem-safe
        const safeKey = key.replace(/[^a-zA-Z0-9_:-]/g, '_');
        return path.join(getSecretsDir(), `${safeKey}.enc`);
    }

    safeHandle('secrets:get', async (_event, key: string) => {
        if (!key) {
            throw new Error('Key is required for secrets:get');
        }

        const filePath = getSecretFilePath(key);

        if (!fs.existsSync(filePath)) {
            return null;
        }

        try {
            const fileData = fs.readFileSync(filePath);

            if (safeStorage.isEncryptionAvailable()) {
                return safeStorage.decryptString(fileData);
            } else {
                // Fallback: read as plain text
                return fileData.toString('utf8');
            }
        } catch (error) {
            logger.main.error(`[secrets:get] Failed to read secret for key ${key}:`, error);
            return null;
        }
    });

    safeHandle('secrets:set', async (_event, key: string, value: string) => {
        if (!key) {
            throw new Error('Key is required for secrets:set');
        }
        if (value === undefined || value === null) {
            throw new Error('Value is required for secrets:set');
        }

        const filePath = getSecretFilePath(key);

        try {
            if (safeStorage.isEncryptionAvailable()) {
                const encrypted = safeStorage.encryptString(value);
                fs.writeFileSync(filePath, encrypted);
            } else {
                // Fallback: save as plain text (with warning)
                logger.main.warn(`[secrets:set] safeStorage not available - saving secret without encryption`);
                fs.writeFileSync(filePath, value, 'utf8');
            }
            logger.main.info(`[secrets:set] Secret saved for key: ${key}`);
        } catch (error) {
            logger.main.error(`[secrets:set] Failed to save secret for key ${key}:`, error);
            throw error;
        }
    });

    safeHandle('secrets:delete', async (_event, key: string) => {
        if (!key) {
            throw new Error('Key is required for secrets:delete');
        }

        const filePath = getSecretFilePath(key);

        try {
            if (fs.existsSync(filePath)) {
                fs.unlinkSync(filePath);
                logger.main.info(`[secrets:delete] Secret deleted for key: ${key}`);
            }
        } catch (error) {
            logger.main.error(`[secrets:delete] Failed to delete secret for key ${key}:`, error);
            throw error;
        }
    });

    // Get sidebar width
    safeHandle('get-sidebar-width', (_event, workspacePath: string) => {
        if (!workspacePath) {
            throw new Error('workspacePath is required for get-sidebar-width');
        }
        return getWorkspaceState(workspacePath).sidebarWidth;
    });

    // Set sidebar width
    safeOn('set-sidebar-width', (_event, payload: { workspacePath: string; width: number }) => {
        if (!payload?.workspacePath) {
            logger.store.warn('[ipc] set-sidebar-width called without workspacePath');
            return;
        }
        updateWorkspaceState(payload.workspacePath, state => {
            state.sidebarWidth = payload.width;
        });
    });

    // Get theme (async)
    safeHandle('get-theme', () => {
        return getTheme();
    });

    // Get theme (sync) - for immediate HTML script use
    // CRITICAL: Must use getThemeSync() to resolve 'system' to actual theme
    safeOn('get-theme-sync', (event) => {
        const theme = getThemeSync();
        console.log('[SettingsHandlers] get-theme-sync returning:', theme);
        event.returnValue = theme;
    });

    // Get fully-resolved theme (sync) - collapses extension/filesystem themes
    // into 'dark' | 'light' | 'crystal-dark'. Used by callers that cannot
    // consult the in-renderer extension theme registry (project picker window
    // and the flash-prevention script in index.html).
    safeOn('get-resolved-theme-sync', (event) => {
        const theme = getResolvedThemeSync();
        event.returnValue = theme;
    });

    // Get app version (from app.getVersion)
    safeHandle('get-app-version', () => {
        const { app } = require('electron');
        return app.getVersion();
    });

    // AI Chat state has been moved to unified workspace state
    // Use workspace:get-state and workspace:update-state instead

    // Completion sound settings
    safeHandle('completion-sound:is-enabled', () => {
        return isCompletionSoundEnabled();
    });

    safeHandle('completion-sound:set-enabled', (_event, enabled: boolean) => {
        setCompletionSoundEnabled(enabled);
    });

    safeHandle('completion-sound:get-type', () => {
        return getCompletionSoundType();
    });

    safeHandle('completion-sound:set-type', (_event, soundType: CompletionSoundType) => {
        setCompletionSoundType(soundType);
    });

    safeHandle('completion-sound:test', (_event, soundType: CompletionSoundType) => {
        const soundService = SoundNotificationService.getInstance();
        soundService.testSound(soundType);
    });

    // Release channel settings
    safeHandle('release-channel:get', () => {
        return getReleaseChannel();
    });

    safeHandle('release-channel:set', (_event, channel: ReleaseChannel) => {
        setReleaseChannel(channel);
        // Reconfigure auto-updater with new channel
        autoUpdaterService.reconfigureFeedURL();
        logger.store.info(`[SettingsHandlers] Release channel changed to ${channel}, auto-updater reconfigured`);
    });

    // Alpha feature flags
    safeHandle('alpha-features:get', () => {
        return getAlphaFeatures();
    });

    safeHandle('alpha-features:set', (_event, features: Record<string, boolean>) => {
        setAlphaFeatures(features as any);
        logger.store.info('[SettingsHandlers] Alpha features updated:', features);
    });

    // Beta feature flags
    safeHandle('beta-features:get', () => {
        return getBetaFeatures();
    });

    safeHandle('beta-features:set', (_event, features: Record<string, boolean>) => {
        setBetaFeatures(features as any);
        logger.store.info('[SettingsHandlers] Beta features updated:', features);
    });

    safeHandle('beta-features:get-enable-all', () => {
        return getEnableAllBetaFeatures();
    });

    safeHandle('beta-features:set-enable-all', (_event, enabled: boolean) => {
        setEnableAllBetaFeatures(enabled);
        logger.store.info('[SettingsHandlers] Enable all beta features:', enabled);
    });

    // Developer feature flags (features only available in developer mode)
    safeHandle('developer-features:get', () => {
        return getDeveloperFeatures();
    });

    safeHandle('developer-features:set', (_event, features: Record<string, boolean>) => {
        setDeveloperFeatures(features as any);
        logger.store.info('[SettingsHandlers] Developer features updated:', features);
    });

    // Check if a specific developer feature is available (developer mode + feature enabled)
    safeHandle('developer-features:is-available', (_event, tag: string) => {
        return isDeveloperFeatureAvailable(tag as any);
    });

    // Debug flags (verbose logging toggles, off by default)
    safeHandle('debug-flags:get', () => {
        return getDebugFlags();
    });

    safeHandle('debug-flags:set', (_event, flags: Partial<DebugFlags>) => {
        setDebugFlags(flags);
        // Mirror to all renderers so the in-renderer atom + window mirror stay in sync without
        // a full reload. Renderers register a listener for 'debug-flags:changed'.
        const next = getDebugFlags();
        for (const win of BrowserWindow.getAllWindows()) {
            win.webContents.send('debug-flags:changed', next);
        }
        logger.store.info('[SettingsHandlers] Debug flags updated:', next);
    });

    // Get recent projects
    safeHandle('settings:get-recent-projects', () => {
        return getRecentItems('workspaces');
    });

    // Multi-project rail (opt-in: hosts multiple projects in a single window)
    safeHandle('app:get-multi-project-mode', async () => {
        return getMultiProjectMode();
    });

    safeHandle('app:set-multi-project-mode', async (_event, enabled: boolean) => {
        setMultiProjectMode(enabled);
    });

    safeHandle('app:get-open-projects', async () => {
        return getOpenProjectPaths();
    });

    safeHandle('app:set-open-projects', async (_event, paths: string[]) => {
        setOpenProjectPaths(Array.isArray(paths) ? paths : []);
    });

    safeHandle('app:get-active-project-path', async () => {
        return getActiveProjectPath();
    });

    safeHandle('app:set-active-project-path', async (_event, path: string | null) => {
        setActiveProjectPath(path);
    });

    safeHandle('app:get-restore-previous-projects', async () => {
        return getRestorePreviousProjectsOnLaunch();
    });

    safeHandle('app:set-restore-previous-projects', async (_event, enabled: boolean) => {
        setRestorePreviousProjectsOnLaunch(!!enabled);
    });

    // Onboarding state.
    //
    // Diagnostic timing is emitted here because issue #260 reports a beach-ball
    // hang on the developer-vs-standard mode picker, where this IPC is the
    // suspected stall point on cold start. The renderer races this call against
    // a timeout (see useOnboarding.ts), so we want a main-side breadcrumb that
    // tells us whether the handler ever ran and how long the underlying store
    // read took. Logs the elapsed time at info level so it lands in main.log on
    // packaged builds.
    safeHandle('onboarding:get', async () => {
        const t0 = Date.now();
        try {
            const state = getOnboardingState();
            const elapsed = Date.now() - t0;
            if (elapsed > 50) {
                logger.main.warn(`[SettingsHandlers] onboarding:get slow read: ${elapsed}ms`);
            } else {
                logger.main.info(`[SettingsHandlers] onboarding:get ok (${elapsed}ms)`);
            }
            return state;
        } catch (err) {
            logger.main.error('[SettingsHandlers] onboarding:get failed:', err);
            throw err;
        }
    });

    safeHandle('onboarding:update', async (_event, state: Partial<OnboardingState>) => {
        updateOnboardingState(state);
    });

    // Developer mode (global app setting)
    safeHandle('developer-mode:get', async () => {
        return isDeveloperMode();
    });

    safeHandle('developer-mode:set', async (_event, enabled: boolean) => {
        setDeveloperMode(enabled);
    });

    // Feature walkthrough state (shown on first launch)
    safeHandle('feature-walkthrough:is-completed', async () => {
        return isFeatureWalkthroughCompleted();
    });

    safeHandle('feature-walkthrough:set-completed', async (_event, completed: boolean) => {
        setFeatureWalkthroughCompleted(completed);
    });

    // Worktree onboarding state
    safeHandle('worktree-onboarding:is-shown', async () => {
        return isWorktreeOnboardingShown();
    });

    safeHandle('worktree-onboarding:set-shown', async (_event: Electron.IpcMainInvokeEvent, shown: boolean) => {
        setWorktreeOnboardingShown(shown);
    });

    // Default AI model settings
    safeHandle('settings:get-default-ai-model', () => {
        return getDefaultAIModel();
    });

    safeHandle('settings:set-default-ai-model', (_event, model: string) => {
        setDefaultAIModel(model);
    });

    // Default effort level settings (Opus 4.6 adaptive reasoning)
    safeHandle('settings:get-default-effort-level', () => {
        return getDefaultEffortLevel();
    });

    safeHandle('settings:set-default-effort-level', (_event, level: string) => {
        setDefaultEffortLevel(parseEffortLevel(level));
    });

    // Analytics settings
    safeHandle('analytics:is-enabled', () => {
        return isAnalyticsEnabled();
    });

    safeHandle('analytics:set-enabled', (_event, enabled: boolean) => {
        setAnalyticsEnabled(enabled);
    });

    // NOTE: MockupLM settings handlers removed - MockupLM now managed via extension system

    // Claude Code settings
    safeHandle('claudeCode:get-settings', async () => {
        return getClaudeCodeSettings();
    });

    safeHandle('agentWorkflows:get-settings', async () => {
        return {
            sourceSettings: getAgentWorkflowSourceSettings(),
            exportSettings: getAgentWorkflowExportSettings(),
        };
    });

    // Claude Code user-level environment variables (~/.claude/settings.json)
    safeHandle('claudeSettings:get-env', async () => {
        const { ClaudeSettingsManager } = await import('../services/ClaudeSettingsManager');
        const claudeSettingsManager = ClaudeSettingsManager.getInstance();
        return claudeSettingsManager.getUserLevelEnv();
    });

    safeHandle('claudeSettings:set-env', async (_event, env: Record<string, string>) => {
        const { ClaudeSettingsManager } = await import('../services/ClaudeSettingsManager');
        const claudeSettingsManager = ClaudeSettingsManager.getInstance();
        await claudeSettingsManager.setUserLevelEnv(env);
        logger.store.info('[SettingsHandlers] Claude Code user-level env vars updated');
        return { success: true };
    });

    safeHandle('claudeCode:set-project-commands-enabled', async (_event, enabled: boolean) => {
        setClaudeCodeProjectCommandsEnabled(enabled);
        logger.store.info(`[SettingsHandlers] Claude Code project commands ${enabled ? 'enabled' : 'disabled'}`);
    });

    safeHandle('claudeCode:set-user-commands-enabled', async (_event, enabled: boolean) => {
        setClaudeCodeUserCommandsEnabled(enabled);
        logger.store.info(`[SettingsHandlers] Claude Code user commands ${enabled ? 'enabled' : 'disabled'}`);
    });

    safeHandle('agentWorkflows:set-source-settings', async (_event, updates: {
        workspaceClaudeCompatibilityEnabled?: boolean;
        includeProjectClaudeSources?: boolean;
        includeUserClaudeSources?: boolean;
        extensionWorkflowsEnabled?: boolean;
    }) => {
        const next = setAgentWorkflowSourceSettings(updates ?? {});
        logger.store.info('[SettingsHandlers] Agent workflow source settings updated');
        return next;
    });

    safeHandle('agentWorkflows:set-export-settings', async (_event, updates: {
        codexEnabled?: boolean;
        claudeGeneratedExtensionWorkflowsEnabled?: boolean;
    }) => {
        const next = setAgentWorkflowExportSettings(updates ?? {});
        logger.store.info('[SettingsHandlers] Agent workflow export settings updated');
        return next;
    });

    // Extension Development Kit (EDK) settings
    safeHandle('extensionDevTools:is-enabled', () => {
        return isExtensionDevToolsEnabled();
    });

    safeHandle('extensionDevTools:set-enabled', async (_event, enabled: boolean) => {
        setExtensionDevToolsEnabled(enabled);
        logger.store.info(`[SettingsHandlers] Extension dev tools ${enabled ? 'enabled' : 'disabled'}`);

        // Start or stop the ExtensionDevService based on the new setting
        const { ExtensionDevService } = await import('../services/ExtensionDevService');
        const service = ExtensionDevService.getInstance();

        if (enabled) {
            await service.start();
        } else {
            await service.shutdown();
        }
    });

    safeHandle('extensionDevTools:get-logs', async (_event, filter?: {
        extensionId?: string;
        lastSeconds?: number;
        logLevel?: 'error' | 'warn' | 'info' | 'debug' | 'all';
        source?: 'renderer' | 'main' | 'build' | 'all';
    }) => {
        const { ExtensionLogService } = await import('../services/ExtensionLogService');
        const logService = ExtensionLogService.getInstance();

        const logs = logService.getLogs({
            extensionId: filter?.extensionId,
            lastSeconds: filter?.lastSeconds ?? 300, // Default to 5 minutes for UI
            logLevel: filter?.logLevel ?? 'all',
            source: filter?.source ?? 'all',
        });

        const stats = logService.getStats();

        return { logs, stats };
    });

    safeHandle('extensionDevTools:clear-logs', async (_event, extensionId?: string) => {
        const { ExtensionLogService } = await import('../services/ExtensionLogService');
        const logService = ExtensionLogService.getInstance();

        if (extensionId) {
            logService.clearForExtension(extensionId);
        } else {
            logService.clear();
        }
    });

    safeHandle('extensionDevTools:get-process-info', () => {
        // Return process start time as epoch milliseconds
        const uptimeSeconds = process.uptime();
        const startTime = Date.now() - (uptimeSeconds * 1000);
        return {
            startTime,
            uptimeSeconds,
        };
    });

    // App restart (used by extension dev mode)
    safeHandle('app:restart', async () => {
        const { app } = await import('electron');
        const path = await import('path');
        const fs = await import('fs');

        // Check if we're in dev mode (electron-vite spawns both vite and electron)
        const isDev = process.env.NODE_ENV === 'development' || !!process.env.ELECTRON_RENDERER_URL;

        if (isDev) {
            // In dev mode, write a restart signal file and quit.
            // The outer dev-loop.sh script watches for this file and restarts npm run dev.
            const restartSignalPath = getRestartSignalPath();

            logger.store.info(`[app:restart] Dev mode restart: writing signal to ${restartSignalPath}`);

            fs.writeFileSync(restartSignalPath, Date.now().toString(), 'utf8');

            // Give the file a moment to be written, then quit
            setTimeout(() => {
                app.quit();
            }, 100);

            return { success: true, mode: 'dev' };
        } else {
            // In production, use the standard relaunch mechanism
            app.relaunch();
            app.exit(0);

            return { success: true, mode: 'production' };
        }
    });

    // Session sync settings
    safeHandle('sync:get-config', () => {
        return getSessionSyncConfig();
    });

    safeHandle('sync:set-config', async (_event, config: SessionSyncConfig | null) => {
        setSessionSyncConfig(config ?? undefined);
        logger.store.info(`[SettingsHandlers] Session sync ${config?.enabled ? 'enabled' : 'disabled'}`);

        // Reinitialize sync with the new configuration
        try {
            const { repositoryManager } = await import('../services/RepositoryManager');
            await repositoryManager.reinitializeSyncWithNewConfig();
        } catch (error) {
            logger.store.error('[SettingsHandlers] Failed to reinitialize sync:', error);
        }
    });

    // Switch which account's personalOrgId is used for session sync.
    // This persists the choice and reinitializes sync to connect to the new index room.
    safeHandle('sync:switch-sync-account', async (_event, personalOrgId: string) => {
        ensureStytchInitialized();
        const accounts = StytchAuth.getAccounts();
        const account = accounts.find(a => a.personalOrgId === personalOrgId);
        if (!account) {
            return { success: false, error: 'Account not found' };
        }

        const currentConfig = getSessionSyncConfig();
        if (!currentConfig) {
            return { success: false, error: 'Sync not configured' };
        }

        // Update the persisted sync identity
        setSessionSyncConfig({
            ...currentConfig,
            personalOrgId: account.personalOrgId,
            personalUserId: account.personalUserId ?? undefined,
        });
        logger.store.info('[SettingsHandlers] Switched sync account to:', account.email, account.personalOrgId);

        // Reinitialize sync with the new identity
        try {
            const { repositoryManager } = await import('../services/RepositoryManager');
            await repositoryManager.reinitializeSyncWithNewConfig();
        } catch (error) {
            logger.store.error('[SettingsHandlers] Failed to reinitialize sync after account switch:', error);
            return { success: false, error: 'Failed to reinitialize sync' };
        }

        return { success: true };
    });

    safeHandle('sync:set-prevent-sleep', (_event, mode: 'off' | 'always' | 'pluggedIn') => {
        const currentConfig = getSessionSyncConfig();
        if (currentConfig) {
            setSessionSyncConfig({ ...currentConfig, preventSleepMode: mode, preventSleepWhenSyncing: undefined });
        }
        // Update the blocker state without full sync reinit
        updateSleepPrevention();
        return { success: true };
    });

    safeHandle('sync:test-connection', async (_event, config: SessionSyncConfig) => {
        // Simple test - try to connect to the health endpoint
        if (!config.serverUrl) {
            return { success: false, error: 'Server URL is required' };
        }

        // Require Stytch authentication
        const jwt = StytchAuth.getSessionJwt();
        if (!jwt) {
            return { success: false, error: 'Not authenticated. Please sign in first.' };
        }

        try {
            // Convert ws:// to http:// for health check
            const httpUrl = config.serverUrl
                .replace(/^ws:/, 'http:')
                .replace(/^wss:/, 'https:')
                .replace(/\/$/, '');

            const response = await fetch(`${httpUrl}/health`, {
                method: 'GET',
                headers: {
                    'Authorization': `Bearer ${jwt}`,
                },
                signal: AbortSignal.timeout(5000),
            });

            if (response.ok) {
                // CollabV3 returns plain text "OK"
                const text = await response.text();
                try {
                    const data = JSON.parse(text);
                    return { success: true, data };
                } catch {
                    // Plain text response (e.g., "OK" from CollabV3)
                    return { success: true, data: { status: text } };
                }
            } else {
                return { success: false, error: `Server returned ${response.status}` };
            }
        } catch (error) {
            const message = error instanceof Error ? error.message : 'Connection failed';
            return { success: false, error: message };
        }
    });

    // Get connected devices from the sync server
    safeHandle('sync:get-devices', async () => {
        const config = getSessionSyncConfig();

        if (!config?.enabled || !config.serverUrl) {
            return { success: false, devices: [], error: 'Sync not configured' };
        }

        // Require Stytch authentication
        const jwt = StytchAuth.getSessionJwt();
        if (!jwt) {
            return { success: false, devices: [], error: 'Not authenticated' };
        }

        try {
            // Fetch via the /api/sessions endpoint which forwards to IndexRoom status
            const httpUrl = config.serverUrl
                .replace(/^ws:/, 'http:')
                .replace(/^wss:/, 'https:')
                .replace(/\/$/, '');

            const response = await fetch(`${httpUrl}/api/sessions`, {
                method: 'GET',
                headers: {
                    'Authorization': `Bearer ${jwt}`,
                },
                signal: AbortSignal.timeout(5000),
            });

            if (response.ok) {
                const data = await response.json();
                return {
                    success: true,
                    devices: data.devices || [],
                    sessionCount: data.session_count || 0,
                    projectCount: data.project_count || 0,
                };
            } else {
                return { success: false, devices: [], error: `Server returned ${response.status}` };
            }
        } catch (error) {
            const message = error instanceof Error ? error.message : 'Failed to get devices';
            return { success: false, devices: [], error: message };
        }
    });

    // Get sync status for the navigation gutter button
    safeHandle('sync:get-status', async (_event, workspacePath?: string) => {
        const config = getSessionSyncConfig();

        // Lazy init Stytch to check auth status
        ensureStytchInitialized();

        // Sync is "configured" if the user is authenticated with Stytch
        // The serverUrl is derived from environment (defaults to wss://sync.nimbalyst.com)
        // so we don't need to check config.serverUrl anymore
        if (!StytchAuth.isAuthenticated()) {
            return {
                appConfigured: false,
                projectEnabled: false,
                connected: false,
                syncing: false,
                error: null,
                stats: {
                    sessionCount: 0,
                    lastSyncedAt: null,
                },
            };
        }

        // Check if project is enabled - only explicitly selected projects sync
        const enabledProjects = config?.enabledProjects ?? [];
        const isProjectEnabled = workspacePath ? enabledProjects.includes(workspacePath) : false;

        // Get sync provider status from SyncManager
        const { isSyncEnabled, getSyncProvider } = await import('../services/SyncManager');
        const provider = getSyncProvider();
        const syncActive = isSyncEnabled();

        // Get session count for this workspace using a simple, fast query
        let sessionCount = 0;
        let lastSyncedAt: number | null = null;

        if (workspacePath && syncActive) {
            try {
                // Get session count for status display (only called on mount, not polled)
                const { database } = await import('../database/PGLiteDatabaseWorker');
                const { rows } = await database.query<{ count: string; max_updated: Date | null }>(
                    `SELECT COUNT(*) as count, MAX(updated_at) as max_updated
                     FROM ai_sessions
                     WHERE workspace_id = $1 AND (is_archived = FALSE OR is_archived IS NULL)`,
                    [workspacePath]
                );
                if (rows[0]) {
                    sessionCount = parseInt(rows[0].count) || 0;
                    if (rows[0].max_updated) {
                        lastSyncedAt = rows[0].max_updated instanceof Date
                            ? rows[0].max_updated.getTime()
                            : new Date(rows[0].max_updated).getTime();
                    }
                }
            } catch (error) {
                logger.store.warn('[sync:get-status] Failed to get session count:', error);
            }
        }

        // Check connection status
        // The provider doesn't expose a direct "isConnected" status, but we can infer from syncActive
        const connected = syncActive && provider !== null;

        // Get doc sync stats from ProjectFileSyncService
        let docSyncStats = { projectCount: 0, fileCount: 0, connected: false };
        try {
            const { getProjectFileSyncService } = await import('../services/ProjectFileSyncService');
            docSyncStats = getProjectFileSyncService().getStats();
        } catch {
            // Non-fatal
        }

        return {
            appConfigured: true,
            projectEnabled: isProjectEnabled,
            connected,
            syncing: false, // We don't have real-time syncing status yet
            error: null,
            stats: {
                sessionCount,
                lastSyncedAt,
            },
            docSyncStats,
            userEmail: StytchAuth.getUserEmail(),
        };
    });

    // Toggle sync for a specific project
    safeHandle('sync:toggle-project', async (_event, workspacePath: string, enabled: boolean) => {
        if (!workspacePath) {
            throw new Error('workspacePath is required for sync:toggle-project');
        }

        // Bootstrap config if it doesn't exist yet (e.g., user just authenticated
        // but hasn't explicitly configured sync settings)
        let config = getSessionSyncConfig();
        if (!config) {
            config = { enabled: false, serverUrl: '', enabledProjects: [] };
        }

        let enabledProjects = config.enabledProjects || [];

        if (enabled) {
            // Add project to enabled list if not already present
            if (!enabledProjects.includes(workspacePath)) {
                enabledProjects = [...enabledProjects, workspacePath];
            }
        } else {
            // Remove project from enabled list
            enabledProjects = enabledProjects.filter(p => p !== workspacePath);
        }

        // Save updated config (also update enabled based on whether any projects are selected)
        setSessionSyncConfig({
            ...config,
            enabledProjects,
            enabled: enabledProjects.length > 0,
        });

        logger.store.info(`[sync:toggle-project] Project sync ${enabled ? 'enabled' : 'disabled'} for: ${workspacePath}`);

        // If a project was enabled, trigger sync to push its sessions immediately
        if (enabled) {
            try {
                const { triggerIncrementalSync, isSyncProviderReady } = await import('../services/SyncManager');
                if (isSyncProviderReady()) {
                    // Provider exists - trigger incremental sync directly
                    triggerIncrementalSync().catch(err => {
                        logger.store.error('[sync:toggle-project] Failed to trigger sync:', err);
                    });
                } else {
                    // Provider not ready yet (e.g. sync was just enabled) - reinitialize
                    // which will create the provider and run initial sync including this project
                    const { repositoryManager } = await import('../services/RepositoryManager');
                    repositoryManager.reinitializeSyncWithNewConfig().catch(err => {
                        logger.store.error('[sync:toggle-project] Failed to reinitialize sync:', err);
                    });
                }
            } catch (err) {
                logger.store.error('[sync:toggle-project] Failed to trigger sync:', err);
            }
        }

        return { success: true };
    });

    // Subscribe to sync status changes and broadcast to all windows
    // This is called once when the first window requests it
    safeHandle('sync:subscribe-status', () => {
        if (syncStatusListenerSetup) {
            return; // Already subscribed
        }
        syncStatusListenerSetup = true;

        onSyncStatusChange((status) => {
            // Broadcast to all windows
            for (const window of BrowserWindow.getAllWindows()) {
                window.webContents.send('sync:status-changed', status);
            }
        });

        logger.store.info('[sync:subscribe-status] Subscribed to sync status changes');
    });

    // ============================================================
    // Credential Management (for E2E encryption key)
    // ============================================================

    // Get encryption key info (for sync pairing)
    safeHandle('credentials:get', () => {
        const creds = getCredentials();
        return {
            encryptionKeySeed: creds.encryptionKeySeed,
            createdAt: creds.createdAt,
            isSecure: isUsingSecureStorage(),
        };
    });

    // Reset encryption key (generates new one - invalidates paired devices)
    safeHandle('credentials:reset', () => {
        const creds = resetCredentials();
        return {
            encryptionKeySeed: creds.encryptionKeySeed,
            createdAt: creds.createdAt,
            isSecure: isUsingSecureStorage(),
        };
    });

    // Generate QR pairing payload for mobile device
    safeHandle('credentials:generate-qr-payload', (_event, serverUrl: string) => {
        if (!serverUrl) {
            throw new Error('serverUrl is required for QR pairing');
        }
        // Include the sync email so mobile can validate it matches their login.
        // Include personalOrgId/personalUserId so mobile uses the same room IDs as desktop.
        const authState = StytchAuth.getAuthState();
        const syncEmail = authState.user?.emails?.[0]?.email;
        const personalOrgId = StytchAuth.getPersonalOrgId() ?? undefined;
        const personalUserId = StytchAuth.getPersonalUserId() ?? undefined;

        // Persist the sync identity at pairing time -- this is the authoritative
        // moment for which org sessions should sync to. Survives logout/re-login
        // so login order doesn't matter.
        if (personalOrgId) {
            const currentConfig = getSessionSyncConfig();
            if (currentConfig) {
                setSessionSyncConfig({
                    ...currentConfig,
                    personalOrgId,
                    personalUserId,
                });
            }
        }

        return generateQRPairingPayload(
            serverUrl,
            syncEmail,
            personalOrgId,
            personalUserId,
        );
    });

    // Check if secure storage (keychain) is available
    safeHandle('credentials:is-secure', () => {
        return isUsingSecureStorage();
    });

    // Get local network IP for mobile pairing with local dev server
    safeHandle('network:get-local-ip', () => {
        return getLocalNetworkIP();
    });

    // ============================================================
    // Stytch Authentication (for account-based sync)
    // ============================================================

    // Get current Stytch auth state
    safeHandle('stytch:get-auth-state', () => {
        ensureStytchInitialized();
        return StytchAuth.getAuthState();
    });

    // Get all signed-in accounts (public info, no JWTs)
    safeHandle('stytch:get-accounts', () => {
        ensureStytchInitialized();
        return StytchAuth.getAccounts();
    });

    // Check if user is authenticated with Stytch
    safeHandle('stytch:is-authenticated', () => {
        ensureStytchInitialized();
        return StytchAuth.isAuthenticated();
    });

    // Sign in with Google OAuth
    safeHandle('stytch:sign-in-google', async () => {
        ensureStytchInitialized();
        // Get the sync server URL from settings
        const syncConfig = getSessionSyncConfig();
        const isDev = process.env.NODE_ENV !== 'production';

        // Only honor environment config in dev builds - production builds always use production
        const effectiveEnvironment = isDev ? syncConfig?.environment : undefined;

        // Derive server URL from environment - don't rely on persisted serverUrl
        let serverUrl: string;
        if (effectiveEnvironment === 'development') {
            serverUrl = 'ws://localhost:8790';
        } else {
            // Production is the default (for both prod builds and when not explicitly set in dev)
            serverUrl = 'wss://sync.nimbalyst.com';
        }

        // Convert WebSocket URLs to HTTP: wss:// -> https://, ws:// -> http://
        const httpUrl = serverUrl.replace(/^wss:/, 'https:').replace(/^ws:/, 'http:');
        logger.main.info('[stytch:sign-in-google] Auth URL:', httpUrl, 'effectiveEnvironment:', effectiveEnvironment);
        return StytchAuth.signInWithGoogle(httpUrl);
    });

    // Send magic link for passwordless authentication
    safeHandle('stytch:send-magic-link', async (_event, email: string) => {
        ensureStytchInitialized();
        if (!email) {
            return { success: false, error: 'Email is required' };
        }
        // Get the sync server URL from settings
        const syncConfig = getSessionSyncConfig();
        const isDev = process.env.NODE_ENV !== 'production';

        // Only honor environment config in dev builds - production builds always use production
        const effectiveEnvironment = isDev ? syncConfig?.environment : undefined;

        // Derive server URL from environment - don't rely on persisted serverUrl
        let serverUrl: string;
        if (effectiveEnvironment === 'development') {
            serverUrl = 'ws://localhost:8790';
        } else {
            // Production is the default (for both prod builds and when not explicitly set in dev)
            serverUrl = 'wss://sync.nimbalyst.com';
        }

        // Convert WebSocket URLs to HTTP: wss:// -> https://, ws:// -> http://
        const httpUrl = serverUrl.replace(/^wss:/, 'https:').replace(/^ws:/, 'http:');
        logger.main.info('[stytch:send-magic-link] Sending to:', httpUrl, 'effectiveEnvironment:', effectiveEnvironment);
        return StytchAuth.sendMagicLink(email, httpUrl);
    });

    // Sign out (all accounts)
    safeHandle('stytch:sign-out', async () => {
        ensureStytchInitialized();
        await StytchAuth.signOut();
        return { success: true };
    });

    // Add a new account (opens OAuth flow)
    safeHandle('stytch:add-account', async () => {
        ensureStytchInitialized();
        const syncConfig = getSessionSyncConfig();
        const isDev = process.env.NODE_ENV !== 'production';
        const effectiveEnvironment = isDev ? syncConfig?.environment : undefined;
        let serverUrl: string;
        if (effectiveEnvironment === 'development') {
            serverUrl = 'http://localhost:8790';
        } else if (syncConfig?.serverUrl) {
            serverUrl = syncConfig.serverUrl.replace(/^wss:/, 'https:').replace(/^ws:/, 'http:');
        } else {
            serverUrl = 'https://sync.nimbalyst.com';
        }
        return StytchAuth.addAccount(serverUrl);
    });

    // Remove a specific account by personalOrgId
    safeHandle('stytch:remove-account', async (_event, personalOrgId: string) => {
        ensureStytchInitialized();
        await StytchAuth.removeAccount(personalOrgId);
        return { success: true };
    });

    // Delete account and all associated data
    safeHandle('stytch:delete-account', async () => {
        ensureStytchInitialized();
        // Derive server URL same as other Stytch handlers
        const syncConfig = getSessionSyncConfig();
        const isDev = process.env.NODE_ENV !== 'production';
        const effectiveEnvironment = isDev ? syncConfig?.environment : undefined;
        let serverUrl: string;
        if (effectiveEnvironment === 'development') {
            serverUrl = 'ws://localhost:8790';
        } else {
            serverUrl = 'wss://sync.nimbalyst.com';
        }
        return StytchAuth.deleteAccount(serverUrl);
    });

    // Get session JWT for server authentication
    safeHandle('stytch:get-session-jwt', () => {
        ensureStytchInitialized();
        return StytchAuth.getSessionJwt();
    });

    // Validate and refresh the current session
    safeHandle('stytch:refresh-session', async () => {
        ensureStytchInitialized();
        return StytchAuth.validateAndRefreshSession();
    });

    // Subscribe to auth state changes
    safeHandle('stytch:subscribe-auth-state', () => {
        ensureStytchInitialized();
        // Set up listener to broadcast auth state changes to all windows
        StytchAuth.onAuthStateChange((state) => {
            for (const window of BrowserWindow.getAllWindows()) {
                window.webContents.send('stytch:auth-state-changed', state);
            }
        });
        return StytchAuth.getAuthState();
    });

    // ============================================================
    // System Tray Settings
    // ============================================================

    safeHandle('tray:get-visible', () => {
        return isShowTrayIcon();
    });

    safeHandle('tray:set-visible', (_event, visible: boolean) => {
        TrayManager.getInstance().setVisible(visible);
        logger.store.info(`[SettingsHandlers] Tray icon ${visible ? 'shown' : 'hidden'}`);
    });

    // ============================================================
    // External Editor Settings
    // ============================================================

    safeHandle('external-editor:get-settings', () => {
        const editorType = getAppSetting('externalEditorType') ?? 'none';
        const customPath = getAppSetting('externalEditorCustomPath') ?? '';
        return { editorType, customPath };
    });

    safeHandle('external-editor:set-settings', (_event, settings: { editorType: string; customPath?: string }) => {
        if (!settings) {
            throw new Error('Settings object is required for external-editor:set-settings');
        }
        setAppSetting('externalEditorType', settings.editorType);
        setAppSetting('externalEditorCustomPath', settings.customPath ?? '');
        logger.store.info(`[SettingsHandlers] External editor settings updated: ${settings.editorType}`);
    });

    // Switch Stytch environment (dev only - signs out and switches to test/live)
    safeHandle('stytch:switch-environment', async (_event, environment: 'development' | 'production') => {
        try {
            // Reset initialized flag so next call re-initializes with new environment
            stytchInitialized = false;
            await StytchAuth.switchStytchEnvironment(environment);
            stytchInitialized = true; // Mark as initialized after switch
            return { success: true };
        } catch (error) {
            logger.main.error('[Settings] Failed to switch Stytch environment:', error);
            return { success: false, error: String(error) };
        }
    });
}
