/**
 * IPC handlers for chat attachment operations
 */

import { BrowserWindow, app } from 'electron';
import { AttachmentService } from '../services/AttachmentService';
import { getWindowId, windowStates } from '../window/WindowManager';
import { safeHandle, safeOn } from '../utils/ipcRegistry';

// Map of workspace paths to AttachmentService instances
const attachmentServices = new Map<string, AttachmentService>();

/**
 * Get or create an AttachmentService for a workspace
 */
function getAttachmentService(workspacePath: string): AttachmentService {
  if (!attachmentServices.has(workspacePath)) {
    const userDataPath = app.getPath('userData');
    attachmentServices.set(workspacePath, new AttachmentService(workspacePath, userDataPath));
  }
  return attachmentServices.get(workspacePath)!;
}

export function registerAttachmentHandlers() {
  /**
   * Save an attachment file
   */
  safeHandle('attachment:save', async (event, {
    fileBuffer,
    filename,
    mimeType,
    sessionId
  }: {
    fileBuffer: number[] | Buffer; // Accept array from renderer or Buffer
    filename: string;
    mimeType: string;
    sessionId: string;
  }) => {
    try {
      const window = BrowserWindow.fromWebContents(event.sender);
      if (!window) {
        console.error('[AttachmentHandlers] No window found');
        return { success: false, error: 'No window found' };
      }

      const windowId = getWindowId(window);
      if (windowId === null) {
        console.error('[AttachmentHandlers] No window ID found');
        return { success: false, error: 'No window ID found' };
      }

      const state = windowStates.get(windowId);
      if (!state?.workspacePath) {
        console.error('[AttachmentHandlers] No workspace path found');
        return { success: false, error: 'No workspace open' };
      }

      const service = getAttachmentService(state.workspacePath);
      const result = await service.saveAttachment(
        Buffer.from(fileBuffer),
        filename,
        mimeType,
        sessionId
      );

      // console.log('[AttachmentHandlers] Save attachment result', {
      //   success: result.success,
      //   filename
      // });

      return result;
    } catch (error) {
      console.error('[AttachmentHandlers] Save attachment failed', error);
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Failed to save attachment'
      };
    }
  });

  /**
   * Delete an attachment file
   */
  safeHandle('attachment:delete', async (event, {
    attachmentId,
    sessionId
  }: {
    attachmentId: string;
    sessionId: string;
  }) => {
    try {
      const window = BrowserWindow.fromWebContents(event.sender);
      if (!window) {
        return { success: false, error: 'No window found' };
      }

      const windowId = getWindowId(window);
      if (windowId === null) {
        return { success: false, error: 'No window ID found' };
      }

      const state = windowStates.get(windowId);
      if (!state?.workspacePath) {
        return { success: false, error: 'No workspace open' };
      }

      const service = getAttachmentService(state.workspacePath);
      return await service.deleteAttachment(attachmentId, sessionId);
    } catch (error) {
      console.error('[AttachmentHandlers] Delete attachment failed', error);
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Failed to delete attachment'
      };
    }
  });

  /**
   * Read attachment as base64 (for sending to AI providers)
   */
  safeHandle('attachment:readAsBase64', async (event, {
    filepath
  }: {
    filepath: string;
  }) => {
    try {
      const window = BrowserWindow.fromWebContents(event.sender);
      if (!window) {
        return { success: false, error: 'No window found' };
      }

      const windowId = getWindowId(window);
      if (windowId === null) {
        return { success: false, error: 'No window ID found' };
      }

      const state = windowStates.get(windowId);
      if (!state?.workspacePath) {
        return { success: false, error: 'No workspace open' };
      }

      const service = getAttachmentService(state.workspacePath);
      return await service.readAttachmentAsBase64(filepath);
    } catch (error) {
      console.error('[AttachmentHandlers] Read attachment failed', error);
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Failed to read attachment'
      };
    }
  });

  /**
   * Read attachment as text (for converting back to prompt text)
   */
  safeHandle('attachment:readAsText', async (event, {
    filepath
  }: {
    filepath: string;
  }) => {
    try {
      const window = BrowserWindow.fromWebContents(event.sender);
      if (!window) {
        return { success: false, error: 'No window found' };
      }

      const windowId = getWindowId(window);
      if (windowId === null) {
        return { success: false, error: 'No window ID found' };
      }

      const state = windowStates.get(windowId);
      if (!state?.workspacePath) {
        return { success: false, error: 'No workspace open' };
      }

      const service = getAttachmentService(state.workspacePath);
      return await service.readAttachmentAsText(filepath);
    } catch (error) {
      console.error('[AttachmentHandlers] Read attachment as text failed', error);
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Failed to read attachment'
      };
    }
  });

  /**
   * Validate a file before uploading
   */
  safeHandle('attachment:validate', async (event, {
    fileSize,
    mimeType,
    filename
  }: {
    fileSize: number;
    mimeType: string;
    filename?: string;
  }) => {
    try {
      const window = BrowserWindow.fromWebContents(event.sender);
      if (!window) {
        return { valid: false, error: 'No window found' };
      }

      const windowId = getWindowId(window);
      if (windowId === null) {
        return { valid: false, error: 'No window ID found' };
      }

      const state = windowStates.get(windowId);
      if (!state?.workspacePath) {
        return { valid: false, error: 'No workspace open' };
      }

      const service = getAttachmentService(state.workspacePath);
      return service.validateFile(fileSize, mimeType, filename);
    } catch (error) {
      console.error('[AttachmentHandlers] Validate file failed', error);
      return {
        valid: false,
        error: error instanceof Error ? error.message : 'Failed to validate file'
      };
    }
  });
}
