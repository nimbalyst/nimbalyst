/**
 * Intercepts clicks on `<a href="collab-asset://...">` anchors inside the
 * editor's root element and routes them through `window.open` so the
 * registered `collab-asset://` protocol handler can fetch + decrypt the
 * asset. Without this, non-image attachment links would do nothing while
 * the editor is editable (because the stock ClickableLink plugin is
 * intentionally disabled during editing).
 *
 * Scoped to `collab-asset://` only -- regular http(s) links continue to
 * follow the standard ClickableLink semantics.
 *
 * Headless extension (Phase 7.3). Replaces the prior React-component
 * `CollabAssetLinkPlugin` mounted in Editor.tsx.
 */

import { defineExtension } from 'lexical';
import { isDOMNode } from 'lexical';

function getCollabAssetAnchor(target: Node): HTMLAnchorElement | null {
  const el = typeof Element !== 'undefined' && target instanceof Element
    ? target
    : target.parentElement;
  const anchor = el?.closest('a[href^="collab-asset://"]');
  return anchor instanceof HTMLAnchorElement ? anchor : null;
}

export const CollabAssetLinkExtension = defineExtension({
  name: '@nimbalyst/editor/collab-asset-link',
  register: (editor) => {
    const handle = (event: MouseEvent, allowButton: (button: number) => boolean) => {
      if (event.defaultPrevented || !allowButton(event.button)) return;
      const target = event.target;
      if (!isDOMNode(target)) return;
      const anchor = getCollabAssetAnchor(target);
      if (!anchor) return;
      event.preventDefault();
      // `noopener,noreferrer` so the popup can't reach back into the
      // editor renderer; not security-critical (same Electron app), but
      // avoids surprises with window.opener.
      window.open(anchor.href, '_blank', 'noopener,noreferrer');
    };

    const onClick = (event: MouseEvent) => handle(event, (b) => b === 0);
    const onAuxClick = (event: MouseEvent) => handle(event, (b) => b === 1);

    return editor.registerRootListener((rootElement, prevRootElement) => {
      if (prevRootElement) {
        prevRootElement.removeEventListener('click', onClick, true);
        prevRootElement.removeEventListener('auxclick', onAuxClick, true);
      }
      if (!rootElement) return undefined;
      rootElement.addEventListener('click', onClick, true);
      rootElement.addEventListener('auxclick', onAuxClick, true);
      return () => {
        rootElement.removeEventListener('click', onClick, true);
        rootElement.removeEventListener('auxclick', onAuxClick, true);
      };
    });
  },
});
