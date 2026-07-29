/**
 * Caret rectangle for a textarea, used as the virtual reference for the
 * mention and emoji autocompletes.
 *
 * A textarea exposes no caret geometry, so the standard technique is a mirror:
 * an off-screen div with the textarea's own typography and box metrics, filled
 * with the text up to the caret, ending in a zero-width marker whose position
 * is measurable. It is measured and discarded synchronously, so no mirror
 * outlives the call.
 *
 * When measurement is unavailable -- jsdom reports every rect as zero -- the
 * caller falls back to anchoring on the textarea itself. That is why this
 * returns null rather than a zero rect: a zero rect at the viewport origin
 * would silently park the picker in the top-left corner.
 */

const MIRRORED_PROPERTIES = [
  'boxSizing',
  'width',
  'paddingTop',
  'paddingRight',
  'paddingBottom',
  'paddingLeft',
  'borderTopWidth',
  'borderRightWidth',
  'borderBottomWidth',
  'borderLeftWidth',
  'fontFamily',
  'fontSize',
  'fontWeight',
  'fontStyle',
  'letterSpacing',
  'lineHeight',
  'textTransform',
  'wordSpacing',
  'tabSize',
] as const;

export function caretRect(textarea: HTMLTextAreaElement, caret: number): DOMRect | null {
  if (typeof window === 'undefined' || typeof window.getComputedStyle !== 'function') return null;

  const bounds = textarea.getBoundingClientRect();
  if (bounds.width === 0 && bounds.height === 0) return null;

  const computed = window.getComputedStyle(textarea);
  const mirror = document.createElement('div');
  const style = mirror.style;

  style.position = 'absolute';
  style.visibility = 'hidden';
  style.whiteSpace = 'pre-wrap';
  style.overflowWrap = 'break-word';
  style.top = '0';
  style.left = '-9999px';
  for (const property of MIRRORED_PROPERTIES) {
    style[property] = computed[property] as string;
  }

  mirror.textContent = textarea.value.slice(0, caret);
  const marker = document.createElement('span');
  // A zero-width space still gets a box, so the marker is measurable even when
  // the caret sits at the very end of the text.
  marker.textContent = '​';
  mirror.appendChild(marker);
  document.body.appendChild(mirror);

  const markerRect = marker.getBoundingClientRect();
  const mirrorRect = mirror.getBoundingClientRect();
  document.body.removeChild(mirror);

  if (markerRect.height === 0) return null;

  const x = bounds.left + (markerRect.left - mirrorRect.left) - textarea.scrollLeft;
  const y = bounds.top + (markerRect.top - mirrorRect.top) - textarea.scrollTop;

  return new DOMRect(x, y, 1, markerRect.height);
}
