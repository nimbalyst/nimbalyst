// @vitest-environment jsdom
import { describe, it, expect } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import { useEditorMaximize } from '../useEditorMaximize';

/**
 * Simulates a mode's panel state so the adapter reads live values, mirroring
 * how the real modes read Jotai/useState on each render.
 */
function makePanels(initial: { sidebar: boolean; chat: boolean }) {
  const state = { ...initial };
  return {
    state,
    adapter: {
      snapshot: () => ({ ...state }),
      maximize: () => {
        state.sidebar = true;
        state.chat = true;
      },
      restore: (snap: { sidebar: boolean; chat: boolean }) => {
        state.sidebar = snap.sidebar;
        state.chat = snap.chat;
      },
    },
  };
}

describe('useEditorMaximize', () => {
  it('starts un-maximized', () => {
    const { adapter } = makePanels({ sidebar: false, chat: false });
    const { result } = renderHook(() => useEditorMaximize(adapter));
    expect(result.current.isMaximized).toBe(false);
  });

  it('maximizes then restores the exact prior state', () => {
    // Sidebar already collapsed, chat open, before maximizing.
    const panels = makePanels({ sidebar: true, chat: false });
    const { result } = renderHook(() => useEditorMaximize(panels.adapter));

    act(() => result.current.toggle());
    expect(result.current.isMaximized).toBe(true);
    expect(panels.state).toEqual({ sidebar: true, chat: true });

    act(() => result.current.toggle());
    expect(result.current.isMaximized).toBe(false);
    // Restores to the pre-maximize snapshot: sidebar stays collapsed, chat reopens.
    expect(panels.state).toEqual({ sidebar: true, chat: false });
  });

  it('clearMaximize drops the snapshot so the next toggle re-maximizes', () => {
    const panels = makePanels({ sidebar: false, chat: false });
    const { result } = renderHook(() => useEditorMaximize(panels.adapter));

    act(() => result.current.toggle()); // maximize -> both collapsed
    // User manually reopens the chat while maximized.
    panels.state.chat = false;
    act(() => result.current.clearMaximize());
    expect(result.current.isMaximized).toBe(false);

    // Next toggle snapshots the CURRENT (chat-open) state, not the stale one.
    act(() => result.current.toggle());
    expect(panels.state).toEqual({ sidebar: true, chat: true });
    act(() => result.current.toggle());
    expect(panels.state).toEqual({ sidebar: true, chat: false });
  });

  it('clearMaximize is a no-op when not maximized', () => {
    const panels = makePanels({ sidebar: false, chat: false });
    const { result } = renderHook(() => useEditorMaximize(panels.adapter));
    act(() => result.current.clearMaximize());
    expect(result.current.isMaximized).toBe(false);
    expect(panels.state).toEqual({ sidebar: false, chat: false });
  });

  it('clears a pending restore snapshot when the scope changes', () => {
    const firstScope = makePanels({ sidebar: false, chat: false });
    const secondScope = makePanels({ sidebar: true, chat: false });

    const { result, rerender } = renderHook(
      ({ scopeKey, adapter }) => useEditorMaximize({ scopeKey, ...adapter }),
      {
        initialProps: {
          scopeKey: 'workstream-a',
          adapter: firstScope.adapter,
        },
      },
    );

    act(() => result.current.toggle());
    expect(result.current.isMaximized).toBe(true);
    expect(firstScope.state).toEqual({ sidebar: true, chat: true });

    rerender({ scopeKey: 'workstream-b', adapter: secondScope.adapter });
    expect(result.current.isMaximized).toBe(false);

    act(() => result.current.toggle());
    expect(firstScope.state).toEqual({ sidebar: true, chat: true });
    expect(secondScope.state).toEqual({ sidebar: true, chat: true });

    act(() => result.current.toggle());
    expect(secondScope.state).toEqual({ sidebar: true, chat: false });
  });
});
