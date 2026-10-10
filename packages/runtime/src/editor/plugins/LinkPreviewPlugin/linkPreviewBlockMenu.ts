/**
 * A link preview's block-menu items: switch between card and player (when the
 * site has a player), open the link, and reset a dragged width. Other embedded
 * files keep their own menus; these show only for web link previews.
 */

import type { LexicalNode } from 'lexical';

import { $isEmbeddedFileNode, EmbeddedFileNode } from '../EmbedPlugin/EmbeddedFileNodeCore';
import { draggableBlockMenuRegistry } from '../DraggableBlockPlugin/DraggableBlockMenuRegistry';
import { resolveExternalEmbed } from './externalEmbeds';
import { $setPreviewAttr } from './linkPreviewInsert';
import { getLinkPreviewMode, isLinkPreviewLink, LINK_PREVIEW_ATTR, type LinkPreviewMode } from './linkPreviewLinks';

const NODE_TYPES = [EmbeddedFileNode.getType()];

function preview(node: LexicalNode): { src: string; mode: LinkPreviewMode; width?: string } | null {
  if (!$isEmbeddedFileNode(node)) return null;
  const attrs = node.getAttrs();
  if (!isLinkPreviewLink(node.getSrc(), attrs, node.getTitle())) return null;
  return { src: node.getSrc(), mode: getLinkPreviewMode(attrs) ?? 'card', width: attrs.width };
}

const switchTo = (mode: LinkPreviewMode, label: string, icon: string, order: number) => draggableBlockMenuRegistry.registerMenuItem({
  id: `link-preview:${mode}`,
  label,
  icon,
  nodeTypes: NODE_TYPES,
  order,
  isVisible: (node, editor) => {
    const current = preview(node);
    return !!current && !!editor?.isEditable() && current.mode !== mode && !!resolveExternalEmbed(current.src);
  },
  command: (editor, node) => editor.update(() => {
    const latest = node.getLatest();
    if ($isEmbeddedFileNode(latest)) $setPreviewAttr(latest, LINK_PREVIEW_ATTR, mode);
  }),
});
switchTo('card', 'Show as card', 'article', 0);
switchTo('embed', 'Show player', 'play_circle', 0);

draggableBlockMenuRegistry.registerMenuItem({
  id: 'link-preview:open',
  label: 'Open link',
  icon: 'open_in_new',
  nodeTypes: NODE_TYPES,
  order: 1,
  isVisible: (node) => !!preview(node),
  // The window-open guard sends web URLs to the system browser.
  command: (_editor, node) => {
    const current = preview(node);
    if (current) window.open(current.src, '_blank', 'noopener,noreferrer');
  },
});

draggableBlockMenuRegistry.registerMenuItem({
  id: 'link-preview:reset-size',
  label: 'Reset size',
  icon: 'fit_screen',
  nodeTypes: NODE_TYPES,
  order: 20,
  isVisible: (node, editor) => !!preview(node)?.width && !!editor?.isEditable(),
  command: (editor, node) => editor.update(() => {
    const latest = node.getLatest();
    if ($isEmbeddedFileNode(latest)) $setPreviewAttr(latest, 'width', null);
  }),
});
