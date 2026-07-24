/**
 * Document Header System Exports
 *
 * This module handles document headers that appear at the top of editor content.
 * The tracker document header displays a status bar for plan/decision documents.
 */

import { DocumentHeaderRegistry } from './DocumentHeaderRegistry';
import { TrackerDocumentHeader, shouldRenderTrackerHeader } from './TrackerDocumentHeader';

// Register tracker document header provider at module load time
// This ensures the provider is available before DocumentHeaderContainer queries the registry.
// Note: This registration is also done in the parent TrackerPlugin/index.tsx, but since
// this submodule can be imported directly (via @nimbalyst/runtime/plugins/TrackerPlugin/documentHeader),
// we need to ensure registration happens here as well.
// Only register if not already registered (handles the case where both paths are imported)
if (!DocumentHeaderRegistry.getAllProviders().find(p => p.id === 'tracker-document-header')) {
  DocumentHeaderRegistry.register({
    id: 'tracker-document-header',
    priority: 100,
    shouldRender: shouldRenderTrackerHeader,
    component: TrackerDocumentHeader,
  });
}

// Re-export for consumers
export { DocumentHeaderRegistry };
export type { DocumentHeaderProvider, DocumentHeaderComponentProps } from './DocumentHeaderRegistry';

export { DocumentHeaderContainer } from './DocumentHeaderContainer';
export { TrackerDocumentHeader, shouldRenderTrackerHeader };

export {
  extractFrontmatter,
  detectTrackerFromFrontmatter,
  updateFrontmatter,
  updateTrackerInFrontmatter,
} from './frontmatterUtils';
export type { TrackerFrontmatter } from './frontmatterUtils';
