/**
 * Headless extension that owns `EmbeddedFileNode`, the auto-upgrade rule
 * that turns paragraph-isolated CommonMark links into embeds, and the
 * Tab-key toggle that lets users flip between link and embed presentations
 * of the same file.
 *
 * Import rule (Phase 1):
 *   A `LinkNode` is upgraded to an `EmbeddedFileNode` when *all*
 *     - its URL ends in a registered embeddable file extension
 *       (today: `.excalidraw`), and
 *     - it is the only meaningful child of its parent `ParagraphNode`
 *       (empty text-node siblings are ignored so paragraph whitespace
 *       doesn't block the upgrade), and
 *     - its title attributes don't include `embed=false` (the marker the
 *       Tab-downgrade adds so the auto-upgrade doesn't immediately put
 *       the user's choice back).
 *   Anything else stays a normal link. Inline links inside running text
 *   never upgrade.
 *
 * Tab-toggle rule:
 *   Pressing Tab while the selection is on / inside an embeddable link
 *   upgrades it to an embed. Pressing Tab while the selection is on an
 *   embed downgrades it back to a paragraph-isolated link with
 *   `embed=false` set in the title so the auto-upgrade rule respects the
 *   user's choice. Tab in any other context is left alone so list
 *   indentation and focus traversal still work.
 *
 * Export rule:
 *   `EMBED_TRANSFORMER` writes the node back as `[label](src "k=v k=v")`.
 *   This is published into the extension contributions store so the
 *   markdown copy / paste / export pipeline picks it up alongside the
 *   built-in transformers.
 */

import {
  $createParagraphNode,
  $createTextNode,
  $getRoot,
  $getSelection,
  $isElementNode,
  $isNodeSelection,
  $isParagraphNode,
  $isRangeSelection,
  $isTextNode,
  COMMAND_PRIORITY_LOW,
  KEY_TAB_COMMAND,
  defineExtension,
  type LexicalEditor,
  type LexicalNode,
} from 'lexical';
import { $createLinkNode, $isLinkNode, LinkNode } from '@lexical/link';
import { mergeRegister } from '@lexical/utils';

import {
  $createEmbeddedFileNode,
  $isEmbeddedFileNode,
  EmbeddedFileNode,
} from '../../plugins/EmbedPlugin/EmbeddedFileNode';
import { EMBED_TRANSFORMER } from '../../plugins/EmbedPlugin/EmbedTransformer';
import {
  parseEmbedAttrs,
  serializeEmbedAttrs,
} from '../../plugins/EmbedPlugin/embedAttrs';
import {
  isEmbeddableUrl,
  subscribeToEmbeddableExtensionsChanges,
} from '../../plugins/EmbedPlugin/embeddableExtensions';
import { setExtensionContributions } from '../extensionContributionsStore';

const NAME = '@nimbalyst/editor/embed';

function isEmptyTextNode(node: LexicalNode): boolean {
  return $isTextNode(node) && node.getTextContent() === '';
}

/** Find the enclosing LinkNode for a selection-anchor node, if any. */
function $findEnclosingLinkNode(node: LexicalNode | null): LinkNode | null {
  let current: LexicalNode | null = node;
  while (current && !$isLinkNode(current)) {
    current = current.getParent();
  }
  return current as LinkNode | null;
}

function isEmbedOptOut(title: string | null | undefined): boolean {
  if (!title) return false;
  return parseEmbedAttrs(title).embed === 'false';
}

function $upgradeParagraphIsolatedLinkToEmbed(linkNode: LinkNode): void {
  // Skip auto-links (`<https://...>` style) -- those aren't filesystem refs.
  if (!$isLinkNode(linkNode)) return;

  const url = linkNode.getURL();
  if (!isEmbeddableUrl(url)) return;

  // Respect explicit user opt-out (set by the Tab-downgrade path).
  const title = linkNode.getTitle() ?? '';
  if (isEmbedOptOut(title)) return;

  const parent = linkNode.getParent();
  if (!parent || !$isParagraphNode(parent)) return;

  // Paragraph must contain only this link (ignoring empty text-node siblings).
  const meaningfulChildren = parent.getChildren().filter((c) => !isEmptyTextNode(c));
  if (meaningfulChildren.length !== 1 || meaningfulChildren[0] !== linkNode) {
    return;
  }

  const label = linkNode.getTextContent();
  const attrs = parseEmbedAttrs(title);

  const embedNode = $createEmbeddedFileNode({
    src: url,
    label,
    attrs,
  });

  // Replace the entire paragraph -- embeds are block-level, not inline.
  parent.replace(embedNode);
}

/**
 * Convert a paragraph-isolated embeddable link to an EmbeddedFileNode. Used
 * by the Tab handler; mirrors `$upgradeParagraphIsolatedLinkToEmbed` but
 * also clears the `embed=false` opt-out so the upgrade actually sticks.
 * Returns true when an upgrade happened.
 */
function $upgradeLinkToEmbed(linkNode: LinkNode): boolean {
  if (!$isLinkNode(linkNode)) return false;
  const url = linkNode.getURL();
  if (!isEmbeddableUrl(url)) return false;

  const parent = linkNode.getParent();
  if (!parent || !$isParagraphNode(parent)) return false;

  const meaningfulChildren = parent.getChildren().filter((c) => !isEmptyTextNode(c));
  if (meaningfulChildren.length !== 1 || meaningfulChildren[0] !== linkNode) {
    return false;
  }

  const title = linkNode.getTitle() ?? '';
  const attrs = parseEmbedAttrs(title);
  // Clear the opt-out, then upgrade.
  delete attrs.embed;

  const embedNode = $createEmbeddedFileNode({
    src: url,
    label: linkNode.getTextContent(),
    attrs,
  });
  parent.replace(embedNode);
  return true;
}

/**
 * Convert an embed back to a paragraph-isolated link. Records `embed=false`
 * in the title so the auto-upgrade rule doesn't immediately reverse the
 * user's Tab. Returns true on success.
 */
function $downgradeEmbedToLink(embedNode: EmbeddedFileNode): boolean {
  if (!$isEmbeddedFileNode(embedNode)) return false;
  const src = embedNode.getSrc();
  const label = embedNode.getLabel() || src;
  const attrs = { ...embedNode.getAttrs(), embed: 'false' };
  const title = serializeEmbedAttrs(attrs);

  const linkNode = $createLinkNode(src, title ? { title } : undefined);
  linkNode.append($createTextNode(label));
  const paragraph = $createParagraphNode();
  paragraph.append(linkNode);
  embedNode.replace(paragraph);
  // Place the caret in the new link's text so a follow-on Tab toggles
  // back to embed.
  linkNode.selectEnd();
  return true;
}

/** Handle Tab. Returns true when we toggle (consumes the event). */
function $handleTabToggle(): boolean {
  const selection = $getSelection();

  if ($isNodeSelection(selection)) {
    for (const node of selection.getNodes()) {
      if ($isEmbeddedFileNode(node)) {
        return $downgradeEmbedToLink(node);
      }
    }
    return false;
  }

  if ($isRangeSelection(selection)) {
    const anchorNode = selection.anchor.getNode();
    const linkNode = $findEnclosingLinkNode(anchorNode);
    if (linkNode) {
      return $upgradeLinkToEmbed(linkNode);
    }
  }

  return false;
}

/**
 * Walk every node in the editor and upgrade any qualifying paragraph-
 * isolated `LinkNode` to an embed. Needed because the embeddable file-
 * type set is usually empty when the host markdown doc first loads
 * (extensions register their types AFTER initial import), so the
 * `registerNodeTransform` callbacks that ran on import all saw an empty
 * set and left links alone. This scan re-runs the upgrade rule against
 * the live tree once the set changes.
 */
function $rescanForEmbedUpgrade(): void {
  const stack: LexicalNode[] = [$getRoot()];
  while (stack.length > 0) {
    const node = stack.pop()!;
    if ($isLinkNode(node)) {
      $upgradeParagraphIsolatedLinkToEmbed(node);
      // Don't descend into a LinkNode's children -- text content can't
      // host another link.
      continue;
    }
    if ($isElementNode(node)) {
      const children = node.getChildren();
      for (const child of children) stack.push(child);
    }
  }
}

export const EmbedExtension = defineExtension({
  name: NAME,
  nodes: [EmbeddedFileNode],
  register: (editor: LexicalEditor) =>
    mergeRegister(
      editor.registerNodeTransform(LinkNode, (node) => {
        $upgradeParagraphIsolatedLinkToEmbed(node);
      }),
      editor.registerCommand(
        KEY_TAB_COMMAND,
        (event: KeyboardEvent) => {
          const handled = $handleTabToggle();
          if (handled) {
            event.preventDefault();
            event.stopPropagation();
          }
          return handled;
        },
        // LOW so the typeahead menu (NORMAL) and list indentation (also
        // higher) win when they apply. We only catch the Tab nobody else
        // wanted.
        COMMAND_PRIORITY_LOW,
      ),
      subscribeToEmbeddableExtensionsChanges(() => {
        // Schedule a Lexical update so the rescan happens in the proper
        // transactional context. Editor.update is a no-op if the editor
        // has been torn down between the listener firing and this
        // callback running.
        editor.update(() => {
          $rescanForEmbedUpgrade();
        });
      }),
    ),
});

setExtensionContributions(NAME, {
  markdownTransformers: [EMBED_TRANSFORMER],
});
