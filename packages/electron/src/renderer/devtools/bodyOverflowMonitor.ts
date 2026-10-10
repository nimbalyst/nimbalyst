/**
 * Dev-only warning for elements left in <body> outside the viewport.
 *
 * index.css clips <body> so a leaked element can no longer scroll the window,
 * which also hides the leak. Libraries that render into temp containers on
 * <body> (mermaid did, one error SVG per failed diagram) still grow the DOM,
 * so this names them in the renderer log instead of letting them pile up
 * unseen.
 */

const CHECK_DELAY_MS = 1000;

export function describeElement(el: Element): string {
  const id = el.id ? `#${el.id}` : '';
  const cls = typeof el.className === 'string' && el.className.trim()
    ? `.${el.className.trim().split(/\s+/).slice(0, 2).join('.')}`
    : '';
  return `${el.tagName.toLowerCase()}${id}${cls}`;
}

/**
 * Direct <body> children that extend past the bottom or right edge of the
 * viewport. Hosts parked at negative offsets (offscreen editors) never qualify.
 */
export function findBodyOverflow(body: HTMLElement, viewportWidth: number, viewportHeight: number): Element[] {
  const offenders: Element[] = [];
  for (const el of Array.from(body.children)) {
    if (el.tagName === 'SCRIPT' || el.tagName === 'STYLE') continue;
    const rect = el.getBoundingClientRect();
    if (rect.width === 0 && rect.height === 0) continue;
    if (rect.bottom > viewportHeight + 1 || rect.right > viewportWidth + 1) {
      offenders.push(el);
    }
  }
  return offenders;
}

export function installBodyOverflowMonitor(): void {
  const reported = new WeakSet<Element>();
  let timer: ReturnType<typeof setTimeout> | null = null;

  const check = () => {
    timer = null;
    for (const el of findBodyOverflow(document.body, window.innerWidth, window.innerHeight)) {
      if (reported.has(el)) continue;
      reported.add(el);
      const rect = el.getBoundingClientRect();
      console.warn(
        `[BodyOverflow] <body> child ${describeElement(el)} extends outside the viewport ` +
        `(bottom=${Math.round(rect.bottom)} right=${Math.round(rect.right)}, viewport ${window.innerWidth}x${window.innerHeight}). ` +
        'Likely a leaked library container.',
      );
    }
  };

  new MutationObserver(() => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(check, CHECK_DELAY_MS);
  }).observe(document.body, { childList: true });
}
