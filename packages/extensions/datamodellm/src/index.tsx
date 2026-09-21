/**
 * DatamodelLM Extension
 *
 * A Nimbalyst extension for AI-assisted data modeling with visual
 * entity-relationship diagrams.
 *
 * This extension provides:
 * - A custom editor for .prisma files
 * - Visual canvas with drag-and-drop entities
 * - Crow's foot notation for relationships
 * - AI tools for schema manipulation
 */

import './styles.css';
import type { ExtensionContext } from '@nimbalyst/extension-sdk';
import { DatamodelLMEditor } from './components/DatamodelLMEditor';
import { DataModelCollabContentAdapter } from './collab/DataModelCollabContentAdapter';

export { DataModelCollabContentAdapter };
import { aiTools as datamodelAITools } from './aiTools';

// Export types for consumers
export type {
  Entity,
  Field,
  Relationship,
  Database,
  EntityViewMode,
  DataModelFile,
} from './types';

/**
 * Extension activation
 * Called when the extension is loaded
 */
export async function activate(context: ExtensionContext) {
  context.services.collab.registerContentAdapter(DataModelCollabContentAdapter);
  console.log('[DatamodelLM] Extension activated');

}

/** Extension deactivation. File capture is owned by the host. */
export function deactivate() {}

/**
 * Components exported by this extension
 * These are referenced in the manifest.json
 */
export const components = {
  DatamodelLMEditor,
};

/**
 * AI tools exported by this extension
 * These enable Claude to create and modify data models through conversation.
 */
export const aiTools = datamodelAITools;

// Embedding a data model inside a markdown document is handled by the host's
// editor-neutral embed system: `EmbeddedFileNode` upgrades a paragraph-isolated
// link whose target has a registered custom editor, and `.prisma` qualifies via
// the `customEditors` contribution below. This extension used to ship its own
// Lexical node, markdown transformer, picker menu and `/datamodel` slash
// command to do the same job; they were removed once the neutral path covered
// it. Keeping them meant every consumer of this bundle -- including the browser
// hosts, which register no extension Lexical nodes at all -- paid for a whole
// Lexical dependency graph the ERD canvas never touches.
