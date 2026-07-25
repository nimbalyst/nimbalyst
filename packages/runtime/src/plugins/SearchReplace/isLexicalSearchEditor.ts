import type { LexicalEditor } from 'lexical';

export function isLexicalSearchEditor(editor: unknown): editor is LexicalEditor {
  if (!editor || typeof editor !== 'object') return false;

  const candidate = editor as Partial<LexicalEditor>;
  return typeof candidate.getEditorState === 'function'
    && typeof candidate.getElementByKey === 'function'
    && typeof candidate.getRootElement === 'function'
    && typeof candidate.registerUpdateListener === 'function'
    && typeof candidate.update === 'function';
}
