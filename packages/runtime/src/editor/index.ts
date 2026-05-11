/**
 * Nimbalyst - Main library entry point
 *
 * A rich text editor built with Meta's Lexical framework, featuring markdown support,
 * tables, and comprehensive editing capabilities.
 */

// Import main CSS styles
import './index.css';

// Register built-in plugins (must be done before any editor initialization)
import { registerBuiltinPlugins } from './plugins/registerBuiltinPlugins';
registerBuiltinPlugins();

// Main editor components
export { NimbalystEditor, type NimbalystEditorProps } from './NimbalystEditor';
export { default as Editor } from './Editor';

// Configuration
export {
  type EditorConfig,
  type UploadedEditorAsset,
  DEFAULT_EDITOR_CONFIG,
  type Theme as ConfigTheme,
} from './EditorConfig';

// Hooks
export { useFlashMessage } from './hooks/useFlashMessage';
export { useModal } from './hooks/useModal';
export { useIsEditorActive } from './hooks/useIsEditorActive';

// Context providers - for advanced usage
export { ThemeProvider, useTheme, type Theme, type ThemeConfig } from './context/ThemeContext';
export { FlashMessageContext } from './context/FlashMessageContext';
export { SharedHistoryContext } from './context/SharedHistoryContext';
export { TableContext } from './plugins/TablePlugin/TablePlugin';
export { ToolbarContext } from './context/ToolbarContext';
export { RuntimeSettingsProvider, useRuntimeSettings } from './context/RuntimeSettingsContext';

// Themes
export { default as NimbalystEditorTheme } from './themes/NimbalystEditorTheme';
export { PRINT_STYLESHEET, wrapWithPrintStyles } from './themes/PrintTheme';

// Unified Theme System Types
export type {
  ThemeId,
  BuiltInThemeId,
  ThemeColors,
  ExtendedThemeColors,
  Theme as NimbalystTheme,
  // ThemeContribution is exported from runtime's extensions/types.ts
  ThemeChangeEvent,
} from './themes/types';
export { isBuiltInTheme, getThemeExtensionId } from './themes/types';

// Theme Registry
export {
  getTheme,
  getAllThemes,
  getBuiltInThemes,
  getExtensionThemes,
  getBaseThemeColors,
  registerTheme,
  registerThemeContribution,
  getActiveThemeId,
  getActiveTheme,
  setActiveTheme,
  onThemesChanged,
  onActiveThemeChanged,
  hasTheme,
  getThemeColor,
} from './themes/registry';

// Node types - for advanced customization
export { default as EditorNodes } from './nodes/EditorNodes';

// Re-export key Lexical types that consumers might need
export type {
  LexicalEditor,
  EditorState,
  LexicalNode,
  ElementNode,
  TextNode,
  LexicalCommand,
} from 'lexical';

export type {
  InitialConfigType,
} from '@lexical/react/LexicalComposer';

// Plugin system exports
export type { PluginPackage, DynamicMenuOption, UserCommand } from './types/PluginTypes';
export { pluginRegistry } from './plugins/PluginRegistry';
export { PluginManager } from './plugins/PluginManager';

// Lexical-extension contributions from Nimbalyst extensions (Phase 7.6).
// The electron-side bridge writes here; `NimbalystEditor` reads from here
// and includes the contributions in the editor's extension graph.
export {
  setExtensionLexicalExtensions,
  getExtensionLexicalExtensions,
  useExtensionLexicalExtensions,
} from './extensions/extensionLexicalExtensionsStore';

// Markdown utilities. Always go through `$convertFromEnhancedMarkdownString` /
// `$convertToEnhancedMarkdownString` so frontmatter extraction, list-indent
// normalization, and the NCR-based literal-emphasis encoding stay applied.
// Calling upstream's `$convertFromMarkdownString` directly skips those steps.
export {
  MarkdownStreamProcessor,
  createHeadlessEditorFromEditor,
  markdownToJSONSync,
  type InsertMode,
  getEditorTransformers, // Gets complete set of transformers (core + plugin)
  $convertToEnhancedMarkdownString,
  $convertNodeToEnhancedMarkdownString,
  $convertSelectionToEnhancedMarkdownString
} from './markdown';

// Markdown normalization utilities
export {
  detectMarkdownIndentSize,
  normalizeMarkdown,
  normalizeMarkdownLists,
  type NormalizerConfig
} from './markdown/MarkdownNormalizer';

// Frontmatter utilities
export {
  $getFrontmatter,
  $setFrontmatter,
  parseFrontmatter,
  serializeWithFrontmatter,
  hasFrontmatter,
  isValidFrontmatter,
  type FrontmatterData
} from './markdown/FrontmatterUtils';

// Tracker type helpers
export {
  applyTrackerTypeToMarkdown,
  removeTrackerTypeFromMarkdown,
  getCurrentTrackerTypeFromMarkdown,
  getDefaultFrontmatterForType,
  getModelDefaults,
  getBuiltInFullDocumentTrackerTypes,
  type TrackerTypeInfo,
} from './plugins/FloatingDocumentActionsPlugin/TrackerTypeHelper';

// Additional frontmatter utilities from EnhancedMarkdownImport
export {
  $mergeFrontmatter,
  $updateFrontmatter,
  $convertFromEnhancedMarkdownString
} from './markdown/EnhancedMarkdownImport';

// Markdown copy extension - Cmd+Shift+C to copy as markdown (Phase 7.3
// headless extension; previously a React-mounted plugin).
export { COPY_AS_MARKDOWN_COMMAND } from './extensions/builtin/MarkdownCopyExtension';

// Diff plugin and hook
export { DiffPlugin, useDiffCommands, APPLY_MARKDOWN_REPLACE_COMMAND, LiveNodeKeyState } from './plugins/DiffPlugin';

// Diff utilities (now from local plugin)
export {
  applyMarkdownReplace,
  $approveDiffs,
  $rejectDiffs,
  $hasDiffNodes,
  $setDiffState,
  groupDiffChanges,
  scrollToChangeGroup,
  $approveChangeGroup,
  $rejectChangeGroup,
  $getDiffState,
  APPROVE_DIFF_COMMAND,
  REJECT_DIFF_COMMAND,
  CLEAR_DIFF_TAG_COMMAND,
  INCREMENTAL_APPROVAL_COMMAND,
  generateUnifiedDiff,
  type TextReplacement,
  type TextReplacementInput
} from './plugins/DiffPlugin/core/exports';
export type { DiffChangeGroup } from './plugins/DiffPlugin/core/exports';

// Anchor context for floating UI consumers
export { AnchorProvider, AnchorContext, useAnchorElem } from './context/AnchorContext';

// Frontmatter context for plugins that need frontmatter access
export { FrontmatterProvider, useFrontmatterUtils, type FrontmatterUtils } from './context/FrontmatterContext';

// Typeahead components
export { TypeaheadMenuPlugin } from './plugins/TypeaheadPlugin/TypeaheadMenuPlugin';
export type { TypeaheadMenuOption } from './plugins/TypeaheadPlugin/TypeaheadMenu';
