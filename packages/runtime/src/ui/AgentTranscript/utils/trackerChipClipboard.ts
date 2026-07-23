/**
 * Clipboard serialization for tracker-reference chips in the AI transcript.
 *
 * Transcript chips (`.tracker-reference-chip`, rendered by TrackerReferenceChip)
 * carry `user-select: none`, so the browser's native selection copy drops the
 * chip entirely — the issue key ("NIM-123") never reaches the clipboard, or
 * leaks out mangled (e.g. "NIM 123") via inter-box boundary whitespace. The
 * transcript has no copy handler, so the `nimbalyst://` reference is lost too.
 *
 * This helper rewrites a copied selection so every chip becomes its issue key in
 * `text/plain` and a `nimbalyst://` anchor in `text/html`. It returns `null`
 * when the selection contains no chips, so callers leave normal copies to the
 * browser.
 */

/** Root class of a rendered tracker-reference chip. */
export const TRACKER_CHIP_SELECTOR = '.tracker-reference-chip';

// Keep in sync with TRACKER_REFERENCE_URN_SCHEME in
// plugins/TrackerLinkPlugin/TrackerReferenceNode.tsx. Inlined so this pure DOM
// util (and its test) stay free of the Lexical/React import chain.
const TRACKER_REFERENCE_URN_SCHEME = 'nimbalyst://';

/**
 * Block-level tags that should introduce a line break when a cloned selection is
 * flattened to plain text, so multi-line selections (lists, paragraphs) keep
 * their line structure.
 */
const BLOCK_TAGS = new Set([
  'ADDRESS', 'ARTICLE', 'ASIDE', 'BLOCKQUOTE', 'DD', 'DIV', 'DL', 'DT',
  'FIGCAPTION', 'FIGURE', 'FOOTER', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6',
  'HEADER', 'HR', 'LI', 'MAIN', 'NAV', 'OL', 'P', 'PRE', 'SECTION', 'TABLE',
  'TR', 'UL',
]);

/** Resolve the issue key a chip should copy as, preferring the canonical attr. */
function issueKeyFromChip(chip: Element): string {
  const attr = chip.getAttribute('data-issue-key')?.trim();
  if (attr) return attr;
  const keySpan = chip.querySelector('.tracker-reference-chip-key');
  return (keySpan?.textContent ?? chip.textContent ?? '').trim();
}

/** Flatten a node tree to plain text, emitting newlines around block elements. */
function fragmentToPlainText(root: Node): string {
  let out = '';
  const visit = (node: Node): void => {
    node.childNodes.forEach((child) => {
      if (child.nodeType === Node.TEXT_NODE) {
        out += child.textContent ?? '';
        return;
      }
      if (child.nodeType !== Node.ELEMENT_NODE) return;
      const el = child as Element;
      if (el.tagName === 'BR') {
        out += '\n';
        return;
      }
      const isBlock = BLOCK_TAGS.has(el.tagName);
      if (isBlock && out.length > 0 && !out.endsWith('\n')) out += '\n';
      visit(el);
      if (isBlock && !out.endsWith('\n')) out += '\n';
    });
  };
  visit(root);
  return out
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/**
 * Given a cloned selection fragment, produce clipboard payloads in which each
 * tracker chip is replaced by its issue key (plain text) and a `nimbalyst://`
 * anchor (HTML). Returns `null` when the fragment has no chips.
 */
export function serializeSelectionWithTrackerChips(
  fragment: DocumentFragment,
): { text: string; html: string } | null {
  if (fragment.querySelector(TRACKER_CHIP_SELECTOR) == null) return null;

  const doc = fragment.ownerDocument ?? document;

  // Plain text: each chip becomes a bare "NIM-123" text node.
  const textRoot = fragment.cloneNode(true) as DocumentFragment;
  textRoot.querySelectorAll(TRACKER_CHIP_SELECTOR).forEach((chip) => {
    chip.replaceWith(doc.createTextNode(issueKeyFromChip(chip)));
  });
  const text = fragmentToPlainText(textRoot);

  // Rich text: each chip becomes a nimbalyst:// anchor so rich paste targets can
  // rebuild a live reference.
  const htmlRoot = fragment.cloneNode(true) as DocumentFragment;
  htmlRoot.querySelectorAll(TRACKER_CHIP_SELECTOR).forEach((chip) => {
    const key = issueKeyFromChip(chip);
    const anchor = doc.createElement('a');
    anchor.setAttribute('href', `${TRACKER_REFERENCE_URN_SCHEME}${key}`);
    anchor.textContent = key;
    chip.replaceWith(anchor);
  });
  const container = doc.createElement('div');
  container.appendChild(htmlRoot);
  const html = container.innerHTML;

  return { text, html };
}
