/**
 * Extension Editor Bridge
 *
 * Bridges the ExtensionLoader with the CustomEditorRegistry,
 * automatically registering custom editors from loaded extensions.
 */

import { getExtensionLoader, type EditorHostProps } from '@nimbalyst/runtime';
import { customEditorRegistry } from '../components/CustomEditors';
import { logger } from '../utils/logger';

// Track which extension editors have been registered
const registeredExtensionEditors = new Map<string, string[]>();
const registeredEditorComponents = new Map<string, React.ComponentType<EditorHostProps>[]>();

/**
 * Register custom editors from a single extension.
 * Returns the file extensions that were registered.
 */
function registerExtensionEditors(extensionId: string): string[] {
  const loader = getExtensionLoader();
  const manifest = loader.getExtensionManifest(extensionId);
  const editors = loader.getCustomEditors().filter(
    (editor) => editor.extensionId === extensionId,
  );

  if (!manifest || editors.length === 0) {
    return [];
  }

  const registeredExtensions: string[] = [];

  for (const { contribution, component } of editors) {

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
        supportsAI: manifest.permissions?.ai || false,
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
    registeredEditorComponents.delete(extensionId);
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
  const availableEditors = loader.getCustomEditors();

  logger.ui.info(
    `[ExtensionEditorBridge] Syncing ${availableEditors.length} editor contribution(s)`,
  );

  // Includes evaluated extensions and manifest-registered deferred editors.
  const currentIds = new Set(availableEditors.map((editor) => editor.extensionId));

  // Unregister editors from extensions that are no longer loaded
  for (const extensionId of registeredExtensionEditors.keys()) {
    if (!currentIds.has(extensionId)) {
      unregisterExtensionEditors(extensionId);
    }
  }

  // Register editors from newly available manifests/modules.
  for (const extensionId of currentIds) {
    const nextComponents = availableEditors
      .filter(editor => editor.extensionId === extensionId)
      .map(editor => editor.component);
    const previousComponents = registeredEditorComponents.get(extensionId);
    const componentsChanged = !previousComponents
      || previousComponents.length !== nextComponents.length
      || previousComponents.some((component, index) => component !== nextComponents[index]);

    if (componentsChanged) {
      unregisterExtensionEditors(extensionId);
      const extensions = registerExtensionEditors(extensionId);
      if (extensions.length > 0) {
        registeredExtensionEditors.set(extensionId, extensions);
        registeredEditorComponents.set(extensionId, nextComponents);
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
