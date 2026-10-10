/**
 * Turning a URL into a preview block, shared by the paste menu and the
 * "Link preview" slash entry. The block is an `EmbeddedFileNode` carrying
 * `preview=<mode>`, exactly what importing `[label](url "preview=<mode>")`
 * produces, so both paths write the same markdown.
 *
 * React-free.
 */

import {
  $createParagraphNode,
  $getSelection,
  $insertNodes,
  $isParagraphNode,
  $isRangeSelection,
  createCommand,
  type LexicalCommand,
  type LexicalNode,
} from 'lexical';
import { $isLinkNode, type LinkNode } from '@lexical/link';

import { $createEmbeddedFileNode, type EmbeddedFileNode } from '../EmbedPlugin/EmbeddedFileNodeCore';
import { parseEmbedAttrs } from '../EmbedPlugin/embedAttrs';
import { setTitleAttr } from '../EmbedPlugin/embedTitle';
import { isEmptyTextNode } from '../EmbedPlugin/embedUpgrade';
import { LINK_PREVIEW_ATTR, type LinkPreviewMode } from './linkPreviewLinks';

/** Opens the "Link preview" URL dialog (handled by `AutoEmbedPlugin`). */
export const INSERT_LINK_PREVIEW_COMMAND: LexicalCommand<void> = createCommand('INSERT_LINK_PREVIEW_COMMAND');

/**
 * Sets one `key=value` in a preview's link title (removed when null), keeping
 * the rest of the title as written; a node without a title edits its attrs.
 */
export function $setPreviewAttr(node: EmbeddedFileNode, key: string, value: string | null): void {
  const title = node.getTitle();
  if (title !== null) {
    node.setTitle(setTitleAttr(title, key, value));
    return;
  }
  const attrs = { ...node.getAttrs() };
  if (value === null) delete attrs[key];
  else attrs[key] = value;
  node.setAttrs(attrs);
}

function $createPreview(url: string, label: string, title: string | null, mode: LinkPreviewMode): EmbeddedFileNode {
  // Only the keys this block owns change; the rest of the title stays as written.
  const next = setTitleAttr(setTitleAttr(title, 'embed', null), LINK_PREVIEW_ATTR, mode);
  return $createEmbeddedFileNode({ src: url, label, attrs: parseEmbedAttrs(next), title: next });
}

function $enclosingLink(node: LexicalNode | null): LinkNode | null {
  let current = node;
  while (current && !$isLinkNode(current)) current = current.getParent();
  return current;
}

/**
 * Upgrade a link to a preview block. A link alone in its paragraph replaces
 * the paragraph; a link inside text stays where it is and the block goes in
 * after the paragraph.
 */
export function $convertLinkToPreview(link: LinkNode, mode: LinkPreviewMode): EmbeddedFileNode {
  const url = link.getURL();
  const label = link.getTextContent() || url;
  const preview = $createPreview(url, label, link.getTitle(), mode);
  const parent = link.getParent();
  if ($isAloneInParagraph(link) && parent) parent.replace(preview);
  else if (parent) parent.getTopLevelElementOrThrow().insertAfter(preview);
  else $insertNodes([preview]);
  $placeCaretAfter(preview);
  return preview;
}

/** The caret was in the link the block replaced; put it in the paragraph after the block. */
function $placeCaretAfter(preview: EmbeddedFileNode): void {
  const next = preview.getNextSibling();
  if ($isParagraphNode(next)) {
    next.selectStart();
    return;
  }
  const paragraph = $createParagraphNode();
  preview.insertAfter(paragraph);
  paragraph.select();
}

/** The link with this URL that the caret sits in or just after (where a paste leaves it). */
function $linkAtCaret(url: string): LinkNode | null {
  const selection = $getSelection();
  if (!$isRangeSelection(selection)) return null;
  const anchor = selection.anchor.getNode();
  const link = $enclosingLink(anchor)
    ?? [anchor.getPreviousSibling(), anchor].find((node): node is LinkNode => $isLinkNode(node))
    ?? null;
  return link && link.getURL() === url ? link : null;
}

function $isAloneInParagraph(link: LinkNode): boolean {
  const parent = link.getParent();
  return $isParagraphNode(parent)
    && parent.getChildren().filter((child) => !isEmptyTextNode(child)).every((child) => child === link);
}

/** True when the just-pasted link is the only thing in its paragraph, so offering a block makes sense. */
export function $isPastedLinkAlone(url: string): boolean {
  const link = $linkAtCaret(url);
  return !!link && $isAloneInParagraph(link);
}

/**
 * The paste path: the link the caret sits in (or just after) when its URL
 * matches. Falls back to inserting a new block at the selection.
 */
export function $insertLinkPreview(url: string, mode: LinkPreviewMode): EmbeddedFileNode {
  const link = $linkAtCaret(url);
  if (link) return $convertLinkToPreview(link, mode);
  const preview = $createPreview(url, url, null, mode);
  $insertNodes([preview]);
  $placeCaretAfter(preview);
  return preview;
}
