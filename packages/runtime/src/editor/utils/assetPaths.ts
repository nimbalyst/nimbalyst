/**
 * Utility functions for resolving asset paths in markdown documents
 */

import * as path from 'path';

/**
 * Calculate the relative path from a document to an asset in .nimbalyst/assets/
 *
 * @param documentPath - Absolute path to the markdown document
 * @param workspacePath - Absolute path to the workspace root
 * @param assetHash - Hash of the asset
 * @param assetExtension - File extension of the asset
 * @returns Relative path from document to asset
 *
 * @example
 * // Document at /workspace/plans/feature.md
 * // Workspace at /workspace
 * // Asset at /workspace/.nimbalyst/assets/abc123.png
 * getRelativeAssetPath('/workspace/plans/feature.md', '/workspace', 'abc123', 'png')
 * // Returns: '../.nimbalyst/assets/abc123.png'
 */
export function getRelativeAssetPath(
  documentPath: string,
  workspacePath: string,
  assetHash: string,
  assetExtension: string
): string {
  // Get the directory containing the document
  const documentDir = path.dirname(documentPath);

  // Build the absolute path to the asset
  const assetPath = path.join(workspacePath, '.nimbalyst', 'assets', `${assetHash}.${assetExtension}`);

  // Calculate relative path from document directory to asset
  const relativePath = path.relative(documentDir, assetPath);

  // Normalize path separators for markdown (always use forward slashes)
  return relativePath.split(path.sep).join('/');
}

/**
 * Extract asset hash from a relative asset path
 *
 * @param assetPath - Relative path to asset (e.g., '../.nimbalyst/assets/abc123.png')
 * @returns Asset hash or null if not a valid asset path
 *
 * @example
 * extractAssetHash('../.nimbalyst/assets/abc123.png') // Returns: 'abc123'
 * extractAssetHash('image.png') // Returns: null
 */
export function extractAssetHash(assetPath: string): string | null {
  const match = assetPath.match(/\.nimbalyst\/assets\/([a-f0-9]+)\./);
  return match ? match[1] : null;
}

/**
 * Check if a path is an asset path (points to .nimbalyst/assets/)
 *
 * @param imagePath - Path to check
 * @returns True if path points to .nimbalyst/assets/
 */
export function isAssetPath(imagePath: string): boolean {
  return imagePath.includes('.nimbalyst/assets/');
}

/**
 * Resolve an asset path to an absolute filesystem path
 *
 * @param assetPath - Relative asset path from markdown
 * @param documentPath - Absolute path to the markdown document
 * @returns Absolute filesystem path to the asset
 *
 * @example
 * resolveAssetPath('../.nimbalyst/assets/abc123.png', '/workspace/plans/feature.md')
 * // Returns: '/workspace/.nimbalyst/assets/abc123.png'
 */
export function resolveAssetPath(assetPath: string, documentPath: string): string {
  const documentDir = path.dirname(documentPath);
  return path.resolve(documentDir, assetPath);
}
