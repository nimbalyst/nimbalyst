/**
 * Offscreen Editor Manager
 *
 * Manages lifecycle of offscreen editor instances for MCP tool access.
 * Editors can be mounted in hidden containers without visible UI, allowing
 * AI tools to work with files that aren't currently open in tabs.
 *
 * Key features:
 * - Reference counting for concurrent tool usage
 * - TTL-based caching to avoid repeated mount/unmount
 * - Seamless integration with visible editors (same registry)
 */

import electron, { BrowserWindow } from 'electron';
import { join } from 'path';
import { logger } from '../utils/logger';
import { getPreloadPath } from '../utils/appPaths';
import { findWindowByWorkspace } from '../window/WindowManager';

interface OffscreenEditorEntry {
  filePath: string;
  mountedAt: Date;
  lastUsed: Date;
  refCount: number;
  unmountTimer: NodeJS.Timeout | null;
}

export class OffscreenEditorManager {
  private static instance: OffscreenEditorManager | null = null;

  // Track mounted offscreen editors by file path
  private editors = new Map<string, OffscreenEditorEntry>();

  // Hidden BrowserWindow for flash-free offscreen editor screenshots.
  // Loads the same renderer URL with ?mode=capture, which initializes only
  // the offscreen editor system. capturePage() on a hidden window captures
  // real pixels without ever displaying to the user.
  private captureWindow: BrowserWindow | null = null;
  private captureWindowReady = false;

  // Configuration
  private cacheTTL = 30000; // 30 seconds
  private maxCached = 5;

  private constructor() {}

  public static getInstance(): OffscreenEditorManager {
    if (!OffscreenEditorManager.instance) {
      OffscreenEditorManager.instance = new OffscreenEditorManager();
    }
    return OffscreenEditorManager.instance;
  }

  /**
   * Get or create the hidden capture window.
   * This window loads the renderer in capture mode (?mode=capture) which only
   * initializes the offscreen editor system -- no Monaco, PostHog, React, or settings.
   */
  private async getCaptureWindow(): Promise<BrowserWindow> {
    if (this.captureWindow && !this.captureWindow.isDestroyed()) {
      return this.captureWindow;
    }

    logger.main.info('[OffscreenEditorManager] Creating hidden capture window');

    this.captureWindow = new BrowserWindow({
      show: false,
      width: 1280,
      height: 800,
      webPreferences: {
        preload: getPreloadPath(),
        sandbox: false,
        contextIsolation: true,
      },
    });

    this.captureWindow.on('closed', () => {
      this.captureWindow = null;
      this.captureWindowReady = false;
    });

    // Load renderer in capture mode
    const { app } = electron;
    if (!app.isPackaged && process.env['ELECTRON_RENDERER_URL']) {
      await this.captureWindow.loadURL(`${process.env['ELECTRON_RENDERER_URL']}?mode=capture`);
    } else {
      const appPath = app.getAppPath();
      let htmlPath: string;
      if (app.isPackaged) {
        htmlPath = join(appPath, 'out/renderer/index.html');
      } else if (appPath.includes('/out/main') || appPath.includes('\\out\\main')) {
        htmlPath = join(appPath, '../renderer/index.html');
      } else {
        htmlPath = join(appPath, 'out/renderer/index.html');
      }
      await this.captureWindow.loadFile(htmlPath, {
        query: { mode: 'capture' },
      });
    }

    // Wait for capture window to initialize
    await new Promise(resolve => setTimeout(resolve, 1000));
    this.captureWindowReady = true;

    logger.main.info('[OffscreenEditorManager] Hidden capture window ready');
    return this.captureWindow;
  }

  /**
   * Mount an editor offscreen for a file.
   * If already mounted, increments reference count and refreshes TTL.
   * Mounts in the hidden capture window (not the main window).
   */
  public async mountOffscreen(filePath: string, workspacePath: string): Promise<void> {
    logger.main.info(`[OffscreenEditorManager] Mount request for ${filePath}`);

    // Check if already mounted
    const existing = this.editors.get(filePath);
    if (existing) {
      logger.main.info(`[OffscreenEditorManager] Already mounted, incrementing ref count`);
      existing.refCount++;
      existing.lastUsed = new Date();

      // Cancel pending unmount timer
      if (existing.unmountTimer) {
        clearTimeout(existing.unmountTimer);
        existing.unmountTimer = null;
      }

      return;
    }

    // Check cache limit
    if (this.editors.size >= this.maxCached) {
      logger.main.info(`[OffscreenEditorManager] Cache full, evicting LRU entry`);
      this.evictLRU();
    }

    // Mount in the hidden capture window (not the main window)
    const captureWin = await this.getCaptureWindow();

    logger.main.info(`[OffscreenEditorManager] Sending mount request to capture window`);

    // Create entry before sending IPC (renderer will report when ready)
    const entry: OffscreenEditorEntry = {
      filePath,
      mountedAt: new Date(),
      lastUsed: new Date(),
      refCount: 1,
      unmountTimer: null,
    };

    this.editors.set(filePath, entry);

    // Send IPC to capture window renderer to mount
    try {
      captureWin.webContents.send('offscreen-editor:mount', {
        filePath,
        workspacePath,
      });

      // Wait for editor to be ready (renderer will register API)
      // Longer delay for editors with iframes (mockups, etc.)
      await new Promise(resolve => setTimeout(resolve, 3000));

      logger.main.info(`[OffscreenEditorManager] Editor mounted for ${filePath}`);
    } catch (error) {
      // Clean up on failure
      this.editors.delete(filePath);
      throw error;
    }
  }

  /**
   * Unmount an offscreen editor.
   * Decrements reference count and schedules unmount after TTL if count reaches 0.
   */
  public unmountOffscreen(filePath: string): void {
    const entry = this.editors.get(filePath);
    if (!entry) {
      logger.main.warn(`[OffscreenEditorManager] No offscreen editor for ${filePath}`);
      return;
    }

    entry.refCount--;
    entry.lastUsed = new Date();

    if (entry.refCount <= 0) {
      logger.main.info(`[OffscreenEditorManager] Ref count 0, scheduling unmount after TTL`);

      // Schedule unmount after TTL
      entry.unmountTimer = setTimeout(() => {
        this.performUnmount(filePath);
      }, this.cacheTTL);
    } else {
      logger.main.info(`[OffscreenEditorManager] Ref count: ${entry.refCount}, keeping mounted`);
    }
  }

  /**
   * Check if an editor is available (visible or offscreen).
   * This delegates to the renderer's editor registry.
   */
  public isAvailable(filePath: string): boolean {
    // Check if we have it mounted offscreen
    return this.editors.has(filePath);
  }

  /**
   * Get statistics for debugging.
   */
  public getStats(): { mounted: number; cache: Map<string, { mountedAt: Date; lastUsed: Date; refCount: number }> } {
    const cache = new Map();
    for (const [filePath, entry] of this.editors) {
      cache.set(filePath, {
        mountedAt: entry.mountedAt,
        lastUsed: entry.lastUsed,
        refCount: entry.refCount,
      });
    }

    return {
      mounted: this.editors.size,
      cache,
    };
  }

  /**
   * Capture screenshot from an editor using Electron's native capturePage().
   *
   * This captures actual composited pixels from the GPU, so WebGL, canvas,
   * complex CSS transforms, and iframe content all work correctly.
   *
   * For visible editors (open in a tab): captures from the main window.
   * For offscreen editors: captures from the hidden capture window (no flash).
   */
  public async captureScreenshot(filePath: string, workspacePath: string, selector?: string, theme?: string): Promise<Buffer> {
    const wasMounted = this.editors.has(filePath);

    logger.main.info(`[OffscreenEditorManager] captureScreenshot - wasMounted: ${wasMounted}, editorCount: ${this.editors.size}, filePath: ${filePath}, theme: ${theme || 'current'}`);

    // First, try to capture from a visible editor in the main window.
    // This is the fast path -- no mounting, no flash.
    // Only use this path if no specific theme is requested (we can't change the main window's theme).
    if (!theme) {
      const mainWin = this.getTargetWindow(workspacePath);
      if (mainWin && !mainWin.isDestroyed()) {
        const visibleResult = await this.tryCaptureFromWindow(mainWin, filePath, selector);
        if (visibleResult) {
          logger.main.info(`[OffscreenEditorManager] Captured from visible editor: ${visibleResult.length} bytes`);
          return visibleResult;
        }
      }
    }

    // Not visible in main window (or specific theme requested) -- use the hidden capture window
    if (!wasMounted) {
      logger.main.info(`[OffscreenEditorManager] Mounting in capture window for screenshot: ${filePath}`);
      await this.mountOffscreen(filePath, workspacePath);
    }

    const captureWin = await this.getCaptureWindow();

    // Capture from the hidden window -- editor is positioned at 0,0 there
    const result = await this.captureFromWindow(captureWin, filePath, selector, theme);

    if (!wasMounted) {
      this.unmountOffscreen(filePath);
    }

    return result;
  }

  /**
   * Try to capture a visible editor from a window.
   * Returns null if no visible editor is found for the file.
   */
  private async tryCaptureFromWindow(win: BrowserWindow, filePath: string, selector?: string): Promise<Buffer | null> {
    const result = await this.sendCaptureRequest(win, filePath, selector);

    if (!result.success) {
      // If it failed because no visible editor was found, return null
      if (result.error?.includes('No offscreen editor mounted') || result.error?.includes('No visible')) {
        return null;
      }
      // Other errors are real failures
      return null;
    }

    if (!result.imageBase64) return null;
    return Buffer.from(result.imageBase64, 'base64');
  }

  /**
   * Capture from a window, throwing on failure.
   */
  private async captureFromWindow(win: BrowserWindow, filePath: string, selector?: string, theme?: string): Promise<Buffer> {
    const result = await this.sendCaptureRequest(win, filePath, selector, theme);

    if (!result.success || !result.imageBase64) {
      throw new Error(result.error || 'Screenshot failed');
    }

    const buffer = Buffer.from(result.imageBase64, 'base64');
    logger.main.info(`[OffscreenEditorManager] Screenshot captured: ${buffer.length} bytes`);
    return buffer;
  }

  /**
   * Send a capture request to a window's renderer and wait for the response.
   */
  private async sendCaptureRequest(win: BrowserWindow, filePath: string, selector?: string, theme?: string): Promise<{ success: boolean; imageBase64?: string; error?: string }> {
    return new Promise((resolve, reject) => {
      const { ipcMain } = require('electron');
      const responseChannel = `offscreen-editor:capture-screenshot-response:${Date.now()}-${Math.random()}`;

      const timeout = setTimeout(() => {
        ipcMain.removeHandler(responseChannel);
        reject(new Error('Screenshot request timed out after 30s'));
      }, 30000);

      ipcMain.handle(responseChannel, async (_event: any, response: any) => {
        clearTimeout(timeout);
        ipcMain.removeHandler(responseChannel);
        resolve(response);
        return { received: true };
      });

      win.webContents.send('offscreen-editor:capture-screenshot-request', {
        filePath,
        selector,
        theme,
        responseChannel,
      });
    });
  }

  /**
   * Actually unmount the editor and notify the capture window renderer.
   */
  private performUnmount(filePath: string): void {
    const entry = this.editors.get(filePath);
    if (!entry) return;

    logger.main.info(`[OffscreenEditorManager] Unmounting ${filePath}`);

    // Send unmount to the capture window where offscreen editors live
    if (this.captureWindow && !this.captureWindow.isDestroyed()) {
      this.captureWindow.webContents.send('offscreen-editor:unmount', { filePath });
    }

    this.editors.delete(filePath);
  }

  /**
   * Evict least recently used editor to make room.
   */
  private evictLRU(): void {
    let oldest: { filePath: string; entry: OffscreenEditorEntry } | null = null;

    for (const [filePath, entry] of this.editors) {
      if (!oldest || entry.lastUsed < oldest.entry.lastUsed) {
        oldest = { filePath, entry };
      }
    }

    if (oldest) {
      logger.main.info(`[OffscreenEditorManager] Evicting LRU: ${oldest.filePath}`);

      // Cancel unmount timer if any
      if (oldest.entry.unmountTimer) {
        clearTimeout(oldest.entry.unmountTimer);
      }

      this.performUnmount(oldest.filePath);
    }
  }

  /**
   * Find a renderer window for the workspace.
   */
  private getTargetWindow(workspacePath: string): BrowserWindow | null {
    // Route to the correct window for this workspace
    const window = findWindowByWorkspace(workspacePath);

    if (window && !window.isDestroyed()) {
      logger.main.info(`[OffscreenEditorManager] Found window for workspace: ${workspacePath}`);
      return window;
    }

    logger.main.warn(`[OffscreenEditorManager] No window found for workspace ${workspacePath}, trying first available`);
    const windows = BrowserWindow.getAllWindows().filter(w => !w.isDestroyed());
    return windows.length > 0 ? windows[0] : null;
  }

  /**
   * Cleanup on shutdown.
   */
  public cleanup(): void {
    logger.main.info('[OffscreenEditorManager] Cleaning up');

    // Cancel all timers
    for (const entry of this.editors.values()) {
      if (entry.unmountTimer) {
        clearTimeout(entry.unmountTimer);
      }
    }

    this.editors.clear();

    // Close the hidden capture window
    if (this.captureWindow && !this.captureWindow.isDestroyed()) {
      this.captureWindow.close();
      this.captureWindow = null;
    }
  }
}
