import { autoUpdater } from 'electron-updater';
import { app, BrowserWindow, dialog } from 'electron';
import log from 'electron-log/main';
import * as fs from 'fs';
import * as path from 'path';
import { getReleaseChannel, store } from '../utils/store';
import { safeHandle, safeOn } from '../utils/ipcRegistry';
import { AnalyticsService } from './analytics/AnalyticsService';
import { hasActiveStreamingSessions } from '../ipc/SessionStateHandlers';
import { getSessionStateManager } from '@nimbalyst/runtime/ai/server/SessionStateManager';
import { getDatabase } from '../database/initialize';

// Reminder suppression duration: 24 hours
const REMINDER_SUPPRESSION_DURATION_MS = 24 * 60 * 60 * 1000;
const GITHUB_UPDATE_PROVIDER = {
  provider: 'github' as const,
  owner: 'nimbalyst',
  repo: 'nimbalyst'
};

/**
 * Categorize download duration for analytics
 */
function getDurationCategory(durationMs: number): string {
  if (durationMs < 30000) return 'fast';       // < 30 seconds
  if (durationMs < 120000) return 'medium';    // 30s - 2 minutes
  return 'slow';                                // > 2 minutes
}

/**
 * Classify update errors for analytics
 */
function classifyUpdateError(error: Error): string {
  const message = error.message.toLowerCase();
  if (message.includes('network') || message.includes('enotfound') || message.includes('timeout') || message.includes('econnrefused')) {
    return 'network';
  }
  if (message.includes('permission') || message.includes('eacces')) {
    return 'permission';
  }
  if (message.includes('disk') || message.includes('space') || message.includes('enospc')) {
    return 'disk_space';
  }
  if (message.includes('signature') || message.includes('verify') || message.includes('certificate') || message.includes('cert')) {
    return 'signature';
  }
  return 'unknown';
}

// Antivirus on Windows often holds a transient handle on the freshly-downloaded
// installer, causing electron-updater's temp -> final rename to fail with EPERM
// (occasionally EBUSY). The fix is to wait briefly and retry the download once.
function isWindowsRenameLockError(err: Error): boolean {
  if (process.platform !== 'win32') return false;
  const msg = err.message || '';
  if (/\bEPERM\b.*\brename\b/i.test(msg)) return true;
  if (/\bEBUSY\b/i.test(msg)) return true;
  return false;
}

export class AutoUpdaterService {
  private updateCheckInterval: NodeJS.Timeout | null = null;
  private isCheckingForUpdate = false;
  private isManualCheck = false; // Track if this is a user-initiated check (for showing up-to-date toast)
  private static isUpdating = false;
  private pendingUpdateInfo: { version: string; releaseNotes?: string; releaseDate?: string } | null = null;
  private downloadStartTime: number | null = null; // Track download start time for duration analytics
  private downloadRetryAttempted = false; // Windows EPERM rename retry guard (one retry per user-initiated download)

  constructor() {
    // Configure electron-updater logger
    log.transports.file.level = 'info';
    autoUpdater.logger = log;

    // Configure auto-updater
    autoUpdater.autoDownload = false;
    autoUpdater.autoInstallOnAppQuit = true;

    // Configure feed URL based on release channel
    this.configureFeedURL();

    // Set up event handlers
    this.setupEventHandlers();

    // Set up IPC handlers for renderer communication
    this.setupIpcHandlers();
  }

  private configureFeedURL() {
    const channel = getReleaseChannel();

    if (channel === 'alpha') {
      log.info('Configuring alpha channel updates from GitHub prereleases');
      autoUpdater.allowPrerelease = true;
      autoUpdater.channel = 'alpha';
      autoUpdater.setFeedURL(GITHUB_UPDATE_PROVIDER);
    } else {
      log.info('Configuring stable channel updates from GitHub releases');
      autoUpdater.allowPrerelease = false;
      autoUpdater.channel = 'latest';
      autoUpdater.setFeedURL(GITHUB_UPDATE_PROVIDER);
    }
  }

  private setupEventHandlers() {
    autoUpdater.on('checking-for-update', () => {
      log.info('Checking for update...');
      this.isCheckingForUpdate = true;
      this.sendToAllWindows('update-checking');
    });

    autoUpdater.on('update-available', async (info) => {
      log.info('Update available:', info);
      this.isCheckingForUpdate = false;
      const wasManualCheck = this.isManualCheck;
      this.isManualCheck = false;

      let releaseNotes = info.releaseNotes as string | undefined;
      const channel = getReleaseChannel();
      log.info(`Release channel: ${channel}, releaseNotes present: ${Boolean(releaseNotes)}`);

      log.info(`Final releaseNotes being sent to window: "${releaseNotes?.substring(0, 100)}..."`);

      // Store pending update info for later use
      this.pendingUpdateInfo = {
        version: info.version,
        releaseNotes: releaseNotes,
        releaseDate: info.releaseDate
      };

      // Send to frontmost window via toast system. The renderer fires
      // `update_toast_shown` analytics after passing suppression checks --
      // firing here would over-count by ~14x because update-available
      // re-fires every hourly auto-check even when the toast is suppressed.
      this.sendToFrontmostWindow('update-toast:show-available', {
        currentVersion: app.getVersion(),
        newVersion: info.version,
        releaseNotes: releaseNotes,
        releaseDate: info.releaseDate,
        releaseChannel: channel,
        isManualCheck: wasManualCheck
      });

      this.sendToAllWindows('update-available', info);
    });

    autoUpdater.on('update-not-available', (info) => {
      log.info('Update not available:', info);
      this.isCheckingForUpdate = false;
      // Only show up-to-date toast for manual (user-initiated) checks
      if (this.isManualCheck) {
        this.sendToFrontmostWindow('update-toast:up-to-date');
        this.isManualCheck = false;
      }
      this.sendToAllWindows('update-not-available', info);
    });

    autoUpdater.on('error', (err) => {
      log.error('Update error:', err);
      this.isCheckingForUpdate = false;
      this.isManualCheck = false; // Reset manual check flag

      // Windows-only: antivirus often holds a transient handle on the freshly
      // downloaded installer, so electron-updater's temp -> final rename throws
      // EPERM. Clean the pending dir and retry once after a short delay.
      const wasDownloading = this.downloadStartTime !== null;
      if (wasDownloading && !this.downloadRetryAttempted && isWindowsRenameLockError(err)) {
        this.downloadRetryAttempted = true;
        log.warn('Windows rename lock during update; cleaning pending dir and retrying once');
        this.cleanupWindowsPendingDirectory();
        setTimeout(() => {
          autoUpdater.downloadUpdate().catch(retryErr => {
            log.error('Retry of downloadUpdate failed:', retryErr);
          });
        }, 3000);
        return;
      }

      // Track update error - determine stage based on context
      // If downloadStartTime is set, we were downloading; otherwise it was a check error
      const stage = wasDownloading ? 'download' : 'check';
      AnalyticsService.getInstance().sendEvent('update_error', {
        stage,
        error_type: classifyUpdateError(err),
        release_channel: getReleaseChannel()
      });
      this.downloadStartTime = null;
      this.downloadRetryAttempted = false;

      // Send error to frontmost window via toast system
      this.sendToFrontmostWindow('update-toast:error', {
        message: err.message
      });

      this.sendToAllWindows('update-error', err.message);
    });

    autoUpdater.on('download-progress', (progressObj) => {
      let logMessage = `Download speed: ${progressObj.bytesPerSecond}`;
      logMessage = `${logMessage} - Downloaded ${progressObj.percent}%`;
      logMessage = `${logMessage} (${progressObj.transferred}/${progressObj.total})`;
      log.info(logMessage);

      // Send progress to frontmost window via toast system
      this.sendToFrontmostWindow('update-toast:progress', {
        bytesPerSecond: progressObj.bytesPerSecond,
        percent: progressObj.percent,
        transferred: progressObj.transferred,
        total: progressObj.total
      });

      this.sendToAllWindows('update-download-progress', progressObj);
    });

    autoUpdater.on('update-downloaded', (info) => {
      log.info('Update downloaded:', info);

      // Track download completed with duration
      const downloadDuration = this.downloadStartTime ? Date.now() - this.downloadStartTime : 0;
      AnalyticsService.getInstance().sendEvent('update_download_completed', {
        release_channel: getReleaseChannel(),
        new_version: info.version,
        duration_category: getDurationCategory(downloadDuration)
      });
      this.downloadStartTime = null;

      // Reset retry guard now that we have a successful download in pending
      this.downloadRetryAttempted = false;

      // Send ready notification to frontmost window via toast system
      this.sendToFrontmostWindow('update-toast:show-ready', {
        version: info.version
      });

      this.sendToAllWindows('update-downloaded', info);
    });
  }

  /**
   * Compute the electron-updater pending download directory on Windows.
   * Mirrors electron-updater's path resolution: `${baseCachePath}\${appName}-updater\pending`,
   * where baseCachePath on Windows is %LOCALAPPDATA% and appName is `app.getName()`.
   */
  private getWindowsPendingDirectory(): string | null {
    if (process.platform !== 'win32') return null;
    const baseCachePath = process.env['LOCALAPPDATA'] || path.join(app.getPath('home'), 'AppData', 'Local');
    return path.join(baseCachePath, `${app.getName()}-updater`, 'pending');
  }

  /**
   * Delete the pending download directory on Windows. Stale or AV-locked files
   * here are the most common cause of EPERM on the final temp -> installer rename.
   * Non-fatal: best-effort, logs and continues on failure.
   */
  private cleanupWindowsPendingDirectory(): void {
    const pendingDir = this.getWindowsPendingDirectory();
    if (!pendingDir) return;
    try {
      if (fs.existsSync(pendingDir)) {
        log.info(`Removing stale pending update directory: ${pendingDir}`);
        fs.rmSync(pendingDir, { recursive: true, force: true });
      }
    } catch (err) {
      log.warn('Failed to clean pending update directory:', err);
    }
  }

  /**
   * Get the frontmost (focused) window, or the first workspace window if no window is focused
   */
  private getFrontmostWindow(): BrowserWindow | null {
    // First try to get the focused window
    const focused = BrowserWindow.getFocusedWindow();
    if (focused && !focused.isDestroyed()) {
      return focused;
    }

    // Otherwise, find the first visible workspace window
    const allWindows = BrowserWindow.getAllWindows();
    for (const win of allWindows) {
      if (!win.isDestroyed() && win.isVisible()) {
        // Check if it's a workspace window (not update window, settings window, etc.)
        const url = win.webContents.getURL();
        if (!url.includes('mode=') || url.includes('mode=workspace')) {
          return win;
        }
      }
    }

    // Last resort: return the first visible window
    return allWindows.find(w => !w.isDestroyed() && w.isVisible()) || null;
  }

  /**
   * Send a message to the frontmost window
   */
  private sendToFrontmostWindow(channel: string, data?: any) {
    const window = this.getFrontmostWindow();
    if (window && !window.isDestroyed()) {
      log.info(`Sending ${channel} to frontmost window`);
      window.webContents.send(channel, data);
    } else {
      log.warn(`No frontmost window available to send ${channel}`);
    }
  }

  /**
   * Close the database and release the PID lock before force-quitting.
   * quitAndInstall() bypasses the before-quit handler, so the normal
   * cleanup in index.ts never runs. Without this, a stale lock file
   * persists and blocks relaunch -- especially after a system reboot
   * where the old PID gets reused by a different process.
   */
  private async closeDatabaseBeforeQuit() {
    try {
      const db = getDatabase();
      if (db) {
        log.info('Closing database before quit-and-install...');
        const closePromise = db.close();
        const timeoutPromise = new Promise((resolve) => setTimeout(resolve, 2000));
        await Promise.race([closePromise, timeoutPromise]);
        log.info('Database closed before quit-and-install');
      }
    } catch (err) {
      log.warn('Database close failed before quit-and-install:', err);
    }

    // Fallback: if db.close() didn't release the lock (timeout or error),
    // delete the PID file directly so the next launch isn't blocked.
    try {
      const lockPath = path.join(app.getPath('userData'), 'nimbalyst-db.pid');
      if (fs.existsSync(lockPath)) {
        fs.unlinkSync(lockPath);
        log.info('Removed residual PID lock file');
      }
    } catch (lockErr) {
      log.warn('Failed to remove PID lock file:', lockErr);
    }
  }

  private performQuitAndInstall() {
    setImmediate(async () => {
      try {
        log.info('Performing quit and install...');
        await this.closeDatabaseBeforeQuit();
        AutoUpdaterService.isUpdating = true;
        app.removeAllListeners('before-quit');
        app.removeAllListeners('window-all-closed');
        autoUpdater.quitAndInstall(true, true);
      } catch (error) {
        log.error('Failed to quit and install:', error);
        AutoUpdaterService.isUpdating = true;
        app.removeAllListeners('before-quit');
        app.removeAllListeners('window-all-closed');
        app.relaunch();
        app.exit(0);
      }
    });
  }

  public reconfigureFeedURL() {
    this.configureFeedURL();
  }

  private setupIpcHandlers() {
    safeHandle('check-for-updates', async () => {
      if (this.isCheckingForUpdate) {
        return { checking: true };
      }

      try {
        const result = await autoUpdater.checkForUpdatesAndNotify();
        return result;
      } catch (error) {
        log.error('Failed to check for updates:', error);
        throw error;
      }
    });

    safeHandle('download-update', async () => {
      try {
        await autoUpdater.downloadUpdate();
        return { success: true };
      } catch (error) {
        log.error('Failed to download update:', error);
        throw error;
      }
    });

    safeHandle('quit-and-install', () => {
      // Reuse the same quit flow as performQuitAndInstall
      this.performQuitAndInstall();
    });

    safeHandle('get-current-version', () => {
      return app.getVersion();
    });

    // Toast-based update IPC handlers
    safeOn('update-toast:download', async () => {
      try {
        log.info('Update toast: Starting download...');

        // Track download started (user action tracking is done in renderer)
        this.downloadStartTime = Date.now();
        this.downloadRetryAttempted = false;
        AnalyticsService.getInstance().sendEvent('update_download_started', {
          release_channel: getReleaseChannel(),
          new_version: this.pendingUpdateInfo?.version || 'unknown'
        });

        // Windows: clear out any stale/locked installer left in the pending dir
        // before starting a fresh download, to avoid EPERM on the final rename.
        this.cleanupWindowsPendingDirectory();

        // In test mode, skip the actual download (tests will manually trigger progress)
        if (process.env.NODE_ENV !== 'test' && process.env.PLAYWRIGHT !== '1') {
          // Re-check for the latest version before downloading in case a newer update
          // was released while the update window was sitting idle
          await this.checkAndDownloadLatest();
        } else {
          log.info('Test mode: Skipping actual download');
        }
      } catch (error) {
        log.error('Failed to download update from toast:', error);

        // Track download error
        AnalyticsService.getInstance().sendEvent('update_error', {
          stage: 'download',
          error_type: classifyUpdateError(error instanceof Error ? error : new Error(String(error))),
          release_channel: getReleaseChannel()
        });

        this.sendToFrontmostWindow('update-toast:error', {
          message: error instanceof Error ? error.message : 'Unknown error'
        });
      }
    });

    safeOn('update-toast:install', () => {
      log.info('Update toast: Installing update...');

      // Track install initiated
      AnalyticsService.getInstance().sendEvent('update_install_initiated', {
        new_version: this.pendingUpdateInfo?.version || 'unknown'
      });

      this.performQuitAndInstall();
    });

    // Check if any AI sessions are currently active
    safeHandle('update:has-active-sessions', () => {
      return { hasActiveSessions: hasActiveStreamingSessions() };
    });

    // Deferred install: wait for all AI sessions to finish, then install
    safeOn('update-toast:install-when-idle', () => {
      log.info('Update toast: Deferring install until AI sessions finish...');

      AnalyticsService.getInstance().sendEvent('update_install_deferred', {
        new_version: this.pendingUpdateInfo?.version || 'unknown'
      });

      // Subscribe to session state changes to detect when all sessions complete
      const stateManager = getSessionStateManager();
      const unsubscribe = stateManager.subscribe((event) => {
        if (event.type === 'session:completed' || event.type === 'session:interrupted') {
          // Check if there are still active sessions
          if (!hasActiveStreamingSessions()) {
            log.info('Update toast: All AI sessions finished, proceeding with install');
            unsubscribe();
            // Notify renderer that we're about to install
            this.sendToFrontmostWindow('update-toast:sessions-finished');
            // Small delay to let the user see the transition
            setTimeout(() => {
              this.performQuitAndInstall();
            }, 1500);
          }
        }
      });
    });

    // Reminder suppression handlers
    safeHandle('update:check-reminder-suppression', (_event, version: string) => {
      const dismissedVersion = store.get('updateDismissedVersion');
      const dismissedAt = store.get('updateDismissedAt') as number | undefined;

      if (dismissedVersion !== version) {
        // Different version, don't suppress
        return { suppressed: false };
      }

      if (!dismissedAt) {
        return { suppressed: false };
      }

      const timeSinceDismissal = Date.now() - dismissedAt;
      if (timeSinceDismissal < REMINDER_SUPPRESSION_DURATION_MS) {
        log.info(`Update reminder suppressed for version ${version} (${Math.round(timeSinceDismissal / 1000 / 60)} minutes ago)`);
        return { suppressed: true };
      }

      // Suppression expired
      return { suppressed: false };
    });

    safeHandle('update:set-reminder-suppression', (_event, version: string) => {
      store.set('updateDismissedVersion', version);
      store.set('updateDismissedAt', Date.now());
      log.info(`Update reminder suppressed for version ${version}`);
      // User action tracking is done in renderer
      return { success: true };
    });
  }

  private sendToAllWindows(channel: string, data?: any) {
    BrowserWindow.getAllWindows().forEach(window => {
      window.webContents.send(channel, data);
    });
  }

  public startAutoUpdateCheck(intervalMinutes = 60) {
    // Initial check after 30 seconds
    setTimeout(() => {
      this.checkForUpdates();
    }, 30000);

    // Set up periodic checks
    this.updateCheckInterval = setInterval(() => {
      this.checkForUpdates();
    }, intervalMinutes * 60 * 1000);
  }

  public stopAutoUpdateCheck() {
    if (this.updateCheckInterval) {
      clearInterval(this.updateCheckInterval);
      this.updateCheckInterval = null;
    }
  }

  public static isUpdatingApp(): boolean {
    return AutoUpdaterService.isUpdating;
  }

  public async checkForUpdates() {
    if (this.isCheckingForUpdate) {
      log.info('Already checking for updates, skipping...');
      return;
    }

    try {
      log.info('Checking for updates...');
      await autoUpdater.checkForUpdatesAndNotify();
    } catch (error) {
      log.error('Failed to check for updates:', error);
    }
  }

  public async checkForUpdatesWithUI() {
    if (this.isCheckingForUpdate) {
      // Already checking, don't show anything - the checking toast is already visible
      return;
    }

    // In dev mode (not packaged), electron-updater skips the check without firing events
    // Show appropriate feedback to the user
    if (!app.isPackaged) {
      log.info('Skipping update check in dev mode (app not packaged)');
      this.sendToFrontmostWindow('update-toast:checking');
      // Brief delay so user sees the checking state, then show error
      setTimeout(() => {
        this.sendToFrontmostWindow('update-toast:error', {
          message: 'Update checking is not available in development mode'
        });
      }, 500);
      return;
    }

    // Mark this as a manual check so the event handlers know to show UI feedback
    this.isManualCheck = true;

    // Show checking toast
    this.sendToFrontmostWindow('update-toast:checking');

    try {
      // checkForUpdates() will fire either 'update-available' or 'update-not-available' events
      // The event handlers will send the appropriate toast messages
      await autoUpdater.checkForUpdates();
    } catch (error) {
      log.error('Failed to check for updates:', error);
      this.isManualCheck = false;
      this.sendToFrontmostWindow('update-toast:error', {
        message: error instanceof Error ? error.message : 'Failed to check for updates'
      });
    }
  }

  private async checkAndDownloadLatest() {
    try {
      log.info('Re-checking for latest version before download...');

      // Check for the absolute latest version
      const result = await autoUpdater.checkForUpdates();

      if (result && result.updateInfo) {
        log.info(`Latest version found: ${result.updateInfo.version}, downloading...`);

        // Download the latest version that was just checked
        // Progress events will update the toast automatically
        await autoUpdater.downloadUpdate();
      } else {
        log.info('No update found during re-check');
        // Show up-to-date toast (rare edge case - update was released then pulled)
        this.sendToFrontmostWindow('update-toast:up-to-date');
      }
    } catch (error) {
      log.error('Failed to check and download latest:', error);
      this.sendToFrontmostWindow('update-toast:error', {
        message: error instanceof Error ? error.message : 'Failed to download the update'
      });
    }
  }
}

// Export singleton instance
export const autoUpdaterService = new AutoUpdaterService();

// Test helpers - only used in test environment
if (process.env.NODE_ENV === 'test' || process.env.PLAYWRIGHT === '1') {
  safeHandle('test:trigger-update-available', (_event, updateInfo: { version: string; releaseNotes?: string; releaseDate?: string }) => {
    log.info('Test: Triggering update available');
    const focused = BrowserWindow.getFocusedWindow();
    const window = focused || BrowserWindow.getAllWindows().find(w => !w.isDestroyed() && w.isVisible());
    if (window && !window.isDestroyed()) {
      window.webContents.send('update-toast:show-available', {
        currentVersion: app.getVersion(),
        newVersion: updateInfo.version,
        releaseNotes: updateInfo.releaseNotes || '',
        releaseDate: updateInfo.releaseDate
      });
    }
  });

  safeHandle('test:trigger-download-progress', (_event, progress: { bytesPerSecond: number; percent: number; transferred: number; total: number }) => {
    log.info(`Test: Triggering download progress ${progress.percent}%`);
    const focused = BrowserWindow.getFocusedWindow();
    const window = focused || BrowserWindow.getAllWindows().find(w => !w.isDestroyed() && w.isVisible());
    if (window && !window.isDestroyed()) {
      window.webContents.send('update-toast:progress', progress);
    }
  });

  safeHandle('test:trigger-update-ready', (_event, updateInfo: { version: string }) => {
    log.info('Test: Triggering update ready');
    const focused = BrowserWindow.getFocusedWindow();
    const window = focused || BrowserWindow.getAllWindows().find(w => !w.isDestroyed() && w.isVisible());
    if (window && !window.isDestroyed()) {
      window.webContents.send('update-toast:show-ready', {
        version: updateInfo.version
      });
    }
  });

  safeHandle('test:trigger-update-error', (_event, errorMessage: string) => {
    log.info('Test: Triggering update error');
    const focused = BrowserWindow.getFocusedWindow();
    const window = focused || BrowserWindow.getAllWindows().find(w => !w.isDestroyed() && w.isVisible());
    if (window && !window.isDestroyed()) {
      window.webContents.send('update-toast:error', {
        message: errorMessage
      });
    }
  });

  safeHandle('test:trigger-update-checking', () => {
    log.info('Test: Triggering update checking');
    const focused = BrowserWindow.getFocusedWindow();
    const window = focused || BrowserWindow.getAllWindows().find(w => !w.isDestroyed() && w.isVisible());
    if (window && !window.isDestroyed()) {
      window.webContents.send('update-toast:checking');
    }
  });

  safeHandle('test:trigger-update-up-to-date', () => {
    log.info('Test: Triggering up to date');
    const focused = BrowserWindow.getFocusedWindow();
    const window = focused || BrowserWindow.getAllWindows().find(w => !w.isDestroyed() && w.isVisible());
    if (window && !window.isDestroyed()) {
      window.webContents.send('update-toast:up-to-date');
    }
  });

  safeHandle('test:clear-update-suppression', () => {
    log.info('Test: Clearing update suppression');
    store.delete('updateDismissedVersion');
    store.delete('updateDismissedAt');
  });
}
