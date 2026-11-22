/**
 * Where a page in a tab was scrolled, so Back and Forward in Pages return to
 * it. A page remounts when its tab navigates, so the offset is read from the
 * outgoing page's DOM and written back once the returning page has rendered.
 * Works for every kind of page: the scroller is whichever element inside the
 * tab the user scrolled, found again by its class.
 */

import { useCallback, useEffect, useRef } from 'react';
import type { PageScroll } from '../../contexts/tabHistory';
import type { TabData } from '../../contexts/TabsContext';

/**
 * Lends the tab host's elements to tab history: `setReader` is TabsContext's
 * `setPageScrollReader`, so leaving a page records its offset. Returns the
 * call the host makes after mounting a tab's page, which scrolls a page Back
 * or Forward returned to. Each return restores once, not on every remount.
 */
export function usePageScrollMemory(
  setReader: (reader: ((tabId: string) => PageScroll | undefined) | null) => void,
  getElement: (tabId: string) => HTMLElement | undefined,
): (tab: TabData) => void {
  const getElementRef = useRef(getElement);
  getElementRef.current = getElement;
  const restoredRef = useRef(new WeakSet<PageScroll>());

  useEffect(() => {
    setReader((tabId) => {
      const element = getElementRef.current(tabId);
      return element ? readPageScroll(element) : undefined;
    });
    return () => setReader(null);
  }, [setReader]);

  return useCallback((tab: TabData) => {
    const scroll = tab.restoreScroll;
    const element = getElementRef.current(tab.id);
    if (!scroll || !element || restoredRef.current.has(scroll)) return;
    restoredRef.current.add(scroll);
    restorePageScroll(element, scroll);
  }, []);
}

/** The outermost element under `root` that is scrolled down, or undefined when the page is at the top. */
export function readPageScroll(root: HTMLElement): PageScroll | undefined {
  // Document order puts an ancestor before its descendants, so the page's own
  // scroller wins over a scrolled code block or table inside it.
  for (const element of root.querySelectorAll<HTMLElement>('*')) {
    if (element.scrollTop > 0 && typeof element.className === 'string' && element.className.trim()) {
      return { scroller: element.className, top: element.scrollTop };
    }
  }
  return undefined;
}

function findScroller(root: HTMLElement, className: string): HTMLElement | null {
  const firstClass = className.trim().split(/\s+/)[0];
  for (const element of root.getElementsByClassName(firstClass)) {
    if (element.className === className) return element as HTMLElement;
  }
  return null;
}

export interface RestorePageScrollOptions {
  /** Give up after this long even if the page never grew tall enough. */
  timeoutMs?: number;
  /** Stop once the offset is reached and the page height held this long. */
  settleMs?: number;
  now?: () => number;
  requestFrame?: (callback: () => void) => unknown;
}

/**
 * Scrolls the page under `root` back to `scroll`. A page fills in after it
 * mounts (a shared page paints when its document arrives, diagrams render
 * late), so the offset is applied every frame until the page is tall enough
 * and its height stops changing. A vertical scroll, key, click or touch in
 * the tab hands control back to the user. Returns a cancel function.
 */
export function restorePageScroll(root: HTMLElement, scroll: PageScroll, options: RestorePageScrollOptions = {}): () => void {
  const {
    timeoutMs = 4000,
    settleMs = 300,
    now = () => performance.now(),
    requestFrame = (callback) => requestAnimationFrame(callback),
  } = options;
  const start = now();
  let done = false;
  let reachedHeight = -1;
  let reachedAt = 0;

  const stop = () => {
    if (done) return;
    done = true;
    for (const type of USER_INPUT) root.removeEventListener(type, stop, true);
    root.removeEventListener('wheel', onWheel, true);
  };
  // A trackpad swipe that went Back keeps sending horizontal wheel events
  // (the rest of the gesture, then momentum) into the page it landed on, so
  // only a vertical scroll is the user taking over.
  const onWheel = (event: WheelEvent) => {
    if (Math.abs(event.deltaY) > Math.abs(event.deltaX)) stop();
  };
  for (const type of USER_INPUT) root.addEventListener(type, stop, true);
  root.addEventListener('wheel', onWheel, true);

  const tick = () => {
    if (done) return;
    if (!root.isConnected || now() - start > timeoutMs) {
      stop();
      return;
    }
    const scroller = findScroller(root, scroll.scroller);
    if (scroller && scroller.scrollHeight - scroller.clientHeight >= scroll.top) {
      if (scroller.scrollTop !== scroll.top) scroller.scrollTop = scroll.top;
      if (scroller.scrollHeight !== reachedHeight) {
        reachedHeight = scroller.scrollHeight;
        reachedAt = now();
      } else if (now() - reachedAt >= settleMs) {
        stop();
        return;
      }
    }
    requestFrame(tick);
  };
  tick();
  return stop;
}

const USER_INPUT = ['keydown', 'pointerdown', 'touchstart'] as const;
