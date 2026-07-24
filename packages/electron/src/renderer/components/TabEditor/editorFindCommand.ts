/**
 * Routes the app-menu Find command ("menu:find") to whichever editor is
 * mounted for the active file. Cmd+F is a native menu accelerator, so the
 * renderer never sees the keystroke -- the command arrives over IPC and must
 * be dispatched to the right editor here. Each tab registers a handler that
 * opens its own find UI (Monaco's native widget, the Lexical search/replace
 * bar, ...); useIPCHandlers resolves the active file path and invokes it.
 */

type EditorFindHandler = () => void;

const handlersByFilePath = new Map<string, EditorFindHandler>();

/** Register the find handler for a file. Returns an unregister function. */
export function registerEditorFindHandler(filePath: string, handler: EditorFindHandler): () => void {
  handlersByFilePath.set(filePath, handler);
  return () => {
    if (handlersByFilePath.get(filePath) === handler) {
      handlersByFilePath.delete(filePath);
    }
  };
}

/** Invoke the registered find handler for a file, if any. */
export function openEditorFind(filePath: string): boolean {
  const handler = handlersByFilePath.get(filePath);
  if (!handler) return false;
  handler();
  return true;
}

/** An editor wrapper that exposes its own find UI (e.g. the Monaco wrapper). */
export interface EditorWithFind {
  openFind: () => void;
}

export function hasEditorFind(editor: unknown): editor is EditorWithFind {
  return typeof (editor as Partial<EditorWithFind> | null | undefined)?.openFind === 'function';
}
