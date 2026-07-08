/**
 * Editor Wrappers
 *
 * Platform-agnostic editor wrappers that adapt pure editors (Rexical, Monaco)
 * to work with the EditorHost interface.
 *
 * These wrappers:
 * - Receive EditorHost as prop
 * - Load content via host.loadContent()
 * - Save content via host.saveContent()
 * - Report dirty state via host.setDirty()
 * - Handle file change notifications via host.onFileChanged()
 * - Handle save requests via host.onSaveRequested()
 */

export { MarkdownEditor } from './MarkdownEditor';
export type { MarkdownEditorProps, MarkdownEditorConfig } from './MarkdownEditor';

export { MonacoEditor } from './MonacoEditor';
export type { MonacoEditorProps, MonacoEditorConfig, MonacoEditorCollabConfig } from './MonacoEditor';

export { MonacoCodeEditor } from './MonacoCodeEditor';
export type { MonacoCodeEditorProps, MonacoDiffModeConfig } from './MonacoCodeEditor';

export { getMonacoTheme, getMonacoLanguage, toMonacoExtensionThemeName } from './monacoUtils';

export { createMonacoCollabBinding } from './monacoCollabBinding';
export type {
  MonacoCollabBindingOptions,
  MonacoCollabBindingHandle,
} from './monacoCollabBinding';
