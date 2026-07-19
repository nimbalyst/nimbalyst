import { app, BrowserWindow, dialog, nativeImage, nativeTheme, session } from 'electron';
import { safeHandle, safeOn } from './utils/ipcRegistry';
import { markBootComplete } from './utils/bootState';
import { markStart, markEnd, checkpoint, logSummary } from './utils/startupTiming';
import type { SessionStore } from '@nimbalyst/runtime';
import * as os from 'os';
import { randomUUID } from 'crypto';
import * as path from 'path';
import { join } from 'path';
import * as fs from 'fs';
import { appendFileSync, existsSync, renameSync, unlinkSync, writeFileSync } from 'fs';
import { createWindow, findWindowByFilePath, findWindowByWorkspace, getMostRecentlyFocusedWorkspaceWindow } from './window/WindowManager';
import { loadFileIntoWindow } from './file/FileOperations';
import { createApplicationMenu } from './menu/ApplicationMenu';
import { updateNativeTheme, updateWindowTitleBars } from './theme/ThemeManager';
import { restoreSessionState, saveSessionState } from './session/SessionState';
import { getRestartSignalPath } from './utils/appPaths';
import { createWorkspaceManagerWindow, setupWorkspaceManagerHandlers, wasWorkspaceManagerManuallyClosed } from './window/WorkspaceManagerWindow.ts';
import { setupTeamManagementHandlers } from './window/TeamManagementWindow';
import { showSplashScreen, closeSplashScreen } from './window/SplashScreen';
import { registerFileHandlers } from './ipc/FileHandlers';
import { registerWorkspaceHandlers } from './ipc/WorkspaceHandlers.ts';
import { registerSettingsHandlers } from './ipc/SettingsHandlers';
import { registerWindowHandlers } from './ipc/WindowHandlers';
import { registerEditorStateHandlers } from './ipc/EditorStateHandlers';
import { registerHistoryHandlers } from './ipc/HistoryHandlers';
import { registerSessionHandlers } from './ipc/SessionHandlers';
import { registerSessionStateHandlers, shutdownSessionStateHandlers, hasActiveStreamingSessions } from './ipc/SessionStateHandlers';
import { registerAttachmentHandlers } from './ipc/AttachmentHandlers';
import { registerThemeHandlers } from './ipc/ThemeHandlers';
import { registerWorkspaceWatcherHandlers } from './file/WorkspaceWatcher';
import { setupSessionFileHandlers } from './ipc/SessionFileHandlers';
import { registerSlashCommandHandlers } from './ipc/SlashCommandHandlers';
import { registerActionPromptHandlers } from './ipc/ActionPromptHandlers';
import { registerClaudeCodeHandlers } from './ipc/ClaudeCodeHandlers';
import { registerCodexAuthHandlers } from './ipc/CodexAuthHandlers';
import { initializeClaudeCodeSessionHandlers } from './ipc/ClaudeCodeSessionHandlers';
import { registerNotificationHandlers } from './ipc/NotificationHandlers';
import { registerPermissionHandlers } from './ipc/PermissionHandlers';
import { registerGitStatusHandlers } from './ipc/GitStatusHandlers';
import { registerGitHandlers } from './ipc/GitHandlers';
import { registerProjectSelectionHandlers } from './ipc/ProjectSelectionHandlers';
import { registerMultiProjectRailHandlers } from './ipc/MultiProjectRailHandlers';
import { registerUsageAnalyticsHandlers } from './ipc/UsageAnalyticsHandlers';
import { registerWorktreeHandlers } from './ipc/WorktreeHandlers';
import { registerPullRequestHandlers, stopPullRequestPollScheduler } from './ipc/PullRequestHandlers';
import { registerReadReceiptHandlers } from './ipc/ReadReceiptHandlers';
import { registerTrackerPersonalStateHandlers } from './ipc/TrackerPersonalStateHandlers';
import { registerWakeupHandlers } from './ipc/WakeupHandlers';
import { registerBlitzHandlers } from './ipc/BlitzHandlers';
import { registerProjectMigrationHandlers } from './ipc/ProjectMigrationHandlers';
import { registerSuperLoopHandlers } from './ipc/SuperLoopHandlers';
import { getSuperLoopService } from './services/SuperLoopService';
import {
    type AppTheme,
    dismissClaudeCodeWindowsWarning,
    dismissCommunityPopup,
    dismissDiscordInvitation,
    getCompletedSessionsWithTools,
    markCommunityPopupShown,
    shouldShowCommunityPopup,
    shouldShowRosettaWarning,
    dismissRosettaWarning,
    getSessionSyncConfig,
    addToRecentItems,
    getTheme,
    hasCheckedClaudeCodeInstallation,
    incrementLaunchCount,
    wasCommunityPopupShownThisLaunch,
    markClaudeCodeInstallationChecked,
    setTheme,
    clearPendingThemeFallback,
    updateWorkspaceState,
    runMigrations,
    getAppSetting,
    getClaudeCodeSettings,
    isSettingsAgentToolsDisabled,
    isTrackersAgentToolsEnabled,
    store
} from './utils/store';
import { getAIProviderOverridesWithWorktreeFallback } from './utils/aiSettingsMerge';
import { registerMCPConfigHandlers } from './ipc/MCPConfigHandlers';
import { getOpenCodeConfigService, registerOpenCodeConfigHandlers } from './ipc/OpenCodeConfigHandlers';
import { registerClaudeCodePluginHandlers } from './ipc/ClaudeCodePluginHandlers';
import { registerExportHandlers } from './ipc/ExportHandlers';
import { registerSemanticSearchHandlers } from './ipc/SemanticSearchHandlers';
import { SemanticCatalogService } from './services/SemanticCatalogService';
import { registerShareHandlers } from './ipc/ShareHandlers';
import { MCPConfigService } from './services/MCPConfigService';
import { setMcpConfigServiceGetter } from './mcpConfigServiceRef';
import { ClaudeCliLauncherConfig } from './services/ai/claudeCliLauncherSingleton';
import { registerDatabaseBrowserHandlers } from './ipc/DatabaseBrowserHandlers';
import { registerDatabaseBrowserSqliteHandlers } from './ipc/DatabaseBrowserSqliteHandlers';
import { registerMigrationHandlers } from './ipc/MigrationHandlers';
import { registerTerminalHandlers, shutdownTerminalHandlers } from './ipc/TerminalHandlers';
import { AIService } from './services/ai/AIService';
import { detectFileWorkspace, suggestWorkspaceForFile, getAdditionalDirectoriesForWorkspace } from './utils/workspaceDetection';
import { cliManager, initEnhancedPath, getEnhancedPath, getShellEnvironment } from './services/CLIManager';
import { registerWorkspaceWindow, registerExtensionTools, shutdownHttpServer, startMcpHttpServer, updateDocumentState, getActiveExtensionShortNames } from './mcp/httpServer';
import { writeMcpEndpointDescriptor, removeMcpEndpointDescriptor, type EndpointWorkspace } from './mcp/mcpEndpointDescriptor';
import {
  startWorkspaceBackendModules,
  syncEnabledBackendModulesOnStartup,
  getDefaultBackendModuleLifecycleDeps,
} from './extensions/backendModuleLifecycle';
// MCP consolidation Phase 7: sessionContextServer / settingsServer no longer run
// as standalone HTTP servers; their tool dispatch + schemas are imported by the
// unified httpServer instead. Nothing to start/shutdown from here.
import { generateMcpAuthToken, getMcpAuthToken } from './mcp/mcpAuth';
import {
  registerNimAssetSchemeAsPrivileged,
  registerNimAssetProtocolHandler,
  addNimAssetRoot,
  removeNimAssetRoot,
} from './protocols/nimAssetProtocol';
import {
  registerNimPreviewSchemeAsPrivileged,
  registerNimPreviewProtocolHandler,
  addNimPreviewWorkspaceRoot,
} from './protocols/nimPreviewProtocol';
import { registerBrowserSessionHandlers } from './ipc/BrowserSessionHandlers';
import { BrowserSessionService } from './services/BrowserSessionService';
import {
  registerCollabAssetSchemeAsPrivileged,
  installCollabAssetProtocolHandler,
} from './protocols/collabAssetProtocol';
import { SessionNamingService } from './services/SessionNamingService';
import { SessionWakeupScheduler } from './services/SessionWakeupScheduler';
import { getSessionWakeupsStore } from './services/RepositoryManager';
import { ExtensionDevService } from './services/ExtensionDevService';
import { MetaAgentService } from './services/MetaAgentService';
// SuperLoopProgressService import removed - server disabled (leaking into non-super-loop sessions)
import { registerMockupHandlers } from './ipc/MockupHandlers';
import { registerOffscreenEditorHandlers } from './ipc/OffscreenEditorHandlers';
import { initVoiceModeService } from './services/voice/VoiceModeService';
import { initVoiceModeSettingsHandler } from './services/voice/VoiceModeSettingsHandler';
import { registerWalkthroughHandlers } from './ipc/WalkthroughHandlers';
import { registerDataModelHandlers } from './ipc/DataModelHandlers';
import { registerClaudeUsageHandlers } from './ipc/ClaudeUsageHandlers';
import { claudeUsageService } from './services/ClaudeUsageService';
import { registerCodexUsageHandlers } from './ipc/CodexUsageHandlers';
import { codexUsageService } from './services/CodexUsageService';
import { registerGeminiUsageHandlers } from './ipc/GeminiUsageHandlers';
import { geminiUsageService } from './services/GeminiUsageService';
import { codexAuthService } from './services/CodexAuthService';
import { registerExtensionHandlers, getClaudePluginPaths, initializeExtensionFileTypes } from './ipc/ExtensionHandlers';
import { registerExtensionPermissionHandlers } from './ipc/ExtensionPermissionHandlers';
import { registerTrackerImporterHandlers } from './ipc/TrackerImporterHandlers';
import { installExtensionAgentBridge } from './extensions/extensionAgentBridge';
import { getAgentWorkflowService } from './services/AgentWorkflowService';
import { queueMarketplaceInstallRequest, registerExtensionMarketplaceHandlers, runExtensionAutoUpdate } from './ipc/ExtensionMarketplaceHandlers';
import { getRegisteredExtensions } from './extensions/RegisteredFileTypes';
import { ClaudeCodeProvider, OpenAICodexProvider, OpenAICodexACPProvider, OpenCodeProvider, CopilotCLIProvider } from '@nimbalyst/runtime/ai/server';
import { configureMcpServers } from '@nimbalyst/runtime/ai/server';
import { matchesAllowPattern } from '@nimbalyst/runtime/ai/server/permissions/toolPermissionHelpers';
import { resolveCodexPreEditHookScriptPath } from './services/ai/codexPreEditHookPath';
import { sessionFileTracker } from './services/SessionFileTracker';
import { historyManager } from './HistoryManager';
import { readFileContentOrNull } from './services/ai/aiServiceUtils';
import { AISessionsRepository } from '@nimbalyst/runtime/storage/repositories/AISessionsRepository';
import { isMCPServerEnabledForProvider, MCP_PROVIDER_IDS } from '@nimbalyst/runtime/types/MCPServerConfig';
import type { MCPServerConfig } from '@nimbalyst/runtime/types/MCPServerConfig';
import { logger, overrideConsole } from './utils/logger';
import { startPerformanceMonitoring, stopPerformanceMonitoring } from './utils/performanceMonitor';
import { setupForceQuit } from './utils/forceQuit';
import { stopAllFileWatchers } from './file/FileWatcher';
import { stopAllWorkspaceWatchers } from './file/WorkspaceWatcher.ts';
import { commitTrackerLinker } from './services/CommitTrackerLinker';
import { gitRefWatcher } from './file/GitRefWatcher';
import { autoUpdaterService, AutoUpdaterService } from './services/autoUpdater';
import { initializeDatabase } from './database/initialize';
import { database, HandledError } from './database/PGLiteDatabaseWorker';
import { AnalyticsService } from "./services/analytics/AnalyticsService.ts";
import { registerAnalyticsHandlers } from "./ipc/AnalyticsHandlers.ts";
import { registerFeatureUsageHandlers } from "./ipc/FeatureUsageHandlers.ts";
import { FeatureUsageService, FEATURES } from "./services/FeatureUsageService.ts";
import { shutdownStytchAuth, handleAuthCallback, isAuthenticated, getPersonalUserId } from './services/StytchAuthService';
import { registerTrackerSyncHandlers, initializeTrackerSync } from './services/TrackerSyncManager';
import { initTrackerSchemaService, updateTrackerSchemaWorkspace } from './services/TrackerSchemaService';
import { initTrackerNavigationService } from './services/TrackerNavigationService';
import { registerTeamHandlers, autoMatchTeamForWorkspace, getOrgScopedJwt, findTeamForWorkspace } from './services/TeamService';
import { windowStates, windows, resolveActiveWorkspacePath } from './window/windowState';
import { getRecentItems } from './utils/store';
import { registerOrgKeyHandlers, getOrgKey } from './services/OrgKeyService';
import { registerDocumentSyncHandlers } from './ipc/DocumentSyncHandlers';
import { getCollabOutboxDrainCoordinator } from './services/CollabOutboxDrainerService';
import { getCollabAssetOutboxDrainCoordinator } from './services/CollabAssetOutboxDrainCoordinator';
import { getCollabAssetStore } from './services/CollabAssetStore';
import { registerCollabBackupHandlers } from './ipc/CollabBackupHandlers';
import { flushPendingCollabBackups } from './services/CollabBackupService';
import { registerBuiltinCollabContentAdapters } from './services/collabContentAdapterRegistration';
import { registerCollabV3TestHandlers } from './ipc/CollabV3TestHandlers';
import { getPermissionService } from './services/PermissionService';
import { ClaudeSettingsManager } from './services/ClaudeSettingsManager';
import { TrayManager } from './tray/TrayManager';
import { pathToFileURL } from 'url';
import { registerLinuxAppImageProtocolHandler } from './services/LinuxProtocolRegistration';
import { installWindowOpenGuard } from './window/windowOpenGuard';

// CRITICAL: Hide dock icon when running as background Node process
// This prevents Terminal icon from appearing when Claude Code spawns child processes
if (process.env.ELECTRON_RUN_AS_NODE === '1' && process.platform === 'darwin') {
  // When Electron runs as Node (ELECTRON_RUN_AS_NODE=1), hide from dock
  // This must happen before app.whenReady()
  if (app.dock) {
    app.dock.hide();
  }
}

// Windows notifications require a stable AppUserModelID.
if (process.platform === 'win32') {
  app.setAppUserModelId('com.nimbalyst.electron');
}

// Issue #146: register the `nim-asset://` scheme as standard/secure BEFORE
// `app.whenReady` resolves. Per Electron docs, schemes must be marked as
// privileged before the app is ready or the renderer treats them as opaque
// origins. The actual request handler is wired up after whenReady.
registerNimAssetSchemeAsPrivileged();
registerNimPreviewSchemeAsPrivileged();
registerCollabAssetSchemeAsPrivileged();

// NIM-1487: no window may be spawned by an unhandled window.open — relative
// file links that slip past the renderer's link routing used to open blank
// white child windows.
installWindowOpenGuard();

// NOTE: User data directory configuration is handled in bootstrap.ts
// which runs BEFORE this file is imported, ensuring electron-store
// uses the correct path.

// Track pending file to open
let pendingFilePath: string | null = null;
// Track pending workspace to open
let pendingWorkspacePath: string | null = null;
// Track pending filter to apply
let pendingFilter: string | null = null;
// Track pending file to open within workspace (--file flag, requires --workspace)
let pendingCliFilePath: string | null = null;

// Session save interval
let sessionSaveInterval: NodeJS.Timeout | null = null;
let menuUpdateInterval: NodeJS.Timeout | null = null;
let memoryMonitorInterval: NodeJS.Timeout | null = null;

// Track if app is quitting
let isAppQuitting = false;

// Track if app is restarting (to prevent session state from being overwritten during window close)
let isAppRestarting = false;

/** Check if the app is in a restart flow (session state already saved) */
export function isRestarting(): boolean {
    return isAppRestarting;
}

/**
 * Mark the app as restarting. Set by code paths that have already persisted
 * session state and don't want window-close handlers to clobber it as
 * windows tear down (e.g. auto-update quit-and-install, MCP restart).
 */
export function setRestarting(value: boolean): void {
    isAppRestarting = value;
}

// Track app start time for memory monitoring
const appStartTime = Date.now();

// Stable, immutable-for-this-launch boot identity (NIM-364). Reused as the
// watcher-obligation recovery nonce and safe to expose in the MCP endpoint
// descriptor; regenerated fresh on every launch (a new PID/timestamp alone
// is not sufficient because a fast restart can collide on either).
const hostBootId = randomUUID();

// Single instance lock removed - allow multiple instances to run

const analytics = AnalyticsService.getInstance();

/**
 * Check for pending restart continuations and queue continuation prompts.
 * This is called after AIService is initialized on app startup.
 * If restart_nimbalyst was called, this queues continuation prompts for all
 * sessions that were active at restart time.
 */
async function checkForRestartContinuation(aiService: AIService): Promise<void> {
    try {
        const restartContinuationPath = path.join(app.getPath('userData'), 'restart-continuation.json');

        // Check if continuation file exists
        if (!fs.existsSync(restartContinuationPath)) {
            return;
        }

        // Read and parse continuation data
        const continuationJson = fs.readFileSync(restartContinuationPath, 'utf8');
        const continuation = JSON.parse(continuationJson);

        // Validate continuation data
        if (!continuation.sessionIds || !Array.isArray(continuation.sessionIds)) {
            logger.main.warn('[RestartContinuation] Invalid continuation data, skipping');
            fs.unlinkSync(restartContinuationPath);
            return;
        }

        const { sessionIds, timestamp } = continuation;

        // Check if continuation is stale (older than 5 minutes)
        const ageMs = Date.now() - (timestamp || 0);
        if (ageMs > 5 * 60 * 1000) {
            logger.main.warn(`[RestartContinuation] Continuation is stale (${Math.round(ageMs / 1000)}s old), skipping`);
            fs.unlinkSync(restartContinuationPath);
            return;
        }

        if (sessionIds.length === 0) {
            logger.main.info('[RestartContinuation] No active sessions to continue');
            fs.unlinkSync(restartContinuationPath);
            return;
        }

        logger.main.info(`[RestartContinuation] Found continuation for ${sessionIds.length} session(s), queueing continuation prompts`);

        // Queue continuation prompts for all sessions
        const { getQueuedPromptsStore } = await import('./services/RepositoryManager');
        const queuedPromptsStore = getQueuedPromptsStore();

        let successCount = 0;
        let errorCount = 0;

        for (const sessionId of sessionIds) {
            try {
                await queuedPromptsStore.create({
                    id: `restart-continuation-${sessionId}-${Date.now()}`,
                    sessionId,
                    prompt: 'Nimbalyst has restarted. Please continue with your work.'
                });
                successCount++;
                logger.main.info(`[RestartContinuation] Queued continuation prompt for session ${sessionId}`);
            } catch (error) {
                errorCount++;
                logger.main.error(`[RestartContinuation] Failed to queue continuation prompt for session ${sessionId}:`, error);
            }
        }

        logger.main.info(`[RestartContinuation] Continuation complete: ${successCount} succeeded, ${errorCount} failed`);

        // Delete the continuation file after processing
        fs.unlinkSync(restartContinuationPath);
    } catch (error) {
        logger.main.error('[RestartContinuation] Error checking for restart continuation:', error);
        // Try to clean up the file even on error
        try {
            const restartContinuationPath = path.join(app.getPath('userData'), 'restart-continuation.json');
            if (fs.existsSync(restartContinuationPath)) {
                fs.unlinkSync(restartContinuationPath);
            }
        } catch {}
    }
}

/**
 * Check if Claude Code is installed on first app launch.
 * This only runs once ever - on the very first launch of the app.
 * We check for the ~/.claude/ directory which is created when Claude CLI is installed.
 */
function checkClaudeCodeInstallationOnFirstLaunch(): void {
    // Only run this check once ever
    if (hasCheckedClaudeCodeInstallation()) {
        return;
    }

    try {
        // Check for Claude settings directory (~/.claude/)
        const claudeSettingsDir = path.join(os.homedir(), '.claude');
        const hasClaudeInstalled = existsSync(claudeSettingsDir);

        logger.main.info(`First launch Claude Code check: hasClaudeInstalled=${hasClaudeInstalled}`);

        // Send analytics event
        analytics.sendEvent('first_launch_claude_check', {
            hasClaudeInstalled,
        });
    } catch (error) {
        logger.main.error('Error checking Claude Code installation:', error);
    } finally {
        // Mark the check as done regardless of outcome
        markClaudeCodeInstallationChecked();
    }
}

// AI service instance
let aiService: AIService | null = null;
let runtimeSessionStore: SessionStore | null = null;
let mcpHttpServer: any = null;
let mcpConfigService: MCPConfigService | null = null;
let mcpConfigServiceCleanedUp = false;

// Publish a closure over the local variable so other modules can read the
// live MCPConfigService without back-importing this entry-point file (which
// would drag the whole app graph in at module load). See mcpConfigServiceRef.
setMcpConfigServiceGetter(() => mcpConfigService);

export { getMcpConfigService } from './mcpConfigServiceRef';

// Set custom userData path if RUN_ONE_DEV_MODE environment variable is set
// This allows running a dev instance alongside a production build without conflicts
// This must be done before app is ready and before any calls to app.getPath('userData')
if (process.env.RUN_ONE_DEV_MODE === 'true') {
    const defaultUserData = app.getPath('userData');
    const devUserData = path.join(path.dirname(defaultUserData), 'Nimbalyst-Dev');
    app.setPath('userData', devUserData);
    console.log(`Dev mode enabled: Using isolated userData path: ${devUserData}`);
}

// Log rotation constants
const MAX_DEBUG_LOG_SESSIONS = 5; // Keep current + 4 previous sessions
const MAX_MAIN_LOG_SESSIONS = 3; // Keep current + 2 previous sessions

/**
 * Rotate main process log on app startup.
 * Files: main.log (current), main.1.log (previous), main.2.log (oldest)
 */
function rotateMainLog() {
    const logsDir = join(app.getPath('userData'), 'logs');
    const baseName = 'main';
    const ext = '.log';

    try {
        // Delete oldest log if it exists
        const oldestPath = join(logsDir, `${baseName}.${MAX_MAIN_LOG_SESSIONS - 1}${ext}`);
        if (existsSync(oldestPath)) {
            unlinkSync(oldestPath);
        }

        // Shift existing logs: N-1 -> N, ..., 1 -> 2
        for (let i = MAX_MAIN_LOG_SESSIONS - 2; i >= 1; i--) {
            const currentPath = join(logsDir, `${baseName}.${i}${ext}`);
            const nextPath = join(logsDir, `${baseName}.${i + 1}${ext}`);
            if (existsSync(currentPath)) {
                renameSync(currentPath, nextPath);
            }
        }

        // Move current log to .1
        const currentLogPath = join(logsDir, `${baseName}${ext}`);
        const firstBackupPath = join(logsDir, `${baseName}.1${ext}`);
        if (existsSync(currentLogPath)) {
            renameSync(currentLogPath, firstBackupPath);
        }
    } catch (error) {
        // Log rotation is best-effort, don't fail startup
        console.error('Failed to rotate main log:', error);
    }
}

/**
 * Rotate debug logs on app startup.
 * Each log file represents one app session, preserving crash logs intact.
 * Files: nimbalyst-debug.log (current), .1.log (previous), .2.log, .3.log, .4.log (oldest)
 */
function rotateDebugLogs() {
    const userData = app.getPath('userData');
    const baseName = 'nimbalyst-debug';
    const ext = '.log';

    try {
        // Delete oldest log if it exists
        const oldestPath = join(userData, `${baseName}.${MAX_DEBUG_LOG_SESSIONS - 1}${ext}`);
        if (existsSync(oldestPath)) {
            unlinkSync(oldestPath);
        }

        // Shift existing logs: N-1 -> N, N-2 -> N-1, ..., 1 -> 2
        for (let i = MAX_DEBUG_LOG_SESSIONS - 2; i >= 1; i--) {
            const currentPath = join(userData, `${baseName}.${i}${ext}`);
            const nextPath = join(userData, `${baseName}.${i + 1}${ext}`);
            if (existsSync(currentPath)) {
                renameSync(currentPath, nextPath);
            }
        }

        // Move current log to .1
        const currentLogPath = join(userData, `${baseName}${ext}`);
        const firstBackupPath = join(userData, `${baseName}.1${ext}`);
        if (existsSync(currentLogPath)) {
            renameSync(currentLogPath, firstBackupPath);
        }
    } catch (error) {
        // Log rotation is best-effort, don't fail startup
        console.error('Failed to rotate debug logs:', error);
    }
}

// Initialize logging
function initializeLogging() {
    // electron-log handles main process logging
    logger.main.info('Application logging initialized');

    // Always capture error logs for debugging
    const debugLogPath = join(app.getPath('userData'), 'nimbalyst-debug.log');

    // Rotate main log on every startup (keeps 2 previous sessions)
    rotateMainLog();

    // Rotate debug logs on startup (development mode only - preserves previous session logs)
    if (process.env.NODE_ENV !== 'production') {
        rotateDebugLogs();
    }

    // Initialize or append to log
    try {
        const timestamp = new Date().toISOString();
        if (process.env.NODE_ENV !== 'production') {
            writeFileSync(debugLogPath, `=== Debug Log Started ${timestamp} ===\n`);
        } else {
            appendFileSync(debugLogPath, `\n=== App Started ${timestamp} ===\n`);
        }
    } catch (error) {
        logger.main.error('Failed to initialize debug log:', error);
    }

    // Listen for console logs from renderer (always capture errors)
    safeOn('console-log', (_event, data) => {
        // In production, only log errors and warnings
        if (process.env.NODE_ENV === 'production' && !['error', 'warn'].includes(data.level)) {
            return;
        }

        const logEntry = `[${data.timestamp}] [${data.level.toUpperCase()}] [${data.source}] ${data.message}\n`;
        try {
            appendFileSync(debugLogPath, logEntry);
        } catch (error) {
            // Ignore write errors
        }
    });

    logger.main.info(`Debug logs will be written to: ${debugLogPath}`);
}

// Register custom URL protocol handler (nimbalyst://)
// Must be done before app is ready on macOS
if (process.defaultApp) {
    if (process.argv.length >= 2) {
        // Remove any stale registration first (e.g. from packaged builds or Electron Fiddle)
        app.removeAsDefaultProtocolClient('nimbalyst', process.execPath, [path.resolve(process.argv[1])]);
        app.setAsDefaultProtocolClient('nimbalyst', process.execPath, [path.resolve(process.argv[1])]);
        logger.main.info(`[DeepLink] Registered nimbalyst:// protocol for dev mode (exec: ${process.execPath}, arg: ${path.resolve(process.argv[1])})`);
        logger.main.info(`[DeepLink] isDefaultProtocolClient: ${app.isDefaultProtocolClient('nimbalyst', process.execPath, [path.resolve(process.argv[1])])}`);
    }
} else {
    app.removeAsDefaultProtocolClient('nimbalyst');
    app.setAsDefaultProtocolClient('nimbalyst');
}

registerLinuxAppImageProtocolHandler();

// Single-instance lock
// Ensures only one instance runs at a time. When a second instance launches
// (e.g., from a file double-click), it forwards its context to the primary instance.
// Skip for multi-instance dev mode and Playwright tests.
const allowMultipleInstances = !!process.env.NIMBALYST_USER_DATA_DIR || !!process.env.PLAYWRIGHT;

if (!allowMultipleInstances) {
    const gotTheLock = app.requestSingleInstanceLock();

    if (!gotTheLock) {
        // Another instance holds the lock. On macOS, when the OS launches the
        // packaged app to open a file, the path comes via Apple Events which
        // Electron delivers as the open-file event. But open-file only fires
        // once the event loop is running. We must NOT quit synchronously or the
        // event is lost. Instead, stay alive, wait for open-file, relay the
        // path via a signal file, then exit.
        const pendingOpenFilePath = path.join(app.getPath('userData'), '.pending-open-file');

        logger.main.info(`[SingleInstance] Second instance launched, waiting for open-file. argv=${JSON.stringify(process.argv)}`);

        // Also check argv for file paths (Windows/Linux, or CLI open --args)
        const fileArg = process.argv.find(arg =>
            !arg.startsWith('-') &&
            arg !== process.argv[0] &&
            path.isAbsolute(arg)
        );
        if (fileArg) {
            logger.main.info(`[SingleInstance] Found file in argv: ${fileArg}`);
            try { writeFileSync(pendingOpenFilePath, fileArg, 'utf-8'); } catch (_) {}
            app.quit();
        } else if (process.argv.find(arg => arg.startsWith('nimbalyst://'))) {
            // Primary instance will handle via second-instance event; quit immediately
            logger.main.info('[SingleInstance] Second instance has deep link arg, quitting immediately');
            app.quit();
        } else {
            // No file in argv -- wait for open-file Apple Event
            let gotFile = false;
            app.on('open-file', (event, filePath) => {
                event.preventDefault();
                gotFile = true;
                logger.main.info(`[SingleInstance] Second instance received open-file: ${filePath}`);
                try {
                    writeFileSync(pendingOpenFilePath, filePath, 'utf-8');
                    logger.main.info(`[SingleInstance] Wrote signal file: ${pendingOpenFilePath}`);
                } catch (err) {
                    logger.main.error('[SingleInstance] Failed to write signal file:', err);
                }
                app.quit();
            });

            // Fallback timeout -- if open-file never fires, quit anyway
            setTimeout(() => {
                if (!gotFile) {
                    logger.main.info('[SingleInstance] No open-file after timeout, quitting');
                    app.quit();
                }
            }, 5000);
        }
    } else {
        // We are the primary instance. When a second instance tries to launch,
        // extract any deep link URL or file path and handle it here.
        app.on('second-instance', (_event, argv, _workingDirectory) => {
            logger.main.info('[SingleInstance] second-instance event, argv:', argv);

            // On Windows the protocol URL is passed as the last argument
            const deepLinkUrl = argv.find(arg => arg.startsWith('nimbalyst://'));
            if (deepLinkUrl) {
                logger.main.info('[SingleInstance] Found deep link in argv:', summarizeDeepLink(deepLinkUrl));
                handleDeepLink(deepLinkUrl);
            }

            // Check argv for file paths (Windows/Linux pass files as args)
            const fileArg = argv.find(arg =>
                !arg.startsWith('-') &&
                !arg.startsWith('nimbalyst://') &&
                arg !== argv[0] &&
                path.isAbsolute(arg) &&
                existsSync(arg) &&
                fs.statSync(arg).isFile()
            );
            if (fileArg) {
                logger.main.info(`[SingleInstance] Opening file from argv: ${fileArg}`);
                openFileWithWorkspaceDetection(fileArg);
            }

            // Focus an existing window so the user sees the result
            const windows = BrowserWindow.getAllWindows();
            if (windows.length > 0) {
                const win = windows[0];
                if (win.isMinimized()) win.restore();
                win.focus();
            }
        });
    }
}

// Watch for pending open-file signals from other instances.
// On macOS, when the packaged app is launched to open a file but a dev instance
// holds the single-instance lock, the file path is lost because macOS delivers
// file paths via Apple Events (not argv), and the second instance quits before
// its event loop processes the Apple Event. In production this isn't an issue
// because the packaged app IS the primary instance.
//
// Workaround for dev mode: watch a signal file that the second instance writes.
// Currently only works for CLI invocations where the path is in argv.
// For Finder double-click during dev, quit the packaged app first.
{
    const pendingOpenFilePath = path.join(app.getPath('userData'), '.pending-open-file');

    // Check for a stale signal file on startup (second instance may have written
    // it before we started watching)
    const checkPendingFile = () => {
        try {
            if (existsSync(pendingOpenFilePath)) {
                const filePath = fs.readFileSync(pendingOpenFilePath, 'utf-8').trim();
                unlinkSync(pendingOpenFilePath);
                if (filePath && existsSync(filePath)) {
                    logger.main.info(`[SingleInstance] Opening file from signal: ${filePath}`);
                    if (app.isReady()) {
                        openFileWithWorkspaceDetection(filePath);
                    } else {
                        pendingFilePath = filePath;
                    }
                }
            }
        } catch (_) {}
    };

    // Check immediately
    checkPendingFile();

    // Watch the userData directory for the signal file
    try {
        const userDataPath = app.getPath('userData');
        fs.watch(userDataPath, (eventType, filename) => {
            if (filename === '.pending-open-file') {
                // Small delay to ensure the file is fully written
                setTimeout(checkPendingFile, 50);
            }
        });
    } catch (err) {
        logger.main.warn('[SingleInstance] Failed to watch for open-file signals:', err);
    }
}

// Track pending deep link URL
let pendingDeepLinkUrl: string | null = null;

// Per-workspace queue of shared-document deep links waiting for the renderer
// to be ready (e.g., a window we just created for the project). Drained via
// the `deep-link:consume-pending-shared-doc` IPC during listener init.
const pendingSharedDocLinks = new Map<string, { documentId: string; orgId: string }>();

safeHandle('deep-link:consume-pending-shared-doc', (_event, workspacePath: string) => {
    if (!workspacePath) return null;
    const pending = pendingSharedDocLinks.get(workspacePath);
    if (!pending) return null;
    pendingSharedDocLinks.delete(workspacePath);
    return { ...pending, workspacePath };
});

// Same pattern for tracker deep links: nimbalyst://tracker/{trackerId}?orgId=...
const pendingTrackerLinks = new Map<string, { trackerId: string; orgId: string }>();

safeHandle('deep-link:consume-pending-tracker', (_event, workspacePath: string) => {
    if (!workspacePath) return null;
    const pending = pendingTrackerLinks.get(workspacePath);
    if (!pending) return null;
    pendingTrackerLinks.delete(workspacePath);
    return { ...pending, workspacePath };
});

// Same pattern for shared-folder deep links: nimbalyst://folder/{folderId}?orgId=...
const pendingSharedFolderLinks = new Map<string, { folderId: string; orgId: string }>();

safeHandle('deep-link:consume-pending-shared-folder', (_event, workspacePath: string) => {
    if (!workspacePath) return null;
    const pending = pendingSharedFolderLinks.get(workspacePath);
    if (!pending) return null;
    pendingSharedFolderLinks.delete(workspacePath);
    return { ...pending, workspacePath };
});

// Sensitive query params that must not be logged verbatim. Anything not in
// this set is logged as-is so worker-supplied error codes/messages are visible.
const SENSITIVE_DEEP_LINK_PARAMS = new Set([
    'session_token',
    'session_jwt',
    'token',
    'stytch_token',
    'oauth_state',
    'state',
]);

/**
 * Summarize a deep-link URL for logging. Keeps host/pathname intact, replaces
 * any sensitive param value with `[redacted:N]` (length only), and passes
 * everything else through. Worker error codes (`error`, `error_description`,
 * `stytch_error_type`) end up logged verbatim so a failed sign-in is diagnosable.
 */
function summarizeDeepLink(url: string): { host: string; pathname: string; params: Record<string, string> } | { rawUrl: string; parseError: string } {
    try {
        const parsed = new URL(url);
        const params: Record<string, string> = {};
        for (const [key, value] of parsed.searchParams.entries()) {
            params[key] = SENSITIVE_DEEP_LINK_PARAMS.has(key) ? `[redacted:${value.length}]` : value;
        }
        return { host: parsed.host, pathname: parsed.pathname, params };
    } catch (err) {
        return { rawUrl: url, parseError: String(err) };
    }
}

// Handle deep link URLs (nimbalyst://...)
app.on('open-url', (event, url) => {
    event.preventDefault();
    logger.main.info('[DeepLink] open-url event:', summarizeDeepLink(url));

    if (app.isReady()) {
        handleDeepLink(url);
    } else {
        // Store the URL to handle after app is ready
        pendingDeepLinkUrl = url;
    }
});

// Handle deep link URL
async function handleDeepLink(url: string): Promise<void> {
    try {
        const parsed = new URL(url);

        // Handle auth callback: nimbalyst://auth/callback?session_token=...
        if (parsed.host === 'auth' && parsed.pathname === '/callback') {
            const sessionToken = parsed.searchParams.get('session_token');
            const sessionJwt = parsed.searchParams.get('session_jwt');
            const userId = parsed.searchParams.get('user_id');
            const email = parsed.searchParams.get('email');
            const expiresAt = parsed.searchParams.get('expires_at');

            // Surface any worker-supplied error indicators before checking for
            // session_token. The collabv3 worker may redirect back with
            // `?error=...&error_description=...` instead of a session, and
            // until now we silently fell into the "missing session_token"
            // branch with no clue why.
            const errorCode = parsed.searchParams.get('error');
            const errorDescription = parsed.searchParams.get('error_description');
            const stytchErrorType = parsed.searchParams.get('stytch_error_type');
            if (errorCode || errorDescription || stytchErrorType) {
                logger.main.error('[DeepLink] Auth callback returned error from server:', {
                    error: errorCode,
                    errorDescription,
                    stytchErrorType,
                    allParams: summarizeDeepLink(url),
                });
                return;
            }

            if (sessionToken) {
                const orgId = parsed.searchParams.get('org_id');

                // B2B auth requires org_id - reject callbacks without it
                if (!orgId) {
                    logger.main.error('[DeepLink] Auth callback missing org_id - B2B auth requires organization context');
                    return;
                }

                logger.main.info('[DeepLink] Auth callback params:', {
                    hasSessionToken: !!sessionToken,
                    hasSessionJwt: !!sessionJwt,
                    userId,
                    email,
                    orgId,
                });

                await handleAuthCallback({
                    sessionToken,
                    sessionJwt: sessionJwt || undefined,
                    userId: userId || undefined,
                    email: email || undefined,
                    expiresAt: expiresAt || undefined,
                    orgId,
                });
                logger.main.info('[DeepLink] Auth callback handled successfully');

                // Reinitialize sync now that we're authenticated
                try {
                    const { repositoryManager } = await import('./services/RepositoryManager');
                    await repositoryManager.reinitializeSyncWithNewConfig();
                    logger.main.info('[DeepLink] Sync reinitialized after auth');
                } catch (syncError) {
                    logger.main.error('[DeepLink] Failed to reinitialize sync after auth:', syncError);
                }
            } else {
                // No session_token and no recognized error param -- log everything
                // we got so the worker's actual response shape is visible.
                logger.main.error('[DeepLink] Auth callback missing session_token; full params:', summarizeDeepLink(url));
            }
        } else if (parsed.host === 'install' || parsed.pathname?.startsWith('/install/')) {
            // Handle extension install: nimbalyst://install/com.nimbalyst.excalidraw
            const extensionId = parsed.host === 'install'
                ? parsed.pathname?.replace(/^\//, '')
                : parsed.pathname?.replace('/install/', '');

            if (extensionId) {
                logger.main.info(`[DeepLink] Extension install request: ${extensionId}`);
                queueMarketplaceInstallRequest(extensionId);
            } else {
                logger.main.warn('[DeepLink] Extension install missing extension ID');
            }
        } else if (parsed.host === 'doc' || parsed.pathname?.startsWith('/doc/')) {
            // Handle shared document link: nimbalyst://doc/{documentId}?orgId={orgId}
            const encoded = parsed.host === 'doc'
                ? parsed.pathname?.replace(/^\//, '')
                : parsed.pathname?.replace('/doc/', '');
            let documentId: string | undefined;
            try {
                documentId = encoded ? decodeURIComponent(encoded) : undefined;
            } catch {
                logger.main.warn('[DeepLink] Shared doc link has malformed documentId:', summarizeDeepLink(url));
                return;
            }
            const orgId = parsed.searchParams.get('orgId');

            if (!documentId || !orgId) {
                logger.main.warn('[DeepLink] Shared doc link missing documentId or orgId:', summarizeDeepLink(url));
                return;
            }

            await openSharedDocumentFromDeepLink(documentId, orgId);
        } else if (parsed.host === 'folder' || parsed.pathname?.startsWith('/folder/')) {
            // Handle shared folder link: nimbalyst://folder/{folderId}?orgId={orgId}
            const encoded = parsed.host === 'folder'
                ? parsed.pathname?.replace(/^\//, '')
                : parsed.pathname?.replace('/folder/', '');
            let folderId: string | undefined;
            try {
                folderId = encoded ? decodeURIComponent(encoded) : undefined;
            } catch {
                logger.main.warn('[DeepLink] Shared folder link has malformed folderId:', summarizeDeepLink(url));
                return;
            }
            const orgId = parsed.searchParams.get('orgId');

            if (!folderId || !orgId) {
                logger.main.warn('[DeepLink] Shared folder link missing folderId or orgId:', summarizeDeepLink(url));
                return;
            }

            await openSharedFolderFromDeepLink(folderId, orgId);
        } else if (parsed.host === 'tracker' || parsed.pathname?.startsWith('/tracker/')) {
            // Handle tracker link: nimbalyst://tracker/{trackerId}?orgId={orgId}
            const encoded = parsed.host === 'tracker'
                ? parsed.pathname?.replace(/^\//, '')
                : parsed.pathname?.replace('/tracker/', '');
            let trackerId: string | undefined;
            try {
                trackerId = encoded ? decodeURIComponent(encoded) : undefined;
            } catch {
                logger.main.warn('[DeepLink] Tracker link has malformed trackerId:', summarizeDeepLink(url));
                return;
            }
            const orgId = parsed.searchParams.get('orgId');

            if (!trackerId || !orgId) {
                logger.main.warn('[DeepLink] Tracker link missing trackerId or orgId:', summarizeDeepLink(url));
                return;
            }

            await openTrackerFromDeepLink(trackerId, orgId);
        } else {
            logger.main.warn('[DeepLink] Unknown deep link:', summarizeDeepLink(url));
        }
    } catch (error) {
        logger.main.error('[DeepLink] Failed to handle deep link:', error);
    }
}

/**
 * Snapshot the workspaces currently open across all windows, for the `nim` CLI
 * endpoint descriptor. Best-effort and de-duplicated; falls back to recent
 * workspaces if no windows are open yet.
 */
/**
 * Workspaces we've already kicked backend-module startup for, so the per-document
 * `mcp:updateDocumentState` events don't re-scan extension dirs on every update.
 */
const backendModulesStartedForWorkspace = new Set<string>();

/**
 * Start the backend modules of every enabled extension across the workspaces of
 * all currently-open windows, derived from `windowStates` (main-side, NOT the
 * renderer). The per-workspace `mcp:updateDocumentState` hook only fires once
 * the renderer pushes document state — which is driven by MCP/agent usage — so a
 * freshly-restarted app with an enabled engine would otherwise not start it
 * until something touched that window's MCP surface. This sweep (run shortly
 * after startup and on window focus) makes enabled engines come up promptly.
 * Idempotent: workspaces already swept are skipped, and `startModule` itself is
 * idempotent.
 */
async function sweepOpenWindowsForBackendModules(): Promise<boolean> {
    const seen = new Set<string>();
    const workspaces: string[] = [];
    for (const state of windowStates.values()) {
        const candidates = [
            resolveActiveWorkspacePath(state),
            state?.workspacePath,
            ...(state?.additionalWorkspacePaths ?? []),
        ];
        for (const p of candidates) {
            if (p && !seen.has(p)) {
                seen.add(p);
                workspaces.push(p);
            }
        }
    }
    const fresh = workspaces.filter((p) => !backendModulesStartedForWorkspace.has(p));
    if (fresh.length === 0) return false;
    for (const p of fresh) backendModulesStartedForWorkspace.add(p);
    const deps = { ...getDefaultBackendModuleLifecycleDeps(), collectWorkspaces: () => fresh };
    await syncEnabledBackendModulesOnStartup(deps);
    return true;
}

function collectOpenWorkspaces(): EndpointWorkspace[] {
    const seen = new Set<string>();
    const out: EndpointWorkspace[] = [];
    try {
        for (const state of windowStates.values()) {
            const paths = new Set<string>();
            const active = resolveActiveWorkspacePath(state);
            if (active) paths.add(active);
            if (state?.workspacePath) paths.add(state.workspacePath);
            for (const p of state?.additionalWorkspacePaths ?? []) paths.add(p);
            for (const p of paths) {
                if (!p || seen.has(p)) continue;
                seen.add(p);
                out.push({ path: p, name: path.basename(p) });
            }
        }
        if (out.length === 0) {
            for (const item of getRecentItems('workspaces')) {
                if (!item?.path || seen.has(item.path)) continue;
                seen.add(item.path);
                out.push({ path: item.path, name: (item as any).name ?? path.basename(item.path) });
            }
        }
    } catch {
        /* best-effort */
    }
    return out;
}

/**
 * Find a workspace path whose team matches the given orgId. Looks first
 * across all open windows (active + rail-warm), then falls back to the
 * user's recent workspaces. Returns null if no known workspace matches.
 */
async function findWorkspaceForOrgId(orgId: string): Promise<string | null> {
    const seen = new Set<string>();

    // Open windows first — both active and rail-warm paths.
    for (const state of windowStates.values()) {
        const paths = new Set<string>();
        const active = resolveActiveWorkspacePath(state);
        if (active) paths.add(active);
        if (state?.workspacePath) paths.add(state.workspacePath);
        for (const p of state?.additionalWorkspacePaths ?? []) paths.add(p);

        for (const workspacePath of paths) {
            if (seen.has(workspacePath)) continue;
            seen.add(workspacePath);
            const team = await findTeamForWorkspace(workspacePath);
            if (team?.orgId === orgId) return workspacePath;
        }
    }

    // Fall back to recent workspaces the user has opened before.
    const recent = getRecentItems('workspaces');
    for (const item of recent) {
        if (seen.has(item.path)) continue;
        seen.add(item.path);
        const team = await findTeamForWorkspace(item.path);
        if (team?.orgId === orgId) return item.path;
    }

    return null;
}

/**
 * Route a shared-document deep link to the renderer holding the matching
 * team workspace. Queues the payload in `pendingSharedDocLinks` so a freshly
 * created window's renderer can drain it on listener init.
 */
async function openSharedDocumentFromDeepLink(documentId: string, orgId: string): Promise<void> {
    const reason = !isAuthenticated() ? 'not-authenticated' : 'no-workspace';
    const workspacePath = isAuthenticated() ? await findWorkspaceForOrgId(orgId) : null;

    if (!workspacePath) {
        logger.main.warn('[DeepLink] Cannot route shared doc:', { reason, orgId, documentId });
        const fallback = getMostRecentlyFocusedWorkspaceWindow();
        if (fallback) {
            if (fallback.isMinimized()) fallback.restore();
            fallback.focus();
            fallback.webContents.send('deep-link:shared-document-not-available', { documentId, orgId, reason });
        }
        return;
    }

    // Queue first; the renderer drains by workspacePath on listener init.
    // For an already-loaded window we also fire the live event below; the
    // renderer treats it as idempotent against the pending queue.
    pendingSharedDocLinks.set(workspacePath, { documentId, orgId });

    const existing = findWindowByWorkspace(workspacePath);
    if (existing && !existing.isDestroyed()) {
        if (existing.isMinimized()) existing.restore();
        existing.focus();
        existing.webContents.send('deep-link:open-shared-document', {
            documentId,
            orgId,
            workspacePath,
        });
        logger.main.info('[DeepLink] Routed shared doc to existing window:', { workspacePath, documentId });
        return;
    }

    // No window has this workspace open — create one. The renderer's
    // deep-link listener will drain the pending queue once it mounts.
    logger.main.info('[DeepLink] Opening new window for shared doc workspace:', { workspacePath, documentId });
    createWindow(false, true, workspacePath);
}

/**
 * Route a shared-folder deep link to the renderer holding the matching team
 * workspace. Mirrors the shared-document flow, but targets Collab mode focused
 * on the folder (expand ancestors + select).
 */
async function openSharedFolderFromDeepLink(folderId: string, orgId: string): Promise<void> {
    const reason = !isAuthenticated() ? 'not-authenticated' : 'no-workspace';
    const workspacePath = isAuthenticated() ? await findWorkspaceForOrgId(orgId) : null;

    if (!workspacePath) {
        logger.main.warn('[DeepLink] Cannot route shared folder:', { reason, orgId, folderId });
        const fallback = getMostRecentlyFocusedWorkspaceWindow();
        if (fallback) {
            if (fallback.isMinimized()) fallback.restore();
            fallback.focus();
            fallback.webContents.send('deep-link:shared-folder-not-available', { folderId, orgId, reason });
        }
        return;
    }

    pendingSharedFolderLinks.set(workspacePath, { folderId, orgId });

    const existing = findWindowByWorkspace(workspacePath);
    if (existing && !existing.isDestroyed()) {
        if (existing.isMinimized()) existing.restore();
        existing.focus();
        existing.webContents.send('deep-link:open-shared-folder', {
            folderId,
            orgId,
            workspacePath,
        });
        logger.main.info('[DeepLink] Routed shared folder to existing window:', { workspacePath, folderId });
        return;
    }

    logger.main.info('[DeepLink] Opening new window for shared folder workspace:', { workspacePath, folderId });
    createWindow(false, true, workspacePath);
}

/**
 * Route a tracker deep link to the matching team workspace. Mirrors the
 * shared-document flow, but targets tracker mode + tracker-item selection.
 */
async function openTrackerFromDeepLink(trackerId: string, orgId: string): Promise<void> {
    const reason = !isAuthenticated() ? 'not-authenticated' : 'no-workspace';
    const workspacePath = isAuthenticated() ? await findWorkspaceForOrgId(orgId) : null;

    if (!workspacePath) {
        logger.main.warn('[DeepLink] Cannot route tracker:', { reason, orgId, trackerId });
        const fallback = getMostRecentlyFocusedWorkspaceWindow();
        if (fallback) {
            if (fallback.isMinimized()) fallback.restore();
            fallback.focus();
            fallback.webContents.send('deep-link:tracker-not-available', { trackerId, orgId, reason });
        }
        return;
    }

    pendingTrackerLinks.set(workspacePath, { trackerId, orgId });

    const existing = findWindowByWorkspace(workspacePath);
    if (existing && !existing.isDestroyed()) {
        if (existing.isMinimized()) existing.restore();
        existing.focus();
        existing.webContents.send('deep-link:open-tracker', {
            trackerId,
            orgId,
            workspacePath,
        });
        logger.main.info('[DeepLink] Routed tracker to existing window:', { workspacePath, trackerId });
        return;
    }

    logger.main.info('[DeepLink] Opening new window for tracker workspace:', { workspacePath, trackerId });
    createWindow(false, true, workspacePath);
}

// Handle file open from OS (macOS)
app.on('open-file', (event, path) => {
    event.preventDefault();
    logger.main.info(`open-file event received: ${path}`);

    if (app.isReady()) {
        openFileWithWorkspaceDetection(path);
    } else {
        // Store the file path to open after app is ready
        pendingFilePath = path;
    }
});

// Helper function to open a file with workspace detection
async function openFileWithWorkspaceDetection(filePath: string): Promise<void> {
    // Check if file is already open in a window
    const existingWindow = findWindowByFilePath(filePath);
    if (existingWindow) {
        // Window is already open - no need to focus, let macOS handle window ordering
        return;
    }

    // Detect which workspace this file belongs to
    const workspacePath = detectFileWorkspace(filePath);

    if (workspacePath) {
        // File belongs to a known workspace
        logger.main.info(`File belongs to workspace: ${workspacePath}`);

        // Find or create workspace window
        let workspaceWindow = findWindowByWorkspace(workspacePath);

        if (workspaceWindow) {
            // Workspace window exists, use it - no need to focus, let macOS handle window ordering
            await loadFileIntoWindow(workspaceWindow, filePath);
        } else {
            // Create new workspace window for this workspace
            workspaceWindow = createWindow(false, true, workspacePath);
            updateTrackerSchemaWorkspace(workspacePath);
            workspaceWindow.once('ready-to-show', async () => {
                workspaceWindow!.show();
                // Window state is already set by createWindow with workspace path
                // Just load the file
                await loadFileIntoWindow(workspaceWindow!, filePath);
            });
        }
    } else {
        // File is not in a known workspace - open it in the frontmost workspace window as an external file
        logger.main.info(`File not in known workspace, opening as external file in frontmost window`);

        const frontmostWindow = getMostRecentlyFocusedWorkspaceWindow();
        if (frontmostWindow) {
            await loadFileIntoWindow(frontmostWindow, filePath);
        } else {
            // No workspace windows open - try to detect a project root and open it
            const suggestedWorkspace = suggestWorkspaceForFile(filePath);
            if (suggestedWorkspace && suggestedWorkspace !== path.dirname(filePath)) {
                logger.main.info(`Opening suggested workspace: ${suggestedWorkspace}`);
                addToRecentItems('workspaces', suggestedWorkspace, path.basename(suggestedWorkspace));
                const newWindow = createWindow(false, true, suggestedWorkspace);
                updateTrackerSchemaWorkspace(suggestedWorkspace);
                newWindow.once('ready-to-show', async () => {
                    newWindow.show();
                    await loadFileIntoWindow(newWindow, filePath);
                });
            } else {
                // No project root detected - use the file's directory as workspace
                const fileDir = path.dirname(filePath);
                logger.main.info(`Using file directory as workspace: ${fileDir}`);
                addToRecentItems('workspaces', fileDir, path.basename(fileDir));
                const newWindow = createWindow(false, true, fileDir);
                updateTrackerSchemaWorkspace(fileDir);
                newWindow.once('ready-to-show', async () => {
                    newWindow.show();
                    await loadFileIntoWindow(newWindow, filePath);
                });
            }
        }
    }
}

// Parse command line arguments
function parseCommandLineArgs() {
    logger.main.info(`Full process.argv:`, process.argv);
    const args = process.argv.slice(app.isPackaged ? 1 : 2);
    logger.main.info(`Parsing command line args (after slice):`, args);

    for (let i = 0; i < args.length; i++) {
        const arg = args[i];
        logger.main.info(`Checking arg[${i}]: "${arg}"`);

        if (arg === '--workspace' && i + 1 < args.length) {
            pendingWorkspacePath = args[i + 1];
            logger.main.info(`✓ Workspace path from CLI: ${pendingWorkspacePath}`);
        } else if (arg === '--file' && i + 1 < args.length) {
            pendingCliFilePath = args[i + 1];
            logger.main.info(`✓ File path from CLI (--file): ${pendingCliFilePath}`);
        } else if (arg === '--filter' && i + 1 < args.length) {
            pendingFilter = args[i + 1];
            logger.main.info(`✓ Filter from CLI: ${pendingFilter}`);
        } else if (arg.startsWith('nimbalyst://')) {
            pendingDeepLinkUrl = arg;
            logger.main.info(`[SingleInstance] Found deep link in argv: ${arg.substring(0, 60)}...`);
        } else if (!arg.startsWith('--') && !arg.startsWith('-')) {
            // Handle plain file path argument (e.g., "preditor file.md")
            const argExists = existsSync(arg);
            const argIsMarkdown = arg.endsWith('.md');
            logger.main.info(`  Potential file: exists=${argExists}, isMarkdown=${argIsMarkdown}`);

            if (argExists && argIsMarkdown) {
                pendingFilePath = arg;
                logger.main.info(`✓ File path from CLI: ${pendingFilePath}`);
            }
        }
    }

    // Validate --file requires --workspace
    if (pendingCliFilePath && !pendingWorkspacePath) {
        logger.main.warn('--file flag requires --workspace to be specified. Ignoring --file.');
        pendingCliFilePath = null;
    }

    logger.main.info(`FINAL: pendingFilePath=${pendingFilePath}, pendingWorkspacePath=${pendingWorkspacePath}, pendingFilter=${pendingFilter}, pendingCliFilePath=${pendingCliFilePath}`);
}


// --- ACTIVATION DEBUGGING ---
// Log every app activation and browser-window-focus event to trace focus stealing during launch
const appLaunchTime = Date.now();
function activationLog(msg: string) {
    const elapsed = Date.now() - appLaunchTime;
    // Use logger directly since overrideConsole() hasn't run yet at startup
    // logger.main.info(`[ACTIVATION +${elapsed}ms] ${msg}`);
}

app.on('browser-window-focus', (_event, win) => {
    activationLog(`browser-window-focus: window id=${win.id} title="${win.getTitle()}"`);
});

app.on('browser-window-blur', (_event, win) => {
    activationLog(`browser-window-blur: window id=${win.id} title="${win.getTitle()}"`);
});

app.on('activate', () => {
    activationLog('app activate event fired');
});

// Monkey-patch BrowserWindow prototype to log show/focus calls with stack traces
const origShow = BrowserWindow.prototype.show;
BrowserWindow.prototype.show = function(this: BrowserWindow) {
    activationLog(`BrowserWindow.show() called on id=${this.id} title="${this.getTitle()}"\n  stack: ${new Error().stack?.split('\n').slice(1, 4).join('\n  ')}`);
    return origShow.call(this);
};

const origShowInactive = BrowserWindow.prototype.showInactive;
BrowserWindow.prototype.showInactive = function(this: BrowserWindow) {
    activationLog(`BrowserWindow.showInactive() called on id=${this.id} title="${this.getTitle()}"\n  stack: ${new Error().stack?.split('\n').slice(1, 4).join('\n  ')}`);
    return origShowInactive.call(this);
};

const origFocus = BrowserWindow.prototype.focus;
BrowserWindow.prototype.focus = function(this: BrowserWindow) {
    activationLog(`BrowserWindow.focus() called on id=${this.id} title="${this.getTitle()}"\n  stack: ${new Error().stack?.split('\n').slice(1, 4).join('\n  ')}`);
    return origFocus.call(this);
};
// --- END ACTIVATION DEBUGGING ---

// App ready handler
app.whenReady().then(async () => {
    checkpoint('app-ready');

    // Raise the file descriptor soft limit from the macOS default of 256.
    // Nimbalyst uses recursive fs.watch, chokidar per open tab, terminal PTYs,
    // and database connections — 256 FDs is far too low and causes silent
    // watcher failures (EMFILE) on machines that haven't manually raised it.
    if (process.platform === 'darwin' || process.platform === 'linux') {
        try {
            process.setFdLimit(10240);
        } catch {
            // setFdLimit may fail if the hard limit is lower — not fatal
        }
    }

    // Apply saved spellcheck preference (enabled by default)
    const spellcheckEnabled = getAppSetting<boolean>('spellcheckEnabled');
    if (spellcheckEnabled === false) {
        session.defaultSession.setSpellCheckerEnabled(false);
    }

    // Issue #146: wire up the `nim-asset://` request handler. Workspaces are
    // added to its allowlist below, as windows register their workspace path.
    registerNimAssetProtocolHandler();

    // `nim-preview://` serves HTML/CSS/JS assets from active workspaces to the
    // BrowserSessionService's WebContentsView. Workspaces are added to the
    // allowlist alongside nim-asset below.
    registerNimPreviewProtocolHandler();

    // Browser session IPC handlers + state-changed event broadcast. The
    // service itself owns the WebContentsView pool.
    registerBrowserSessionHandlers();

    // collab-asset:// E2E-encrypted document attachment handler.
    // Same-origins the production worker request from Chromium's perspective,
    // so we can keep webSecurity:true. The per-doc registry is populated by
    // document-sync:open / torn down by document-sync:close-doc.
    installCollabAssetProtocolHandler({
        getOrgKey,
        getOrgScopedJwt,
        getAccountId: getPersonalUserId,
        assetStore: getCollabAssetStore(),
        getCollabHttpUrl: () => {
            const config = getSessionSyncConfig();
            const isDev = process.env.NODE_ENV !== 'production';
            const env = isDev ? config?.environment : undefined;
            return env === 'development'
                ? 'http://localhost:8790'
                : 'https://sync.nimbalyst.com';
        },
    });

    // Show splash screen immediately so the user sees something while we initialize
    // Skip splash in Playwright tests - the splash window would be returned by firstWindow()
    // instead of the actual workspace window, causing tests to fail
    if (!process.env.PLAYWRIGHT) {
        showSplashScreen();
    }

    // Set up permission request handler to control when system permission dialogs appear
    // This prevents microphone permission prompt from appearing on app launch
    // Microphone access is only granted when the user explicitly enables voice mode
    // The voice mode flow (VoiceModeService) uses systemPreferences.askForMediaAccess()
    // which bypasses this handler and properly requests OS-level permission
    session.defaultSession.setPermissionRequestHandler((webContents, permission, callback, details) => {
        // Allow most permissions by default
        if (permission === 'media') {
            // For media permissions, check what type is being requested
            // details.mediaTypes contains 'audio' and/or 'video'
            const mediaTypes = (details as any).mediaTypes || [];

            // Check if microphone permission has already been granted at the OS level
            // If so, allow the renderer to access it
            if (mediaTypes.includes('audio')) {
                const { systemPreferences } = require('electron');
                const micStatus = systemPreferences.getMediaAccessStatus('microphone');

                if (micStatus === 'granted') {
                    // User has already granted microphone permission via voice mode activation
                    callback(true);
                    return;
                }

                // Microphone not yet granted - deny to prevent premature permission prompt
                // The voice mode activation flow will request permission properly
                callback(false);
                return;
            }
        }

        // Allow other permissions
        callback(true);
    });

    // Override console methods to capture all console output in log file
    // This must be called FIRST before any console.log calls
    overrideConsole();

    logger.main.info('App ready');

    // Start async PATH detection early (doesn't block startup)
    initEnhancedPath().catch(err => {
        logger.main.warn('Failed to initialize enhanced PATH:', err);
    });

    // Run migrations based on version changes
    runMigrations(app.getVersion());

    // Track app launch for community popup fallback
    const launchCount = incrementLaunchCount();
    logger.main.info(`App launch count: ${launchCount}`);

    // Track app launch in feature usage system
    FeatureUsageService.getInstance().recordUsage(FEATURES.APP_LAUNCH);

    // Check if Claude Code is installed (only on very first launch)
    checkClaudeCodeInstallationOnFirstLaunch();

    // Fire user_created event on very first launch (launchCount === 1)
    if (launchCount === 1) {
        analytics.sendEvent('user_created', {
            $set_once: { first_seen_version: app.getVersion() },
        });
    }

    // Parse command line arguments
    parseCommandLineArgs();

    // Initialize logging
    initializeLogging();

    // NOTE: Stytch auth is initialized lazily when sync is requested for a project
    // This avoids loading sync code at startup and prevents IPC handler registration issues

    // Initialize PGLite database
    markStart('database-init');
    try {
        runtimeSessionStore = await initializeDatabase();
        markEnd('database-init');
        logger.main.info('Database initialization completed');
      } catch (error) {
        logger.main.error('Error initializing database:', error);

        // If the error was already handled with a user-facing dialog (e.g. DATABASE_LOCKED),
        // don't show a second dialog. The dialog's own callback will call app.quit().
        if (error instanceof HandledError) {
            logger.main.info('Database error already handled via dialog, skipping redundant error UI');
            return;
        }

        const errorMessage = error instanceof Error ? error.message : String(error);

        // Detect WASM runtime crash (PGLite uses WASM internally)
        // Note: 'Aborted' comes from worker.js when it detects RuntimeError or WASM abort
        const isWasmRuntimeCrash = errorMessage.includes('exit(1)') ||
                                   errorMessage.includes('Program terminated') ||
                                   errorMessage.includes('ExitStatus') ||
                                   errorMessage.includes('Aborted') ||
                                   errorMessage.includes('DATABASE_INIT_FAILED');

        // Send analytics about the failure
        try {
            const analytics = AnalyticsService.getInstance();
            if (isWasmRuntimeCrash) {
                // Track as a known error for monitoring specific failure patterns
                analytics.sendEvent('known_error', {
                    errorId: 'pglite_wasm_runtime_crash',
                    context: 'database_initialization'
                });
            } else {
                // Track generic database initialization failure
                analytics.sendEvent('known_error', {
                    errorId: 'database_initialization_failed',
                    context: 'database_initialization',
                    errorMessage: errorMessage.slice(0, 200) // Truncate for privacy
                });
            }
        } catch {
            // Analytics failure shouldn't block error handling
        }

        // Show appropriate error dialog
        if (isWasmRuntimeCrash) {
            // Get database path for the error message (use actual expanded path)
            const dbPath = join(app.getPath('userData'), 'pglite-db');

            dialog.showErrorBox(
                'Nimbalyst - Database Initialization Failed',
                `The database system failed to start.\n\n` +
                `This usually indicates:\n` +
                `1. Another process has the database locked\n` +
                `2. Database files are corrupted\n` +
                `3. Insufficient file system permissions\n\n` +
                `To fix this:\n` +
                `1. Close any other Nimbalyst windows\n` +
                `2. Restart your computer (clears stale locks)\n` +
                `3. If the problem persists, delete the database folder:\n` +
                `   ${dbPath}\n\n` +
                `Nimbalyst will now close.`
            );
        } else {
            dialog.showErrorBox(
                'Nimbalyst - Database Initialization Failed',
                `Failed to initialize the database system.\n\nError: ${errorMessage}\n\nNimbalyst cannot continue without the database.`
            );
        }

        // Exit the app
        app.quit();
        return;
    }

    // Set dock icon for macOS
    if (process.platform === 'darwin' && app.dock) {
        // icon.png is at the package root in both dev and packaged builds
        // (included in electron-builder's `files` array, so it's inside the ASAR at the root)
        const iconPath = join(app.getAppPath(), 'icon.png');

        if (existsSync(iconPath)) {
            const dockIcon = nativeImage.createFromPath(iconPath);
            app.dock.setIcon(dockIcon);
            // logger.main.info('Dock icon set successfully from:', iconPath);
        } else {
            logger.main.warn(`icon not found at: ${iconPath}`);
        }
    }

    // Register all IPC handlers
    markStart('ipc-handlers');
    registerFileHandlers();
    registerWorkspaceHandlers();
    registerWorkspaceWatcherHandlers();
    registerSettingsHandlers();
    registerWindowHandlers();
    registerEditorStateHandlers();
    await registerHistoryHandlers();
    await registerSessionHandlers();
    await registerSessionStateHandlers();
    await registerThemeHandlers();
    setupWorkspaceManagerHandlers();
    setupTeamManagementHandlers();
    setupSessionFileHandlers();
    registerSlashCommandHandlers();
    registerActionPromptHandlers();
    await registerUsageAnalyticsHandlers();
    registerAttachmentHandlers();
    registerProjectSelectionHandlers();
    registerMultiProjectRailHandlers();
    registerClaudeCodeHandlers();
    registerCodexAuthHandlers();
    initializeClaudeCodeSessionHandlers();  // Initialize Claude Code session import
    registerAnalyticsHandlers();
    registerFeatureUsageHandlers();
    registerNotificationHandlers();
    registerClaudeUsageHandlers();
    claudeUsageService.initialize();
    registerCodexUsageHandlers();
    codexUsageService.initialize();
    registerGeminiUsageHandlers();
    geminiUsageService.initialize();
    registerPermissionHandlers();
    registerGitStatusHandlers();
    registerGitHandlers();
    registerWorktreeHandlers();
    registerPullRequestHandlers();
    registerReadReceiptHandlers();
    registerTrackerPersonalStateHandlers();
    registerWakeupHandlers();
    registerBlitzHandlers();
    registerProjectMigrationHandlers();
    registerSuperLoopHandlers();
    registerMCPConfigHandlers();
    registerOpenCodeConfigHandlers();
    registerClaudeCodePluginHandlers();
    const activeSqlite = database.getActiveSQLiteDatabase();
    if (database.getEngine() === 'sqlite' && activeSqlite) {
        const userDataPath = process.env.NIMBALYST_USER_DATA_PATH || app.getPath('userData');
        registerDatabaseBrowserSqliteHandlers({
            sqlite: activeSqlite,
            backupService: database.getBackupService() as any,
            sqliteFilePath: join(userDataPath, 'sqlite-db', 'nimbalyst.sqlite'),
        });
    } else {
        registerDatabaseBrowserHandlers();
    }
    registerMigrationHandlers();
    registerTerminalHandlers();
    registerExportHandlers();
    registerShareHandlers();
    registerTrackerSyncHandlers();
    registerSemanticSearchHandlers();
    // Reactively catalog trackers into the memory engine (when enabled) and
    // serve Quick Open semantic search.
    SemanticCatalogService.getInstance().start();
    initTrackerSchemaService(); // Register IPC handlers + load built-in schemas
    initTrackerNavigationService();

    // Initialize commit-tracker linking (listens to GitRefWatcher for all commits)
    commitTrackerLinker.initialize({ getDatabase: () => database });
    gitRefWatcher.onCommitDetected((event) => commitTrackerLinker.handleCommitDetected(event));

    registerTeamHandlers();
    registerOrgKeyHandlers();
    registerBuiltinCollabContentAdapters();
    registerDocumentSyncHandlers();
    getCollabOutboxDrainCoordinator().start();
    getCollabAssetOutboxDrainCoordinator().start();
    registerCollabBackupHandlers();
    registerCollabV3TestHandlers();
    markEnd('ipc-handlers');

    // Initialize system tray for session status visibility
    try {
        const trayManager = TrayManager.getInstance();
        trayManager.setDatabase(database);
        await trayManager.initialize();
    } catch (error) {
        logger.main.error('[TrayManager] Failed to initialize:', error);
    }

    // Inject MCP config loader into ClaudeCodeProvider
    // This allows the runtime package to load merged user + workspace MCP configs
    mcpConfigService = new MCPConfigService();

    // Start watching user-level MCP config for changes
    mcpConfigService.startWatchingUserConfig();

    // Register change callback to notify all windows when MCP config changes
    mcpConfigService.onChange((scope, workspacePath) => {
        logger.mcp.info('[MCP] Config changed:', { scope, workspacePath });

        // Notify all windows
        BrowserWindow.getAllWindows().forEach(window => {
            if (!window.isDestroyed()) {
                window.webContents.send('mcp-config-changed', { scope, workspacePath });
            }
        });
    });

    ClaudeCodeProvider.setMCPConfigLoader(async (workspacePath?: string) => {
        if (!mcpConfigService) {
            throw new Error('MCP config service not initialized');
        }
        const mergedConfig = await mcpConfigService.getMergedConfig(workspacePath);
        const allServers = mergedConfig.mcpServers || {};

        // Filter to servers enabled for Claude Agent and process for runtime
        // (On Windows, converts npm/npx/etc commands to .cmd equivalents)
        const enabledServers: Record<string, any> = {};
        for (const [name, config] of Object.entries(allServers)) {
            if (isMCPServerEnabledForProvider(config as MCPServerConfig, MCP_PROVIDER_IDS.CLAUDE_AGENT)) {
                const isAuthorized = await mcpConfigService.isOAuthAuthorized(config as MCPServerConfig);
                if (!isAuthorized) {
                    logger.mcp.info(`[MCP] Skipping unauthorized OAuth server for Claude Agent: ${name}`);
                    continue;
                }
                enabledServers[name] = mcpConfigService.processServerConfigForRuntime(config as any);
            }
        }
        return enabledServers;
    });
    OpenAICodexProvider.setMCPConfigLoader(async (workspacePath?: string) => {
        if (!mcpConfigService) {
            throw new Error('MCP config service not initialized');
        }
        const mergedConfig = await mcpConfigService.getMergedConfig(workspacePath);
        const allServers = mergedConfig.mcpServers || {};

        // Filter to servers enabled for Codex and process for runtime
        const enabledServers: Record<string, any> = {};
        for (const [name, config] of Object.entries(allServers)) {
            if (isMCPServerEnabledForProvider(config as MCPServerConfig, MCP_PROVIDER_IDS.CODEX)) {
                const isAuthorized = await mcpConfigService.isOAuthAuthorized(config as MCPServerConfig, {
                    useMcpRemoteForNativeOAuth: true,
                });
                if (!isAuthorized) {
                    logger.mcp.info(`[MCP] Skipping unauthorized OAuth server for Codex: ${name}`);
                    continue;
                }
                enabledServers[name] = mcpConfigService.processServerConfigForRuntime(config as any);
            }
        }
        return enabledServers;
    });
    // Codex ACP shares the Codex MCP enablement filter -- it's the same Codex
    // CLI under the hood, just with a different transport.
    OpenAICodexACPProvider.setMCPConfigLoader(async (workspacePath?: string) => {
        if (!mcpConfigService) {
            throw new Error('MCP config service not initialized');
        }
        const mergedConfig = await mcpConfigService.getMergedConfig(workspacePath);
        const allServers = mergedConfig.mcpServers || {};

        const enabledServers: Record<string, any> = {};
        for (const [name, config] of Object.entries(allServers)) {
            if (isMCPServerEnabledForProvider(config as MCPServerConfig, MCP_PROVIDER_IDS.CODEX)) {
                const isAuthorized = await mcpConfigService.isOAuthAuthorized(config as MCPServerConfig, {
                    useMcpRemoteForNativeOAuth: true,
                });
                if (!isAuthorized) {
                    logger.mcp.info(`[MCP] Skipping unauthorized OAuth server for Codex ACP: ${name}`);
                    continue;
                }
                enabledServers[name] = mcpConfigService.processServerConfigForRuntime(config as any);
            }
        }
        return enabledServers;
    });
    CopilotCLIProvider.setMCPConfigLoader(async (workspacePath?: string) => {
        if (!mcpConfigService) {
            throw new Error('MCP config service not initialized');
        }
        const mergedConfig = await mcpConfigService.getMergedConfig(workspacePath);
        const allServers = mergedConfig.mcpServers || {};

        const enabledServers: Record<string, any> = {};
        for (const [name, config] of Object.entries(allServers)) {
            if (isMCPServerEnabledForProvider(config as MCPServerConfig, MCP_PROVIDER_IDS.COPILOT)) {
                const isAuthorized = await mcpConfigService.isOAuthAuthorized(config as MCPServerConfig, {
                    useMcpRemoteForNativeOAuth: true,
                });
                if (!isAuthorized) {
                    logger.mcp.info(`[MCP] Skipping unauthorized OAuth server for Copilot: ${name}`);
                    continue;
                }
                enabledServers[name] = mcpConfigService.processServerConfigForRuntime(config as any);
            }
        }
        return enabledServers;
    });

    // Claude CLI (subscription) launcher shares the Claude Agent MCP filter —
    // the genuine CLI hits the identical MCP handlers as the SDK path (NIM-806).
    ClaudeCliLauncherConfig.setMcpConfigLoader(async (workspacePath?: string) => {
        if (!mcpConfigService) {
            throw new Error('MCP config service not initialized');
        }
        const mergedConfig = await mcpConfigService.getMergedConfig(workspacePath);
        const allServers = mergedConfig.mcpServers || {};

        const enabledServers: Record<string, any> = {};
        for (const [name, config] of Object.entries(allServers)) {
            if (isMCPServerEnabledForProvider(config as MCPServerConfig, MCP_PROVIDER_IDS.CLAUDE_AGENT)) {
                const isAuthorized = await mcpConfigService.isOAuthAuthorized(config as MCPServerConfig);
                if (!isAuthorized) {
                    logger.mcp.info(`[MCP] Skipping unauthorized OAuth server for Claude CLI: ${name}`);
                    continue;
                }
                enabledServers[name] = mcpConfigService.processServerConfigForRuntime(config as any);
            }
        }
        return enabledServers;
    });

    // Inject extension plugins loader into ClaudeCodeProvider
    // This allows extensions to provide Claude SDK plugins with custom commands/agents
    // Uses main-process-native implementation that reads extension manifests directly
    ClaudeCodeProvider.setExtensionPluginsLoader(async (workspacePath?: string) => {
        if (!workspacePath) {
            return getClaudePluginPaths(workspacePath);
        }
        return getAgentWorkflowService(workspacePath).getClaudeProviderPluginPaths();
    });

    // ScheduleWakeup handler: the CLI emits ScheduleWakeup tool calls but its tool_result is
    // informational only. Re-queue the prompt at fire time via SessionWakeupScheduler.
    // Lives here in main because runtime is cross-platform (Capacitor/mobile too) and must
    // not import Electron-only services.
    ClaudeCodeProvider.setScheduleWakeupHandler(async ({ sessionId, workspacePath, delaySeconds, prompt, reason }) => {
        const id = `wakeup-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
        const fireAt = new Date(Date.now() + delaySeconds * 1000);

        const row = await getSessionWakeupsStore().create({
            id,
            sessionId,
            workspaceId: workspacePath,
            prompt,
            reason,
            fireAt,
        });
        SessionWakeupScheduler.getInstance().onCreated(row);

        for (const window of BrowserWindow.getAllWindows()) {
            if (!window.isDestroyed()) {
                try {
                    window.webContents.send('wakeup:changed', row);
                } catch {
                    // ignore destroyed window
                }
            }
        }

        console.log(`[CLAUDE-CODE] ScheduleWakeup -> session=${sessionId} fireAt=${fireAt.toISOString()} delay=${delaySeconds}s`);
    });

    // Inject Claude Code settings loader
    // This allows user/project commands to be enabled/disabled via settings
    ClaudeCodeProvider.setClaudeCodeSettingsLoader(async () => {
        return getClaudeCodeSettings();
    });

    // Inject env vars loader to pass ~/.claude/settings.json env vars to the SDK
    // This ensures experimental flags (e.g., CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS)
    // are passed directly via the SDK env option for maximum reliability
    ClaudeCodeProvider.setClaudeSettingsEnvLoader(async () => {
        const settingsManager = ClaudeSettingsManager.getInstance();
        return settingsManager.getUserLevelEnv();
    });
    OpenAICodexProvider.setClaudeSettingsEnvLoader(async () => {
        const settingsManager = ClaudeSettingsManager.getInstance();
        return settingsManager.getUserLevelEnv();
    });
    OpenAICodexACPProvider.setClaudeSettingsEnvLoader(async () => {
        const settingsManager = ClaudeSettingsManager.getInstance();
        return settingsManager.getUserLevelEnv();
    });

    // Inject shell environment loader to pass the user's full login shell env vars
    // (AWS credentials, NODE_EXTRA_CA_CERTS, etc.) to the Claude Code subprocess.
    // Without this, Dock/Finder-launched Nimbalyst has a minimal environment.
    ClaudeCodeProvider.setShellEnvironmentLoader(() => getShellEnvironment());
    OpenAICodexProvider.setShellEnvironmentLoader(() => getShellEnvironment());
    OpenAICodexACPProvider.setShellEnvironmentLoader(() => getShellEnvironment());
    OpenCodeProvider.setShellEnvironmentLoader(() => getShellEnvironment());
    CopilotCLIProvider.setShellEnvironmentLoader(() => getShellEnvironment());

    // Inject enhanced PATH loader so agents can access system tools
    // (docker, homebrew, nvm, etc.) that are missing from Electron's GUI PATH.
    // For Claude Code this is critical: the SDK spawns stdio MCP subprocesses
    // (`npx`, `uvx`, ...) using options.env.PATH and fails with "Executable not
    // found in $PATH: npx" otherwise when Nimbalyst is launched from Dock.
    ClaudeCodeProvider.setEnhancedPathLoader(() => getEnhancedPath());
    OpenAICodexProvider.setEnhancedPathLoader(() => getEnhancedPath());
    OpenAICodexACPProvider.setEnhancedPathLoader(() => getEnhancedPath());
    OpenCodeProvider.setEnhancedPathLoader(() => getEnhancedPath());
    CopilotCLIProvider.setEnhancedPathLoader(() => getEnhancedPath());

    // Inject opencode.json loader so OpenCodeProvider.getModels() can surface
    // user-configured providers (e.g. an LM Studio bridge) in the model picker.
    OpenCodeProvider.setConfigLoader(() => getOpenCodeConfigService().readConfig());

    // Inject SDK module loader for packaged builds where dynamic import('@openai/codex-sdk')
    // can't resolve the package from within app.asar.
    // Note: @openai/codex-sdk is ESM-only, so requiring the package directory fails.
    if (app.isPackaged) {
      const sdkEntryCandidates = [
        path.join(
          process.resourcesPath,
          'app.asar.unpacked',
          'node_modules',
          '@openai',
          'codex-sdk',
          'dist',
          'index.js'
        ),
        path.join(
          process.resourcesPath,
          'node_modules',
          '@openai',
          'codex-sdk',
          'dist',
          'index.js'
        ),
        path.join(
          process.resourcesPath,
          'app.asar.unpacked',
          '@openai',
          'codex-sdk',
          'dist',
          'index.js'
        ),
      ];
      OpenAICodexProvider.setSdkModuleLoader(async () => {
        let lastError: unknown = null;
        for (const entryPath of sdkEntryCandidates) {
          if (!existsSync(entryPath)) {
            continue;
          }

          try {
            const sdkModule = await import(pathToFileURL(entryPath).href);
            if ((sdkModule as any).Codex) {
              return sdkModule as any;
            }
            if ((sdkModule as any).default?.Codex) {
              return (sdkModule as any).default;
            }
          } catch (error) {
            lastError = error;
          }
        }

        const lastMessage = lastError instanceof Error ? lastError.message : String(lastError ?? 'unknown');
        throw new Error(
          `[OpenAICodexProvider] Failed to load @openai/codex-sdk from packaged resources. ` +
          `Checked: ${sdkEntryCandidates.join(', ')}. Last error: ${lastMessage}`
        );
      });
    }

    // Inject additional directories loader. Adds the parent project root and
    // sibling worktrees so agents can read shared configs, traverse the .git
    // common dir from a worktree, and (for Codex) escape its workspace-write
    // sandbox when an orchestrator session needs to edit sibling worktrees.
    // Issue #37 problem 1.
    // Claude opts out of sibling worktrees: the Claude CLI loads .claude/commands
    // skills from every additional directory, so N worktrees = N duplicate
    // copies of every project skill in the system prompt (~7K tokens wasted per
    // session). Claude has no Codex-style sandbox; cross-worktree file access
    // still works through the normal permission flow.
    ClaudeCodeProvider.setAdditionalDirectoriesLoader((workspacePath: string) =>
      getAdditionalDirectoriesForWorkspace(workspacePath, { includeSiblingWorktrees: false }));
    OpenAICodexProvider.setAdditionalDirectoriesLoader(getAdditionalDirectoriesForWorkspace);

    // Wire the Codex PreToolUse hook (LEGACY -- only consulted by the SDK
    // transport, which is no longer the default). The hook script ships
    // under packages/electron/resources/ and is invoked synchronously by
    // Codex before every apply_patch, snapshotting each affected path's
    // pre-edit content to a per-session sidecar dir under userData. The
    // provider reads from the sidecar at item.started time, bypassing the
    // race where Codex emits item.started after the patch is already on
    // disk. The new app-server transport recovers pre-edit content from the
    // diff text in item/completed and does not need this hook.
    OpenAICodexProvider.setPreEditHookScriptPathResolver(resolveCodexPreEditHookScriptPath);
    OpenAICodexProvider.setPreEditSidecarDirResolver((sessionId: string) => {
      if (!sessionId) return undefined;
      const safeId = sessionId.replace(/[^A-Za-z0-9_-]/g, '_');
      return join(app.getPath('userData'), 'codex-pre-edit-snapshots', safeId);
    });

    // Codex transport selection. Default to 'app-server' for new sessions
    // unless the user has explicitly opted into the legacy 'sdk' transport
    // via the `openaiCodex.transport` app setting (the documented escape
    // hatch). Captured at provider-construct time per session so a settings
    // change takes effect on the next codex session without an app restart.
    OpenAICodexProvider.setCodexTransportResolver(() => {
      const setting = getAppSetting<{ transport?: 'sdk' | 'app-server' }>('openaiCodex')?.transport;
      return setting === 'sdk' ? 'sdk' : 'app-server';
    });

    // Pre-flight auth gate for the codex app-server transport. Reuses the
    // long-lived codexAuthService child (no extra spawn per turn). Returning a
    // permissive `{ requiresOpenaiAuth: false }` on failure means the provider
    // falls through to its normal createSession path -- the child will surface
    // any real auth issue mid-stream as before, so we never block a turn on a
    // gate that itself broke.
    //
    // We force `refreshToken: true` so codex re-reads ~/.codex/auth.json (and
    // refreshes the OAuth token if expired) before answering. Without this the
    // long-lived child can stay cached on a "not signed in" view it loaded
    // before the user completed the browser flow. We treat `account === null`
    // as the only valid "not signed in" signal -- `requiresOpenaiAuth` can be
    // true on signed-in-but-no-codex-access plans, which is a different state
    // and should surface as a 401 mid-turn, not as a sign-in prompt.
    OpenAICodexProvider.setCodexAuthGate(async () => {
      try {
        const status = await codexAuthService.getStatus(true);
        return { requiresOpenaiAuth: status.account === null };
      } catch (err) {
        console.warn('[CODEX] codexAuthService.getStatus() failed in auth gate:', err);
        return { requiresOpenaiAuth: false };
      }
    });

    // Wire shared permission infrastructure for all agent providers.
    // Both Claude Code and OpenAI Codex use the same pattern storage,
    // trust checking, and security logging, just via different setter names.
    const claudeSettingsManager = ClaudeSettingsManager.getInstance();
    const permissionService = getPermissionService();

    const patternSaver = async (workspacePath: string, pattern: string) => {
      await claudeSettingsManager.addAllowedTool(workspacePath, pattern);
    };
    // Claude Code allow patterns are prefix-wildcards, not exact strings:
    // `Bash(git:*)` covers `Bash(git status:*)`, `WebFetch` covers any
    // `WebFetch(domain:...)`, and `mcp__server` covers every tool under
    // that server. The old `.includes(pattern)` check only ever matched
    // exact strings, so a user with broad allows in `~/.claude/settings.json`
    // still saw a permission dialog for every distinct subcommand. The
    // wildcard-aware `matchesAllowPattern` brings Nimbalyst's pre-screen
    // in line with Claude Code's own pattern semantics. Fixes #152.
    const patternChecker = async (workspacePath: string, pattern: string) => {
      const effectiveSettings = await claudeSettingsManager.getEffectiveSettings(workspacePath);
      return effectiveSettings.permissions.allow.some((allow) =>
        matchesAllowPattern(pattern, allow),
      );
    };
    // NOTE: For worktree sessions, AIService pre-resolves the worktree path to the parent
    // project (worktreeProjectPath) and passes it via documentContext.permissionsPath.
    // Providers then use permissionsPath for trust checks, ensuring this
    // checker receives the parent project path, not the worktree path.
    const trustChecker = (workspacePath: string) => {
      const mode = permissionService.getPermissionMode(workspacePath);
      return {
        trusted: mode !== null,
        mode,
        allowAllUsesClassifier: permissionService.getAllowAllUsesClassifier(workspacePath),
      };
    };

    if (process.env.NODE_ENV === 'development') {
      const securityLogger = (message: string, data?: any) => {
        logger.agentSecurity.info(message, data);
      };
      ClaudeCodeProvider.setSecurityLogger(securityLogger);
      OpenAICodexProvider.setSecurityLogger(securityLogger);
      OpenAICodexACPProvider.setSecurityLogger(securityLogger);
    }

    ClaudeCodeProvider.setClaudeSettingsPatternSaver(patternSaver);
    ClaudeCodeProvider.setClaudeSettingsPatternChecker(patternChecker);
    ClaudeCodeProvider.setTrustChecker(trustChecker);

    OpenAICodexProvider.setPermissionPatternSaver(patternSaver);
    OpenAICodexProvider.setPermissionPatternChecker(patternChecker);
    OpenAICodexProvider.setTrustChecker(trustChecker);

    OpenAICodexACPProvider.setPermissionPatternSaver(patternSaver);
    OpenAICodexACPProvider.setPermissionPatternChecker(patternChecker);
    OpenAICodexACPProvider.setTrustChecker(trustChecker);

    // ACP exposes pre/post file-write hooks. Wire them so Codex ACP edits
    // produce the same FilesEditedSidebar entries and pre-edit baselines as
    // Claude Code edits, even when Codex routes the write through
    // fs/write_text_file (which doesn't always emit a session/tool_call).
    OpenAICodexACPProvider.setOnBeforeFileWrite(async (filePath, sessionId) => {
      if (!sessionId) return;
      try {
        const session = await AISessionsRepository.get(sessionId);
        const workspacePath = session?.workspacePath;
        if (!workspacePath) return;

        const beforeContent = (await readFileContentOrNull(filePath)) ?? '';
        const toolUseId = `codex-acp-write-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
        const tagId = `ai-edit-pending-${sessionId}-${toolUseId}`;

        await historyManager.createTag(
          workspacePath,
          filePath,
          tagId,
          beforeContent,
          sessionId,
          toolUseId,
        );

        await sessionFileTracker.trackToolExecution(
          sessionId,
          workspacePath,
          'Write',
          { path: filePath },
          undefined,
          toolUseId,
          findWindowByWorkspace(workspacePath),
        );
      } catch (error) {
        const errorStr = String(error);
        if (!errorStr.includes('unique') && !errorStr.includes('UNIQUE') && !errorStr.includes('duplicate')) {
          logger.ai.error('[CodexACP] onBeforeFileWrite hook failed:', error);
        }
      }
    });

    OpenAICodexACPProvider.setOnTurnFilesEdited(async (filePaths, sessionId) => {
      if (!sessionId || filePaths.size === 0) return;
      try {
        const session = await AISessionsRepository.get(sessionId);
        const workspacePath = session?.workspacePath;
        if (!workspacePath) return;
        // The turn-end snapshot pass is handled by the watcher pipeline; the
        // hook just emits a renderer notification so the FilesEditedSidebar
        // refreshes after a multi-file turn completes.
        const window = findWindowByWorkspace(workspacePath);
        if (window && !window.isDestroyed()) {
          window.webContents.send('session-files:updated', sessionId);
        }
      } catch (error) {
        logger.ai.error('[CodexACP] onTurnFilesEdited hook failed:', error);
      }
    });

    // Inject image compressor
    // Compresses images to fit within Claude API 5MB base64 limit
    ClaudeCodeProvider.setImageCompressor(async (buffer, mimeType, options) => {
      const { compressImage } = await import('./services/ImageCompressor');
      const result = await compressImage(buffer, mimeType, options);
      return {
        buffer: result.buffer,
        mimeType: result.mimeType,
        wasCompressed: result.wasCompressed
      };
    });

    // Inject extension file types loader
    // Allows planning mode to permit editing extension-registered file types
    ClaudeCodeProvider.setExtensionFileTypesLoader(getRegisteredExtensions);

    registerMockupHandlers();
    registerDataModelHandlers();
    registerExtensionHandlers();
    registerExtensionPermissionHandlers();
    registerTrackerImporterHandlers();
    registerExtensionMarketplaceHandlers();
    registerOffscreenEditorHandlers();

    // Phase 4: install the extension-agent bridge so the runtime-side
    // `ExtensionAgentProvider` wrapper can route to PrivilegedExtensionHost.
    // Workspace resolution prefers the focused window's active workspace;
    // falls back to any window with one open. Returns null if no window has
    // a workspace path -- the bridge surfaces this as a `no-workspace` error.
    installExtensionAgentBridge({
      resolveActiveWorkspacePath: () => {
        const { BrowserWindow } = require('electron') as typeof import('electron');
        const focused = BrowserWindow.getFocusedWindow();
        if (focused) {
          const state = windowStates.get(focused.id);
          const path = resolveActiveWorkspacePath(state);
          if (path) return path;
        }
        for (const state of windowStates.values()) {
          const path = resolveActiveWorkspacePath(state);
          if (path) return path;
        }
        return null;
      },
    });

    // Initialize extension file types (must happen before file operations)
    markStart('extension-file-types');
    await initializeExtensionFileTypes();
    markEnd('extension-file-types');

    // Initialize AI service
    markStart('ai-service-init');
    if (!runtimeSessionStore) {
        throw new Error('AI session store unavailable after database initialization');
    }
    aiService = new AIService(runtimeSessionStore);
    markEnd('ai-service-init');

    // Recovery sweep: any queued_prompts row that was 'executing' when the
    // app shut down is now invisible to listPending. sweepExecutingOnBoot
    // distinguishes "delivered, but the agent was paused on a user prompt
    // (AskUserQuestion / ExitPlanMode / permission request) at quit" from
    // "crashed before the user message was ever sent" by checking whether
    // an ai_agent_messages input row exists for the session at or after
    // claimed_at. Delivered rows are marked completed; undelivered rows
    // are rolled back to pending for retry. Without this split, a session
    // paused on AskUserQuestion at quit gets its original user prompt
    // re-sent on next launch (NIM-615).
    try {
      const { getQueuedPromptsStore } = await import('./services/RepositoryManager');
      const { completed, failed, rolledBack } = await getQueuedPromptsStore().sweepExecutingOnBoot();
      if (completed > 0 || failed > 0 || rolledBack > 0) {
        logger.main.info(
          `[Main] Boot sweep: ${completed} answered prompt(s) marked completed, ${failed} delivered-but-unanswered prompt(s) marked failed, ${rolledBack} undelivered prompt(s) rolled back to pending`
        );
      }
    } catch (sweepErr) {
      logger.main.error('[Main] Boot sweep failed:', sweepErr);
    }

    // Initialize Voice Mode handlers
    // The renderer calls 'voice-mode:init' to trigger initialization
    safeHandle('voice-mode:init', async () => {
      return { success: true };
    });
    initVoiceModeService();
    initVoiceModeSettingsHandler();
    registerWalkthroughHandlers();

    // Start MCP SSE server
    markStart('mcp-servers');

    // Generate the per-launch bearer token before any MCP server starts.
    // The same token is shared across all five internal MCP servers (they all
    // run in this process). It is held in memory only -- never persisted.
    // Issue #146: required so a malicious page in the user's browser can't
    // invoke MCP tools against the localhost ports.
    const mcpAuthToken = generateMcpAuthToken();
    configureMcpServers({ mcpAuthToken });

    // Test-only IPC handler: lets E2E tests verify the bearer token is
    // enforced by the MCP servers. Mirrors the pattern used for
    // `meta-agent:get-server-port`.
    if (process.env.PLAYWRIGHT === '1' || process.env.PLAYWRIGHT_TEST === 'true' || process.env.NODE_ENV === 'test') {
        safeHandle('mcp:get-server-port', async () => {
            const port = (global as any).mcpServerPort;
            return { success: typeof port === 'number', port: typeof port === 'number' ? port : null };
        });
        safeHandle('mcp:get-auth-token', async () => {
            const token = getMcpAuthToken();
            return { success: token !== null, token };
        });
    }

    try {
        const result = await startMcpHttpServer(3456, { aiService });
        mcpHttpServer = result.httpServer;
        logger.mcp.info('MCP SSE server started on port', result.port);

        // Store the actual port for providers to use
        (global as any).mcpServerPort = result.port;

        // MCP consolidation: all internal MCP-server enablement (port, per-ext
        // servers, tracker opt-out) goes through the shared registry once —
        // every provider + the CLI launcher read it via getMcpConfigService.
        //
        // Per-extension servers (Phase 3): each active extension gets its own
        // deferred `nimbalyst-<ext>` server; read fresh per session-start so
        // newly-loaded extensions get a server without an app restart.
        //
        // Tracker opt-out (Phase 4): read `trackers.enabled` from workspace state
        // per config build so the Trackers settings toggle takes effect on the
        // next session start without a restart. Returns "disabled" (true => omit
        // `nimbalyst-trackers`); default on.
        configureMcpServers({
            mcpServerPort: result.port,
            extensionMcpServerNamesLoader: (workspacePath?: string) =>
                getActiveExtensionShortNames(workspacePath),
            trackersAgentToolsDisabledLoader: (workspacePath?: string) =>
                workspacePath ? !isTrackersAgentToolsEnabled(workspacePath) : false,
        });

        // Publish the loopback endpoint + per-launch token so the `nim`
        // companion CLI can discover and talk to this running instance (live
        // mode). The file is 0600 and removed on quit; the CLI checks pid
        // liveness before trusting it. See mcpEndpointDescriptor.ts.
        try {
            writeMcpEndpointDescriptor({
                port: result.port,
                token: mcpAuthToken,
                hostBootId,
                workspaces: collectOpenWorkspaces(),
            });
        } catch (descriptorError) {
            logger.mcp.error('Failed to publish MCP endpoint descriptor:', descriptorError);
        }

        // Backend modules: sweep open windows after startup so enabled extension
        // engines (e.g. project-memory) come up without waiting for an agent to
        // touch the window's MCP surface (which is what drives the renderer
        // mcp:updateDocumentState the per-workspace hook relies on). `windowStates`
        // populates as windows finish restoring — AFTER this point — so retry on a
        // short interval until a sweep finds open workspaces, then stop (later
        // opens are covered by the focus listener + per-workspace hook). Capped so
        // a windowless run doesn't poll forever. All paths are idempotent.
        let backendSweepAttempts = 0;
        const backendSweepTimer = setInterval(() => {
            backendSweepAttempts += 1;
            void sweepOpenWindowsForBackendModules()
                .then((sweptAny) => {
                    if (sweptAny || backendSweepAttempts >= 20) {
                        clearInterval(backendSweepTimer);
                    }
                })
                .catch((err) => {
                    logger.mcp.error('Startup backend-module sweep failed:', err);
                    if (backendSweepAttempts >= 20) clearInterval(backendSweepTimer);
                });
        }, 3000);
        app.on('browser-window-focus', () => {
            void sweepOpenWindowsForBackendModules().catch((err) =>
                logger.mcp.error('Focus backend-module sweep failed:', err)
            );
        });
    } catch (error) {
            logger.mcp.error('Failed to start MCP SSE server:', error);
    }

    // Session metadata fns injection (MCP consolidation Phase 7: no standalone
    // HTTP server — `update_session_meta` is served by the unified `/mcp/core`).
    // The service still injects the title/metadata/query fns that dispatch uses.
    try {
        const sessionNamingService = SessionNamingService.getInstance();
        await sessionNamingService.start();
    } catch (error) {
        logger.mcp.error('Failed to start session naming service:', error);
    }

    // Start extension dev MCP server (for Extension Developer Kit). Still its own
    // standalone HTTP server (profile-gated); registers its port via the shared
    // MCP config registry.
    try {
        const extensionDevService = ExtensionDevService.getInstance();
        await extensionDevService.start();
    } catch (error) {
        logger.mcp.error('Failed to start extension dev MCP server:', error);
    }

    // MCP consolidation Phase 7: session-context + settings tools fold onto the
    // unified server (`/mcp/host`); no standalone HTTP servers. The settings
    // kill-switch (read fresh from the store per config build, so flipping
    // `settingsAgentToolsDisabled` in Settings > Advanced takes effect on the
    // next session start) is the only thing still wired here.
    configureMcpServers({
        settingsAgentToolsDisabledLoader: () => isSettingsAgentToolsDisabled(),
    });

    try {
        const metaAgentService = MetaAgentService.getInstance();
        await metaAgentService.start(aiService);
    } catch (error) {
        logger.mcp.error('Failed to start meta-agent MCP server:', error);
    }

    // Watcher-obligation startup recovery (NIM-364): after the DB/queue boot
    // sweep and the meta-agent MCP surface are both up, but before restart
    // continuations, super-loop recovery, or session wakeups resume, give an
    // operator-configured watcher-obligation controller one chance to
    // re-establish its own state for this boot. A failure here must never
    // block startup.
    try {
        const { runWatcherObligationStartupRecovery } = await import('./services/WatcherObligationStartupRecovery');
        await runWatcherObligationStartupRecovery({ hostBootId });
    } catch (error) {
        logger.main.error('[Main] Watcher-obligation startup recovery failed:', error);
    }

    // Check for pending restart continuations and queue continuation prompts.
    // NIM-364: moved here (was previously right after the boot sweep) so it
    // runs after the meta-agent MCP surface and watcher-obligation recovery
    // are both ready, per the required startup ordering.
    await checkForRestartContinuation(aiService);

    // Recover any super loops that were running when the app last shut down.
    // NIM-364: moved here alongside checkForRestartContinuation, same reason.
    await getSuperLoopService().recoverStaleLoopState();

    // Start session wakeup scheduler (persistent scheduled re-invocations)
    try {
        const aiSvcRef = aiService;
        const scheduler = SessionWakeupScheduler.getInstance();
        scheduler.configure({
            store: getSessionWakeupsStore(),
            executor: async ({ sessionId, workspacePath, prompt }) => {
                if (!aiSvcRef) {
                    return { triggered: false };
                }
                await aiSvcRef.queuePromptForSession(sessionId, prompt, undefined, { promptOrigin: 'wakeup_resume' });
                const triggered = await aiSvcRef.triggerQueuedPromptProcessingForSession(
                    sessionId,
                    workspacePath,
                );
                return { triggered };
            },
            broadcastChanged: (row) => {
                for (const window of BrowserWindow.getAllWindows()) {
                    if (!window.isDestroyed()) {
                        try {
                            window.webContents.send('wakeup:changed', row);
                        } catch {
                            // ignore -- destroyed window
                        }
                    }
                }
            },
        });
        await scheduler.start();
    } catch (error) {
        logger.mcp.error('Failed to start session wakeup scheduler:', error);
    }
    markEnd('mcp-servers');

    // Set up IPC handler to update document state for MCP
    safeOn('mcp:updateDocumentState', (event, state) => {
        // Get the window that sent this message
        const window = BrowserWindow.fromWebContents(event.sender);
        const windowId = window?.id;

        // Register the workspace-to-window mapping for routing
        if (state?.workspacePath && windowId) {
            // logger.mcp.info(`Registering workspace ${state.workspacePath} -> window ${windowId}`);
            registerWorkspaceWindow(state.workspacePath, windowId);

            // First time we see this workspace, start the backend modules of any
            // enabled extension in it. This is the reliable "workspace is open in
            // a window" signal (the renderer reports document state after init),
            // so it doubles as the startup path for already-enabled extensions
            // and the open-path for newly-opened workspaces. startModule is
            // idempotent, so the guard is only an efficiency measure.
            if (!backendModulesStartedForWorkspace.has(state.workspacePath)) {
                backendModulesStartedForWorkspace.add(state.workspacePath);
                const ws = state.workspacePath;
                void startWorkspaceBackendModules(ws, getDefaultBackendModuleLifecycleDeps()).catch(
                    (err) => logger.mcp.error(`Backend-module start failed for workspace ${ws}:`, err)
                );
            }
            // Issue #146: also allow `nim-asset://` to serve images from the
            // workspace. addNimAssetRoot is idempotent.
            addNimAssetRoot(state.workspacePath);
            // Browser previews serve HTML/CSS/JS from the same workspace via
            // the `nim-preview://` scheme.
            addNimPreviewWorkspaceRoot(state.workspacePath);
        } else {
            logger.mcp.warn(`Cannot register workspace: workspacePath=${state?.workspacePath}, windowId=${windowId}`);
        }

        // Update document state with the workspace path (canonical identifier)
        updateDocumentState(state);
    });

    // Set up IPC handler for extension tool registration
    safeOn('mcp:registerExtensionTools', (event, data) => {
        const { workspacePath, tools } = data;
        if (workspacePath && tools) {
            registerExtensionTools(workspacePath, tools);
        }
    });

    // Set up IPC handler for theme changes from renderer
    safeOn('set-theme', (event, theme: AppTheme, isDark?: boolean) => {
        setTheme(theme, isDark);
        FeatureUsageService.getInstance().recordUsage(FEATURES.THEME_CHANGED);
        // User explicitly applied a theme — clear any pending fallback banner
        clearPendingThemeFallback();
        updateNativeTheme();
        BrowserWindow.getAllWindows().forEach(window => {
            window.webContents.send('theme-change', theme);
        });
        updateWindowTitleBars();
    });

    // Set up IPC handler for Discord invitation dismissal
    safeOn('dismiss-discord-invitation', (event) => {
        logger.main.info('User dismissed community popup permanently');
        dismissCommunityPopup();
        dismissDiscordInvitation();
    });

    // Set up IPC handler for Windows Claude Code warning dismissal
    safeOn('dismiss-claude-code-windows-warning', (event) => {
        logger.main.info('User dismissed Windows Claude Code warning permanently');
        dismissClaudeCodeWindowsWarning();
    });

    // Rosetta warning: x64 build running on Apple Silicon via translation
    safeHandle('platform:should-show-rosetta-warning', async () => {
        return shouldShowRosettaWarning();
    });

    safeOn('dismiss-rosetta-warning', (event) => {
        logger.main.info('User dismissed Rosetta warning permanently');
        dismissRosettaWarning();
    });

    // Skip session restoration if opening a specific workspace from CLI
    markStart('session-restore');
    const shouldSkipSessionRestore = !!pendingWorkspacePath;
    const sessionRestored = shouldSkipSessionRestore ? false : await restoreSessionState();
    markEnd('session-restore');

    // Note: customClaudeCodePathLoader is now set up in AIService constructor,
    // where it has direct access to the ai-settings store that owns this value.

    // Close splash screen now that initialization is done and a real window is about to show.
    // The last restored window activates the app via its own ready-to-show handler.
    closeSplashScreen();

    if (pendingWorkspacePath) {
        // Handle workspace path from CLI
        const workspacePath = pendingWorkspacePath;
        const filterToApply = pendingFilter;
        const fileToOpen = pendingCliFilePath;
        pendingWorkspacePath = null;
        pendingFilter = null;
        pendingCliFilePath = null;

        // Track workspace opened from CLI
        try {
            const { readdirSync, statSync } = await import('fs');
            const { join } = await import('path');
            const { GitStatusService } = await import('./services/GitStatusService');

            // Count files in workspace
            let fileCount = 0;
            let hasSubfolders = false;
            try {
                const entries = readdirSync(workspacePath, { withFileTypes: true });
                for (const entry of entries) {
                    if (entry.isFile()) {
                        fileCount++;
                    } else if (entry.isDirectory() && !entry.name.startsWith('.')) {
                        hasSubfolders = true;
                    }
                }
            } catch (error) {
                // Ignore count errors
            }

            // Bucket file count
            let fileCountBucket = '1-10';
            if (fileCount > 100) fileCountBucket = '100+';
            else if (fileCount > 50) fileCountBucket = '51-100';
            else if (fileCount > 10) fileCountBucket = '11-50';

            // Check git repository status (defaults to false if git not available)
            let isGitRepository = false;
            let isGitHub = false;

            try {
                const gitStatusService = new GitStatusService();
                isGitRepository = await gitStatusService.isGitRepo(workspacePath);
                if (isGitRepository) {
                    isGitHub = await gitStatusService.hasGitHubRemote(workspacePath);
                }
            } catch (gitError) {
                // Git checks failed - continue with defaults (false, false)
                logger.main.error('Error checking git status:', gitError);
            }

            analytics.sendEvent('workspace_opened', {
                fileCount: fileCountBucket,
                hasSubfolders,
                source: 'cli',
                isGitRepository,
                isGitHub,
            });
        } catch (error) {
            logger.main.error('Error tracking workspace_opened event:', error);
        }

        // Ensure .nimbalyst/trackers/ directory exists
        // DISABLED FOR NOW - test creates it
        // if (workspacePath) {
        //     const { getTrackerLoaderService } = await import('./services/TrackerLoaderService');
        //     await getTrackerLoaderService().ensureTrackersDirectory(workspacePath);
        // }

        // Apply filter to workspace state if specified
        if (filterToApply) {
            const validFilters = ['all', 'markdown', 'known', 'git-uncommitted', 'git-worktree', 'ai-read', 'ai-written'];
            if (validFilters.includes(filterToApply)) {
                logger.main.info(`Applying filter '${filterToApply}' to workspace ${workspacePath}`);
                updateWorkspaceState(workspacePath, (state) => {
                    state.fileTreeFilter = filterToApply as any;
                });

                // Track git-worktree filter usage with set-once property
                if (filterToApply === 'git-worktree') {
                    analytics.sendEvent('workspace_opened_with_filter', {
                        filter: 'git-worktree',
                        $set_once: {
                            'ever_opened_direct_to_worktree': true
                        }
                    });
                }
            } else {
                logger.main.warn(`Invalid filter '${filterToApply}' specified via CLI. Valid filters: ${validFilters.join(', ')}`);
            }
        }

        const window = createWindow(false, true, workspacePath);

        setTimeout(() => {
            // Yield before background workspace initialization so CLI opens don't
            // inherit synchronous git/process work on the startup tick.
            void autoMatchTeamForWorkspace(workspacePath).catch(() => {});
            void initializeTrackerSync(workspacePath).catch(() => {});
            updateTrackerSchemaWorkspace(workspacePath);
        }, 0);

        window.once('ready-to-show', () => {
            window.show();
            // Notify renderer to ensure workspace UI syncs with the selected path
            window.webContents.send('open-workspace-from-cli', workspacePath);

            // If --file was specified, open the file after workspace UI initializes
            if (fileToOpen) {
                // Give the renderer time to initialize workspace mode, then load the file
                setTimeout(() => {
                    loadFileIntoWindow(window, fileToOpen);
                }, 200);
            }
        });
    } else if (!sessionRestored && !pendingFilePath) {
        // No session to restore and no file to open - show Workspace Manager
        createWorkspaceManagerWindow();
    } else if (pendingFilePath) {
        // Handle pending file with workspace detection
        const fileToOpen = pendingFilePath;
        pendingFilePath = null;
        await openFileWithWorkspaceDetection(fileToOpen);
    }

    // Handle pending deep link URL (e.g., auth callback)
    if (pendingDeepLinkUrl) {
        const urlToHandle = pendingDeepLinkUrl;
        pendingDeepLinkUrl = null;
        await handleDeepLink(urlToHandle);
    }

    // Community popup fallback for passive users:
    // show on launch 5+ if success-moment trigger (3 tool sessions) has not fired.
    if (
        shouldShowCommunityPopup()
        && launchCount >= 5
        && getCompletedSessionsWithTools() < 3
        && !wasCommunityPopupShownThisLaunch()
    ) {
        setTimeout(() => {
            if (wasCommunityPopupShownThisLaunch()) {
                return;
            }

            const windows = BrowserWindow.getAllWindows().filter(window => !window.isDestroyed());
            const focusedWindow = BrowserWindow.getFocusedWindow();
            const targetWindow = focusedWindow && !focusedWindow.isDestroyed() ? focusedWindow : windows[0];

            if (!targetWindow || targetWindow.isDestroyed()) {
                return;
            }

            targetWindow.webContents.send('show-discord-invitation');
            markCommunityPopupShown();
        }, 2000);
    }

    // Create application menu
    await createApplicationMenu();

    // Set initial native theme
    updateNativeTheme();

    // Initialize auto-updater (only in production)
    if (app.isPackaged) {
        logger.main.info('Starting auto-updater service');
        autoUpdaterService.startAutoUpdateCheck(60); // Check every hour
    } else {
        logger.main.info('Skipping auto-updater in development mode');
    }

    // Start performance monitoring
    startPerformanceMonitoring();

    // Mark boot as complete - all critical initialization is done
    markBootComplete();

    // Auto-update marketplace extensions (fire-and-forget, don't block startup)
    runExtensionAutoUpdate();

    // Log startup timing summary (in dev mode or when NIMBALYST_STARTUP_TIMING=true)
    logSummary();

    // Remove periodic menu updates - menus should update on events only
    // This was causing high CPU usage by updating every second
    // menuUpdateInterval = setInterval(() => {
    //     if (!isAppQuitting && BrowserWindow.getAllWindows().length > 0) {
    //         updateApplicationMenu();
    //     }
    // }, 1000);

    // Save session periodically (every 30 seconds)
    sessionSaveInterval = setInterval(async () => {
        // Only save if app is not quitting or restarting. During a restart the
        // good state is saved once in `before-quit`; a periodic save firing
        // afterward (over an emptied windows map) would clobber it (NIM-869).
        if (!isAppQuitting && !isRestarting()) {
            await saveSessionState();
        }
    }, 30000);

    // Monitor memory usage and perform cleanup for long-running sessions
    memoryMonitorInterval = setInterval(() => {
        if (!isAppQuitting) {
            const memUsage = process.memoryUsage();
            const uptime = Date.now() - appStartTime;

            // Log memory usage every hour
            if (uptime % 3600000 < 60000) {
                console.log('[Memory] Usage:', JSON.stringify({
                    rss: `${Math.round(memUsage.rss / 1024 / 1024)}MB`,
                    heapUsed: `${Math.round(memUsage.heapUsed / 1024 / 1024)}MB`,
                    heapTotal: `${Math.round(memUsage.heapTotal / 1024 / 1024)}MB`,
                    uptime: `${Math.round(uptime / 1000 / 60)} minutes`
                }));
            }

            // If memory usage is high (>1GB heap), trigger garbage collection
            if (memUsage.heapUsed > 1024 * 1024 * 1024) {
                if (global.gc) {
                    console.log('[Memory] High heap usage detected, running garbage collection');
                    global.gc();
                }

                // Also clear webContents caches for all windows
                BrowserWindow.getAllWindows().forEach(window => {
                    if (!window.isDestroyed()) {
                        window.webContents.session.clearCache();
                    }
                });
            }

        }
    }, 60000); // Check every minute

    // Listen for system theme changes
    let lastNativeDark = nativeTheme.shouldUseDarkColors;
    nativeTheme.on('updated', () => {
        const currentTheme = getTheme();
        const isDark = nativeTheme.shouldUseDarkColors;
        // Only react when:
        //  - app theme is 'system', and
        //  - the effective dark/light value actually changed
        if (currentTheme === 'system' && isDark !== lastNativeDark) {
            lastNativeDark = isDark;
            // Update windows when system theme changes
            updateWindowTitleBars();
            // Send RESOLVED theme (light or dark) to all windows
            const resolvedTheme = isDark ? 'dark' : 'light';
            BrowserWindow.getAllWindows().forEach(window => {
                window.webContents.send('theme-change', resolvedTheme);
            });
        }
    });
});

// Activate handler (macOS)
app.on('activate', () => {
    // Avoid resurrecting windows while quitting
    if (isAppQuitting) return;
    // Only create window if app is ready (screen module requires app to be ready)
    if (!app.isReady()) return;
    // On macOS, show WorkspaceManager when dock icon is clicked and no windows are open
    if (BrowserWindow.getAllWindows().length === 0) {
        createWorkspaceManagerWindow();
    }
});

// Before quit handler
app.on('before-quit', async (event) => {
    getCollabOutboxDrainCoordinator().stop();
    getCollabAssetOutboxDrainCoordinator().stop();
    console.log('[QUIT] before-quit event triggered');

    // If auto-updater is updating, don't prevent quit
    if (AutoUpdaterService.isUpdatingApp()) {
        console.log('[QUIT] Auto-updater is updating, allowing quit');
        return;
    }

    // If we're already quitting, don't prevent default to avoid infinite loop
    if (isAppQuitting) {
        console.log('[QUIT] Already quitting, allowing default behavior');
        return;
    }

    // Check if this is a programmatic restart request (from MCP restart_nimbalyst tool)
    const restartSignalPath = getRestartSignalPath();
    if (fs.existsSync(restartSignalPath)) {
        console.log('[QUIT] Restart signal detected, saving session state before restart');
        // Mark as restarting BEFORE saving to prevent window close handlers from overwriting
        isAppRestarting = true;
        // Stop the periodic session-save timer and mark quitting so NO further
        // save can fire after windows tear down. Without this the periodic save
        // (guarded only by !isAppQuitting) could run over an emptied windows map
        // and overwrite the good state with `{ windows: [] }` -- the restart
        // would then come back to the Workspace Manager with no projects (NIM-869).
        isAppQuitting = true;
        if (sessionSaveInterval) {
            clearInterval(sessionSaveInterval);
            sessionSaveInterval = null;
        }
        // Save session state so the session is restored after restart
        try {
            await saveSessionState();
            await flushPendingCollabBackups();
            console.log('[QUIT] Session state saved for restart');
        } catch (error) {
            console.error('[QUIT] Error saving session state for restart:', error);
        }
        // Don't delete the file here - dev-loop.sh needs it to know to restart
        return;
    }

    // Check for active AI sessions before proceeding
    // Skip in Playwright test environment to allow clean test teardown
    if (hasActiveStreamingSessions() && !process.env.PLAYWRIGHT) {
        event.preventDefault();

        analytics.sendEvent('quit_confirmation_shown', {
            reason: 'active_ai_session'
        });

        const response = await dialog.showMessageBox({
            type: 'warning',
            title: 'AI Session in Progress',
            message: 'An AI session is currently running.',
            detail: 'If you quit now, the current AI response will be lost. Are you sure you want to quit?',
            buttons: ['Quit Anyway', 'Cancel'],
            defaultId: 1,
            cancelId: 1
        });

        if (response.response !== 0) {
            // User cancelled - stay running.
            console.log('[QUIT] User cancelled quit due to active AI session');
            analytics.sendEvent('quit_confirmation_result', {
                result: 'cancelled'
            });
            return;
        }

        // User clicked "Quit Anyway". Fall through to the graceful cleanup block
        // below (event.preventDefault was already called above) so the database
        // is checkpointed, closed, and its lock released. The old code called
        // app.quit() and returned here, which skipped cleanup on BOTH passes (the
        // second before-quit short-circuits on isAppQuitting), leaking
        // nimbalyst-db.pid and forcing the next launch onto stale-lock detection.
        console.log('[QUIT] User confirmed quit with active AI session');
        analytics.sendEvent('quit_confirmation_result', {
            result: 'quit_anyway'
        });
    }

    // Prevent default to do async cleanup
    event.preventDefault();

    // Mark app as quitting to prevent interval operations
    isAppQuitting = true;

    // Live collaboration backups are debounced. Flush the latest decrypted
    // snapshots before renderer teardown so a quick quit cannot drop them.
    await flushPendingCollabBackups();

    // Setup force quit timer - allow enough time for database backup + close
    // Database operations: backup (up to 5s) + close worker (up to 5s) + buffer (5s/3s)
    // The close budget is 5s instead of 2s because PGLite runs Postgres in --single
    // mode (no background checkpointer), so close() now issues an explicit CHECKPOINT
    // first; on a large WAL that can take several seconds. Force-quit total bumped
    // accordingly so the new close budget isn't preempted.
    // This is CRITICAL for Windows where forced shutdowns need proper cleanup time
    const forceQuitDelay = app.isPackaged ? 15000 : 13000;
    setupForceQuit(forceQuitDelay);

    let debugLog: string | null = null;
    let canWriteLogs = false;

    // stop analytics
    await analytics.destroy();

    // Shutdown tray
    try {
        TrayManager.getInstance().shutdown();
    } catch (error) {
        console.error('[QUIT] Error shutting down TrayManager:', error);
    }

    // Shutdown Stytch auth service
    try {
        shutdownStytchAuth();
    } catch (error) {
        console.error('[QUIT] Error shutting down Stytch auth:', error);
    }

    // Check if we can write to userData directory
    try {
        const userDataPath = app.getPath('userData');
        debugLog = path.join(userDataPath, 'preditor-debug.log');

        // Test write permission
        fs.accessSync(userDataPath, fs.constants.W_OK);
        canWriteLogs = true;
        fs.appendFileSync(debugLog, `\n[QUIT] before-quit event at ${new Date().toISOString()}\n`);
        fs.appendFileSync(debugLog, `[QUIT] User: ${process.env.USER || 'unknown'}, UID: ${process.getuid?.() || 'unknown'}\n`);
    } catch (e) {
        console.error('[QUIT] Cannot write to userData directory:', e);
        canWriteLogs = false;
    }

    try {
        // Clear ALL intervals first (should not fail)
        if (sessionSaveInterval) {
            clearInterval(sessionSaveInterval);
            sessionSaveInterval = null;
        }
        if (menuUpdateInterval) {
            clearInterval(menuUpdateInterval);
            menuUpdateInterval = null;
        }
        if (memoryMonitorInterval) {
            clearInterval(memoryMonitorInterval);
            memoryMonitorInterval = null;
        }

        // Stop the PR review polling scheduler (issue #307, Phase D).
        try {
            stopPullRequestPollScheduler();
        } catch (e) {
            console.error('[QUIT] Failed to stop PR poll scheduler:', e);
        }

        // CRITICAL: Stop performance monitoring - this has an interval that keeps the process alive!
        stopPerformanceMonitoring();

        if (canWriteLogs) {
            logger.session.info('App quitting, intervals cleared');
        }
    } catch (error) {
        console.error('Error clearing intervals:', error);
        if (canWriteLogs && debugLog) {
            try {
                fs.appendFileSync(debugLog, `[QUIT] Error clearing intervals: ${error}\n`);
            } catch (e) {}
        }
    }

    // Clean up all file watchers FIRST - these can keep the process alive
    try {
        const t1 = Date.now();
        console.log(`[QUIT] [${t1}] About to clean up file watchers`);
        if (canWriteLogs && debugLog) {
            try {
                fs.appendFileSync(debugLog, '[QUIT] Cleaning up file watchers\n');
            } catch (e) {}
        }

        console.log(`[QUIT] [${t1}] Calling stopAllFileWatchers...`);
        await stopAllFileWatchers();
        const t2 = Date.now();
        console.log(`[QUIT] [${t2}] stopAllFileWatchers returned (${t2-t1}ms)`);

        console.log(`[QUIT] [${t2}] Calling stopAllWorkspaceWatchers...`);
        await stopAllWorkspaceWatchers();
        const t3 = Date.now();
        console.log(`[QUIT] [${t3}] stopAllWorkspaceWatchers returned (${t3-t2}ms)`);

        // Tear down any in-flight browser preview sessions so we don't leak
        // WebContentsViews if the host windows are torn down asynchronously.
        try {
            BrowserSessionService.getInstance().cleanup();
        } catch (e) {
            console.warn('[QUIT] BrowserSessionService cleanup error:', e);
        }

        if (canWriteLogs && debugLog) {
            try {
                fs.appendFileSync(debugLog, '[QUIT] File watchers cleaned up\n');
            } catch (e) {}
        }
    } catch (error) {
        console.error('[QUIT] Error cleaning up file watchers:', error);
        if (canWriteLogs && debugLog) {
            try {
                fs.appendFileSync(debugLog, `[QUIT] Error cleaning up file watchers: ${error}\n`);
            } catch (e) {}
        }
    }

    try {
        // Clean up session state manager
        const t3_5 = Date.now();
        console.log(`[QUIT] [${t3_5}] Shutting down session state manager`);
        if (canWriteLogs && debugLog) {
            try {
                fs.appendFileSync(debugLog, '[QUIT] Shutting down session state manager\n');
            } catch (e) {}
        }
        await shutdownSessionStateHandlers();
        const t3_6 = Date.now();
        console.log(`[QUIT] [${t3_6}] Session state manager shutdown (${t3_6-t3_5}ms)`);

        // Shutdown terminal sessions
        await shutdownTerminalHandlers();
        console.log(`[QUIT] Terminal sessions shutdown`);

        // Tear down the codex auth app-server child if it was lazily started.
        try {
            codexAuthService.shutdown();
        } catch (e) {
            console.warn('[QUIT] codexAuthService shutdown failed:', e);
        }
    } catch (error) {
        console.error('[QUIT] Error shutting down session state manager:', error);
        if (canWriteLogs && debugLog) {
            try {
                fs.appendFileSync(debugLog, `[QUIT] Error shutting down session state manager: ${error}\n`);
            } catch (e) {}
        }
    }

    try {
        // Clean up AI service
        const t4 = Date.now();
        console.log(`[QUIT] [${t4}] Cleaning up AI service`);
        if (aiService) {
            if (canWriteLogs && debugLog) {
                try {
                    fs.appendFileSync(debugLog, '[QUIT] Destroying AI service\n');
                } catch (e) {}
            }
            aiService.destroy();
            aiService = null;
        }
        const t5 = Date.now();
        console.log(`[QUIT] [${t5}] AI service cleanup complete (${t5-t4}ms)`);
    } catch (error) {
        console.error('[QUIT] Error destroying AI service:', error);
        if (canWriteLogs && debugLog) {
            try {
                fs.appendFileSync(debugLog, `[QUIT] Error destroying AI service: ${error}\n`);
            } catch (e) {}
        }
    }

    try {
        // Shutdown MCP HTTP server with timeout
        const t6 = Date.now();
        console.log(`[QUIT] [${t6}] Shutting down MCP HTTP server`);
        if (canWriteLogs && debugLog) {
            try {
                fs.appendFileSync(debugLog, '[QUIT] Shutting down MCP HTTP server\n');
            } catch (e) {}
        }

        // Add timeout to prevent hanging
        const shutdownPromise = shutdownHttpServer();
        const timeoutPromise = new Promise((resolve) => setTimeout(resolve, 500));
        await Promise.race([shutdownPromise, timeoutPromise]);
        const t7 = Date.now();
        console.log(`[QUIT] [${t7}] MCP HTTP server shutdown complete (${t7-t6}ms)`);

        mcpHttpServer = null;

        // Remove the nim CLI endpoint descriptor so a stale token/port can't be
        // discovered after this instance exits.
        try {
            removeMcpEndpointDescriptor();
        } catch (e) {}

        // Clean up MCP config service file watchers
        if (mcpConfigService && !mcpConfigServiceCleanedUp) {
            try {
                mcpConfigServiceCleanedUp = true;
                mcpConfigService.cleanup();
                mcpConfigService = null;
                console.log('[QUIT] MCP config service cleaned up');
            } catch (error) {
                console.error('[QUIT] Error cleaning up MCP config service:', error);
            }
        }

        // Clean up CLI manager
        const t8 = Date.now();
        console.log(`[QUIT] [${t8}] Cleaning up CLI manager`);
        cliManager.cleanup();
        const t9 = Date.now();
        console.log(`[QUIT] [${t9}] CLI manager cleanup complete (${t9-t8}ms)`);

        if (canWriteLogs && debugLog) {
            try {
                fs.appendFileSync(debugLog, '[QUIT] MCP HTTP server shutdown complete\n');
            } catch (e) {}
        }
    } catch (error) {
        console.error('[QUIT] Error closing MCP server:', error);
        if (canWriteLogs && debugLog) {
            try {
                fs.appendFileSync(debugLog, `[QUIT] Error closing MCP server: ${error}\n`);
            } catch (e) {}
        }
    }

    try {
        // Shutdown session naming MCP HTTP server
        const t6a = Date.now();
        console.log(`[QUIT] [${t6a}] Shutting down session naming MCP HTTP server`);
        if (canWriteLogs && debugLog) {
            try {
                fs.appendFileSync(debugLog, '[QUIT] Shutting down session naming MCP HTTP server\n');
            } catch (e) {}
        }

        const sessionNamingService = SessionNamingService.getInstance();
        const shutdownPromise = sessionNamingService.shutdown();
        const timeoutPromise = new Promise((resolve) => setTimeout(resolve, 500));
        await Promise.race([shutdownPromise, timeoutPromise]);
        const t7a = Date.now();
        console.log(`[QUIT] [${t7a}] Session naming MCP HTTP server shutdown complete (${t7a-t6a}ms)`);

        if (canWriteLogs && debugLog) {
            try {
                fs.appendFileSync(debugLog, '[QUIT] Session naming MCP HTTP server shutdown complete\n');
            } catch (e) {}
        }
    } catch (error) {
        console.error('[QUIT] Error closing session naming MCP server:', error);
        if (canWriteLogs && debugLog) {
            try {
                fs.appendFileSync(debugLog, `[QUIT] Error closing session naming MCP server: ${error}\n`);
            } catch (e) {}
        }
    }

    try {
        // Stop session wakeup scheduler (clears timer; rows in DB persist for next launch)
        SessionWakeupScheduler.getInstance().stop();
    } catch (error) {
        console.error('[QUIT] Error stopping session wakeup scheduler:', error);
    }

    try {
        // Shutdown extension dev MCP server
        const extensionDevService = ExtensionDevService.getInstance();
        const shutdownPromise = extensionDevService.shutdown();
        const timeoutPromise = new Promise((resolve) => setTimeout(resolve, 500));
        await Promise.race([shutdownPromise, timeoutPromise]);
        console.log('[QUIT] Extension dev MCP server shutdown complete');
    } catch (error) {
        console.error('[QUIT] Error closing extension dev MCP server:', error);
    }

    // Super Loop progress MCP server shutdown skipped (server disabled)

    // MCP consolidation Phase 7: session-context / settings / meta-agent tools
    // are served by the unified server; no standalone HTTP servers to tear down.
    // The meta-agent service shutdown still detaches its state listener.
    try {
        const metaAgentService = MetaAgentService.getInstance();
        const shutdownPromise = metaAgentService.shutdown();
        const timeoutPromise = new Promise((resolve) => setTimeout(resolve, 500));
        await Promise.race([shutdownPromise, timeoutPromise]);
        console.log('[QUIT] Meta-agent service shutdown complete');
    } catch (error) {
        console.error('[QUIT] Error shutting down meta-agent service:', error);
    }

    try {
        // Cleanup services (placeholder for future cleanup)
    } catch (error) {
        console.error('[QUIT] Error cleaning up mockup screenshot service:', error);
    }

    try {
        // CRITICAL: Save session state BEFORE destroying windows
        // Destroying windows removes them from the windows Map, so save must happen first
        const t10 = Date.now();
        console.log(`[QUIT] [${t10}] Saving session state`);
        if (canWriteLogs) {
            if (debugLog) {
                try {
                    fs.appendFileSync(debugLog, '[QUIT] Saving session state\n');
                } catch (e) {}
            }

            // Wrap session save with timeout
            const savePromise = new Promise(async (resolve, reject) => {
                try {
                    await saveSessionState();
                    resolve(true);
                } catch (error) {
                    reject(error);
                }
            });
            const timeoutPromise = new Promise((resolve) => setTimeout(() => resolve(false), 300));
            await Promise.race([savePromise, timeoutPromise]);
            const t11 = Date.now();
            console.log(`[QUIT] [${t11}] Session state saved (${t11-t10}ms)`);

            if (debugLog) {
                try {
                    fs.appendFileSync(debugLog, '[QUIT] Session state saved\n');
                } catch (e) {}
            }
        } else {
            console.log('[QUIT] Skipping session save - no write permissions');
        }
    } catch (error) {
        console.error('[QUIT] Error saving session state:', error);
        if (canWriteLogs && debugLog) {
            try {
                fs.appendFileSync(debugLog, `[QUIT] Error saving session: ${error}\n`);
            } catch (e) {}
        }
    }

    // Create database backup (async, but don't wait too long)
    try {
        const t11a = Date.now();
        console.log(`[QUIT] [${t11a}] Creating database backup...`);
        if (canWriteLogs && debugLog) {
            try { fs.appendFileSync(debugLog, '[QUIT] Creating database backup\n'); } catch (e) {}
        }

        // Import database and create backup (with timeout)
        const { getDatabase, stopPeriodicBackupTimer } = await import('./database/initialize');
        const db = getDatabase();

        // Stop the 4h periodic backup timer before doing anything else.
        // If it fires after we close the DB, better-sqlite3's setImmediate-
        // driven backup step throws "database connection is not open" from
        // inside an async chain we no longer await.
        stopPeriodicBackupTimer();

        if (db) {
            const backupPromise = db.createBackup();
            const timeoutPromise = new Promise((resolve) => setTimeout(() => resolve({ success: false, error: 'Timeout' }), 5000));
            const backupResult: any = await Promise.race([backupPromise, timeoutPromise]);

            const t11b = Date.now();
            if (backupResult.success) {
                console.log(`[QUIT] [${t11b}] Database backup created successfully (${t11b-t11a}ms)`);
                if (canWriteLogs && debugLog) {
                    try { fs.appendFileSync(debugLog, `[QUIT] Database backup created (${t11b-t11a}ms)\n`); } catch (e) {}
                }
            } else {
                console.log(`[QUIT] [${t11b}] Database backup failed (${t11b-t11a}ms): ${backupResult.error}`);
                if (canWriteLogs && debugLog) {
                    try { fs.appendFileSync(debugLog, `[QUIT] Database backup failed: ${backupResult.error}\n`); } catch (e) {}
                }
            }

            // Clean up old corrupted backups
            const backupService = db.getBackupService();
            if (backupService) {
                try {
                    await backupService.cleanupOldCorruptedBackups?.();
                    console.log('[QUIT] Old corrupted backups cleaned up');
                    if (canWriteLogs && debugLog) {
                        try { fs.appendFileSync(debugLog, '[QUIT] Old backups cleaned up\n'); } catch (e) {}
                    }
                } catch (error) {
                    console.error('[QUIT] Error cleaning up old backups:', error);
                }
            }

            // CRITICAL: Close database worker to ensure PGlite releases lock files
            // This is essential for Windows where forced shutdowns may not give cleanup time
            const t11c = Date.now();
            console.log(`[QUIT] [${t11c}] Closing database worker...`);
            if (canWriteLogs && debugLog) {
                try { fs.appendFileSync(debugLog, '[QUIT] Closing database worker\n'); } catch (e) {}
            }

            try {
                const closePromise = db.close();
                // 5s instead of 2s: db.close() now issues an explicit CHECKPOINT first
                // (PGLite --single mode has no background checkpointer), which can take
                // several seconds when WAL is large.
                const timeoutPromise = new Promise((resolve) => setTimeout(resolve, 5000));
                await Promise.race([closePromise, timeoutPromise]);
                const t11d = Date.now();
                console.log(`[QUIT] [${t11d}] Database worker closed (${t11d-t11c}ms)`);
                if (canWriteLogs && debugLog) {
                    try { fs.appendFileSync(debugLog, `[QUIT] Database worker closed (${t11d-t11c}ms)\n`); } catch (e) {}
                }
            } catch (closeError) {
                console.error('[QUIT] Error closing database worker:', closeError);
                if (canWriteLogs && debugLog) {
                    try { fs.appendFileSync(debugLog, `[QUIT] Error closing database worker: ${closeError}\n`); } catch (e) {}
                }
            }
        } else {
            console.log('[QUIT] Database not initialized, skipping backup');
        }
    } catch (error) {
        console.error('[QUIT] Error creating database backup:', error);
        if (canWriteLogs && debugLog) {
            try { fs.appendFileSync(debugLog, `[QUIT] Error creating backup: ${error}\n`); } catch (e) {}
        }
    }

    // Aggressively close all windows to avoid any close prompts or handlers
    // IMPORTANT: This must happen AFTER saving session state
    try {
        const t12 = Date.now();
        const all = BrowserWindow.getAllWindows();
        console.log(`[QUIT] [${t12}] Destroying ${all.length} windows`);
        if (canWriteLogs && debugLog) {
            try { fs.appendFileSync(debugLog, `[QUIT] Destroying ${all.length} windows\n`); } catch (e) {}
        }
        for (const win of all) {
            try {
                win.removeAllListeners('close');
                if (!win.isDestroyed()) win.destroy();
            } catch {}
        }
        const t13 = Date.now();
        console.log(`[QUIT] [${t13}] Windows destroyed (${t13-t12}ms)`);
    } catch {}

    // After all cleanup, quit the app
    const t14 = Date.now();
    console.log(`[QUIT] [${t14}] All cleanup complete, checking for active handles`);
    if (canWriteLogs && debugLog) {
        try {
            fs.appendFileSync(debugLog, '[QUIT] All cleanup complete, quitting app\n');

            // Log what's still keeping the process alive
            const activeHandles = (process as any)._getActiveHandles?.();
            const activeRequests = (process as any)._getActiveRequests?.();

            if (activeHandles && activeHandles.length > 0) {
                fs.appendFileSync(debugLog, `[QUIT] WARNING: ${activeHandles.length} handles still active:\n`);
                activeHandles.forEach((handle: any, i: number) => {
                    const name = handle.constructor.name;
                    let details = `  ${i}: ${name}`;
                    if (name === 'Server' || name === 'Socket' || name === 'TCP') {
                        try {
                            details += ` (address: ${handle.address?.() || 'unknown'})`;
                        } catch (e) {}
                    }
                    if (name === 'FSWatcher') {
                        details += ' (file watcher!) - FORCE CLOSING';
                        // Force close ANY FSWatcher we find
                        try {
                            handle.close();
                            fs.appendFileSync(debugLog, `    FORCE CLOSED FSWatcher ${i}\n`);
                        } catch (e) {
                            fs.appendFileSync(debugLog, `    Failed to force close: ${e}\n`);
                        }
                    }
                    if (name === 'Timer' || name === 'Timeout') {
                        details += ' (timer/interval!)';
                    }
                    fs.appendFileSync(debugLog, details + '\n');
                });
            }

            if (activeRequests && activeRequests.length > 0) {
                fs.appendFileSync(debugLog, `[QUIT] WARNING: ${activeRequests.length} requests still active\n`);
            }
        } catch (e) {}
    }

    // Ensure process terminates even if something re-hooks quit
    // Use a short delay to allow logs to flush
    const t15 = Date.now();
    console.log(`[QUIT] [${t15}] Setting exit timeout`);
    setTimeout(() => {
        const t16 = Date.now();
        console.log(`[QUIT] [${t16}] Calling app.exit(0) (${t16-t15}ms after timeout set)`);
        try { app.exit(0); } catch {}
    }, 50);
});

// Window all closed handler
app.on('window-all-closed', () => {
  logger.main.info('All windows closed');
  if (isAppQuitting) {
    // App is quitting, allow normal quit to proceed
    app.quit();
    return;
  }

  // Check if the WorkspaceManager itself was manually closed by the user
  // In that case, don't reopen it (quit on Windows/Linux, stay running on macOS)
  if (wasWorkspaceManagerManuallyClosed()) {
    if (process.platform !== 'darwin') {
      logger.main.info('WorkspaceManager manually closed on non-macOS platform, quitting app');
      app.quit();
    } else {
      logger.main.info('WorkspaceManager manually closed on macOS, app stays running (dock icon can reopen)');
    }
    return;
  }

  // A project window was closed (not the WorkspaceManager)
  // Show the WorkspaceManager so user can open another project
  if (app.isReady()) {
    logger.main.info('Project window closed, showing WorkspaceManager');
    createWorkspaceManagerWindow();
  }
});

// Windows-specific shutdown signal handlers
// Windows sends different signals than Unix systems during forced shutdowns
if (process.platform === 'win32') {
  // Handle SIGBREAK (Windows equivalent of SIGTERM for graceful shutdown)
  process.on('SIGBREAK', () => {
    console.log('[SHUTDOWN] SIGBREAK received (Windows graceful shutdown)');
    logger.main.info('SIGBREAK received, initiating graceful shutdown');
    if (!isAppQuitting) {
      app.quit();
    }
  });

  // Handle SIGINT (Ctrl+C in console, or task manager "End Task")
  process.on('SIGINT', () => {
    console.log('[SHUTDOWN] SIGINT received');
    logger.main.info('SIGINT received, initiating graceful shutdown');
    if (!isAppQuitting) {
      app.quit();
    }
  });

  // Handle SIGTERM (sent by Windows Update restart, shutdown -s, etc.)
  // Note: Windows doesn't always send this, but handle it if it does
  process.on('SIGTERM', () => {
    console.log('[SHUTDOWN] SIGTERM received (Windows forced shutdown)');
    logger.main.info('SIGTERM received, initiating graceful shutdown');
    if (!isAppQuitting) {
      app.quit();
    }
  });
}
