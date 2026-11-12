import React from 'react';
import { act, cleanup, render } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { WorkstreamSessionTabs } from '../WorkstreamSessionTabs';

vi.mock('jotai', () => ({ useAtomValue: (value: unknown) => value, useSetAtom: () => vi.fn() }));
vi.mock('@nimbalyst/runtime/ui/icons/MaterialSymbol', () => ({ MaterialSymbol: () => null }));
vi.mock('@nimbalyst/runtime/ui/icons/ProviderIcons', () => ({ ProviderIcon: () => null }));
vi.mock('@nimbalyst/runtime/store', () => ({ store: { get: vi.fn() } }));
vi.mock('../../../store/atoms/sessions', () => ({
  sessionArchivedAtom: () => false, sessionRegistryAtom: null,
}));
vi.mock('../../../store', () => ({
  sessionTitleAtom: (id: string) => id, sessionProviderAtom: () => 'claude',
  sessionProcessingAtom: () => false, sessionUnreadAtom: () => false, createChildSessionAtom: null,
}));
vi.mock('../../../store/atoms/appSettings', () => ({ defaultAgentModelAtom: null }));
vi.mock('../../../store/atoms/workstreamState', () => ({ workstreamHasChildrenAtom: () => true }));
vi.mock('../AgentSessionPanel', () => ({ AgentSessionPanel: () => null }));
vi.mock('../../AgenticCoding/SessionContextMenu', () => ({ SessionContextMenu: () => null }));

const props = { workspacePath: '/test', workstreamId: 'a', sessions: ['a', 'b', 'c'], onSessionSelect: vi.fn() };
let resized: () => void;
const disconnect = vi.fn();

beforeEach(() => {
  vi.stubGlobal('ResizeObserver', class {
    constructor(callback: () => void) { resized = callback; }
    observe() {}
    disconnect = disconnect;
  });
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

function setGeometry(container: HTMLElement) {
  const scroll = container.querySelector<HTMLElement>('.session-tabs-scroll')!;
  // jsdom has no layout: supply an overflowing viewport and tab positions.
  let width = 300;
  Object.defineProperties(scroll, {
    clientWidth: { get: () => width }, scrollWidth: { get: () => 600 },
  });
  vi.spyOn(scroll, 'getBoundingClientRect').mockImplementation(() => ({ left: 0, right: width }) as DOMRect);
  container.querySelectorAll<HTMLElement>('.session-tab').forEach((tab, i) => {
    vi.spyOn(tab, 'getBoundingClientRect').mockImplementation(() => ({
      left: i * 200 - scroll.scrollLeft, right: (i + 1) * 200 - scroll.scrollLeft,
    }) as DOMRect);
  });
  return { scroll, resize: (next: number) => { width = next; act(() => resized()); } };
}

describe('workstream session tab navigation', () => {
  it('reveals externally selected tabs and keeps them visible after resizing without resetting manual scrolling on rerender', () => {
    const view = render(<WorkstreamSessionTabs {...props} activeSessionId="a" />);
    const { scroll, resize } = setGeometry(view.container);
    view.rerender(<WorkstreamSessionTabs {...props} activeSessionId="c" />);
    expect(scroll.scrollLeft).toBe(300);
    resize(250);
    expect(scroll.scrollLeft).toBe(350);
    resize(150);
    expect(scroll.scrollLeft).toBe(400); // Oversized tab stays aligned at its start.
    scroll.scrollLeft = 100;
    view.rerender(<WorkstreamSessionTabs {...props} sessions={[...props.sessions]} activeSessionId="c" />);
    expect(scroll.scrollLeft).toBe(100);
    view.rerender(<WorkstreamSessionTabs {...props} activeSessionId="a" />);
    expect(scroll.scrollLeft).toBe(0);
    view.unmount();
    expect(disconnect).toHaveBeenCalled();
  });

  it('maps vertical mouse wheels to horizontal scrolling while preserving trackpad and zoom gestures', () => {
    const { container } = render(<WorkstreamSessionTabs {...props} activeSessionId="a" />);
    const { scroll } = setGeometry(container);
    const wheel = (init: WheelEventInit) => {
      const event = new WheelEvent('wheel', { bubbles: true, cancelable: true, ...init });
      scroll.dispatchEvent(event);
      return event.defaultPrevented;
    };
    expect(wheel({ deltaY: 3, deltaMode: 1 })).toBe(true);
    expect(scroll.scrollLeft).toBe(48);
    expect(wheel({ deltaX: 60, deltaY: 10 })).toBe(false);
    expect(wheel({ deltaY: 100, ctrlKey: true })).toBe(false);
    expect(scroll.scrollLeft).toBe(48);
    wheel({ deltaY: 1000 });
    expect(scroll.scrollLeft).toBe(300);
    expect(wheel({ deltaY: 100 })).toBe(false);
  });
});
