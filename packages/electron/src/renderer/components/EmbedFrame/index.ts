/**
 * Renderer-side registration for the embed plugin.
 *
 * Two responsibilities:
 *
 *   1. Inject the concrete `EmbedFrame` component into the runtime so
 *      `EmbeddedFileNode.decorate()` can render it. The runtime stays free
 *      of Electron-only concerns (file watcher IPC, customEditorRegistry).
 *
 *   2. Keep the runtime's set of embeddable file extensions in sync with
 *      whatever extensions have a custom editor registered. The auto-
 *      upgrade transform and the @ picker both read this set, so it must
 *      include every type any installed extension can render. Done as a
 *      live subscription against `customEditorRegistry.onChange`, not a
 *      hardcoded list.
 *
 * Phase 2 will narrow this to extensions that explicitly opt in via a
 * manifest field (e.g. `customEditors[].embeddable: true`) so heavy
 * editors can stay tab-only. Until then, every custom-editor file
 * extension is treated as embeddable.
 */

import {
  setEmbedPluginCallbacks,
  setEmbeddableExtensions,
} from '@nimbalyst/runtime';
import { setCanvasCallbacks } from '@nimbalyst/runtime/canvas';

import { customEditorRegistry } from '../CustomEditors/registry';
import { EmbedFrame } from './EmbedFrame';
import { CanvasCardHost } from './CanvasCardHost';
import { CanvasCardPreview } from './CanvasCardPreview';
import { canvasCardCommentCounts } from './canvasCardCommentCounts';
import { canvasCardRevisions } from './canvasCardRevisions';
import { dispatchCanvasAgentThread } from './canvasAgentDispatch';
import { pickCanvasCardReference } from './pickCanvasCardReference';
import { canvasDropSource } from './canvasDropSource';
import { openFileInTab, workspaceAbsolutePath } from './embeddedFileIo';

export { EmbedFrame } from './EmbedFrame';
export { createEmbeddedFileHost } from './createEmbeddedFileHost';
export { CanvasCardHost } from './CanvasCardHost';

function syncEmbeddableExtensions(): void {
  setEmbeddableExtensions(customEditorRegistry.getRegisteredExtensions());
}

export function registerEmbedFrame(): void {
  setEmbedPluginCallbacks({ renderEmbed: EmbedFrame });
  // The canvas's card slot, filled from the same place and for the same reason:
  // one renderer-side module owns "how a reference becomes a mounted editor,"
  // whether the surface arranging those references is a document or a board.
  setCanvasCallbacks({
    renderCard: CanvasCardHost,
    renderCardPreview: CanvasCardPreview,
    openScreenshotSource: path => {
      const absolutePath = workspaceAbsolutePath(path);
      if (absolutePath) openFileInTab(absolutePath);
    },
    // The other half of a card's dual comment count: threads inside the card's
    // own document, which live in that document's room and never merge with the
    // board's own threads.
    cardComments: canvasCardCommentCounts,
    // A card's history, and the local sessions and commits behind it. The
    // browser console leaves this unset for now: it can reach the room, but not
    // `session_files`, and a rail that could only ever say "By <someone>" is a
    // weaker answer than no rail.
    revisions: canvasCardRevisions,
    dispatchAgentThread: (request) => {
      void dispatchCanvasAgentThread(request);
    },
    // "Put an existing document on the board." Desktop offers both workspace
    // files and shared documents; the browser console has no filesystem and
    // fills this slot with its own, doc-only picker.
    pickCardReference: pickCanvasCardReference,
    // Drag a file out of the workspace tree, or a document out of the shared
    // tree, straight onto the board.
    dropSource: canvasDropSource,
  });
  syncEmbeddableExtensions();
  customEditorRegistry.onChange(syncEmbeddableExtensions);
}
