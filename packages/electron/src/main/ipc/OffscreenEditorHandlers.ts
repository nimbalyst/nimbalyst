/**
 * IPC handlers for offscreen editor operations.
 *
 * Provides handlers for:
 * - Mounting editors offscreen
 * - Unmounting editors
 * - Checking availability
 * - Getting statistics
 */

import { BrowserWindow } from 'electron';
import { OffscreenEditorManager } from '../services/OffscreenEditorManager';
import { logger } from '../utils/logger';
import { safeHandle, safeOn } from '../utils/ipcRegistry';

/**
 * Register IPC handlers for offscreen editor operations.
 */
export function registerOffscreenEditorHandlers(): void {
  const manager = OffscreenEditorManager.getInstance();

  // Mount an editor offscreen
  safeHandle(
    'offscreen-editor:mount',
    async (_event, payload: { filePath: string; workspacePath: string }) => {
      logger.main.info(`[OffscreenEditorHandlers] Mount request: ${payload.filePath}`);

      try {
        await manager.mountOffscreen(payload.filePath, payload.workspacePath);
        return { success: true };
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : 'Unknown error';
        logger.main.error(`[OffscreenEditorHandlers] Mount failed: ${errorMessage}`);
        return {
          success: false,
          error: errorMessage,
        };
      }
    }
  );

  // Unmount an offscreen editor
  safeHandle('offscreen-editor:unmount', async (_event, payload: { filePath: string }) => {
    logger.main.info(`[OffscreenEditorHandlers] Unmount request: ${payload.filePath}`);

    try {
      manager.unmountOffscreen(payload.filePath);
      return { success: true };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      logger.main.error(`[OffscreenEditorHandlers] Unmount failed: ${errorMessage}`);
      return {
        success: false,
        error: errorMessage,
      };
    }
  });

  // Check if editor is available (visible or offscreen)
  safeHandle('offscreen-editor:is-available', async (_event, payload: { filePath: string }) => {
    const isAvailable = manager.isAvailable(payload.filePath);
    return { success: true, isAvailable };
  });

  // Get statistics for debugging
  safeHandle('offscreen-editor:get-stats', async () => {
    const stats = manager.getStats();
    return {
      success: true,
      stats: {
        mounted: stats.mounted,
        cache: Array.from(stats.cache.entries()).map(([filePath, info]) => ({
          filePath,
          mountedAt: info.mountedAt.toISOString(),
          lastUsed: info.lastUsed.toISOString(),
          refCount: info.refCount,
        })),
      },
    };
  });

  // Capture screenshot from offscreen editor
  safeHandle(
    'offscreen-editor:capture-screenshot',
    async (_event, payload: { filePath: string; workspacePath: string; selector?: string; theme?: string }) => {
      logger.main.info(`[OffscreenEditorHandlers] Screenshot request: ${payload.filePath}`);

      // Validate required workspace path - never fall back to path.dirname
      // as that produces incorrect results for files in subdirectories
      if (!payload.workspacePath) {
        logger.main.error('[OffscreenEditorHandlers] Screenshot failed: workspacePath is required');
        return {
          success: false,
          error: 'workspacePath is required for screenshot capture',
        };
      }

      try {
        const imageBuffer = await manager.captureScreenshot(
          payload.filePath,
          payload.workspacePath,
          payload.selector,
          payload.theme
        );

        const imageBase64 = imageBuffer.toString('base64');

        return {
          success: true,
          imageBase64,
          mimeType: 'image/png',
        };
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : 'Unknown error';
        logger.main.error(`[OffscreenEditorHandlers] Screenshot failed: ${errorMessage}`);
        return {
          success: false,
          error: errorMessage,
        };
      }
    }
  );

  // Native capturePage service for renderer to call during screenshot capture.
  // The renderer controls positioning/restoration; this just does the pixel capture.
  safeHandle(
    'offscreen-editor:native-capture',
    async (event, payload: { rect: { x: number; y: number; width: number; height: number } }) => {
      try {
        const win = BrowserWindow.fromWebContents(event.sender);
        if (!win || win.isDestroyed()) {
          return { success: false, error: 'Window not available' };
        }

        const nativeImage = await win.webContents.capturePage(payload.rect);
        const buffer = nativeImage.toPNG();

        logger.main.info(`[OffscreenEditorHandlers] Native capture: ${buffer.length} bytes, ${nativeImage.getSize().width}x${nativeImage.getSize().height}`);

        return {
          success: true,
          imageBase64: buffer.toString('base64'),
        };
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : 'Unknown error';
        logger.main.error(`[OffscreenEditorHandlers] Native capture failed: ${errorMessage}`);
        return { success: false, error: errorMessage };
      }
    }
  );

  logger.main.info('[OffscreenEditorHandlers] Offscreen editor handlers registered');
}
