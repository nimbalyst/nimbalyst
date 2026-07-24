/**
 * File system utilities for the main process.
 */

import { readdirSync } from 'fs';
import { join, relative } from 'path';

export interface GetAllFilesOptions {
  /**
   * Base path to make paths relative to.
   * If provided, returned paths will be relative to this path.
   * If not provided, returned paths will be absolute.
   */
  basePath?: string;
  /**
   * If true, normalize path separators to forward slashes.
   * Useful for git compatibility on Windows.
   * Default: false
   */
  normalizeSlashes?: boolean;
}

/**
 * Recursively get all files within a directory.
 * Used to expand directories into individual file paths.
 *
 * @param dirPath Absolute path to the directory
 * @param options Options for path handling
 * @returns Array of file paths within the directory
 */
export function getAllFilesInDirectory(dirPath: string, options: GetAllFilesOptions = {}): string[] {
  const files: string[] = [];

  try {
    const entries = readdirSync(dirPath, { withFileTypes: true });

    for (const entry of entries) {
      const fullPath = join(dirPath, entry.name);

      if (entry.isDirectory()) {
        // Recursively get files from subdirectories
        files.push(...getAllFilesInDirectory(fullPath, options));
      } else if (entry.isFile()) {
        let resultPath: string;

        if (options.basePath) {
          // Return relative path from base
          resultPath = relative(options.basePath, fullPath);
        } else {
          // Return absolute path
          resultPath = fullPath;
        }

        // Normalize slashes if requested (for git compatibility)
        if (options.normalizeSlashes) {
          resultPath = resultPath.replace(/\\/g, '/');
        }

        files.push(resultPath);
      }
    }
  } catch (error) {
    // If we can't read the directory, skip it
    // Log at debug level since this can happen for permission issues on normal directories
    console.error('[fileUtils] Error reading directory:', dirPath, error);
  }

  return files;
}
