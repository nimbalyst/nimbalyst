/**
 * Nimbalyst - Main library entry point
 *
 * A rich text editor built with Meta's Lexical framework, featuring markdown support,
 * tables, and comprehensive editing capabilities.
 */

// Import main CSS styles
import './index.css';

// Side-effect: registers built-in extension contributions (markdown
// transformers, slash-picker entries) into the extension contributions
// store. Must run before any caller invokes `getEditorTransformers()` or
// mounts an editor.
import './extensions/registerBuiltinExtensions';

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

// Document comments configuration types
export type {
  CommentsConfig,
  CommentMember,
  CommentMentionPayload,
} from './commenting/types';

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
  MonacoThemeContribution,
  MonacoTokenRule,
  MonacoBaseTheme,
} from './themes/types';
export { MONACO_BASE_THEMES } from './themes/types';
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
  getThemesWithMonacoDefinition,
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

// Extension contributions: slash-picker entries and dynamic option types
// formerly carried by the legacy `PluginPackage` shape.
export type { DynamicMenuOption, UserCommand } from './types/PluginTypes';

// Extension contribution stores (transformers + slash-picker entries).
// Renderer-side extension bridges write here; the editor reads through
// the contribution hooks.
export {
  setExtensionContributions,
  clearExtensionContributions,
  getAllExtensionUserCommands,
  getAllExtensionTransformers,
  getAllExtensionDynamicOptions,
  subscribeToExtensionContributions,
  useExtensionUserCommands,
  type EditorExtensionContributions,
} from './extensions/extensionContributionsStore';

// Lexical-extension contributions from Nimbalyst extensions. The
// electron-side bridge writes here; `NimbalystEditor` reads from here
// and includes the contributions in the editor's extension graph.
export {
  setExtensionLexicalExtension,
  setExtensionLexicalExtensions,
  getExtensionLexicalExtensions,
  useExtensionLexicalExtensions,
} from './extensions/extensionLexicalExtensionsStore';

// React component slot for renderer-contributed Lexical plugins (UI
// surfaces that need to live inside `<LexicalExtensionComposer>`, like
// the document-link typeahead or the tracker popovers).
export {
  registerExtensionEditorComponent,
  unregisterExtensionEditorComponent,
  useExtensionEditorComponents,
  type ExtensionEditorComponentEntry,
} from './extensions/extensionEditorComponentsStore';

// Markdown utilities. Always go through `$convertFromEnhancedMarkdownString` /
// `$convertToEnhancedMarkdownString` so frontmatter extraction, list-indent
// normalization, and the NCR-based literal-emphasis encoding stay applied.
// Calling upstream's `$convertFromMarkdownString` directly skips those steps.
export {
  MarkdownStreamProcessor,
  createHeadlessEditorFromEditor,
  markdownToJSONSync,
  type InsertMode,
  getEditorTransformers, // Gets complete set of transformers (core + extension)
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

// Markdown copy extension - Cmd+Shift+C to copy as markdown.
export { COPY_AS_MARKDOWN_COMMAND } from './extensions/builtin/MarkdownCopyExtension';

// Diff command identities + the React hook for callers that want the
// imperative shape.
export { useDiffCommands, APPLY_MARKDOWN_REPLACE_COMMAND, LiveNodeKeyState } from './plugins/DiffPlugin';

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

// Embed plugin -- inline previews of extension-editor files inside markdown
export {
  EmbeddedFileNode,
  $createEmbeddedFileNode,
  $isEmbeddedFileNode,
  EMBED_TRANSFORMER,
  parseEmbedAttrs,
  serializeEmbedAttrs,
  getEmbeddableExtensions,
  isEmbeddableUrl,
  registerEmbeddableExtension,
  unregisterEmbeddableExtension,
  setEmbeddableExtensions,
  subscribeToEmbeddableExtensionsChanges,
  getEmbedPluginCallbacks,
  setEmbedPluginCallbacks,
} from './plugins/EmbedPlugin';
export type {
  EmbedAttrs,
  EmbeddedFilePayload,
  SerializedEmbeddedFileNode,
  EmbedFrameProps,
  EmbedPluginCallbacks,
} from './plugins/EmbedPlugin';
