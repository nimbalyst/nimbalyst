/**
 * Extension Editor Bridge
 *
 * Bridges the ExtensionLoader with the CustomEditorRegistry,
 * automatically registering custom editors from loaded extensions.
 */

import { getExtensionLoader } from '@nimbalyst/runtime';
import { customEditorRegistry } from '../components/CustomEditors';
import { logger } from '../utils/logger';

// Track which extension editors have been registered
const registeredExtensionEditors = new Map<string, string[]>();

/**
 * Register custom editors from a single extension.
 * Returns the file extensions that were registered.
 */
function registerExtensionEditors(extensionId: string): string[] {
  const loader = getExtensionLoader();
  const extension = loader.getExtension(extensionId);

  if (!extension || !extension.enabled) {
    return [];
  }

  const contributions = extension.manifest.contributions?.customEditors || [];
  const components = extension.module.components || {};
  const registeredExtensions: string[] = [];

  for (const contribution of contributions) {
    const component = components[contribution.component];
    if (!component) {
      console.warn(
        `[ExtensionEditorBridge] Extension ${extensionId} declares component '${contribution.component}' but does not export it. Available components: ${Object.keys(components).join(', ')}`
      );
      continue;
    }

    // Convert file patterns to extensions
    const extensions: string[] = [];
    for (const pattern of contribution.filePatterns) {
      // Handle patterns like "*.datamodel" -> ".datamodel"
      if (pattern.startsWith('*.')) {
        extensions.push(pattern.slice(1)); // Remove the '*'
      } else {
        extensions.push(pattern);
      }
    }

    if (extensions.length > 0) {
      // Register with the CustomEditorRegistry
      customEditorRegistry.register({
        extensions,
        component: component as React.FC<any>,
        name: contribution.displayName,
        supportsAI: extension.manifest.permissions?.ai || false,
        supportsSourceMode: contribution.supportsSourceMode || false,
        supportsDiffMode: contribution.supportsDiffMode,
        showDocumentHeader: contribution.showDocumentHeader,
        supportsTranscriptEmbed: contribution.supportsTranscriptEmbed || false,
        transcriptEmbedHeight: contribution.transcriptEmbedHeight,
        extensionId: extensionId,
        componentName: contribution.component,
        collaboration: contribution.collaboration,
      });

      registeredExtensions.push(...extensions);
      // console.log(
      //   `[ExtensionEditorBridge] Registered ${contribution.displayName} for ${extensions.join(', ')} (sourceMode=${contribution.supportsSourceMode || false})`
      // );
    }
  }

  return registeredExtensions;
}

/**
 * Unregister custom editors from a single extension.
 */
function unregisterExtensionEditors(extensionId: string): void {
  const extensions = registeredExtensionEditors.get(extensionId);
  if (extensions && extensions.length > 0) {
    customEditorRegistry.unregister(extensions);
    registeredExtensionEditors.delete(extensionId);
    logger.ui.info(
      `[ExtensionEditorBridge] Unregistered editors for ${extensionId}`
    );
  }
}

/**
 * Sync all extension editors with the registry.
 * Registers editors from newly loaded extensions,
 * unregisters editors from unloaded extensions.
 */
export function syncExtensionEditors(): void {
  const loader = getExtensionLoader();
  const loadedExtensions = loader.getLoadedExtensions();

  logger.ui.info(`[ExtensionEditorBridge] Syncing ${loadedExtensions.length} loaded extension(s)`);
  for (const ext of loadedExtensions) {
    logger.ui.info(`[ExtensionEditorBridge] - ${ext.manifest.id}: enabled=${ext.enabled}, components=${Object.keys(ext.module.components || {}).join(', ')}`);
  }

  // Get current set of loaded extension IDs
  const currentIds = new Set(loadedExtensions.map((ext) => ext.manifest.id));

  // Unregister editors from extensions that are no longer loaded
  for (const extensionId of registeredExtensionEditors.keys()) {
    if (!currentIds.has(extensionId)) {
      unregisterExtensionEditors(extensionId);
    }
  }

  // Register editors from newly loaded extensions
  for (const extension of loadedExtensions) {
    if (!extension.enabled) {
      // If disabled, unregister any editors it had
      unregisterExtensionEditors(extension.manifest.id);
      continue;
    }

    if (!registeredExtensionEditors.has(extension.manifest.id)) {
      const extensions = registerExtensionEditors(extension.manifest.id);
      if (extensions.length > 0) {
        registeredExtensionEditors.set(extension.manifest.id, extensions);
      }
    }
  }
}

/**
 * Initialize the extension editor bridge.
 * Call this after the extension system is initialized.
 */
export function initializeExtensionEditorBridge(): void {
  const loader = getExtensionLoader();

  // Initial sync
  syncExtensionEditors();

  // Subscribe to changes
  loader.subscribe(() => {
    syncExtensionEditors();
  });

  logger.ui.info('[ExtensionEditorBridge] Initialized');
}
