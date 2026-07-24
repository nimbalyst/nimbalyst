/**
 * createMonacoCollabBinding
 *
 * Reusable live binding between a Monaco editor model and a Yjs `Y.Text`,
 * built on `y-monaco`'s `MonacoBinding`. Any Monaco-based custom editor
 * (calc-sheets, future code/source editors) can become collaborative by:
 *
 *   1. registering a text adapter (`createTextCollabContentAdapter` from
 *      `@nimbalyst/extension-sdk`) for the SAME `Y.Text` field, and
 *   2. calling this from `useCollaborativeEditor`'s `createBinding` once the
 *      editor instance is mounted.
 *
 * `MonacoBinding` reconciles Monaco's model edits with the shared `Y.Text`
 * (character-level CRDT merge) and renders remote selections via the optional
 * `awareness`. The returned handle's `destroy()` detaches everything; call it
 * from the binding teardown so observers and awareness listeners are cleaned
 * up on unmount.
 */
import { MonacoBinding } from 'y-monaco';
import type * as Y from 'yjs';
import type { Awareness } from 'y-protocols/awareness';
import type { editor as MonacoEditorNamespace } from 'monaco-editor';

export interface MonacoCollabBindingOptions {
  /** The shared text field to bind. Must be the SAME field the document's
   *  CollabContentAdapter reads/writes (default 'content'). */
  yText: Y.Text;
  /** The mounted Monaco editor instance (e.g. the `editor` on the wrapper
   *  passed to MonacoEditor's `onEditorReady`). */
  editor: MonacoEditorNamespace.IStandaloneCodeEditor;
  /** Optional collaboration awareness for remote cursors/selections. */
  awareness?: Awareness | null;
}

export interface MonacoCollabBindingHandle {
  destroy(): void;
}

export function createMonacoCollabBinding({
  yText,
  editor,
  awareness,
}: MonacoCollabBindingOptions): MonacoCollabBindingHandle {
  const model = editor.getModel();
  if (!model) {
    throw new Error('createMonacoCollabBinding: the Monaco editor has no text model');
  }

  const binding = new MonacoBinding(
    yText,
    model,
    new Set([editor]),
    awareness ?? null,
  );

  return {
    destroy() {
      binding.destroy();
    },
  };
}
