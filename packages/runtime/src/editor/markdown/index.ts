/**
 * Core markdown transformer aggregation.
 * This module provides both core transformers and a way to aggregate
 * plugin-specific transformers for markdown import/export operations.
 */

import { Transformer } from '@lexical/markdown';

// Core transformers that are always available
import { CORE_TRANSFORMERS } from './core-transformers';

// Extension contributions store -- where built-in extensions and the
// renderer extension bridge publish their markdown transformers.
import { getAllExtensionTransformers } from '../extensions/extensionContributionsStore';

/**
 * Gets the complete set of transformers for the editor, including
 * both core transformers and those contributed by enabled extensions.
 *
 * Order matters - more specific transformers should come before general
 * ones. Extension transformers run first so they can override core
 * behavior.
 *
 * @returns Complete transformer array including both extension and core
 * transformers
 */
export function getEditorTransformers(): Transformer[] {
  return [
    ...getAllExtensionTransformers(),
    ...CORE_TRANSFORMERS,
  ];
}

/**
 * Function to create a transformer set with specific plugins.
 * Useful for creating custom transformer sets outside of the main editor.
 *
 * @param pluginTransformers - Array of transformers from enabled plugins
 * @returns Complete transformer array
 */
export function createTransformers(
  pluginTransformers: Transformer[] = []
): Transformer[] {
  return [
    ...pluginTransformers,
    ...CORE_TRANSFORMERS,
  ];
}

export { MarkdownStreamProcessor, createHeadlessEditorFromEditor, markdownToJSONSync } from './MarkdownStreamProcessor';
export type { InsertMode } from './MarkdownStreamProcessor';

// Enhanced markdown system with frontmatter support
export {
  $convertToEnhancedMarkdownString,
  $convertNodeToEnhancedMarkdownString,
  $convertSelectionToEnhancedMarkdownString,
  type EnhancedExportOptions,
} from './EnhancedMarkdownExport';

export {
  $convertFromEnhancedMarkdownString,
  $updateFrontmatter,
  $mergeFrontmatter,
  $getFrontmatter,
  parseEnhancedMarkdown,
  type EnhancedImportOptions,
  type EnhancedImportResult,
} from './EnhancedMarkdownImport';

export {
  $setFrontmatter,
  parseFrontmatter,
  serializeWithFrontmatter,
  hasFrontmatter,
  isValidFrontmatter,
  type FrontmatterData,
} from './FrontmatterUtils';

// Export markdown configuration functions
export {
  setMarkdownConfig,
  getMarkdownConfig,
  type MarkdownConfig,
} from './MarkdownTransformers';

// Export list-specific configuration functions
export {
  setListConfig,
  getListConfig,
  resetDetectedIndent,
  type ListConfig,
} from './ListTransformers';

// Export markdown normalization functions
export {
  normalizeMarkdown,
  normalizeMarkdownLists,
  detectMarkdownIndentSize,
  type NormalizerConfig,
} from './MarkdownNormalizer';
