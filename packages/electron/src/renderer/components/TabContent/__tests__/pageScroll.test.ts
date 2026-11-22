// @vitest-environment jsdom
import { describe, it, expect } from 'vitest';
import { readPageScroll, restorePageScroll } from '../pageScroll';

/** A scroller jsdom can lay out: its content height is set by the test. */
function scroller(className: string, clientHeight = 500) {
  const element = document.createElement('div');
  element.className = className;
  let top = 0;
  const box = { scrollHeight: clientHeight };
  Object.defineProperty(element, 'clientHeight', { get: () => clientHeight });
  Object.defineProperty(element, 'scrollHeight', { get: () => box.scrollHeight });
  Object.defineProperty(element, 'scrollTop', {
    get: () => top,
    set: (value: number) => { top = Math.max(0, Math.min(value, box.scrollHeight - clientHeight)); },
  });
  return { element, setContentHeight: (height: number) => { box.scrollHeight = height; } };
}

/** Frames and time the test steps by hand. */
function frames() {
  let time = 0;
  let pending: Array<() => void> = [];
  return {
    now: () => time,
    requestFrame: (callback: () => void) => { pending.push(callback); },
    advance(ms: number) {
      time += ms;
      const run = pending;
      pending = [];
      run.forEach((callback) => callback());
    },
    get waiting() { return pending.length > 0; },
  };
}

describe('page scroll memory', () => {
  it('reads the outermost scrolled element, not a scrolled block inside the page', () => {
    const root = document.createElement('div');
    const page = scroller('editor-scroller flex-1');
    const codeBlock = scroller('code-excerpt-diff');
    page.element.appendChild(codeBlock.element);
    root.appendChild(page.element);
    page.setContentHeight(3000);
    codeBlock.setContentHeight(900);
    codeBlock.element.scrollTop = 50;
    expect(readPageScroll(root)).toEqual({ scroller: 'code-excerpt-diff', top: 50 });
    page.element.scrollTop = 1200;
    expect(readPageScroll(root)).toEqual({ scroller: 'editor-scroller flex-1', top: 1200 });
  });

  it('waits for the returning page to grow tall enough, holds the offset while it settles, then stops', () => {
    const root = document.createElement('div');
    document.body.appendChild(root);
    const clock = frames();
    // The page mounts empty: a shared page paints when its document arrives.
    restorePageScroll(root, { scroller: 'editor-scroller', top: 1200 }, { now: clock.now, requestFrame: clock.requestFrame, settleMs: 300 });
    const page = scroller('editor-scroller');
    root.appendChild(page.element);
    clock.advance(16);
    expect(page.element.scrollTop).toBe(0);

    page.setContentHeight(3000);
    clock.advance(16);
    expect(page.element.scrollTop).toBe(1200);
    // Layout moves it (a diagram renders); the offset is put back.
    page.element.scrollTop = 900;
    clock.advance(16);
    expect(page.element.scrollTop).toBe(1200);

    clock.advance(400);
    expect(clock.waiting).toBe(false);
    root.remove();
  });

  it('keeps restoring through the tail of the swipe that went Back, and hands the page back on a vertical scroll', () => {
    const root = document.createElement('div');
    document.body.appendChild(root);
    const page = scroller('editor-scroller');
    root.appendChild(page.element);
    const clock = frames();
    restorePageScroll(root, { scroller: 'editor-scroller', top: 1200 }, { now: clock.now, requestFrame: clock.requestFrame });
    // The swipe's remaining horizontal events and momentum land on the returning page.
    page.element.dispatchEvent(new WheelEvent('wheel', { bubbles: true, deltaX: -30, deltaY: 2 }));
    page.setContentHeight(3000);
    clock.advance(16);
    expect(page.element.scrollTop).toBe(1200);

    page.element.dispatchEvent(new WheelEvent('wheel', { bubbles: true, deltaX: 0, deltaY: 40 }));
    page.element.scrollTop = 1240;
    clock.advance(16);
    expect(page.element.scrollTop).toBe(1240);
    expect(clock.waiting).toBe(false);
    root.remove();
  });
});
