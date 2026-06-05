/**
 * TrayManager - System tray icon and menu for AI session status
 *
 * Provides at-a-glance visibility into AI session state from the macOS menu bar.
 * Subscribes to SessionStateManager events for real-time updates and listens
 * to prompt events from AIService for blocked state detection.
 *
 * Icon states (priority order): Error > Needs Attention > Running > Idle
 */

import path from 'node:path';
import { Tray, Menu, app, nativeImage, nativeTheme, systemPreferences, BrowserWindow } from 'electron';
import { getSessionStateManager } from '@nimbalyst/runtime/ai/server/SessionStateManager';
import type { SessionStateEvent } from '@nimbalyst/runtime/ai/server/types/SessionState';
import { AISessionsRepository } from '@nimbalyst/runtime/storage/repositories/AISessionsRepository';
import { findWindowByWorkspace } from '../window/WindowManager';
import { getPackageRoot } from '../utils/appPaths';
import { isShowTrayIcon, setShowTrayIcon, getSessionSyncConfig, setSessionSyncConfig } from '../utils/store';
import { logger } from '../utils/logger';
import { isPreventingSleep, getSleepPreventionMode } from '../services/PowerSaveService';
import { updateSleepPrevention, resolvePreventSleepMode, getSyncProvider } from '../services/SyncManager';

// ─── Types ──────────────────────────────────────────────────────────────────

type TrayIconState = 'idle' | 'running' | 'attention' | 'error';

interface TraySessionInfo {
  sessionId: string;
  title: string;
  workspacePath: string;
  status: 'running' | 'idle' | 'error' | 'completed';
  isStreaming: boolean;
  hasPendingPrompt: boolean;
  hasUnread: boolean;
  /** Timestamp when session completed, used for lingering display */
  completedAt?: number;
}

// ─── Database interface (same as SessionStateManager) ───────────────────────

interface DatabaseWorker {
  query<T = any>(sql: string, params?: any[]): Promise<{ rows: T[] }>;
}

interface TrayUnreadClearPayload {
  sessions: Array<{
    sessionId: string;
    workspacePath: string;
    lastReadAt: number;
  }>;
}

// ─── Constants ──────────────────────────────────────────────────────────────

const MENU_REBUILD_DEBOUNCE_MS = 300;
const COMPLETED_LINGER_MS = 60_000; // Keep completed sessions visible for 1 minute

// ─── TrayManager ────────────────────────────────────────────────────────────

export class TrayManager {
  private static instance: TrayManager;

  private tray: Tray | null = null;
  private sessionCache: Map<string, TraySessionInfo> = new Map();
  private stateUnsubscribe: (() => void) | null = null;
  private menuRebuildTimer: NodeJS.Timeout | null = null;
  private lingerTimers: Map<string, NodeJS.Timeout> = new Map();
  private database: DatabaseWorker | null = null;
  private themeListener: (() => void) | null = null;

  private constructor() {}

  static getInstance(): TrayManager {
    if (!TrayManager.instance) {
      TrayManager.instance = new TrayManager();
    }
    return TrayManager.instance;
  }

  /**
   * Set the database worker for querying session metadata.
   * Must be called before initialize().
   */
  setDatabase(database: DatabaseWorker): void {
    this.database = database;
  }

  /**
   * Initialize the tray icon and subscribe to session state events.
   * Throws if SessionStateManager is not available (fail fast).
   */
  async initialize(): Promise<void> {
    // Skip in Playwright tests -- the tray is not useful in test environments
    if (process.env.PLAYWRIGHT) {
      logger.main.info('[TrayManager] Skipping initialization in Playwright mode');
      return;
    }

    const manager = getSessionStateManager();
    if (!manager) {
      throw new Error('[TrayManager] SessionStateManager is not initialized -- cannot create tray without session data source');
    }

    // Always subscribe to session state events so cache stays warm
    this.stateUnsubscribe = manager.subscribe((event: SessionStateEvent) => {
      this.onSessionStateEvent(event);
    });

    // Re-render icon when system appearance changes (needed for non-template icons with blue dots).
    // `nativeTheme.on('updated', ...)` is cross-platform and remains the primary signal on
    // every OS. `systemPreferences.subscribeNotification` is macOS-only (it wraps
    // NSDistributedNotificationCenter and throws on Linux/Windows), so guard it. Without the
    // guard, this method threw at startup on non-darwin and the tray never initialised.
    // See nimbalyst#39.
    const onThemeUpdated = () => this.updateIcon();
    nativeTheme.on('updated', onThemeUpdated);

    let appearanceSubId: number | null = null;
    if (process.platform === 'darwin') {
      appearanceSubId = systemPreferences.subscribeNotification(
        'AppleInterfaceThemeChangedNotification',
        onThemeUpdated,
      );
    }
    this.themeListener = () => {
      nativeTheme.removeListener('updated', onThemeUpdated);
      if (appearanceSubId !== null) {
        systemPreferences.unsubscribeNotification(appearanceSubId);
      }
    };

    // Seed the cache with sessions that are already unread in the database.
    // Without this, sessions that completed before this app session started
    // would never appear in the tray's "Unread" section.
    await this.seedUnreadFromDatabase();

    // Create the tray if setting is enabled (default: true)
    if (isShowTrayIcon()) {
      this.createTray();
    }

    logger.main.info('[TrayManager] Initialized');
  }

  /**
   * Show or hide the tray icon. Persists the preference.
   */
  setVisible(visible: boolean): void {
    setShowTrayIcon(visible);
    if (visible) {
      if (!this.tray) {
        this.createTray();
      }
    } else {
      this.destroyTray();
    }
  }

  private createTray(): void {
    if (this.tray) return;
    const icon = this.getIconForState('idle');
    this.tray = new Tray(icon);
    this.tray.setToolTip('Nimbalyst');
    this.rebuildMenu();
  }

  private destroyTray(): void {
    if (this.tray) {
      this.tray.destroy();
      this.tray = null;
    }
  }

  /**
   * Clean up tray and all subscriptions on app quit.
   */
  shutdown(): void {
    if (this.stateUnsubscribe) {
      this.stateUnsubscribe();
      this.stateUnsubscribe = null;
    }

    if (this.themeListener) {
      this.themeListener();
      this.themeListener = null;
    }

    if (this.menuRebuildTimer) {
      clearTimeout(this.menuRebuildTimer);
      this.menuRebuildTimer = null;
    }

    for (const timer of this.lingerTimers.values()) {
      clearTimeout(timer);
    }
    this.lingerTimers.clear();

    if (this.tray) {
      this.tray.destroy();
      this.tray = null;
    }

    this.sessionCache.clear();
    logger.main.info('[TrayManager] Shutdown');
  }

  // ─── Prompt state tracking (called from AIService) ──────────────────────

  /**
   * Mark a session as having a pending interactive prompt (blocked on user input).
   * Called from AIService when askUserQuestion, toolPermission, exitPlanMode,
   * or gitCommitProposal events fire.
   */
  onPromptCreated(sessionId: string): void {
    const session = this.sessionCache.get(sessionId);
    if (session) {
      session.hasPendingPrompt = true;
      this.scheduleMenuRebuild();
    }
  }

  /**
   * Clear the pending prompt flag when the user responds.
   */
  onPromptResolved(sessionId: string): void {
    const session = this.sessionCache.get(sessionId);
    if (session) {
      session.hasPendingPrompt = false;
      this.scheduleMenuRebuild();
    }
  }

  /**
   * Mark a session as having unread messages.
   * Called from ai:updateSessionMetadata when the renderer persists hasUnread changes.
   * If the session isn't in the cache yet (e.g., it completed before the tray initialized),
   * fetch its metadata from the database and add it.
   */
  onSessionUnread(sessionId: string, hasUnread: boolean): void {
    const session = this.sessionCache.get(sessionId);
    if (session) {
      session.hasUnread = hasUnread;
      // If no longer unread and not running/attention, remove from cache
      if (!hasUnread && session.status !== 'running' && !session.hasPendingPrompt) {
        this.sessionCache.delete(sessionId);
      }
      this.scheduleMenuRebuild();
      return;
    }

    // Session not in cache -- if marking as unread, fetch metadata and add it
    if (hasUnread) {
      this.fetchSessionMetadata(sessionId).then((info) => {
        info.status = 'completed';
        info.hasUnread = true;
        this.sessionCache.set(sessionId, info);
        this.scheduleMenuRebuild();
      });
    }
  }

  // ─── Session state event handling ───────────────────────────────────────

  private async onSessionStateEvent(event: SessionStateEvent): Promise<void> {
    switch (event.type) {
      case 'session:started':
      case 'session:streaming': {
        // Ensure session is in cache, fetch metadata if needed
        let session = this.sessionCache.get(event.sessionId);
        if (!session) {
          session = await this.fetchSessionMetadata(event.sessionId);
          this.sessionCache.set(event.sessionId, session);
        }
        session.status = 'running';
        session.isStreaming = event.type === 'session:streaming';
        // Clear any linger timer if session restarts
        this.clearLingerTimer(event.sessionId);
        break;
      }

      case 'session:completed': {
        const session = this.sessionCache.get(event.sessionId);
        if (session) {
          session.status = 'completed';
          session.isStreaming = false;
          session.hasPendingPrompt = false; // Session done -- can't be blocked
          session.completedAt = Date.now();

          // Check if app is backgrounded -- if so, mark as unread
          const allWindows = BrowserWindow.getAllWindows();
          const hasVisibleFocusedWindow = allWindows.some(w => w.isVisible() && w.isFocused());
          if (!hasVisibleFocusedWindow) {
            session.hasUnread = true;
          }

          // Start linger timer -- remove from cache after COMPLETED_LINGER_MS
          this.startLingerTimer(event.sessionId);
        }
        break;
      }

      case 'session:error': {
        const session = this.sessionCache.get(event.sessionId);
        if (session) {
          session.status = 'error';
          session.isStreaming = false;
        }
        break;
      }

      case 'session:interrupted': {
        // Remove immediately -- interrupted sessions don't need tray visibility
        this.sessionCache.delete(event.sessionId);
        this.clearLingerTimer(event.sessionId);
        break;
      }

      case 'session:waiting': {
        const session = this.sessionCache.get(event.sessionId);
        if (session) {
          session.status = 'running';
          session.isStreaming = false;
        }
        break;
      }

      case 'session:activity': {
        // Activity events don't change tray state, skip rebuild
        return;
      }
    }

    this.scheduleMenuRebuild();
  }

  // ─── Menu item dot icons ────────────────────────────────────────────────

  /** Cached dot icons (created once, reused across menu rebuilds) */
  private dotIconCache: Map<string, Electron.NativeImage> = new Map();

  /**
   * Create a small colored dot NativeImage for use as a menu item icon.
   * macOS renders these at 16x16 in menus; we draw at @2x (32x32) for retina.
   */
  private getDotIcon(hex: string): Electron.NativeImage {
    const cached = this.dotIconCache.get(hex);
    if (cached) return cached;

    const size = 32;
    const canvas = Buffer.alloc(size * size * 4, 0);

    // Parse hex color
    const r = parseInt(hex.slice(1, 3), 16);
    const g = parseInt(hex.slice(3, 5), 16);
    const b = parseInt(hex.slice(5, 7), 16);

    // Draw a filled circle centered at (16, 16) with radius 5.
    // macOS nativeImage bitmap format is BGRA, not RGBA.
    const cx = 16, cy = 16, radius = 5;
    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        const dx = x - cx, dy = y - cy;
        if (dx * dx + dy * dy <= radius * radius) {
          const offset = (y * size + x) * 4;
          canvas[offset] = b;
          canvas[offset + 1] = g;
          canvas[offset + 2] = r;
          canvas[offset + 3] = 255;
        }
      }
    }

    const image = nativeImage.createFromBuffer(canvas, {
      width: size,
      height: size,
      scaleFactor: 2.0,
    });
    this.dotIconCache.set(hex, image);
    return image;
  }

  // ─── Menu building ──────────────────────────────────────────────────────

  private scheduleMenuRebuild(): void {
    if (this.menuRebuildTimer) {
      clearTimeout(this.menuRebuildTimer);
    }
    this.menuRebuildTimer = setTimeout(() => {
      this.menuRebuildTimer = null;
      this.rebuildMenu();
    }, MENU_REBUILD_DEBOUNCE_MS);
  }

  private rebuildMenu(): void {
    if (!this.tray) return;

    const needsAttention: TraySessionInfo[] = [];
    const running: TraySessionInfo[] = [];
    const unread: TraySessionInfo[] = [];

    for (const session of this.sessionCache.values()) {
      if (session.hasPendingPrompt || session.status === 'error') {
        needsAttention.push(session);
      } else if (session.status === 'running') {
        running.push(session);
      } else if (session.hasUnread) {
        unread.push(session);
      }
    }

    const menuItems: Electron.MenuItemConstructorOptions[] = [];

    const blueDot = this.getDotIcon('#3B82F6');
    const orangeDot = this.getDotIcon('#F97316');
    const redDot = this.getDotIcon('#EF4444');

    // Needs Attention section
    if (needsAttention.length > 0) {
      menuItems.push({ label: 'Needs Attention', enabled: false });
      for (const session of needsAttention) {
        const isError = session.status === 'error';
        const suffix = isError ? ' (error)' : ' (blocked)';
        menuItems.push({
          label: this.truncateTitle(session.title) + suffix,
          icon: isError ? redDot : orangeDot,
          click: () => this.handleSessionClick(session.sessionId, session.workspacePath),
        });
      }
      menuItems.push({ type: 'separator' });
    }

    // Running section
    if (running.length > 0) {
      menuItems.push({ label: 'Running', enabled: false });
      for (const session of running) {
        const suffix = session.isStreaming ? ' (streaming...)' : '';
        menuItems.push({
          label: this.truncateTitle(session.title) + suffix,
          click: () => this.handleSessionClick(session.sessionId, session.workspacePath),
        });
      }
      menuItems.push({ type: 'separator' });
    }

    // Unread section
    if (unread.length > 0) {
      menuItems.push({ label: 'Unread', enabled: false });
      for (const session of unread) {
        menuItems.push({
          label: this.truncateTitle(session.title),
          icon: blueDot,
          click: () => this.handleSessionClick(session.sessionId, session.workspacePath),
        });
      }
      menuItems.push({
        label: 'Clear All Unread',
        click: () => {
          void this.clearAllUnreadSessions();
        },
      });
      menuItems.push({ type: 'separator' });
    }

    // Always show these items
    menuItems.push({
      label: 'New Session',
      click: () => this.handleNewSession(),
    });
    menuItems.push({
      label: 'Open Nimbalyst',
      click: () => {
        const windows = BrowserWindow.getAllWindows();
        if (windows.length > 0) {
          windows[0].show();
          windows[0].focus();
        }
      },
    });
    // Prevent Sleep submenu (only show when sync is configured)
    const syncConfig = getSessionSyncConfig();
    if (syncConfig?.enabled) {
      const currentMode = resolvePreventSleepMode(syncConfig);
      const setMode = (mode: 'off' | 'always' | 'pluggedIn') => {
        const currentConfig = getSessionSyncConfig();
        if (currentConfig) {
          const updated = { ...currentConfig, preventSleepMode: mode, preventSleepWhenSyncing: undefined };
          setSessionSyncConfig(updated);
          updateSleepPrevention();
          this.scheduleMenuRebuild();
          for (const win of BrowserWindow.getAllWindows()) {
            win.webContents.send('sync:config-updated', updated);
          }
        }
      };
      menuItems.push({
        label: 'Prevent Sleep',
        submenu: [
          { label: 'Off', type: 'radio', checked: currentMode === 'off', click: () => setMode('off') },
          { label: 'Always', type: 'radio', checked: currentMode === 'always', click: () => setMode('always') },
          { label: 'When Plugged In', type: 'radio', checked: currentMode === 'pluggedIn', click: () => setMode('pluggedIn') },
        ],
      });
    }
    menuItems.push({
      label: 'Hide Menu Bar Icon',
      click: () => this.setVisible(false),
    });
    menuItems.push({ type: 'separator' });
    menuItems.push({
      label: 'Quit',
      click: () => app.quit(),
    });

    const menu = Menu.buildFromTemplate(menuItems);
    this.tray.setContextMenu(menu);

    // Update icon state
    this.updateIcon();

    // Update dock badge
    this.updateDockBadge(needsAttention.length);
  }

  // ─── Icon management ───────────────────────────────────────────────────

  /** Cached base template image (loaded once from disk) */
  private templateIcon: Electron.NativeImage | null = null;

  private updateIcon(): void {
    if (!this.tray) return;

    const state = this.computeIconState();
    const icon = this.getIconForState(state);
    this.tray.setImage(icon);

    // Update title text on macOS (shown next to the icon). `setTitle` is a
    // macOS-only Tray method; calling it on Linux/Windows is documented as a
    // no-op but the API is officially `darwin` only. Guard it to keep the
    // intent explicit and avoid future Electron versions throwing here.
    if (process.platform === 'darwin') {
      const runningCount = this.getRunningCount();
      const attentionCount = this.getAttentionCount();
      if (attentionCount > 0) {
        this.tray.setTitle(` ${attentionCount}`);
      } else if (runningCount > 0) {
        this.tray.setTitle(` ${runningCount}`);
      } else {
        this.tray.setTitle('');
      }
    }
  }

  private computeIconState(): TrayIconState {
    let hasError = false;
    let hasAttention = false;
    let hasRunning = false;

    for (const session of this.sessionCache.values()) {
      if (session.status === 'error') hasError = true;
      if (session.hasPendingPrompt || session.hasUnread) hasAttention = true;
      if (session.status === 'running') hasRunning = true;
    }

    // Priority order: Error > Needs Attention > Running > Idle
    if (hasError) return 'error';
    if (hasAttention) return 'attention';
    if (hasRunning) return 'running';
    return 'idle';
  }

  /**
   * Load the pre-rendered template icon from resources.
   * Falls back to a 1x1 transparent image if the file is missing (should never happen).
   */
  private loadTemplateIcon(): Electron.NativeImage {
    if (this.templateIcon) return this.templateIcon;

    // In dev: resources/ is at the package root (packages/electron/resources/)
    // getPackageRoot() handles alternate outDir (e.g. out2/main) correctly.
    // In packaged builds: electron-builder copies resources/ into the app Resources dir.
    const resourcesDir = app.isPackaged
      ? process.resourcesPath
      : path.join(getPackageRoot(), 'resources');

    const iconPath = path.join(resourcesDir, 'trayTemplate.png');
    const icon2xPath = path.join(resourcesDir, 'trayTemplate@2x.png');

    // nativeImage.createFromPath handles @2x variants automatically when
    // the base path is given, but only if both files exist at the same location.
    // Load explicitly to ensure correct scale factor mapping.
    try {
      this.templateIcon = nativeImage.createFromPath(iconPath);
      if (this.templateIcon.isEmpty()) {
        logger.main.warn(`[TrayManager] Template icon is empty at ${iconPath}, trying @2x`);
        this.templateIcon = nativeImage.createFromPath(icon2xPath);
      }
    } catch {
      logger.main.warn(`[TrayManager] Failed to load template icon from ${iconPath}`);
      this.templateIcon = nativeImage.createEmpty();
    }

    return this.templateIcon;
  }

  private getIconForState(state: TrayIconState): Electron.NativeImage {
    const baseIcon = this.loadTemplateIcon();
    const needsColorDot = state === 'attention' || state === 'error';

    // For states without a colored dot, use the template image directly.
    // macOS automatically tints template images white on dark menu bars and
    // dark on light menu bars. This tinting is handled by the OS at the
    // NSStatusBar level and is NOT affected by nativeTheme.themeSource.
    if (!needsColorDot) {
      // Ensure the template flag is set (Electron auto-detects from filename
      // "trayTemplate.png" but be explicit)
      baseIcon.setTemplateImage(true);
      return baseIcon;
    }

    // For attention/error states, we need a colored blue dot overlay.
    // Template images are monochrome so we must render manually.
    //
    // Work at @2x (32x32 pixels) for retina crispness.
    const scaleFactor = 2.0;
    const physicalSize = 32; // 16pt * 2

    // Get the raw bitmap at @2x scale (macOS uses BGRA byte order)
    const baseBitmap = baseIcon.toBitmap({ scaleFactor });
    const canvas = Buffer.from(baseBitmap);

    // Always use white (255) foreground for the attention/error icon.
    //
    // Why not detect dark vs light menu bar?
    // - systemPreferences.getEffectiveAppearance() returns the system appearance
    //   ('light'/'dark'), but the macOS menu bar is TRANSLUCENT -- a dark wallpaper
    //   makes it appear dark even in light mode. There's no Electron API to detect
    //   the actual menu bar background luminance.
    // - Template images handle this automatically (macOS tints them at the
    //   NSStatusBar level), but we can't use template mode here because we have
    //   colored pixels (the blue dot).
    // - White foreground matches what other apps (ChatGPT, Slack) use for their
    //   status bar icons when they include colored elements.
    const fg = 255;

    for (let i = 0; i < canvas.length; i += 4) {
      if (canvas[i + 3] > 0) {
        canvas[i] = fg;
        canvas[i + 1] = fg;
        canvas[i + 2] = fg;
      }
    }

    // Draw blue dot in bottom-right (BGRA byte order)
    const dotCx = Math.floor(physicalSize * 0.78);
    const dotCy = Math.floor(physicalSize * 0.78);
    const dotR = Math.floor(physicalSize * 0.14);
    for (let y = dotCy - dotR; y <= dotCy + dotR; y++) {
      for (let x = dotCx - dotR; x <= dotCx + dotR; x++) {
        if (x < 0 || x >= physicalSize || y < 0 || y >= physicalSize) continue;
        const dx = x - dotCx, dy = y - dotCy;
        if (dx * dx + dy * dy <= dotR * dotR) {
          const offset = (y * physicalSize + x) * 4;
          canvas[offset] = 246;     // B: #F6
          canvas[offset + 1] = 130;  // G: #82
          canvas[offset + 2] = 59;   // R: #3B
          canvas[offset + 3] = 255;
        }
      }
    }

    const image = nativeImage.createFromBuffer(canvas, {
      width: physicalSize,
      height: physicalSize,
      scaleFactor,
    });
    // Must NOT be template -- we have colored pixels (blue dot)
    image.setTemplateImage(false);
    return image;
  }

  // ─── Dock badge ────────────────────────────────────────────────────────

  private updateDockBadge(attentionCount: number): void {
    if (process.platform === 'darwin' && app.dock) {
      app.dock.setBadge(attentionCount > 0 ? String(attentionCount) : '');
    }
  }

  // ─── Session click handling ────────────────────────────────────────────

  private handleNewSession(): void {
    const windows = BrowserWindow.getAllWindows();
    if (windows.length > 0) {
      const win = windows[0];
      win.show();
      win.focus();
      // Tell renderer to switch to agent mode and create a new session
      win.webContents.send('tray:new-session');
    }
  }

  private handleSessionClick(sessionId: string, workspacePath: string): void {
    if (!workspacePath) {
      throw new Error(`[TrayManager] workspacePath is missing for session ${sessionId} -- cache bug`);
    }

    const targetWindow = findWindowByWorkspace(workspacePath);
    if (targetWindow && !targetWindow.isDestroyed()) {
      targetWindow.show();
      targetWindow.focus();
      // Send navigation request to renderer
      targetWindow.webContents.send('tray:navigate-to-session', { sessionId, workspacePath });
    } else {
      // No window for this workspace -- just show any window
      const windows = BrowserWindow.getAllWindows();
      if (windows.length > 0) {
        windows[0].show();
        windows[0].focus();
      }
    }

    // Clear unread flag when user clicks (in-memory + database)
    void this.markSessionsRead([{ sessionId, workspacePath }]);
  }

  /**
   * Clear every unread session from the tray in one action.
   */
  private async clearAllUnreadSessions(): Promise<void> {
    const unreadSessions = Array.from(this.sessionCache.values())
      .filter((session) => session.hasUnread && session.workspacePath)
      .map((session) => ({
        sessionId: session.sessionId,
        workspacePath: session.workspacePath,
      }));

    if (unreadSessions.length === 0) return;

    await this.markSessionsRead(unreadSessions);
  }

  /**
   * Apply read-state updates consistently for tray actions:
   * - clear in-memory unread state
   * - persist hasUnread/lastReadAt
   * - fan out a renderer notification so open windows update immediately
   */
  private async markSessionsRead(
    sessions: Array<{ sessionId: string; workspacePath: string }>
  ): Promise<void> {
    if (sessions.length === 0) return;

    const lastReadAt = Date.now();
    const rendererPayload: TrayUnreadClearPayload = {
      sessions: sessions.map((session) => ({
        ...session,
        lastReadAt,
      })),
    };

    for (const session of sessions) {
      this.applyReadStateToCache(session.sessionId);
    }
    this.scheduleMenuRebuild();
    this.broadcastUnreadCleared(rendererPayload);

    await Promise.all(
      sessions.map((session) => this.persistReadState(session.sessionId, lastReadAt))
    );
  }

  private applyReadStateToCache(sessionId: string): void {
    const session = this.sessionCache.get(sessionId);
    if (!session) return;

    session.hasUnread = false;
    if ((session.status === 'completed' || session.status === 'idle') && !session.hasPendingPrompt) {
      this.sessionCache.delete(sessionId);
      this.clearLingerTimer(sessionId);
    }
  }

  private broadcastUnreadCleared(payload: TrayUnreadClearPayload): void {
    for (const window of BrowserWindow.getAllWindows()) {
      if (window.isDestroyed()) continue;
      window.webContents.send('tray:clear-unread', payload);
    }
  }

  /**
   * Persist hasUnread = false and lastReadAt so tray clears match renderer semantics.
   */
  private async persistReadState(sessionId: string, lastReadAt: number): Promise<void> {
    const syncProvider = getSyncProvider();

    try {
      await AISessionsRepository.updateMetadata(sessionId, {
        metadata: {
          hasUnread: false,
          lastReadAt,
        },
      });
      if (syncProvider) {
        syncProvider.pushChange(sessionId, {
          type: 'metadata_updated',
          metadata: { lastReadAt },
        });
      }
    } catch (error) {
      logger.main.error('[TrayManager] Failed to persist read state from tray action:', error);
    }
  }

  // ─── Database queries ─────────────────────────────────────────────────

  /**
   * Query the database for sessions that already have hasUnread = true and
   * seed the session cache. Without this, sessions that completed before this
   * app session started would never appear in the tray's "Unread" section.
   */
  private async seedUnreadFromDatabase(): Promise<void> {
    if (!this.database) return;

    try {
      // The hasUnread flag is stored in the metadata JSONB column.
      // metadata.metadata.hasUnread is the nested path used by sessionStateListeners.
      // Also check metadata.hasUnread for backwards compatibility.
      const { rows } = await this.database.query<any>(
        `SELECT id, title, workspace_id, metadata FROM ai_sessions
         WHERE is_archived = false
           AND (metadata->'metadata'->>'hasUnread' = 'true'
                OR metadata->>'hasUnread' = 'true')`
      );

      for (const row of rows) {
        // Don't overwrite sessions already in cache (e.g., currently running)
        if (this.sessionCache.has(row.id)) continue;

        this.sessionCache.set(row.id, {
          sessionId: row.id,
          title: row.title || 'Untitled Session',
          workspacePath: row.workspace_id || '',
          status: 'completed',
          isStreaming: false,
          // Don't inherit stale hasPendingPrompt from old metadata --
          // a completed session that's merely unread isn't blocked on user input.
          hasPendingPrompt: false,
          hasUnread: true,
        });
      }

      if (rows.length > 0) {
        logger.main.info(`[TrayManager] Seeded ${rows.length} unread session(s) from database`);
        this.scheduleMenuRebuild();
      }
    } catch (error) {
      logger.main.error('[TrayManager] Failed to seed unread sessions from database:', error);
    }
  }

  private async fetchSessionMetadata(sessionId: string): Promise<TraySessionInfo> {
    if (!this.database) {
      return this.createFallbackSession(sessionId);
    }

    try {
      const { rows } = await this.database.query<any>(
        `SELECT id, title, workspace_id, metadata FROM ai_sessions WHERE id = $1`,
        [sessionId]
      );

      if (rows.length === 0) {
        return this.createFallbackSession(sessionId);
      }

      const row = rows[0];
      const metadata = typeof row.metadata === 'string' ? JSON.parse(row.metadata) : (row.metadata || {});

      return {
        sessionId,
        title: row.title || 'Untitled Session',
        workspacePath: row.workspace_id || '',
        status: 'running',
        isStreaming: false,
        hasPendingPrompt: !!metadata.hasPendingPrompt,
        hasUnread: !!metadata.hasUnread,
      };
    } catch (error) {
      // Database query failure is not fatal -- title is cosmetic
      logger.main.error(`[TrayManager] Failed to fetch session metadata for ${sessionId}:`, error);
      return this.createFallbackSession(sessionId);
    }
  }

  private createFallbackSession(sessionId: string): TraySessionInfo {
    return {
      sessionId,
      title: 'AI Session',
      workspacePath: '',
      status: 'running',
      isStreaming: false,
      hasPendingPrompt: false,
      hasUnread: false,
    };
  }

  // ─── Helpers ──────────────────────────────────────────────────────────

  private truncateTitle(title: string, maxLen: number = 40): string {
    if (title.length <= maxLen) return title;
    return title.slice(0, maxLen - 1) + '\u2026';
  }

  private getRunningCount(): number {
    let count = 0;
    for (const session of this.sessionCache.values()) {
      if (session.status === 'running') count++;
    }
    return count;
  }

  private getAttentionCount(): number {
    let count = 0;
    for (const session of this.sessionCache.values()) {
      if (session.hasPendingPrompt || session.hasUnread || session.status === 'error') count++;
    }
    return count;
  }

  private startLingerTimer(sessionId: string): void {
    this.clearLingerTimer(sessionId);
    const timer = setTimeout(() => {
      this.lingerTimers.delete(sessionId);
      const session = this.sessionCache.get(sessionId);
      // Only remove if still in completed state and not unread
      if (session && session.status === 'completed' && !session.hasUnread && !session.hasPendingPrompt) {
        this.sessionCache.delete(sessionId);
        this.scheduleMenuRebuild();
      }
    }, COMPLETED_LINGER_MS);
    this.lingerTimers.set(sessionId, timer);
  }

  private clearLingerTimer(sessionId: string): void {
    const timer = this.lingerTimers.get(sessionId);
    if (timer) {
      clearTimeout(timer);
      this.lingerTimers.delete(sessionId);
    }
  }
}
