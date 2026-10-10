/**
 * How a browser host opens a console link met in a document (a link to
 * another page, a chip for a Personal page): the console routes it in its own
 * tab, as a page link opens in place on the desktop. A Cmd/Ctrl or middle click
 * on a plain link still opens a new browser tab. Without a host opener the
 * link is an ordinary link.
 *
 * An `@` reference to a team page is a chip, not a link: it stores the page as
 * `nimbalyst://doc/<id>` (or a `collab://` uri), which no browser can follow.
 * The host's page reference opener takes the page id and decides where it goes.
 */

import { parseCollabReferenceDocumentId } from '@nimbalyst/runtime/plugins/DocumentLinkPlugin/documentLinkPaths';
import { setHostLinkOpener } from '@nimbalyst/runtime/editor/utils/workspaceLinkNavigation';

/** Returns true when the host opened the link itself. */
export type ConsoleLinkOpener = (href: string) => boolean;

/** Opens a team page by id; `newTab` is true for a Cmd/Ctrl or middle click. */
export type PageReferenceOpener = (documentId: string, options: { newTab: boolean }) => void;

let opener: ConsoleLinkOpener | undefined;
let pageReferenceOpener: PageReferenceOpener | undefined;

/** Installs the host's opener; the returned function removes it. */
export function setConsoleLinkOpener(next: ConsoleLinkOpener): () => void {
  opener = next;
  const removeLinkOpener = setHostLinkOpener((url, { newTab }) => !newTab && next(url));
  return () => {
    removeLinkOpener();
    if (opener === next) opener = undefined;
  };
}

export function openConsoleLink(href: string): boolean {
  return opener?.(href) ?? false;
}

/** Installs the host's page reference opener; the returned function removes it. */
export function setPageReferenceOpener(next: PageReferenceOpener): () => void {
  pageReferenceOpener = next;
  return () => {
    if (pageReferenceOpener === next) pageReferenceOpener = undefined;
  };
}

/**
 * Opens the team page reference chip a click landed on, if any. A drag that
 * selects text across the chip is a selection, not a click.
 */
export function openClickedPageReference(event: MouseEvent): void {
  if (!pageReferenceOpener || (event.button !== 0 && event.button !== 1)) return;
  const target = event.target;
  const element = target instanceof Element ? target : target instanceof Node ? target.parentElement : null;
  const chip = element?.closest('.document-reference[data-path]');
  if (!chip) return;
  const documentId = parseCollabReferenceDocumentId(chip.getAttribute('data-path'));
  if (!documentId) return;
  const selection = chip.ownerDocument.getSelection();
  if (selection && !selection.isCollapsed) return;
  event.preventDefault();
  pageReferenceOpener(documentId, { newTab: event.button === 1 || event.metaKey || event.ctrlKey });
}
