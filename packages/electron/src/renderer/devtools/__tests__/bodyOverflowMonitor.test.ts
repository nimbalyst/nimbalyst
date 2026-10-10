import { describe, expect, it } from 'vitest';
import { findBodyOverflow } from '../bodyOverflowMonitor';

function child(body: HTMLElement, rect: Partial<DOMRect>, tag = 'div'): HTMLElement {
  const el = document.createElement(tag);
  const full = { top: 0, left: 0, bottom: 0, right: 0, width: 0, height: 0, x: 0, y: 0, ...rect };
  el.getBoundingClientRect = () => ({ ...full, toJSON: () => full }) as DOMRect;
  body.appendChild(el);
  return el;
}

describe('findBodyOverflow', () => {
  it('flags leaked containers below or right of the viewport, not parked or empty hosts', () => {
    const body = document.createElement('body');
    child(body, { bottom: 1122, right: 2048, width: 2048, height: 1122 }); // #root
    const below = child(body, { top: 1122, bottom: 1231, right: 2048, width: 2048, height: 109 }); // leaked mermaid div
    const tooltip = child(body, { top: 1122, bottom: 1128, right: 6, width: 6, height: 6 });
    const right = child(body, { bottom: 10, right: 2100, width: 100, height: 10 });
    child(body, { top: -9999, bottom: -9199, left: -9999, right: -8719, width: 1280, height: 800 }); // offscreen editors
    child(body, { top: 2000, bottom: 2000 }); // empty
    child(body, { top: 1122, bottom: 1300, width: 10, height: 178 }, 'script');

    expect(findBodyOverflow(body, 2048, 1122)).toEqual([below, tooltip, right]);
  });
});
