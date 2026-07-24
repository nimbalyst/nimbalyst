/**
 * Electron implementation of MockupPlatformService.
 *
 * This implementation runs in the renderer process and uses IPC
 * to communicate with the main process for file operations.
 */

import type { MockupPlatformService, MockupFileInfo } from '@nimbalyst/runtime';

export class MockupPlatformServiceImpl implements MockupPlatformService {
  private static instance: MockupPlatformServiceImpl | null = null;

  private constructor() {}

  public static getInstance(): MockupPlatformServiceImpl {
    if (!MockupPlatformServiceImpl.instance) {
      MockupPlatformServiceImpl.instance = new MockupPlatformServiceImpl();
    }
    return MockupPlatformServiceImpl.instance;
  }

  /**
   * Capture a screenshot of a mockup and save it to the output path.
   */
  async captureScreenshot(
    mockupPath: string,
    outputPath: string,
  ): Promise<void> {
    const electronAPI = (window as any).electronAPI;
    if (!electronAPI) {
      throw new Error('electronAPI not available');
    }

    try {
      // Use the mockup-specific IPC handler to capture and save
      const result = await electronAPI.invoke(
        'mockup:capture-and-save-screenshot',
        mockupPath,
        outputPath,
      );

      if (!result.success) {
        throw new Error(result.error || 'Failed to capture screenshot');
      }
    } catch (error) {
      console.error('[MockupPlatformService] Failed to capture screenshot:', error);
      throw error;
    }
  }

  /**
   * Open the mockup file in the editor.
   */
  openMockupEditor(mockupPath: string): void {
    const electronAPI = (window as any).electronAPI;
    if (!electronAPI) {
      console.error('[MockupPlatformService] electronAPI not available');
      return;
    }

    // workspacePath is REQUIRED - cannot route file open without it
    const workspacePath = (window as any).__workspacePath;
    if (!workspacePath) {
      console.error('[MockupPlatformService] __workspacePath not set - cannot open mockup');
      return;
    }

    // Use workspace:open-file which sends open-document event to trigger
    // handleWorkspaceFileSelect in the renderer
    electronAPI.invoke('workspace:open-file', {
      workspacePath,
      filePath: mockupPath,
    }).catch((error: Error) => {
      console.error('[MockupPlatformService] Failed to open mockup:', error);
    });
  }

  /**
   * Get the last modified time of a file.
   */
  async getFileModifiedTime(filePath: string): Promise<number> {
    const electronAPI = (window as any).electronAPI;
    if (!electronAPI) {
      throw new Error('electronAPI not available');
    }

    try {
      const result = await electronAPI.invoke('file:get-modified-time', filePath);
      return result;
    } catch (error) {
      console.error('[MockupPlatformService] Failed to get file modified time:', error);
      throw error;
    }
  }

  /**
   * Check if a file exists.
   */
  async fileExists(filePath: string): Promise<boolean> {
    const electronAPI = (window as any).electronAPI;
    if (!electronAPI) {
      return false;
    }

    try {
      const result = await electronAPI.invoke('file:exists', filePath);
      return result;
    } catch (error) {
      console.error('[MockupPlatformService] Failed to check file existence:', error);
      return false;
    }
  }

  /**
   * Resolve a relative path to an absolute path based on the current document.
   */
  resolveRelativePath(relativePath: string, documentPath: string): string {
    // Get document directory
    const lastSlash = documentPath.lastIndexOf('/');
    const documentDir = lastSlash >= 0 ? documentPath.substring(0, lastSlash) : '';

    // Handle paths that start with ./
    let cleanPath = relativePath.replace(/^\.\//, '');

    // Handle ../ navigation
    const dirParts = documentDir.split('/').filter(Boolean);
    const pathParts = cleanPath.split('/');

    for (const part of pathParts) {
      if (part === '..') {
        dirParts.pop();
      } else if (part !== '.') {
        dirParts.push(part);
      }
    }

    return '/' + dirParts.join('/');
  }

  /**
   * Get the relative path from a document to another file.
   * Computes a proper relative path that can navigate up directories with ../
   */
  getRelativePath(fromDocumentPath: string, toFilePath: string): string {
    // Get document directory
    const lastSlash = fromDocumentPath.lastIndexOf('/');
    const documentDir =
      lastSlash >= 0 ? fromDocumentPath.substring(0, lastSlash) : '';

    // If the file is in the same directory or a subdirectory, calculate relative path
    if (toFilePath.startsWith(documentDir + '/')) {
      return toFilePath.substring(documentDir.length + 1);
    }

    // Need to compute relative path with ../
    const fromParts = documentDir.split('/').filter(Boolean);
    const toParts = toFilePath.split('/').filter(Boolean);

    // Find common prefix
    let commonLength = 0;
    while (
      commonLength < fromParts.length &&
      commonLength < toParts.length - 1 && // -1 because last part of toFilePath is the filename
      fromParts[commonLength] === toParts[commonLength]
    ) {
      commonLength++;
    }

    // Build relative path
    const upCount = fromParts.length - commonLength;
    const upParts = Array(upCount).fill('..');
    const downParts = toParts.slice(commonLength);

    const relativePath = [...upParts, ...downParts].join('/');
    return relativePath || toFilePath.split('/').pop() || toFilePath;
  }

  /**
   * List all mockup files in the workspace.
   * Attempts to determine the correct workspace path by checking:
   * 1. The current document path (to infer worktree workspace - PRIORITY)
   * 2. __workspacePath global
   * 3. Falls back to window's workspace path
   */
  async listMockupFiles(): Promise<MockupFileInfo[]> {
    const electronAPI = (window as any).electronAPI;
    if (!electronAPI) {
      return [];
    }

    try {
      // First try to infer workspace from current document path
      // This handles the worktree case: if editing a file in a worktree,
      // the document path will be like /project_worktrees/branch-name/file.md
      // PRIORITY: Always check document path first, as __workspacePath might be
      // the main project path even when editing in a worktree
      const documentPath = (window as any).__currentDocumentPath;
      let workspacePath = (window as any).__workspacePath;

      if (documentPath) {
        // Check if document is in a _worktrees/ directory
        const worktreeMatch = documentPath.match(/^(.+_worktrees[\\/][^\\/]+)/);
        if (worktreeMatch) {
          workspacePath = worktreeMatch[1];
        }
      }

      const result = await electronAPI.invoke('mockup:list-mockups', workspacePath ? { workspacePath } : undefined);
      return result || [];
    } catch (error) {
      console.error('[MockupPlatformService] Failed to list mockup files:', error);
      return [];
    }
  }

  /**
   * Create a new mockup file.
   */
  async createMockupFile(name: string, directory: string): Promise<string> {
    const electronAPI = (window as any).electronAPI;
    if (!electronAPI) {
      throw new Error('electronAPI not available');
    }

    try {
      const result = await electronAPI.invoke('mockup:create-mockup', name, directory);
      if (!result.success) {
        throw new Error(result.error || 'Failed to create mockup');
      }
      return result.filePath;
    } catch (error) {
      console.error('[MockupPlatformService] Failed to create mockup:', error);
      throw error;
    }
  }

  /**
   * Show the mockup picker UI.
   * This is implemented in registerMockupPlugin.ts which has access to the picker logic.
   */
  showMockupPicker(): void {
    // This method is overridden by registerMockupPlugin
    console.warn('[MockupPlatformService] showMockupPicker not implemented');
  }
}
