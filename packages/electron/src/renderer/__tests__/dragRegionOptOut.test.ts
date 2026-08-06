// @vitest-environment jsdom
/**
 * Guards the title-bar drag-region opt-out (NIM-2243, GitHub #1052).
 *
 * `.window-top-bar` is a full-width `-webkit-app-region: drag` strip. On Windows
 * (`titleBarStyle: 'hidden'`) Electron reports that rectangle to the OS as
 * HTCAPTION, so the OS eats the mouse event and the renderer never sees a click.
 * `-webkit-app-region` is not inherited and Blink only subtracts rectangles that
 * declare `no-drag`, so every interactive control painted inside the strip must
 * opt out itself. Adding a button to the bar and forgetting the opt-out is the
 * regression this catches, and it is invisible on macOS (where the frame is
 * `hiddenInset` and the bug does not reproduce).
 *
 * The OS-level behaviour itself cannot be driven here — jsdom does not implement
 * `-webkit-app-region`, and synthetic clicks inject past the non-client hit test.
 * So this renders the real bar and asserts the opt-out is declared on everything
 * clickable in it, which is the part that regresses silently.
 */

import { createElement } from 'react';
import { render } from '@testing-library/react';
import { Provider as JotaiProvider, createStore } from 'jotai';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { windowMenuBarAtom } from '../store/atoms/windowMenu';
import { WindowTopBar } from '../components/WindowTopBar/WindowTopBar';
import { DRAG_REGION, NO_DRAG_REGION } from '../components/WindowTopBar/dragRegion';

vi.mock('@nimbalyst/runtime', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@nimbalyst/runtime')>()),
  MaterialSymbol: ({ icon }: { icon: string }) => createElement('span', { 'data-icon': icon }),
}));

/** Anything the user can click, focus or type into. */
const INTERACTIVE = 'button, a, input, textarea, select, [role="button"], [role="menuitem"]';

function renderFullBar(): HTMLElement {
  const store = createStore();
  // Windows/Linux draw the application menu inside the strip too.
  store.set(windowMenuBarAtom, {
    revision: 1,
    inWindow: true,
    items: [{ id: '0', label: 'File', type: 'submenu', enabled: true, submenu: [] }],
  });

  const { container } = render(
    createElement(
      JotaiProvider,
      { store },
      createElement(WindowTopBar, {
        workspaceName: 'crystal',
        activeModeLabel: 'Files',
        gitStatus: { branch: 'main', ahead: 1, behind: 1, hasUncommitted: true },
        gitActions: { onPull: vi.fn(), onPush: vi.fn(), onOpenLog: vi.fn() },
        newSessionControl: { label: 'New session', onCreate: vi.fn() },
        panelControls: {
          left: { label: 'Sidebar', collapsed: false, onToggle: vi.fn() },
          // The split control: a toggle half plus a caret half inside a wrapper.
          right: {
            label: 'Panel',
            collapsed: false,
            onToggle: vi.fn(),
            options: [
              { id: 'chat', label: 'Chat', icon: 'chat', selected: true, onSelect: vi.fn() },
            ],
          },
        },
      }),
    ),
  );

  return container.querySelector<HTMLElement>('.window-top-bar')!;
}

describe('title-bar drag-region opt-out', () => {
  it('draws the bar as a drag region and opts every control in it out', () => {
    const bar = renderFullBar();

    expect(bar.className).toContain(DRAG_REGION);

    const controls = Array.from(bar.querySelectorAll<HTMLElement>(INTERACTIVE));
    // Guards against the selector silently matching nothing, which would make
    // the check below vacuously pass.
    expect(controls.length).toBeGreaterThan(0);

    const missing = controls
      .filter((control) => !control.className.includes(NO_DRAG_REGION))
      .map((control) => control.outerHTML.slice(0, 160));
    expect(missing).toEqual([]);
  });

  it('opts every @floating-ui portal out of the drag region', () => {
    // Menus and popovers portal to document.body, so they are not descendants of
    // the bar — one global rule covers all of them instead. jsdom loads no
    // stylesheets, so the rule can only be checked in the sheet that declares it.
    // The descendant part matters: a portal root and any wrapper around an
    // absolutely-positioned child are zero-height, so opting out only the root
    // subtracts an empty rectangle and fixes nothing.
    const globalCss = readFileSync(join(__dirname, '..', 'index.css'), 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '');

    expect(globalCss).toMatch(
      /\[data-floating-ui-portal\],\s*\[data-floating-ui-portal\] \*\s*\{[^}]*-webkit-app-region:\s*no-drag/,
    );
  });
});
