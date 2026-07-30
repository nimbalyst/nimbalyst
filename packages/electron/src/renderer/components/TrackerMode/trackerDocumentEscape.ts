/**
 * Escape leaves the focused document view -- the keyboard half of the
 * "Collapse to tracker" button (plan: tracker-document-mode, checkbox 18).
 *
 * The document view listens on the window, so the rule has to be narrow: Escape
 * belongs to whatever transient thing is on screen first. A dialog, a context
 * menu, or a mention typeahead all consume it, and so does any text field the
 * user is in the middle of (the title input, the comment box, the search box) --
 * those treat Escape as "cancel this edit". Only when nothing else claims it
 * does Escape mean "leave the document".
 *
 * The body editor's contenteditable is deliberately *not* in that list: it has
 * no Escape behaviour of its own, and it holds focus nearly the whole time
 * someone is reading a document, so excluding it would make the shortcut
 * unreachable.
 */

/**
 * Transient surfaces that own Escape while they are open. Menus and listboxes
 * cover the floating-ui menus (including the panel picker and the Lexical
 * typeaheads); the dialog selectors cover modals.
 */
export const ESCAPE_BLOCKING_OVERLAY_SELECTOR = [
  '[role="dialog"]',
  '[role="alertdialog"]',
  '[aria-modal="true"]',
  '[role="menu"]',
  '[role="listbox"]',
  '.tracker-row-context-menu',
  '.tracker-document-panel-menu',
].join(', ');

/** Elements whose own Escape handling (cancel the edit) comes first. */
function isTextEntryElement(element: { tagName?: string } | null): boolean {
  if (!element) return false;
  const tag = element.tagName?.toUpperCase();
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT';
}

export interface EscapeScopeDocument {
  activeElement: { tagName?: string } | null;
  querySelector(selector: string): unknown;
}

export function shouldExitDocumentViewOnEscape(
  event: { key: string; defaultPrevented?: boolean },
  doc: EscapeScopeDocument,
): boolean {
  if (event.key !== 'Escape') return false;
  if (event.defaultPrevented) return false;
  if (isTextEntryElement(doc.activeElement)) return false;
  if (doc.querySelector(ESCAPE_BLOCKING_OVERLAY_SELECTOR)) return false;
  return true;
}
