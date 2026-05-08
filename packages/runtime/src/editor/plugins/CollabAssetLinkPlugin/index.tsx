/**
 * CollabAssetLinkPlugin
 *
 * Intercepts clicks on `<a href="collab-asset://...">` and opens the URL
 * in a new browser context via `window.open`. Chromium routes the request
 * through the registered `collab-asset://` protocol handler in main, which
 * fetches and decrypts; for image/PDF/text MIME types Chromium previews
 * inline, otherwise it triggers a download.
 *
 * Why this exists: the editor's stock `ClickableLinkPlugin` is disabled
 * whenever `isEditable === true` (so clicking a link doesn't navigate
 * away from an in-progress edit). In the collaborative editor's normal
 * editable state, that means non-image attachment links would do nothing
 * without this intercept.
 *
 * Scoped to `collab-asset://` only -- regular http(s) links continue to
 * follow the standard ClickableLinkPlugin / no-op-when-editing semantics.
 */
import { useEffect } from 'react';
import { isDOMNode } from 'lexical';
import { useLexicalComposerContext } from '@lexical/react/LexicalComposerContext';

function getCollabAssetAnchor(target: Node): HTMLAnchorElement | null {
  const el = typeof Element !== 'undefined' && target instanceof Element
    ? target
    : target.parentElement;
  const anchor = el?.closest('a[href^="collab-asset://"]');
  return anchor instanceof HTMLAnchorElement ? anchor : null;
}

export default function CollabAssetLinkPlugin(): null {
  const [editor] = useLexicalComposerContext();

  useEffect(() => {
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

    const onClick = (event: MouseEvent) => handle(event, b => b === 0);
    const onAuxClick = (event: MouseEvent) => handle(event, b => b === 1);

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
  }, [editor]);

  return null;
}
