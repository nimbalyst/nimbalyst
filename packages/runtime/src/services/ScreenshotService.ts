/**
 * Screenshot Service
 *
 * A generic service for capturing screenshots of rendered content.
 * Extensions register their screenshot capture capabilities here,
 * and the service routes capture requests to the appropriate handler.
 *
 * This is platform-agnostic - the actual capture implementation
 * is provided by the extension or platform service.
 */

export interface ScreenshotCapability {
  /**
   * Unique identifier for this capability (e.g., 'datamodel', 'mockup')
   */
  id: string;

  /**
   * File extensions this capability handles (e.g., ['.prisma'], ['.mockup.html'])
   */
  fileExtensions: string[];

  /**
   * Capture a screenshot of the file.
   * Returns base64-encoded PNG data.
   */
  capture: (filePath: string) => Promise<string>;
}

class ScreenshotServiceImpl {
  private capabilities = new Map<string, ScreenshotCapability>();
  private extensionsByFileType = new Map<string, string>(); // extension -> capability id

  /**
   * Register a screenshot capability.
   * Called by extensions during activation.
   */
  register(capability: ScreenshotCapability): void {
    this.capabilities.set(capability.id, capability);

    // Map file extensions to this capability
    for (const ext of capability.fileExtensions) {
      this.extensionsByFileType.set(ext.toLowerCase(), capability.id);
    }

    console.log(
      `[ScreenshotService] Registered capability '${capability.id}' for extensions: ${capability.fileExtensions.join(', ')}`
    );
  }

  /**
   * Unregister a screenshot capability.
   * Called by extensions during deactivation.
   */
  unregister(capabilityId: string): void {
    const capability = this.capabilities.get(capabilityId);
    if (capability) {
      // Remove file extension mappings
      for (const ext of capability.fileExtensions) {
        if (this.extensionsByFileType.get(ext.toLowerCase()) === capabilityId) {
          this.extensionsByFileType.delete(ext.toLowerCase());
        }
      }
      this.capabilities.delete(capabilityId);
      console.log(`[ScreenshotService] Unregistered capability '${capabilityId}'`);
    }
  }

  /**
   * Check if we can capture screenshots for a file type.
   */
  canCapture(filePath: string): boolean {
    const capability = this.findCapability(filePath);
    return capability !== null;
  }

  /**
   * Capture a screenshot of a file.
   * Routes to the appropriate capability based on file extension.
   */
  async capture(filePath: string): Promise<string> {
    const capability = this.findCapability(filePath);
    if (!capability) {
      throw new Error(`No screenshot capability registered for file: ${filePath}`);
    }

    console.log(`[ScreenshotService] Capturing ${filePath} using '${capability.id}'`);
    return capability.capture(filePath);
  }

  /**
   * Find the capability that handles a file path.
   */
  private findCapability(filePath: string): ScreenshotCapability | null {
    const lowerPath = filePath.toLowerCase();

    // Check each registered extension (longest match first for compound extensions like .mockup.html)
    const extensions = Array.from(this.extensionsByFileType.keys()).sort(
      (a, b) => b.length - a.length
    );

    for (const ext of extensions) {
      if (lowerPath.endsWith(ext)) {
        const capabilityId = this.extensionsByFileType.get(ext);
        if (capabilityId) {
          return this.capabilities.get(capabilityId) || null;
        }
      }
    }

    return null;
  }

  /**
   * Get all registered capabilities.
   */
  getCapabilities(): ScreenshotCapability[] {
    return Array.from(this.capabilities.values());
  }
}

// Singleton instance
export const screenshotService = new ScreenshotServiceImpl();
