/**
 * Electron implementation of DataModelPlatformService.
 *
 * This implementation runs in the renderer process and uses IPC
 * to communicate with the main process for file operations.
 */

// Define types locally to avoid circular dependencies with extension
// These mirror the types in the datamodellm extension
export interface DataModelFileInfo {
  absolutePath: string;
  relativePath: string;
  name: string;
}

export interface DataModelPlatformService {
  captureScreenshot(dataModelPath: string, outputPath: string): Promise<void>;
  openDataModelEditor(dataModelPath: string): void;
  getFileModifiedTime(filePath: string): Promise<number>;
  fileExists(filePath: string): Promise<boolean>;
  resolveRelativePath(relativePath: string, documentPath: string): string;
  getRelativePath(fromDocumentPath: string, toFilePath: string): string;
  listDataModelFiles(): Promise<DataModelFileInfo[]>;
  createDataModelFile(name: string, directory: string): Promise<string>;
  showDataModelPicker(): void;
}

export class DataModelPlatformServiceImpl implements DataModelPlatformService {
  private static instance: DataModelPlatformServiceImpl | null = null;

  private constructor() {}

  public static getInstance(): DataModelPlatformServiceImpl {
    if (!DataModelPlatformServiceImpl.instance) {
      DataModelPlatformServiceImpl.instance = new DataModelPlatformServiceImpl();
    }
    return DataModelPlatformServiceImpl.instance;
  }

  /**
   * Capture a screenshot of a data model and save it to the output path.
   */
  async captureScreenshot(
    dataModelPath: string,
    outputPath: string,
  ): Promise<void> {
    const electronAPI = (window as any).electronAPI;
    if (!electronAPI) {
      throw new Error('electronAPI not available');
    }

    try {
      // Use the data model-specific IPC handler to capture and save
      const result = await electronAPI.invoke(
        'datamodel:capture-and-save-screenshot',
        dataModelPath,
        outputPath,
      );

      if (!result.success) {
        throw new Error(result.error || 'Failed to capture screenshot');
      }
    } catch (error) {
      console.error('[DataModelPlatformService] Failed to capture screenshot:', error);
      throw error;
    }
  }

  /**
   * Open the data model file in the editor.
   */
  openDataModelEditor(dataModelPath: string): void {
    const electronAPI = (window as any).electronAPI;
    if (!electronAPI) {
      console.error('[DataModelPlatformService] electronAPI not available');
      return;
    }

    // workspacePath is REQUIRED - cannot route file open without it
    const workspacePath = (window as any).__workspacePath;
    if (!workspacePath) {
      console.error('[DataModelPlatformService] __workspacePath not set - cannot open data model');
      return;
    }

    // Use workspace:open-file which sends open-document event to trigger
    // handleWorkspaceFileSelect in the renderer
    electronAPI.invoke('workspace:open-file', {
      workspacePath,
      filePath: dataModelPath,
    }).catch((error: Error) => {
      console.error('[DataModelPlatformService] Failed to open data model:', error);
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
      console.error('[DataModelPlatformService] Failed to get file modified time:', error);
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
      console.error('[DataModelPlatformService] Failed to check file existence:', error);
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
   * List all data model files in the workspace.
   */
  async listDataModelFiles(): Promise<DataModelFileInfo[]> {
    const electronAPI = (window as any).electronAPI;
    if (!electronAPI) {
      return [];
    }

    try {
      const result = await electronAPI.invoke('datamodel:list-datamodels');
      return result || [];
    } catch (error) {
      console.error('[DataModelPlatformService] Failed to list data model files:', error);
      return [];
    }
  }

  /**
   * Create a new data model file.
   */
  async createDataModelFile(name: string, directory: string): Promise<string> {
    const electronAPI = (window as any).electronAPI;
    if (!electronAPI) {
      throw new Error('electronAPI not available');
    }

    try {
      const result = await electronAPI.invoke('datamodel:create-datamodel', name, directory);
      if (!result.success) {
        throw new Error(result.error || 'Failed to create data model');
      }
      return result.filePath;
    } catch (error) {
      console.error('[DataModelPlatformService] Failed to create data model:', error);
      throw error;
    }
  }

  /**
   * Show the data model picker UI.
   * This is implemented by the extension which has access to the picker logic.
   */
  showDataModelPicker(): void {
    // This method is overridden when the extension is initialized
    console.warn('[DataModelPlatformService] showDataModelPicker not implemented');
  }
}
