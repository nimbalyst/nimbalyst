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
 * Web links:
 *   A web link upgrades only when its title asks for a preview
 *   (`preview=card` or `preview=embed`, see `linkPreviewLinks.ts`); Tab on a
 *   lone web link adds that attribute. Transclusion links never upgrade.
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
  $getNodeByKey,
  $getSelection,
  $isNodeSelection,
  $isParagraphNode,
  $isRangeSelection,
  COLLABORATION_TAG,
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
import { NAMED_PAGE_VIEW_TRANSFORMER } from '../../plugins/EmbedPlugin/namedPageView';
import { EMBED_TRANSFORMER } from '../../plugins/EmbedPlugin/EmbedTransformer';
import {
  parseEmbedAttrs,
  serializeEmbedAttrs,
} from '../../plugins/EmbedPlugin/embedAttrs';
import {
  getEmbeddableExtensions,
  subscribeToEmbeddableExtensionsChanges,
} from '../../plugins/EmbedPlugin/embeddableExtensions';
import {
  $rescanForEmbedUpgrade,
  $upgradeParagraphIsolatedLinkToEmbed,
  isEmptyTextNode,
  isPreviewUpgrade,
  isUpgradeableLink,
} from '../../plugins/EmbedPlugin/embedUpgrade';
import { setTitleAttr } from '../../plugins/EmbedPlugin/embedTitle';
import { INSERT_LINK_PREVIEW_COMMAND } from '../../plugins/LinkPreviewPlugin/linkPreviewInsert';
import '../../plugins/LinkPreviewPlugin/linkPreviewBlockMenu';
import {
  LINK_PREVIEW_ATTR,
  defaultLinkPreviewMode,
  isTranscludeTitle,
} from '../../plugins/LinkPreviewPlugin/linkPreviewLinks';
import { setExtensionContributions } from '../extensionContributionsStore';

export { $rescanForEmbedUpgrade };

const NAME = '@nimbalyst/editor/embed';

/**
 * Trailing window for collapsing a burst of remote collaboration
 * transactions into one tree walk.
 */
const COLLAB_RESCAN_DEBOUNCE_MS = 250;

/** Find the enclosing LinkNode for a selection-anchor node, if any. */
function $findEnclosingLinkNode(node: LexicalNode | null): LinkNode | null {
  let current: LexicalNode | null = node;
  while (current && !$isLinkNode(current)) {
    current = current.getParent();
  }
  return current as LinkNode | null;
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
  let title = linkNode.getTitle() ?? '';
  if (!isUpgradeableLink(url, title)) {
    // A plain web link becomes a preview: the site's player when allowlisted,
    // else a card. The mode is written into the title so it survives a save.
    const mode = isTranscludeTitle(title) ? null : defaultLinkPreviewMode(url);
    if (!mode) return false;
    title = setTitleAttr(title, LINK_PREVIEW_ATTR, mode);
  }
  const preview = isPreviewUpgrade(url, title);
  const attrs = parseEmbedAttrs(title);

  const parent = linkNode.getParent();
  if (!parent || !$isParagraphNode(parent)) return false;

  const meaningfulChildren = parent.getChildren().filter((c) => !isEmptyTextNode(c));
  if (meaningfulChildren.length !== 1 || meaningfulChildren[0] !== linkNode) {
    return false;
  }

  // Clear the opt-out, then upgrade. A preview keeps the rest of its title as written.
  delete attrs.embed;

  const embedNode = $createEmbeddedFileNode({
    src: url,
    label: linkNode.getTextContent(),
    attrs,
    title: preview ? setTitleAttr(title, 'embed', null) : null,
  });
  parent.replace(embedNode);
  return true;
}

/**
 * Convert an embed back to a paragraph-isolated link. Records `embed=false`
 * in the title so the auto-upgrade rule doesn't immediately reverse the
 * user's Tab. Returns true on success.
 */
export function $downgradeEmbedToLink(embedNode: EmbeddedFileNode): boolean {
  if (!$isEmbeddedFileNode(embedNode)) return false;
  const src = embedNode.getSrc();
  const label = embedNode.getLabel() || src;
  const verbatim = embedNode.getTitle();
  const title = verbatim !== null
    ? setTitleAttr(verbatim, 'embed', 'false')
    : serializeEmbedAttrs({ ...embedNode.getAttrs(), embed: 'false' });

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

/** The upgrade rule over the direct link children of the given elements only. */
function $upgradeLinksIn(keys: readonly string[]): void {
  for (const key of keys) {
    const node = $getNodeByKey(key);
    if (!$isParagraphNode(node)) continue;
    for (const child of node.getChildren()) {
      if ($isLinkNode(child)) $upgradeParagraphIsolatedLinkToEmbed(child);
    }
  }
}

export const EmbedExtension = defineExtension({
  name: NAME,
  nodes: [EmbeddedFileNode],
  register: (editor: LexicalEditor) => {
    // A remote transaction arrives for every keystroke a collaborator types.
    // `$rescanForEmbedUpgrade` walks the whole tree, so microtask coalescing
    // is not enough -- a typing peer would trigger one full walk per batch.
    // Collapse bursts onto a trailing timer instead, and skip entirely when
    // no extension has registered an embeddable type (nothing can upgrade).
    let collabRescanTimer: ReturnType<typeof setTimeout> | null = null;
    // With no file type registered (the browser editor), only a placed view
    // can upgrade, so walk just the elements remote transactions touched.
    const dirtyKeys = new Set<string>();
    const scheduleCollabRescan = (dirty: Iterable<string>) => {
      const fullWalk = getEmbeddableExtensions().length > 0;
      if (!fullWalk) for (const key of dirty) dirtyKeys.add(key);
      if (collabRescanTimer !== null) return;
      if (!fullWalk && dirtyKeys.size === 0) return;
      collabRescanTimer = setTimeout(() => {
        collabRescanTimer = null;
        const keys = [...dirtyKeys];
        dirtyKeys.clear();
        editor.update(() => {
          if (getEmbeddableExtensions().length > 0) $rescanForEmbedUpgrade();
          else $upgradeLinksIn(keys);
        });
      }, COLLAB_RESCAN_DEBOUNCE_MS);
    };

    return mergeRegister(
      () => {
        if (collabRescanTimer !== null) clearTimeout(collabRescanTimer);
        collabRescanTimer = null;
        dirtyKeys.clear();
      },
      editor.registerNodeTransform(LinkNode, (node) => {
        $upgradeParagraphIsolatedLinkToEmbed(node);
      }),
      // @lexical/yjs deliberately hydrates remote changes with
      // `skipTransforms: true`. Reconcile after that transaction so a shared
      // markdown link can still become a block embed on recipients.
      //
      // This listener is what carries the recipient side: the share-to-team
      // seed writes a plain hinted `LinkNode` (the headless seeder runs no
      // node transforms), and a cold open hydrates it through
      // `syncYjsChangesToLexical`, which tags its update COLLABORATION_TAG.
      // Verified end-to-end against live shared documents and pinned by
      // `collabEmbedUpgrade.test.ts` (NIM-2473) -- including the startup
      // ordering where the doc paints before any embeddable type is
      // registered, which the `subscribeToEmbeddableExtensionsChanges` rescan
      // below picks up.
      //
      // KNOWN LIMITATION: the upgrade replaces the paragraph, and that
      // replacement syncs back to the Y.Doc. If two peers reconcile the same
      // un-upgraded link before either's write arrives, Yjs keeps both
      // inserts and the paragraph ends up duplicated. The debounce narrows
      // the window but does not close it; converging on a single writer needs
      // the embed import to happen at seed time.
      editor.registerUpdateListener(({ tags, dirtyElements }) => {
        if (tags.has(COLLABORATION_TAG)) scheduleCollabRescan(dirtyElements.keys());
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
    );
  },
});

setExtensionContributions(NAME, {
  markdownTransformers: [NAMED_PAGE_VIEW_TRANSFORMER, EMBED_TRANSFORMER],
  userCommands: [
    {
      title: 'Link preview',
      description: 'A card for a web link, or the player for a video or design file',
      icon: 'link',
      keywords: ['link', 'preview', 'bookmark', 'card', 'embed', 'url', 'video', 'youtube', 'figma', 'loom', 'vimeo'],
      command: INSERT_LINK_PREVIEW_COMMAND,
    },
  ],
});
