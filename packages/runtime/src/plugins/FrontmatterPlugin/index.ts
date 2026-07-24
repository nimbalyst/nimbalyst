/**
 * FrontmatterPlugin - Renders generic YAML frontmatter as editable fields
 *
 * This plugin registers a document header provider with lower priority than
 * TrackerDocumentHeader (50 vs 100), so tracker documents still get their
 * specialized UI while all other frontmatter gets a generic editable view.
 */

import { DocumentHeaderRegistry } from '../TrackerPlugin/documentHeader/DocumentHeaderRegistry';
import {
  GenericFrontmatterHeader,
  shouldRenderGenericFrontmatter,
} from './GenericFrontmatterHeader';

// Register document header provider at module load time
// Priority 50 is lower than TrackerDocumentHeader (100), so tracker documents
// won't match this provider (they'll be handled by the tracker-specific UI)
DocumentHeaderRegistry.register({
  id: 'generic-frontmatter-header',
  priority: 50,
  shouldRender: shouldRenderGenericFrontmatter,
  component: GenericFrontmatterHeader,
});

// Re-export utilities for external use
export { GenericFrontmatterHeader, shouldRenderGenericFrontmatter } from './GenericFrontmatterHeader';
export {
  extractFrontmatter,
  extractFrontmatterWithError,
  parseFields,
  inferFieldType,
  updateFieldInFrontmatter,
  hasGenericFrontmatter,
  type InferredField,
  type InferredFieldType,
  type FrontmatterParseResult,
} from './fieldUtils';
