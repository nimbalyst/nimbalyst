/**
 * Excalidraw Extension
 *
 * A Nimbalyst extension for AI-assisted diagram editing with Excalidraw.
 *
 * This extension provides:
 * - A custom editor for .excalidraw files
 * - AI tools for creating and manipulating diagrams
 * - Layout engine for automatic positioning
 * - Lexical integration for embedding diagrams in documents
 */

import './styles.css';
import type { ExtensionContext } from '@nimbalyst/extension-sdk';
import { ExcalidrawEditor } from './components/ExcalidrawEditor';
import { aiTools as excalidrawAITools } from './aiTools';
import { ExcalidrawCollabContentAdapter } from './collab/ExcalidrawCollabContentAdapter';

export { ExcalidrawCollabContentAdapter };

// Export types for consumers
export type {
  ExcalidrawFile,
  ElementType,
  LayoutAlgorithm,
  LabeledElement,
  GroupInfo,
  LayoutOptions,
} from './types';

/**
 * Extension activation
 * Called when the extension is loaded
 */
export async function activate(context: ExtensionContext) {
  context.services.collab.registerContentAdapter(ExcalidrawCollabContentAdapter);
  console.log('[Excalidraw] Extension activated');

  // TODO: Register screenshot capability when screenshot service is available
  // This will allow AI tools to capture diagram screenshots
}

/**
 * Extension deactivation
 * Called when the extension is unloaded
 */
export async function deactivate() {
  console.log('[Excalidraw] Extension deactivated');
}

/**
 * Components exported by this extension
 * These are referenced in the manifest.json
 */
export const components = {
  ExcalidrawEditor,
};

/**
 * AI tools exported by this extension
 * These enable Claude to create and modify diagrams through conversation.
 */
export const aiTools = excalidrawAITools;

// TODO: Implement Lexical integration
// export const nodes = {
//   ExcalidrawNode,
// };

// export const transformers = {
//   EXCALIDRAW_TRANSFORMER,
// };
