/**
 * waitForMonacoModel
 *
 * Resolves once a Monaco editor has a text model attached, tolerating the
 * brief window after a remount where the editor exists but its model has been
 * disposed/not-yet-attached (StrictMode double-mount, diff-mode
 * `<Editor>`/`<DiffEditor>` swap, tab reactivation). Lives in its own module
 * -- with type-only Monaco imports -- so the collab binding can wait for a live
 * model without unit tests transitively pulling `y-monaco`/`monaco-editor` CSS.
 *
 * Returns the model when one attaches, or `null` if the editor disposes first
 * or no model appears within `timeoutMs`. Never throws: callers use the null
 * to skip binding rather than surface an unhandled rejection.
 */
import type { editor as MonacoEditorNamespace, IDisposable } from 'monaco-editor';

/** The slice of `IStandaloneCodeEditor` this helper depends on. */
export interface MonacoModelWaitTarget {
  getModel(): MonacoEditorNamespace.ITextModel | null;
  onDidChangeModel(listener: () => void): IDisposable;
  onDidDispose(listener: () => void): IDisposable;
}

export function waitForMonacoModel(
  editor: MonacoModelWaitTarget,
  options?: { timeoutMs?: number },
): Promise<MonacoEditorNamespace.ITextModel | null> {
  const existing = editor.getModel();
  if (existing) return Promise.resolve(existing);

  const timeoutMs = options?.timeoutMs ?? 2000;
  return new Promise((resolve) => {
    let settled = false;
    const finish = (model: MonacoEditorNamespace.ITextModel | null) => {
      if (settled) return;
      settled = true;
      changeSub.dispose();
      disposeSub.dispose();
      clearTimeout(timer);
      resolve(model);
    };

    const changeSub = editor.onDidChangeModel(() => {
      const model = editor.getModel();
      if (model) finish(model);
    });
    const disposeSub = editor.onDidDispose(() => finish(null));
    const timer = setTimeout(() => finish(editor.getModel()), timeoutMs);
  });
}
