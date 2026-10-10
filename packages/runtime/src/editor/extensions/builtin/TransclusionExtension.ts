/**
 * Owns `TransclusionNode`: a link alone in its paragraph whose title carries
 * `transclude` and whose target is a page becomes a live, read-only copy of
 * that page's section. The node exports back to the same link, so editors and
 * hosts without this extension (and the headless collab worker and CLI, which
 * run no transforms) keep a plain link with the same bytes.
 *
 * Same upgrade timing as `EmbedExtension`: a LinkNode transform for local
 * edits and imports, plus a debounced pass over the elements a collaboration
 * transaction touched, because `@lexical/yjs` hydrates remote changes with
 * transforms skipped.
 */

import { $getNodeByKey, $isParagraphNode, COLLABORATION_TAG, defineExtension, type LexicalEditor } from 'lexical';
import { $isLinkNode, LinkNode } from '@lexical/link';
import { mergeRegister } from '@lexical/utils';

import {
  $upgradeLinkToTransclusion,
  TransclusionNode,
  TRANSCLUSION_TRANSFORMER,
} from '../../plugins/TransclusionPlugin/TransclusionNode';
import { setExtensionContributions } from '../extensionContributionsStore';
import '../../plugins/TransclusionPlugin/transclusionBlockMenu';

const NAME = '@nimbalyst/editor/transclusion';
const COLLAB_RESCAN_DEBOUNCE_MS = 250;

function $upgradeLinksIn(keys: readonly string[]): void {
  for (const key of keys) {
    const node = $getNodeByKey(key);
    if (!$isParagraphNode(node)) continue;
    for (const child of node.getChildren()) {
      if ($isLinkNode(child) && $upgradeLinkToTransclusion(child)) break;
    }
  }
}

export const TransclusionExtension = defineExtension({
  name: NAME,
  nodes: [TransclusionNode],
  register: (editor: LexicalEditor) => {
    let timer: ReturnType<typeof setTimeout> | null = null;
    const dirtyKeys = new Set<string>();
    return mergeRegister(
      () => {
        if (timer !== null) clearTimeout(timer);
        timer = null;
        dirtyKeys.clear();
      },
      editor.registerNodeTransform(LinkNode, (node) => {
        $upgradeLinkToTransclusion(node);
      }),
      editor.registerUpdateListener(({ tags, dirtyElements }) => {
        if (!tags.has(COLLABORATION_TAG)) return;
        for (const key of dirtyElements.keys()) dirtyKeys.add(key);
        if (timer !== null || dirtyKeys.size === 0) return;
        timer = setTimeout(() => {
          timer = null;
          const keys = [...dirtyKeys];
          dirtyKeys.clear();
          editor.update(() => $upgradeLinksIn(keys));
        }, COLLAB_RESCAN_DEBOUNCE_MS);
      }),
    );
  },
});

setExtensionContributions(NAME, {
  markdownTransformers: [TRANSCLUSION_TRANSFORMER],
});
