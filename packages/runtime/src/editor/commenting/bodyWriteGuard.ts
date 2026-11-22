/**
 * Keeps a body-locked user's editor (`editBody: false`) from writing to the
 * Lexical `root` in the shared Y.Doc.
 *
 * The server refuses any commenter update that changes `root`. Yjs updates from
 * one client are clock-ordered, so a single refused update also strands every
 * later update from that client, comments included. Making the editor
 * read-only stops typing, but not the other writers: a plugin's mount-time
 * `editor.update`, a decorator toggling its own state on click, Lexical
 * normalizing text nodes after a remote change, or the collaboration bootstrap
 * seeding an empty document. Each of those reaches the Y.Doc through the
 * collaboration plugin's update listener, which skips any update tagged
 * `SKIP_COLLAB_TAG`.
 *
 * A RootNode transform runs last in every update that dirties any node (Lexical
 * treats the root as intentionally dirty whenever an attached node is), so
 * tagging there covers every content update, local or remote-driven, before the
 * listener sees it. Selection-only updates dirty nothing and write nothing.
 * The editor's view then follows the Y.Doc only, which is what a reader wants.
 *
 * `isLocked` is read inside every update and never cached: access can change
 * while the config object keeps its identity.
 */
import {
  $addUpdateTag,
  RootNode,
  SKIP_COLLAB_TAG,
  type LexicalEditor,
} from 'lexical';

export function registerBodyWriteGuard(
  editor: LexicalEditor,
  isLocked: () => boolean,
): () => void {
  const removeTransform = editor.registerNodeTransform(RootNode, () => {
    if (isLocked()) $addUpdateTag(SKIP_COLLAB_TAG);
  });

  let forcedReadOnly = false;
  const enforceReadOnly = () => {
    if (isLocked() && editor.isEditable()) {
      forcedReadOnly = true;
      editor.setEditable(false);
    }
  };
  enforceReadOnly();
  // A host that flips the editor editable (warm read-only mounts activate on
  // click) is overridden while the body is locked.
  const removeEditableListener =
    editor.registerEditableListener(enforceReadOnly);

  return () => {
    removeTransform();
    removeEditableListener();
    if (forcedReadOnly && !isLocked()) editor.setEditable(true);
  };
}
