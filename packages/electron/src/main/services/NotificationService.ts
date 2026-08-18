/**
 * NotificationService
 *
 * Handles OS-level notifications for AI/agent completion events.
 */

import { Notification, BrowserWindow, app, ipcMain, shell } from 'electron';
import { logger } from '../utils/logger';
import { isOSNotificationsEnabled, isNotifyWhenFocusedEnabled, isSessionBlockedNotificationsEnabled } from '../utils/store';
import {
  findWindowByWorkspace,
  getMostRecentlyFocusedWorkspaceWindow,
} from '../window/WindowManager';
// Via the ref: importing the chokepoint's own module here would drag the
// tracker-sync/tutorial/autoUpdater graph into every suite that reaches
// NotificationService (the MCP interactive tools do).
import { openWorkspaceAwaitingRailSeed } from '../window/workspaceOpenRef';
import { deliverAfterWorkspaceSeed } from '../file/FileOperations';
import type { SessionNotificationNavigationTarget } from '../../shared/sessionNotificationNavigation';
import { composeNotificationTitle } from '../../shared/notificationTitle';
import { resolveNotificationIcon, type NotificationKind } from './notificationIcons';

const NOTIFICATION_OUTCOME_TIMEOUT_MS = 2_000;

/**
 * How long a queued navigation stays valid while its workspace window opens.
 * Without an expiry a queue entry that is never drained (window closed mid-load,
 * renderer failed to boot) would make every later click for that workspace a
 * silent no-op, because the click path treats "a queue entry exists" as
 * "a window is already opening".
 */
const PENDING_NAVIGATION_TTL_MS = 60_000;

interface PendingNavigation {
  target: SessionNotificationNavigationTarget;
  queuedAt: number;
}

export interface NotificationOptions {
  title: string;
  body: string;
  /** Explicit artwork. Overrides whatever `kind` would have resolved to. */
  icon?: string;
  /** What this notification is about; selects the per-kind artwork. */
  kind?: NotificationKind;
  sessionId?: string;
  workspacePath: string;  // REQUIRED: stable identifier for routing
  sourceLabel?: string;
  provider?: string;
  /**
   * Agent/user-attention notifications can opt out of focus suppression while
   * still respecting the user's OS notification setting.
   */
  bypassFocusCheck?: boolean;
  silent?: boolean;
  urgency?: 'normal' | 'critical' | 'low';
  timeoutType?: 'default' | 'never';
}

export type NotificationSkippedReason =
  | 'os_notifications_disabled'
  | 'unsupported'
  | 'app_focused'
  | 'session_visible'
  | 'confirmation_timeout'
  | 'error';

export interface NotificationResult {
  success: boolean;
  attempted: boolean;
  shown: boolean;
  skippedReason: NotificationSkippedReason | null;
  error?: string;
  title: string;
  bodyPreview: string;
  sessionId?: string;
  workspacePath: string;
}

/**
 * Types of blocking interactions that can trigger notifications.
 */
export type BlockingType = 'permission' | 'question' | 'plan_approval' | 'git_commit';

class NotificationService {
  private activeNotifications: Map<string, Notification> = new Map();
  private pendingNavigations = new Map<string, PendingNavigation>();

  constructor() {
    logger.main.info('[NotificationService] Service initialized');
  }

  /**
   * Check if a window is currently viewing a specific session.
   * Uses IPC to query the renderer process.
   */
  private async isWindowViewingSession(window: BrowserWindow, sessionId: string): Promise<boolean> {
    return new Promise((resolve) => {
      // Generate unique request ID
      const requestId = `check-session-${Date.now()}-${Math.random()}`;
      const channel = `notifications:session-check-response:${requestId}`;

      // Set timeout in case renderer doesn't respond
      const timeout = setTimeout(() => {
        ipcMain.removeAllListeners(channel);
        resolve(false); // Assume not viewing on timeout
      }, 500);

      // Register one-time listener for response (use 'once' not 'handleOnce' since renderer uses 'send')
      ipcMain.once(channel, (_event, isViewing: boolean) => {
        clearTimeout(timeout);
        resolve(isViewing);
      });

      // Send request to renderer
      window.webContents.send('notifications:check-active-session', { requestId, sessionId });
    });
  }

  /**
   * Show an OS notification if:
   * 1. User has enabled OS notifications in settings
   * 2. The app window is not focused
   * 3. System allows notifications (respects Do Not Disturb)
   */
  async showNotification(options: NotificationOptions): Promise<void> {
    await this.showNotificationWithResult(options);
  }

  async showNotificationWithResult(options: NotificationOptions): Promise<NotificationResult> {
    const baseResult = (): NotificationResult => ({
      success: true,
      attempted: false,
      shown: false,
      skippedReason: null,
      title: options.title,
      bodyPreview: NotificationService.truncateBody(options.body, 120),
      ...(options.sessionId ? { sessionId: options.sessionId } : {}),
      workspacePath: options.workspacePath,
    });

    // logger.main.info('[NotificationService] showNotification called:', {
    //   title: options.title,
    //   sessionId: options.sessionId,
    // });

    // Check if OS notifications are enabled in settings
    const osNotificationsEnabled = isOSNotificationsEnabled();
    // logger.main.info('[NotificationService] OS notifications enabled:', osNotificationsEnabled);
    if (!osNotificationsEnabled) {
      // logger.main.info('[NotificationService] SKIPPED: OS notifications disabled in settings');
      return {
        ...baseResult(),
        skippedReason: 'os_notifications_disabled',
      };
    }

    // Check if app has permission to show notifications
    if (!Notification.isSupported()) {
      logger.main.warn('[NotificationService] SKIPPED: Notifications not supported on this platform');
      return {
        ...baseResult(),
        skippedReason: 'unsupported',
      };
    }

    // Check if any window is visible and focused
    const allWindows = BrowserWindow.getAllWindows();
    const focusedWindow = allWindows.find(win => win.isVisible() && win.isFocused());
    // logger.main.info('[NotificationService] Has visible focused window:', !!focusedWindow);

    if (focusedWindow && !options.bypassFocusCheck) {
      // Window is focused - check if we should still notify
      const notifyWhenFocused = isNotifyWhenFocusedEnabled();

      if (!notifyWhenFocused) {
        // Traditional behavior: skip all notifications when app is focused
        // logger.main.info('[NotificationService] SKIPPED: App window is focused (notifications only show when app is in background)');
        return {
          ...baseResult(),
          skippedReason: 'app_focused',
        };
      }

      // notifyWhenFocused is enabled - check if viewing this specific session
      if (options.sessionId) {
        const isViewingSession = await this.isWindowViewingSession(focusedWindow, options.sessionId);
        if (isViewingSession) {
          // logger.main.info('[NotificationService] SKIPPED: User is already viewing this session');
          return {
            ...baseResult(),
            skippedReason: 'session_visible',
          };
        }
        // logger.main.info('[NotificationService] User not viewing this session, showing notification');
      }
    }

    try {
      // Create and show the notification using Electron API (production mode)
      const notification = new Notification({
        title: options.title,
        body: options.body,
        icon: options.icon || resolveNotificationIcon(options.kind) || this.getAppIcon(),
        silent: options.silent === true ? true : false,
        urgency: options.urgency || 'normal', // macOS notification urgency
        timeoutType: options.timeoutType || 'default', // Use system default timeout
      });

      // Handle notification click - focus window and switch to session
      notification.on('click', () => {
        this.handleNotificationClick(options);
      });

      // Track notification
      if (options.sessionId) {
        this.activeNotifications.set(options.sessionId, notification);
      }

      return await new Promise<NotificationResult>((resolve) => {
        let settled = false;
        let outcomeTimeout: NodeJS.Timeout | null = null;

        const settle = (result: NotificationResult) => {
          if (settled) {
            return;
          }
          settled = true;
          if (outcomeTimeout) {
            clearTimeout(outcomeTimeout);
          }
          notification.removeListener('show', handleShown);
          notification.removeListener('failed', handleFailed);
          if (
            !result.shown &&
            options.sessionId &&
            this.activeNotifications.get(options.sessionId) === notification
          ) {
            this.activeNotifications.delete(options.sessionId);
          }
          resolve(result);
        };

        const handleShown = () => {
          settle({
            ...baseResult(),
            attempted: true,
            shown: true,
          });
        };

        const handleFailed = (_event: unknown, error: string) => {
          logger.main.error('[NotificationService] Notification failed:', error);
          settle({
            ...baseResult(),
            success: false,
            attempted: true,
            skippedReason: 'error',
            error,
          });
        };

        notification.on('show', handleShown);
        notification.on('failed', handleFailed);
        outcomeTimeout = setTimeout(() => {
          settle({
            ...baseResult(),
            success: false,
            attempted: true,
            skippedReason: 'confirmation_timeout',
            error: 'Timed out waiting for the OS notification outcome',
          });
        }, NOTIFICATION_OUTCOME_TIMEOUT_MS);

        try {
          notification.show();
        } catch (error) {
          logger.main.error('[NotificationService] Error showing notification:', error);
          settle({
            ...baseResult(),
            success: false,
            attempted: true,
            skippedReason: 'error',
            error: error instanceof Error ? error.message : String(error),
          });
        }
      });
    } catch (error) {
      logger.main.error('[NotificationService] Error showing notification:', error);
      return {
        ...baseResult(),
        success: false,
        attempted: true,
        skippedReason: 'error',
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  /**
   * Show a one-off test notification to trigger OS prompting/verification when the user enables notifications.
   * This intentionally bypasses the in-app "notifications enabled" preference.
   */
  async showTestNotification(): Promise<void> {
    if (!Notification.isSupported()) {
      throw new Error('Notifications are not supported on this platform');
    }

    const notification = new Notification({
      title: 'Notifications Enabled',
      body: 'Nimbalyst will notify you when AI responses are ready.',
      icon: this.getAppIcon(),
      silent: true,
      urgency: 'normal',
      timeoutType: 'default',
    });

    notification.on('failed', (_event, error) => {
      logger.main.error('[NotificationService] Test notification failed:', error);
    });

    notification.show();
  }

  /**
   * Open the OS notification settings page when the user needs to recover from a denied prompt.
   */
  async openSystemNotificationSettings(): Promise<void> {
    let target: string | null = null;

    if (process.platform === 'darwin') {
      target = 'x-apple.systempreferences:com.apple.Notifications-Settings.extension';
    } else if (process.platform === 'win32') {
      target = 'ms-settings:notifications';
    }

    if (!target) {
      throw new Error('Opening notification settings is not supported on this platform');
    }

    await shell.openExternal(target);
  }

  /**
   * Handle notification click - bring window to focus and switch to session
   */
  private handleNotificationClick(options: NotificationOptions): void {
    // logger.main.info('[NotificationService] Notification clicked:', {
    //   sessionId: options.sessionId,
    //   workspacePath: options.workspacePath,
    // });

    // REQUIRED: workspacePath must be provided - sessions are tied to workspaces
    if (!options.workspacePath) {
      throw new Error('workspacePath is required for notification routing');
    }

    // Find window by workspace path (the only stable identifier). This matches
    // rail-warm additional paths too, so an already-open project never gets a
    // duplicate window.
    const targetWindow = findWindowByWorkspace(options.workspacePath);

    const focusExisting = (): void => {
      if (!targetWindow || targetWindow.isDestroyed()) return;
      if (targetWindow.isMinimized()) {
        targetWindow.restore();
      }
      targetWindow.focus();
      targetWindow.show();
    };

    // A notification without a session id has nothing to route to, but the user
    // still expects the click to raise the app.
    if (!options.sessionId) {
      focusExisting();
      return;
    }

    const navigation: SessionNotificationNavigationTarget = {
      sessionId: options.sessionId,
      workspacePath: options.workspacePath,
      sourceLabel: this.getSourceLabel(options),
    };

    if (this.takeLivePendingNavigation(options.workspacePath)) {
      // A window for this workspace is still opening. Keep only the latest
      // target so repeated clicks are idempotent rather than queued.
      this.pendingNavigations.set(options.workspacePath, {
        target: navigation,
        queuedAt: Date.now(),
      });
      focusExisting();
      return;
    }

    if (!targetWindow || targetWindow.isDestroyed()) {
      void this.openWorkspaceForNavigation(navigation);
      return;
    }

    // logger.main.info('[NotificationService] Found window for workspace:', options.workspacePath);

    focusExisting();
    targetWindow.webContents.send('notification-clicked', navigation);
  }

  /**
   * Open a window for an unloaded project and queue the navigation for its
   * renderer to drain once the workspace is active.
   *
   * Uses `openOrFocusWorkspaceWindowAwaitingRailSeed` (not the sync
   * `openOrFocusWorkspaceWindow`) and `deliverAfterWorkspaceSeed` to
   * sequence the live `notification-clicked` send after the Multi-Project
   * Mode rail-add actually lands, instead of firing it immediately against
   * the fire-and-forget seed. Sending it immediately raced the renderer's
   * own `rail:add-project` listener (`store/listeners/railProjectListeners.ts`)
   * into independently repeating the same register+activate work that
   * `notification-clicked`'s `activateWorkspace()` also does -- both idempotent,
   * but at `MAX_OPEN_PROJECTS` each side independently detects the cap and
   * shows its own differently-worded "rail full" toast for one click. Awaiting
   * the seed first means the renderer has already registered+activated by
   * the time `notification-clicked` arrives on success, so
   * `activateWorkspace()`'s own "already active" check short-circuits
   * instead of repeating the add.
   *
   * `pendingNavigations` is set SYNCHRONOUSLY, before the first `await`, so
   * a second click on the same still-opening workspace lands on
   * `takeLivePendingNavigation`'s "still opening" guard in
   * `handleNotificationClick` instead of racing a second call into this
   * method -- for the Multi-Project Mode add-to-rail path that second call
   * would fire a second `rail:add-project` seed, the exact duplicate-flow
   * shape this fix exists to remove.
   */
  private async openWorkspaceForNavigation(navigation: SessionNotificationNavigationTarget): Promise<void> {
    const { workspacePath } = navigation;
    this.pendingNavigations.set(workspacePath, { target: navigation, queuedAt: Date.now() });
    logger.main.info('[NotificationService] Opening workspace for notification:', {
      workspacePath,
      sessionId: navigation.sessionId,
    });

    try {
      await deliverAfterWorkspaceSeed(
        openWorkspaceAwaitingRailSeed(workspacePath),
        (outcome) => {
          if (outcome.kind !== 'new-window') {
            // Multi-Project Mode added the project to an already-loaded
            // window's rail (or it was already open) -- there is no fresh
            // mount for the renderer's deep-link-style queue drain to hook
            // into, so deliver the navigation live, the same way an
            // already-open workspace is handled above in
            // handleNotificationClick. Nothing left to queue-drain.
            //
            // Read the pending entry (not the closed-over `navigation`)
            // before deleting it: a second click on this still-opening
            // workspace overwrote it with a newer target in
            // `handleNotificationClick`'s "still opening" branch, and that
            // second click never gets its own `openWorkspaceForNavigation`
            // call to deliver from -- sending the stale first-click target
            // here would silently open the wrong session.
            const latest = this.pendingNavigations.get(workspacePath)?.target ?? navigation;
            this.pendingNavigations.delete(workspacePath);
            if (outcome.window.isMinimized()) outcome.window.restore();
            outcome.window.focus();
            outcome.window.show();
            outcome.window.webContents.send('notification-clicked', latest);
            return;
          }

          // Drop the queued target if the window never gets far enough to
          // drain it. Otherwise the stale entry makes every later click for
          // this workspace a no-op, and a much later manual open would jump
          // to a stale session.
          this.evictPendingNavigationOnWindowLoss(outcome.window, workspacePath);
        },
        (outcome) => {
          // Same "read before delete" reasoning as the success branch above:
          // a second click may have overwritten the pending target.
          const latest = this.pendingNavigations.get(workspacePath)?.target ?? navigation;
          this.pendingNavigations.delete(workspacePath);
          logger.main.warn('[NotificationService] Rail seed did not land for notification workspace:', {
            workspacePath,
            sessionId: latest.sessionId,
            reason: outcome?.reason ?? 'no-opener',
          });
          // 'at-cap': the renderer's own `rail:add-project` listener
          // (`railProjectListeners.ts`) already showed the "rail full" toast
          // for the refused seed, in the SAME rail window
          // `openOrFocusWorkspaceWindowAwaitingRailSeed` just focused.
          // `reportNavigationFailure` delivers `notification-clicked` to
          // `getMostRecentlyFocusedWorkspaceWindow()` -- in production that
          // IS this same rail window -- and `activateWorkspace()` would
          // retry the identical refused add and show a second,
          // differently-worded toast for one click. Log only; there is no
          // window it is safe to deliver into.
          //
          // 'timeout': ambiguous whether the add landed, but nothing was
          // shown to the user either way, so still surface a failure.
          // A null outcome (opener not registered) showed the user nothing
          // either, so it belongs with 'timeout', not with the silent
          // 'at-cap' case the renderer already toasted.
          if (!outcome || outcome.reason === 'timeout') {
            this.reportNavigationFailure(latest);
          }
        },
      );
    } catch (error) {
      const latest = this.pendingNavigations.get(workspacePath)?.target ?? navigation;
      this.pendingNavigations.delete(workspacePath);
      logger.main.error('[NotificationService] Failed to open notification workspace:', error);
      this.reportNavigationFailure(latest);
    }
  }

  private evictPendingNavigationOnWindowLoss(
    window: BrowserWindow | undefined,
    workspacePath: string,
  ): void {
    if (!window || typeof window.once !== 'function') return;
    const evict = (): void => {
      this.pendingNavigations.delete(workspacePath);
    };
    window.once('closed', evict);
    window.webContents?.once?.('render-process-gone', evict);
    // Sub-frame load failures are routine (a failed iframe, a cancelled
    // navigation); only a main-frame failure means the renderer will never
    // drain the queued target.
    window.webContents?.on?.(
      'did-fail-load',
      (_event: unknown, _errorCode: number, _errorDescription: string, _url: string, isMainFrame?: boolean) => {
        if (isMainFrame === false) return;
        evict();
      },
    );
  }

  /**
   * Surface a routing failure the user can act on. Prefers an in-app warning in
   * a real workspace window; falls back to an OS notification when the app has
   * no workspace window left to talk to.
   */
  private reportNavigationFailure(navigation: SessionNotificationNavigationTarget): void {
    const fallback = getMostRecentlyFocusedWorkspaceWindow();
    if (fallback && !fallback.isDestroyed()) {
      fallback.webContents.send('notification-clicked', navigation);
      fallback.show();
      fallback.focus();
      return;
    }

    if (!Notification.isSupported()) return;
    const failure = new Notification({
      title: `${navigation.sourceLabel} -- could not be opened`,
      body: 'Nimbalyst could not open the project for this session. Open the project, then retry.',
      icon: this.getAppIcon(),
      silent: true,
    });
    failure.show();
  }

  /**
   * Read the queued navigation for a workspace, discarding it if it has aged
   * past the open-window window. Returns null when nothing live is queued.
   */
  private takeLivePendingNavigation(workspacePath: string): SessionNotificationNavigationTarget | null {
    const pending = this.pendingNavigations.get(workspacePath);
    if (!pending) return null;
    if (Date.now() - pending.queuedAt > PENDING_NAVIGATION_TTL_MS) {
      this.pendingNavigations.delete(workspacePath);
      logger.main.warn('[NotificationService] Discarded stale queued navigation:', workspacePath);
      return null;
    }
    return pending.target;
  }

  consumePendingNavigation(workspacePath: string): SessionNotificationNavigationTarget | null {
    if (!workspacePath) {
      throw new Error('workspacePath is required to consume notification navigation');
    }
    const pending = this.takeLivePendingNavigation(workspacePath);
    if (pending) {
      this.pendingNavigations.delete(workspacePath);
    }
    return pending;
  }

  private getSourceLabel(options: NotificationOptions): string {
    const explicit = options.sourceLabel?.trim();
    if (explicit) return explicit;

    return options.sessionId
      ? `Session ${options.sessionId.slice(0, 8)}`
      : 'AI session';
  }

  /**
   * Clear notifications for a specific session
   */
  clearNotification(sessionId: string): void {
    const notification = this.activeNotifications.get(sessionId);
    if (notification) {
      notification.close();
      this.activeNotifications.delete(sessionId);
      logger.main.debug('[NotificationService] Cleared notification for session:', sessionId);
    }
  }

  /**
   * Clear all active notifications
   */
  clearAllNotifications(): void {
    this.activeNotifications.forEach((notification) => {
      notification.close();
    });
    this.activeNotifications.clear();
    logger.main.debug('[NotificationService] Cleared all notifications');
  }

  /**
   * Get app icon path for notifications
   */
  private getAppIcon(): string {
    // Use app icon path based on platform
    if (process.platform === 'darwin') {
      return app.getPath('exe');
    } else if (process.platform === 'win32') {
      return app.getPath('exe');
    }
    return '';
  }

  /**
   * Truncate text for notification body
   */
  static truncateBody(text: string, maxLength: number = 100): string {
    if (text.length <= maxLength) {
      return text;
    }
    return text.substring(0, maxLength - 3) + '...';
  }

  /**
   * Get notification title for a blocking type.
   */
  private getBlockedTitle(blockingType: BlockingType): string {
    switch (blockingType) {
      case 'permission':
        return 'Permission Required';
      case 'question':
        return 'Question Waiting';
      case 'plan_approval':
        return 'Plan Ready for Review';
      case 'git_commit':
        return 'Commit Ready';
      default:
        return 'Session Needs Attention';
    }
  }

  /**
   * A question the agent asked reads differently from an approval it is waiting
   * on: one wants an answer only the user has, the other wants a yes/no on work
   * already drafted. They get their own artwork.
   */
  private getBlockedIconKind(blockingType: BlockingType): NotificationKind {
    return blockingType === 'question' ? 'agent-question' : 'needs-input';
  }

  /**
   * Get notification body for a blocking type.
   */
  private getBlockedBody(blockingType: BlockingType, sessionName: string): string {
    switch (blockingType) {
      case 'permission':
        return `"${sessionName}" needs approval`;
      case 'question':
        return `"${sessionName}" has a question`;
      case 'plan_approval':
        return `"${sessionName}" plan is ready`;
      case 'git_commit':
        return `"${sessionName}" has a commit proposal`;
      default:
        return `"${sessionName}" needs your input`;
    }
  }

  /**
   * Show an OS notification when a session becomes blocked.
   * Uses the session blocked notifications setting.
   */
  async showBlockedNotification(
    sessionId: string,
    sessionName: string,
    blockingType: BlockingType,
    workspacePath: string
  ): Promise<void> {
    // Check if session blocked notifications are enabled
    if (!isSessionBlockedNotificationsEnabled()) {
      return;
    }

    // Use the standard showNotification method with appropriate title/body
    await this.showNotification({
      title: composeNotificationTitle(sessionName, this.getBlockedTitle(blockingType)),
      body: this.getBlockedBody(blockingType, sessionName),
      kind: this.getBlockedIconKind(blockingType),
      sessionId,
      workspacePath,
      sourceLabel: sessionName,
    });
  }
}

// Export singleton instance
export const notificationService = new NotificationService();
