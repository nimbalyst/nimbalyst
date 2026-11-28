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
export { CODE_FONT_CHANGED_EVENT } from './codeFont';
export type { MonacoCodeEditorProps, MonacoDiffModeConfig } from './MonacoCodeEditor';

export { getMonacoTheme, getMonacoLanguage, toMonacoExtensionThemeName } from './monacoUtils';

export {
  MONACO_LANGUAGE_BY_EXTENSION,
  MONACO_TEXT_FILE_EXTENSIONS,
  CODE_COLLAB_FILE_EXTENSIONS,
} from './monacoLanguages';

export { CodeCollabContentAdapter, CODE_COLLAB_TEXT_FIELD } from './codeCollabCodec';

export { createMonacoCollabBinding } from './monacoCollabBinding';
export type {
  MonacoCollabBindingOptions,
  MonacoCollabBindingHandle,
} from './monacoCollabBinding';
