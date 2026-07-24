/**
 * Extension Document Header Bridge
 *
 * Bridges the ExtensionLoader with the DocumentHeaderRegistry,
 * automatically registering document headers from loaded extensions.
 * Follows the same pattern as ExtensionEditorBridge.
 */

import { getExtensionLoader, DocumentHeaderRegistry } from '@nimbalyst/runtime';
import { logger } from '../utils/logger';

// Track which extension document headers have been registered
const registeredExtensionHeaders = new Map<string, string[]>();

/**
 * Check if a file path matches any of the given patterns.
 * Supports simple extension patterns ("*.ext") and glob path patterns
 * with wildcards (e.g. path segments with asterisks for single-segment matching).
 */
function matchesFilePatterns(filePath: string, patterns: string[]): boolean {
  const normalizedPath = filePath.replace(/\\/g, '/');
  for (const pattern of patterns) {
    if (pattern.startsWith('*.')) {
      // Simple extension match
      const ext = pattern.slice(1).toLowerCase();
      if (normalizedPath.toLowerCase().endsWith(ext)) {
        return true;
      }
    } else if (pattern.includes('/')) {
      // Glob path pattern - convert to regex
      const regexStr = pattern
        .replace(/[.+^${}()|[\]\\]/g, '\\$&') // Escape regex chars (not * and ?)
        .replace(/\*/g, '[^/]*'); // * matches anything except /
      const regex = new RegExp(`(^|/)${regexStr}$`);
      if (regex.test(normalizedPath)) {
        return true;
      }
    }
  }
  return false;
}

/**
 * Register document headers from a single extension.
 * Returns the IDs of headers that were registered.
 */
function registerExtensionDocumentHeaders(extensionId: string): string[] {
  const loader = getExtensionLoader();
  const extension = loader.getExtension(extensionId);

  if (!extension || !extension.enabled) {
    return [];
  }

  const contributions = extension.manifest.contributions?.documentHeaders || [];
  const components = extension.module.components || {};
  const registeredIds: string[] = [];

  for (const contribution of contributions) {
    const component = components[contribution.component];
    if (!component) {
      console.warn(
        `[ExtensionDocumentHeaderBridge] Extension ${extensionId} declares component '${contribution.component}' but does not export it. Available components: ${Object.keys(components).join(', ')}`
      );
      continue;
    }

    const headerId = `ext:${extensionId}:${contribution.id}`;

    DocumentHeaderRegistry.register({
      id: headerId,
      priority: contribution.priority ?? 50,
      shouldRender: (_content: string, filePath: string) => {
        return matchesFilePatterns(filePath, contribution.filePatterns);
      },
      component: component as React.FC<any>,
    });

    registeredIds.push(headerId);
    console.log(
      `[ExtensionDocumentHeaderBridge] Registered ${contribution.displayName} for ${contribution.filePatterns.join(', ')} (priority=${contribution.priority ?? 50})`
    );
  }

  return registeredIds;
}

/**
 * Unregister document headers from a single extension.
 */
function unregisterExtensionDocumentHeaders(extensionId: string): void {
  const headerIds = registeredExtensionHeaders.get(extensionId);
  if (headerIds && headerIds.length > 0) {
    for (const id of headerIds) {
      DocumentHeaderRegistry.unregister(id);
    }
    registeredExtensionHeaders.delete(extensionId);
    logger.ui.info(
      `[ExtensionDocumentHeaderBridge] Unregistered headers for ${extensionId}`
    );
  }
}

/**
 * Sync all extension document headers with the registry.
 * Registers headers from newly loaded extensions,
 * unregisters headers from unloaded extensions.
 */
export function syncExtensionDocumentHeaders(): void {
  const loader = getExtensionLoader();
  const loadedExtensions = loader.getLoadedExtensions();

  // Get current set of loaded extension IDs
  const currentIds = new Set(loadedExtensions.map((ext) => ext.manifest.id));

  // Unregister headers from extensions that are no longer loaded
  for (const extensionId of registeredExtensionHeaders.keys()) {
    if (!currentIds.has(extensionId)) {
      unregisterExtensionDocumentHeaders(extensionId);
    }
  }

  // Register headers from newly loaded extensions
  for (const extension of loadedExtensions) {
    if (!extension.enabled) {
      unregisterExtensionDocumentHeaders(extension.manifest.id);
      continue;
    }

    if (!registeredExtensionHeaders.has(extension.manifest.id)) {
      const ids = registerExtensionDocumentHeaders(extension.manifest.id);
      if (ids.length > 0) {
        registeredExtensionHeaders.set(extension.manifest.id, ids);
      }
    }
  }
}

/**
 * Initialize the extension document header bridge.
 * Call this after the extension system is initialized.
 */
export function initializeExtensionDocumentHeaderBridge(): void {
  const loader = getExtensionLoader();

  // Initial sync
  syncExtensionDocumentHeaders();

  // Subscribe to changes
  loader.subscribe(() => {
    syncExtensionDocumentHeaders();
  });

  logger.ui.info('[ExtensionDocumentHeaderBridge] Initialized');
}
