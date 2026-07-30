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

/** The same read, named for the component sources the markup checks cover. */
const readSource = readCss;

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

function isDragRegion(css: string, selector: string): boolean {
  return declarationsForSelector(withoutComments(css), selector)
    .some((block) => /-webkit-app-region:\s*drag/.test(block));
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
    // window has lost its only drag handle on Windows. The bar is styled with
    // Tailwind, so the declaration is an arbitrary-property class in the markup
    // rather than a rule in a stylesheet.
    const dragRegionSource = withoutComments(readSource('components/WindowTopBar/dragRegion.ts'));
    expect(dragRegionSource).toContain("DRAG_REGION = '[-webkit-app-region:drag]'");
    expect(dragRegionSource).toContain("NO_DRAG_REGION = '[-webkit-app-region:no-drag]'");

    const topBar = readSource('components/WindowTopBar/WindowTopBar.tsx');
    expect(topBar).toMatch(/className=\{`window-top-bar [^`]*\$\{DRAG_REGION\}`\}/);
  });

  it('opts every interactive control in the title bar out of the drag region', () => {
    // Buttons in the bar sit inside the drag strip, so each needs its own
    // opt-out; the menu bar's top-level items live there too.
    // Menu contents are exempt: they portal out and the global
    // `[data-floating-ui-portal] *` rule already covers them.
    const topBar = withoutComments(readSource('components/WindowTopBar/WindowTopBar.tsx'));
    const barControls = topBar.match(/className=\{`window-top-bar__(?:git |panel-button|panel-split |new-session)[^`]*`\}/g) ?? [];
    // Git status, the split shell and its two halves, the plain pane toggle,
    // and the new-session button.
    expect(barControls.length).toBe(6);
    for (const className of barControls) {
      expect(className).toContain('${NO_DRAG_REGION}');
    }
    expect(readSource('components/WindowTopBar/WindowMenuBar.tsx'))
      .toContain('window-menu-bar__top-item ${NO_DRAG_REGION}');
  });

  it('makes org-window chrome draggable and explicitly opts its controls out', () => {
    const orgWindowCss = readCss('components/TeamMode/TeamManagementWindow.css');
    expect(isDragRegion(
      orgWindowCss,
      '.team-management-window .org-window-drag-region',
    )).toBe(true);
    expect(optsOutOfDragRegion(
      orgWindowCss,
      '.team-management-window .org-window-no-drag',
    )).toBe(true);
  });

  it('opts every interactive element inside an org-window drag region out by kind', () => {
    // The sidebar and the rail are drag regions down to their whitespace, so a
    // control that forgets `.org-window-no-drag` is a button the OS eats. The
    // by-kind rules are the backstop that keeps that from being silent.
    const orgWindowCss = readCss('components/TeamMode/TeamManagementWindow.css');
    for (const kind of ['button', 'a', 'input', 'textarea', 'select', "[role='button']"]) {
      expect(optsOutOfDragRegion(
        orgWindowCss,
        `.team-management-window .org-window-drag-region ${kind}`,
      )).toBe(true);
    }
  });

  it('gives the org window a full-width title-bar strip for the traffic lights', () => {
    // Replaces the old per-column reservation (a 52px spacer inside the 64px
    // org rail plus padding on the sidebar header), which left the lights
    // crowded into one column and most of the chrome undraggable.
    const orgWindowCss = withoutComments(
      readCss('components/TeamMode/TeamManagementWindow.css'),
    );
    expect(declarationsForSelector(
      orgWindowCss,
      '.team-management-window .org-window-titlebar',
    ).join(' ')).toMatch(/height:\s*38px/);
    // macOS draws the lights over the strip, so the title needs to clear them;
    // every other platform keeps its native title bar and the plain gutter.
    expect(declarationsForSelector(
      orgWindowCss,
      '.team-management-window .org-window-titlebar',
    ).join(' ')).toMatch(/padding-left:\s*12px/);
    expect(declarationsForSelector(
      orgWindowCss,
      '.team-management-window-mac .org-window-titlebar',
    ).join(' ')).toMatch(/padding-left:\s*78px/);
    // The superseded reservations must not linger: two rules fighting over the
    // same clearance is how the lights ended up overlapping the rail.
    expect(declarationsForSelector(
      orgWindowCss,
      '.team-management-window-mac .org-rail-traffic-light-clearance',
    )).toHaveLength(0);
    expect(declarationsForSelector(
      orgWindowCss,
      '.team-management-window-mac .org-sidebar-header-single-org',
    )).toHaveLength(0);
  });

  it('marks the org title bar, sidebar and rail as drag regions in the markup', () => {
    // The CSS above only pays off if the elements still carry the class — the
    // window has no other drag handle.
    const dragRegionUsers: Array<[string, string]> = [
      ['components/TeamMode/TeamMode.tsx', 'org-window-titlebar org-sidebar-header org-window-drag-region'],
      ['components/TeamMode/OrgSidebar.tsx', 'org-sidebar org-window-drag-region'],
      ['components/TeamMode/OrgRail.tsx', 'org-rail org-window-drag-region'],
    ];
    for (const [file, marker] of dragRegionUsers) {
      expect(readSource(file)).toContain(marker);
    }
  });
});
