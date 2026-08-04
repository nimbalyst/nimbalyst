/**
 * DOM decoration this host applies once the editor has mounted.
 *
 * Both adjustments exist because the editor renders inside an ordinary web page
 * rather than the desktop shell. Neither needs a teardown: they are writes on
 * nodes the editor owns, so they go away when it does.
 */
export function applyBrowserEditorChrome(element: HTMLElement): void {
  // Content areas opt in to selection; without this a reader in a browser tab
  // cannot select or copy the prose they came to read.
  element.querySelector<HTMLElement>('.editor-scroller')?.classList.add('select-text');
  // Remote carets and their name labels are a visual echo of information the
  // participant list and the presence announcements already carry. Left
  // exposed they inject collaborators' names into the middle of the prose a
  // screen reader is reading, with no indication of what they are.
  element.querySelector<HTMLElement>('.collab-cursors-container')
    ?.setAttribute('aria-hidden', 'true');
}
