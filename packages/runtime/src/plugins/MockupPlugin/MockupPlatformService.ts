/**
 * MockupPlatformService Interface
 *
 * Defines the platform-specific operations needed by the MockupPlugin.
 * Each platform (Electron, Capacitor) provides its own implementation.
 */

export interface MockupFileInfo {
  /** Absolute path to the mockup file */
  absolutePath: string;
  /** Relative path from workspace root */
  relativePath: string;
  /** Display name (filename without extension) */
  name: string;
}

export interface MockupPickerResult {
  /** 'new' to create a new mockup, 'existing' to link an existing one, null if cancelled */
  action: 'new' | 'existing';
  /** For 'existing': the selected mockup's absolute path */
  mockupPath?: string;
  /** For 'new': the name for the new mockup */
  newName?: string;
}

export interface MockupPlatformService {
  /**
   * Capture a screenshot of a mockup file and save it to the specified output path.
   * @param mockupPath - Absolute path to the .mockup.html file
   * @param outputPath - Absolute path where the screenshot should be saved
   * @returns Promise that resolves when the screenshot is saved
   */
  captureScreenshot(mockupPath: string, outputPath: string): Promise<void>;

  /**
   * Open the mockup file in the appropriate editor.
   * @param mockupPath - Absolute path to the .mockup.html file
   */
  openMockupEditor(mockupPath: string): void;

  /**
   * Get the last modified time of a file.
   * @param filePath - Absolute path to the file
   * @returns Promise that resolves to the modification time in milliseconds since epoch
   */
  getFileModifiedTime(filePath: string): Promise<number>;

  /**
   * Check if a file exists.
   * @param filePath - Absolute path to the file
   * @returns Promise that resolves to true if the file exists
   */
  fileExists(filePath: string): Promise<boolean>;

  /**
   * Resolve a relative path to an absolute path based on the current document.
   * @param relativePath - Relative path (e.g., "assets/screenshot.png")
   * @param documentPath - Absolute path to the current document
   * @returns Absolute path
   */
  resolveRelativePath(relativePath: string, documentPath: string): string;

  /**
   * Get the relative path from a document to another file.
   * @param fromDocumentPath - Absolute path to the document
   * @param toFilePath - Absolute path to the target file
   * @returns Relative path from document directory to target file
   */
  getRelativePath(fromDocumentPath: string, toFilePath: string): string;

  /**
   * List all mockup files in the workspace.
   * @returns Promise that resolves to an array of mockup file info
   */
  listMockupFiles(): Promise<MockupFileInfo[]>;

  /**
   * Create a new mockup file.
   * @param name - Name for the mockup (without extension)
   * @param directory - Directory to create the file in (absolute path)
   * @returns Promise that resolves to the absolute path of the created file
   */
  createMockupFile(name: string, directory: string): Promise<string>;

  /**
   * Show the mockup picker UI for selecting new or existing mockup.
   * Called when INSERT_MOCKUP_COMMAND is dispatched without a payload.
   * The picker should dispatch INSERT_MOCKUP_COMMAND with proper payload when user selects.
   */
  showMockupPicker(): void;
}

// Global service instance - set by the platform
let mockupPlatformService: MockupPlatformService | null = null;

/**
 * Set the platform-specific MockupPlatformService implementation.
 * Should be called once during app initialization by the platform layer.
 */
export function setMockupPlatformService(service: MockupPlatformService): void {
  mockupPlatformService = service;
}

/**
 * Get the current MockupPlatformService implementation.
 * Throws if the service hasn't been initialized.
 */
export function getMockupPlatformService(): MockupPlatformService {
  if (!mockupPlatformService) {
    throw new Error(
      'MockupPlatformService not initialized. Call setMockupPlatformService first.',
    );
  }
  return mockupPlatformService;
}

/**
 * Check if the MockupPlatformService has been initialized.
 */
export function hasMockupPlatformService(): boolean {
  return mockupPlatformService !== null;
}
