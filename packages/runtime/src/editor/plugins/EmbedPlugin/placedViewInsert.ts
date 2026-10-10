/**
 * Placing a view at the caret: the slash entries a host publishes ("Table:
 * Competitors", "2x2: Competitors", "Decisions") dispatch this command. Kept
 * out of `EmbedExtension` so a host that cannot list types (the browser
 * editor) does not carry it.
 *
 * The link is a console link for the page's own scope (Decision 23). The
 * command does not know which page it is in, so it reads the document path
 * the host put on the editor's container (`data-file-path`, as images do) and
 * asks the host's resolver for that page's scope.
 */

import {
  $createParagraphNode,
  $getSelection,
  $isParagraphNode,
  $isRangeSelection,
  COMMAND_PRIORITY_EDITOR,
  createCommand,
  defineExtension,
  type LexicalCommand,
  type LexicalEditor,
} from 'lexical';

import { createPlacedViewUrl, type PlacedViewScope, type PlacedViewTarget } from '../../../core/placedViewUrl';
import { $createEmbeddedFileNode } from './EmbeddedFileNodeCore';

export interface PlacedViewInsertPayload {
  target: PlacedViewTarget;
  label: string;
  /** Title-safe definition values (see `encodeViewAttrValue`). */
  attrs?: Record<string, string>;
  /** The page's scope; asked of the host's resolver when absent. */
  scope?: PlacedViewScope;
}

/** The scope of the page at `documentPath` (null when the editor sits in no tagged container). */
export type PlacedViewScopeResolver = (documentPath: string | null) => PlacedViewScope | undefined;

let scopeResolver: PlacedViewScopeResolver | undefined;

export function setPlacedViewScopeResolver(resolver: PlacedViewScopeResolver | undefined): void {
  scopeResolver = resolver;
}

function documentPathOf(editor: LexicalEditor): string | null {
  return editor.getRootElement()?.closest('[data-file-path]')?.getAttribute('data-file-path') ?? null;
}

export const INSERT_PLACED_VIEW_COMMAND: LexicalCommand<PlacedViewInsertPayload> =
  createCommand('INSERT_PLACED_VIEW_COMMAND');

/**
 * Embeds sit at the top level in place of a paragraph, as an imported link
 * does: the empty line the slash entry was typed on, or after the current block.
 */
export function $insertPlacedView({ target, label, attrs = {}, scope }: PlacedViewInsertPayload): boolean {
  const selection = $getSelection();
  if (!$isRangeSelection(selection)) return false;
  const top = selection.anchor.getNode().getTopLevelElementOrThrow();
  const embed = $createEmbeddedFileNode({ src: createPlacedViewUrl(target, scope), label, attrs });
  if ($isParagraphNode(top) && top.getTextContent().trim() === '') top.replace(embed);
  else top.insertAfter(embed);
  if (embed.getNextSibling()) {
    embed.selectNext();
  } else {
    const after = $createParagraphNode();
    embed.insertAfter(after);
    after.select();
  }
  return true;
}

export function registerPlacedViewInsert(editor: LexicalEditor): () => void {
  return editor.registerCommand(
    INSERT_PLACED_VIEW_COMMAND,
    (payload) => $insertPlacedView({ ...payload, scope: payload.scope ?? scopeResolver?.(documentPathOf(editor)) }),
    COMMAND_PRIORITY_EDITOR,
  );
}

export const PlacedViewInsertExtension = defineExtension({
  name: '@nimbalyst/editor/placed-view-insert',
  register: registerPlacedViewInsert,
});
