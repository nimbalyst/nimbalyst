/**
 * Tracks file types that have custom editors registered via extensions.
 * This allows the main process to know which file types can be opened
 * even if they're in the EXCLUDED_EXTENSIONS list.
 */

const registeredFileExtensions = new Set<string>();

/**
 * Register a file extension as having a custom editor.
 * Should be called when extensions are discovered.
 */
export function registerFileExtension(extension: string): void {
  // Normalize to lowercase with leading dot
  const normalized = extension.toLowerCase().startsWith('.')
    ? extension.toLowerCase()
    : `.${extension.toLowerCase()}`;

  registeredFileExtensions.add(normalized);
}

/**
 * Check if a file extension has a custom editor registered.
 */
export function hasCustomEditor(filePath: string): boolean {
  const ext = filePath.substring(filePath.lastIndexOf('.')).toLowerCase();
  return registeredFileExtensions.has(ext);
}

/**
 * Get all registered file extensions.
 */
export function getRegisteredExtensions(): Set<string> {
  return new Set(registeredFileExtensions);
}

/**
 * Clear all registered extensions (useful for tests or reload).
 */
export function clearRegisteredExtensions(): void {
  registeredFileExtensions.clear();
}
