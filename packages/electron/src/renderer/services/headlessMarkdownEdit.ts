/**
 * headlessMarkdownEdit
 *
 * Apply text replacements to a markdown shared document's Y.Doc with no editor
 * mounted, using the SAME reconciliation the mounted editor uses.
 *
 * The cheap alternative -- project to markdown, string-replace, and hand the
 * whole thing back through `codec.applyFromFile` -- is a `$getRoot().clear()`
 * plus reparse, which lands in the room as a wholesale replacement of the
 * document. That clobbers whatever a remote collaborator is typing right now
 * and orphans every comment anchor in the file. A tracker body is a small field
 * nobody co-edits; a shared document is the opposite, so it gets the same
 * minimal-delta path a human's edit would take.
 *
 * The reconciliation itself, and its failure behaviour, is shared with the
 * collab worker: `@nimbalyst/runtime/sync/headlessMarkdownReplace`.
 */
import type { Doc } from 'yjs';
import type { TextReplacement } from '@nimbalyst/runtime';
import { HeadlessBodyNodes } from '@nimbalyst/runtime/editor';
import { getAllExtensionTransformers } from '@nimbalyst/runtime/editor/extensions/extensionContributionsStore';
import { CORE_TRANSFORMERS } from '@nimbalyst/runtime/editor/markdown/core-transformers';
import { applyMarkdownReplacementsToHeadlessEditor } from '@nimbalyst/runtime/sync/headlessMarkdownReplace';
import { withHeadlessLexicalBridge } from '@nimbalyst/runtime/sync/withHeadlessLexicalBridge';

/**
 * `HeadlessBodyNodes`, NOT `EditorNodes`.
 *
 * Being in the renderer does not help: Lexical registers nodes per editor
 * INSTANCE, and `withHeadlessLexicalBridge` builds a standalone editor from
 * this array alone -- it never composes `buildNimbalystRootExtension`, which is
 * where a mounted renderer editor gets list, link, image and friends.
 * `EditorNodes` deliberately omits all of those (see `headlessBodyNodes.ts`).
 *
 * With `EditorNodes` the binding threw "Node list is not registered" on any
 * document containing a bullet list or a link, and the resulting editor state
 * was EMPTY -- so the edit failed as `Old text "..." not found in original
 * markdown`, blaming the agent's quote for a document that never loaded.
 */
export function applyMarkdownReplacementsToYDoc(
  yDoc: Doc,
  replacements: TextReplacement[],
): void {
  withHeadlessLexicalBridge(
    yDoc,
    { nodes: HeadlessBodyNodes, namespace: 'nimbalyst-headless-collab-edit' },
    (headless) => applyMarkdownReplacementsToHeadlessEditor(
      headless.editor,
      replacements,
      [...getAllExtensionTransformers(), ...CORE_TRANSFORMERS],
    ),
  );
}
