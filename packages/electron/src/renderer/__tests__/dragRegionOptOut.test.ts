/**
 * Guards the title-bar drag-region opt-out for floating surfaces (NIM-2243,
 * GitHub #1052).
 *
 * `.window-top-bar` is a full-width `-webkit-app-region: drag` strip. On Windows
 * (`titleBarStyle: 'hidden'`) Electron reports that rectangle to the OS as
 * HTCAPTION, so the OS consumes the mouse event as a title-bar drag and the
 * renderer never sees a click. Blink only subtracts rectangles that explicitly
 * declare `no-drag`, and `-webkit-app-region` is not inherited — so a popup
 * painted over the strip is unclickable unless it opts out itself.
 *
 * The behaviour is enforced by the OS window manager, which no test environment
 * here can drive: jsdom does not implement `-webkit-app-region`, and synthetic
 * clicks (jsdom, Playwright, CDP) inject straight into Blink's input pipeline,
 * bypassing the non-client hit test that causes the bug. The mechanism was
 * verified by hand instead — a plain element over the drag strip swallowed real
 * clicks, the same element with `no-drag` received them. So this asserts the
 * opt-out rules still exist, which is the part that can regress silently.
 */

import { describe, expect, it } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';

const RENDERER_ROOT = join(__dirname, '..');

function readCss(relativePath: string): string {
  return readFileSync(join(RENDERER_ROOT, relativePath), 'utf8');
}

/** Strip comments so prose about `no-drag` can't satisfy an assertion. */
function withoutComments(css: string): string {
  return css.replace(/\/\*[\s\S]*?\*\//g, '');
}

/** The declarations of every rule whose selector list matches `selector`. */
function declarationsForSelector(css: string, selector: string): string[] {
  const blocks: string[] = [];
  const rulePattern = /([^{}]+)\{([^{}]*)\}/g;
  let match: RegExpExecArray | null;
  while ((match = rulePattern.exec(css)) !== null) {
    const selectors = match[1].split(',').map((s) => s.trim());
    if (selectors.includes(selector)) blocks.push(match[2]);
  }
  return blocks;
}

function optsOutOfDragRegion(css: string, selector: string): boolean {
  return declarationsForSelector(withoutComments(css), selector)
    .some((block) => /-webkit-app-region:\s*no-drag/.test(block));
}

describe('title-bar drag-region opt-out', () => {
  const globalCss = readCss('index.css');

  it('opts every @floating-ui portal out of the drag region', () => {
    // Covers every popover/tooltip/menu built on @floating-ui in one rule.
    expect(optsOutOfDragRegion(globalCss, '[data-floating-ui-portal]')).toBe(true);
    // The descendant selector matters: the portal root and any wrapper around an
    // absolutely-positioned child are zero-height, so opting out only the root
    // subtracts an empty rectangle and fixes nothing.
    expect(optsOutOfDragRegion(globalCss, '[data-floating-ui-portal] *')).toBe(true);
  });

  it.each([
    ['.generic-typeahead'],
    ['.session-context-menu'],
    ['.walkthrough-callout'],
  ])('opts %s out of the drag region', (selector) => {
    // Interactive surfaces that portal to document.body by hand, so they carry
    // no portal attribute for the rule above to match on.
    expect(optsOutOfDragRegion(globalCss, selector)).toBe(true);
  });

  it('opts the project rail menus out of the drag region', () => {
    // The reported surface: the add menu is bottom-aligned to the `+` button and
    // grows upward, so with a few recents `shift()` clamps it against the top of
    // the viewport and "Open folder…" lands inside the title bar.
    const railCss = readCss('components/ProjectRail.css');
    expect(optsOutOfDragRegion(railCss, '.project-rail-context-menu')).toBe(true);
  });

  it('still draws the title bar as a drag region', () => {
    // If this ever stops being true the rules above are dead weight, and the
    // window has lost its only drag handle on Windows.
    const topBarCss = readCss('components/WindowTopBar/WindowTopBar.css');
    const declarations = declarationsForSelector(withoutComments(topBarCss), '.window-top-bar');
    expect(declarations.some((block) => /-webkit-app-region:\s*drag/.test(block))).toBe(true);
  });
});
