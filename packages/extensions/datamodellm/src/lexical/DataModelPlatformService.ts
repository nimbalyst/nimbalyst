/**
 * DataModelPlatformService - Platform abstraction for data model operations.
 *
 * This interface allows the DataModel plugin to work across different platforms
 * (Electron, Capacitor) by abstracting platform-specific operations.
 */

export interface DataModelFileInfo {
  /** Absolute path to the data model file */
  absolutePath: string;
  /** Path relative to workspace root */
  relativePath: string;
  /** File name without path */
  name: string;
}

export interface DataModelPlatformService {
  /**
   * Capture a screenshot of a data model and save it to a file.
   * @param dataModelPath - Absolute path to the .prisma file
   * @param outputPath - Absolute path where screenshot should be saved
   */
  captureScreenshot(dataModelPath: string, outputPath: string): Promise<void>;

  /**
   * Open a data model file in the editor.
   * @param dataModelPath - Absolute path to the .prisma file
   */
  openDataModelEditor(dataModelPath: string): void;

  /**
   * Get the modification time of a file.
   * @param filePath - Absolute path to the file
   * @returns Modification time in milliseconds since epoch
   */
  getFileModifiedTime(filePath: string): Promise<number>;

  /**
   * Check if a file exists.
   * @param filePath - Absolute path to the file
   * @returns True if file exists
   */
  fileExists(filePath: string): Promise<boolean>;

  /**
   * Resolve a relative path from a document to an absolute path.
   * @param relativePath - Relative path (e.g., "assets/model.prisma.png")
   * @param documentPath - Absolute path to the document
   * @returns Absolute path
   */
  resolveRelativePath(relativePath: string, documentPath: string): string;

  /**
   * Get the relative path from one file to another.
   * @param fromDocumentPath - Absolute path to the source document
   * @param toFilePath - Absolute path to the target file
   * @returns Relative path from document directory to target file
   */
  getRelativePath(fromDocumentPath: string, toFilePath: string): string;

  /**
   * List all data model files in the workspace.
   * @returns Array of data model file info
   */
  listDataModelFiles(): Promise<DataModelFileInfo[]>;

  /**
   * Create a new data model file with default content.
   * @param name - Name for the new file (without extension)
   * @param directory - Directory to create the file in
   * @returns Absolute path to the created file
   */
  createDataModelFile(name: string, directory: string): Promise<string>;

  /**
   * Show the data model picker UI.
   * Called when INSERT_DATAMODEL_COMMAND is dispatched without payload.
   */
  showDataModelPicker(): void;
}

// Global instance holder
let platformService: DataModelPlatformService | null = null;

/**
 * Set the global DataModelPlatformService instance.
 * Should be called once during platform initialization.
 */
export function setDataModelPlatformService(service: DataModelPlatformService): void {
  platformService = service;
}

/**
 * Get the global DataModelPlatformService instance.
 * @throws Error if service has not been set
 */
export function getDataModelPlatformService(): DataModelPlatformService {
  if (!platformService) {
    throw new Error(
      'DataModelPlatformService has not been initialized. ' +
        'Call setDataModelPlatformService() first.'
    );
  }
  return platformService;
}

/**
 * Check if DataModelPlatformService has been initialized.
 */
export function hasDataModelPlatformService(): boolean {
  return platformService !== null;
}
