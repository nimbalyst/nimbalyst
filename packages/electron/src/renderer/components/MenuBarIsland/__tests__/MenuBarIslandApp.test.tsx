import React from 'react';
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { getDefaultStore } from 'jotai';
import type { MenuBarIslandState } from '../../../../shared/menuBarIsland';
import { MENU_BAR_ISLAND_CHANNELS } from '../../../../shared/menuBarIsland';
import { emptyTrayPanelFeed } from '../../../../shared/traySessions';

/**
 * The strip's title is a click target inside the pin/drag handle.
 *
 * That nesting is the whole risk: the handle decides pin-vs-drag by watching a
 * complete press, so a title press that reached it would open the session *and*
 * toggle the pin on one click. Nothing about that is visible on screen -- both
 * outcomes look like "the session opened" -- which is why it is tested here.
 */

const atoms = vi.hoisted(() => ({ state: null as never, glyph: null as never }));

// The real listener module imports the renderer store barrel, which drags in
// the whole atom graph for a component that reads two atoms.
vi.mock('../../../store/listeners/menuBarIslandListeners', async () => {
  const { atom } = await import('jotai');
  atoms.state = atom(null) as never;
  atoms.glyph = atom<string | null>(null) as never;
  return {
    menuBarIslandStateAtom: atoms.state,
    menuBarIslandGlyphAtom: atoms.glyph,
    initMenuBarIslandListener: () => () => {},
  };
});
vi.mock('@nimbalyst/runtime/ui/icons/MaterialSymbol', () => ({ MaterialSymbol: () => null }));
vi.mock('@nimbalyst/runtime/ui/icons/ProviderIcons', () => ({ ProviderIcon: () => null }));

import { MenuBarIslandApp } from '../MenuBarIslandApp';
import { resizeIslandPanel } from '../IslandResizeHandles';

const send = vi.fn();

function namedFrame(): MenuBarIslandState {
  return {
    strip: {
      mode: 'named',
      sessionId: 'session-1',
      workspacePath: '/work/project',
      title: 'Daily GitHub issue triage',
      state: 'completed',
      age: { label: '2m', hot: false },
    },
    feed: emptyTrayPanelFeed(),
    snippets: {},
    expanded: true,
    anchor: 'center',
    panelSize: { width: 420, listHeight: 340 },
    settings: { style: 'island', showFleetStatus: true, osNotifications: true, preventSleep: null },
  };
}

beforeEach(() => {
  send.mockClear();
  (window as unknown as { electronAPI: unknown }).electronAPI = {
    send,
    on: () => () => {},
    invoke: async () => null,
  };
  // jsdom has neither, and the island uses both to publish its rect and to
  // hold a drag that leaves the window.
  global.ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as unknown as typeof ResizeObserver;
  Element.prototype.setPointerCapture = () => {};
  Element.prototype.hasPointerCapture = () => false;
  getDefaultStore().set(atoms.state, namedFrame() as never);
});

describe('MenuBarIslandApp', () => {
  it('opens the named session from the strip without also toggling the pin', () => {
    render(<MenuBarIslandApp />);

    const title = screen.getByTestId('menu-bar-island-strip-title');
    fireEvent.pointerDown(title);
    fireEvent.pointerUp(title);
    fireEvent.click(title);

    expect(send).toHaveBeenCalledWith(MENU_BAR_ISLAND_CHANNELS.selectSession, {
      sessionId: 'session-1',
      workspacePath: '/work/project',
    });
    const channels = send.mock.calls.map(([channel]) => channel);
    expect(channels).not.toContain(MENU_BAR_ISLAND_CHANNELS.dragStart);
    expect(channels).not.toContain(MENU_BAR_ISLAND_CHANNELS.dragEnd);
  });

  it('still reports a press on the rest of the pill as a press', () => {
    render(<MenuBarIslandApp />);

    const pill = screen.getByTestId('menu-bar-island-strip');
    fireEvent.pointerDown(pill);
    fireEvent.pointerUp(pill);

    const channels = send.mock.calls.map(([channel]) => channel);
    expect(channels).toContain(MENU_BAR_ISLAND_CHANNELS.dragStart);
    expect(channels).toContain(MENU_BAR_ISLAND_CHANNELS.dragEnd);
    expect(channels).not.toContain(MENU_BAR_ISLAND_CHANNELS.selectSession);
  });
});

describe('island panel resize', () => {
  const canvas = { width: 1200, height: 1100 };
  const start = { screenX: 500, screenY: 300, size: { width: 420, listHeight: 340 } };

  it('counts a side drag twice for a centred panel, which grows from both sides', () => {
    const next = resizeIslandPanel({ ...start, edge: 'right' }, { screenX: 550, screenY: 300 }, 'center', canvas);
    expect(next.width).toBe(520);
  });

  it('grows a notch-anchored panel leftward one-for-one from its left edge', () => {
    const next = resizeIslandPanel({ ...start, edge: 'left' }, { screenX: 450, screenY: 300 }, 'notch-left', canvas);
    expect(next.width).toBe(470);
  });

  it('clamps to the canvas and to the minimum size', () => {
    const big = resizeIslandPanel({ ...start, edge: 'bottom-right' }, { screenX: 2000, screenY: 3000 }, 'center', { width: 700, height: 600 });
    expect(big.width).toBe(700 - 80);
    expect(big.listHeight).toBe(600 - 30 - 40 - 40);

    const small = resizeIslandPanel({ ...start, edge: 'bottom-left' }, { screenX: 900, screenY: 0 }, 'center', canvas);
    expect(small.width).toBe(320);
    expect(small.listHeight).toBe(160);
  });

  it('a grip press resizes and never reaches the pill as a move or pin toggle', () => {
    render(<MenuBarIslandApp />);
    const grip = screen.getByTestId('menu-bar-island-resize-bottom-right');
    fireEvent.pointerDown(grip, { button: 0, pointerId: 1, screenX: 500, screenY: 300 });
    fireEvent.pointerUp(grip, { button: 0, pointerId: 1, screenX: 560, screenY: 340 });

    const channels = send.mock.calls.map(([channel]) => channel);
    expect(channels).toContain(MENU_BAR_ISLAND_CHANNELS.resizeStart);
    expect(channels).toContain(MENU_BAR_ISLAND_CHANNELS.resizeEnd);
    expect(channels).not.toContain(MENU_BAR_ISLAND_CHANNELS.dragStart);
  });
});
