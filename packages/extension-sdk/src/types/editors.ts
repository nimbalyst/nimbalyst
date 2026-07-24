/**
 * Types for shared editor components.
 *
 * These types correspond to the MarkdownEditor and MonacoEditor components
 * available from `@nimbalyst/runtime`. Extensions import the components at
 * runtime (they're provided by the host via the externals system) and use
 * these types for type checking.
 *
 * @example
 * ```tsx
 * import { MonacoEditor } from '@nimbalyst/runtime';
 * import type { EditorHostProps, MonacoEditorProps } from '@nimbalyst/extension-sdk';
 *
 * export const MyEditor = ({ host }: EditorHostProps) => {
 *   return <MonacoEditor host={host} fileName={host.fileName} />;
 * };
 * ```
 */

import type { EditorHost } from './editor.js';

// ============================================================================
// MonacoEditor - Syntax-highlighted code editor
// ============================================================================

export interface MonacoEditorConfig {
  /** Theme for the editor */
  theme?: string;

  /** Extension theme ID for custom Monaco themes (e.g., 'sample-themes:solarized-light') */
  extensionThemeId?: string;

  /** Whether this editor's tab is active */
  isActive?: boolean;

  /** Optional transform from stored file content to visible editor content */
  transformLoadContent?: (content: string) => string;

  /** Optional transform from visible editor content back to stored file content */
  transformSaveContent?: (content: string) => string;
}

export interface MonacoEditorProps {
  /** Host service for all editor-host communication */
  host: EditorHost;

  /** File name for language detection */
  fileName: string;

  /** Optional configuration */
  config?: MonacoEditorConfig;

  /** Callback when editor is ready (passes editor instance with diff controls) */
  onEditorReady?: (editor: any) => void;

  /** Callback when getContent function is available */
  onGetContent?: (getContentFn: () => string) => void;

  /** Callback when diff change count updates (for diff header UI) */
  onDiffChangeCountUpdate?: (count: number) => void;
}

// ============================================================================
// MarkdownEditor - Rich text markdown editor (Lexical-based)
// ============================================================================

export interface MarkdownEditorConfig {
  /** Whether the editor is read-only */
  editable?: boolean;

  /** Show the toolbar */
  showToolbar?: boolean;

  /** Show the debug tree view (dev mode only) */
  showTreeView?: boolean;
}

export interface MarkdownEditorProps {
  /** Host service for all editor-host communication */
  host: EditorHost;

  /** Optional configuration */
  config?: MarkdownEditorConfig;
}
