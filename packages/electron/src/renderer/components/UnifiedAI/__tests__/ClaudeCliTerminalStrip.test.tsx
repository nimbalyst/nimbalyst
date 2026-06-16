// @vitest-environment jsdom
import React from 'react';
import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import { render, cleanup, act } from '@testing-library/react';
import { Provider, createStore } from 'jotai';
import { windowFocusedAtom } from '../../../store/atoms/windowFocus';

// Capture what the strip hands to TerminalPanel without pulling in xterm/ghostty.
// `isActive`/`panelVisible` true === "the genuine CLI is being launched".
const terminalProps: Array<{ isActive: boolean; panelVisible: boolean }> = [];
vi.mock('../../Terminal/TerminalPanel', () => ({
  TerminalPanel: (props: { isActive: boolean; panelVisible: boolean }) => {
    terminalProps.push({ isActive: props.isActive, panelVisible: props.panelVisible });
    return <div data-testid="terminal-panel" data-active={String(props.isActive)} />;
  },
}));

import { ClaudeCliTerminalStrip } from '../ClaudeCliTerminalStrip';

// Controllable IntersectionObserver: tests trigger an "on screen" entry on demand.
let intersectCallbacks: Array<(entries: Array<{ isIntersecting: boolean }>) => void> = [];
class MockIO {
  constructor(cb: (entries: Array<{ isIntersecting: boolean }>) => void) {
    intersectCallbacks.push(cb);
  }
  observe() {}
  disconnect() {}
}

function triggerOnScreen() {
  act(() => {
    for (const cb of intersectCallbacks) cb([{ isIntersecting: true }]);
  });
}

beforeEach(() => {
  terminalProps.length = 0;
  intersectCallbacks = [];
  (globalThis as unknown as { IntersectionObserver: typeof MockIO }).IntersectionObserver = MockIO;
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

const launched = () =>
  terminalProps.length > 0 && terminalProps[terminalProps.length - 1].isActive;

function renderStrip(store: ReturnType<typeof createStore>) {
  return render(
    <Provider store={store}>
      <ClaudeCliTerminalStrip sessionId="s1" workspacePath="/ws" />
    </Provider>,
  );
}

describe('ClaudeCliTerminalStrip - launches the CLI only when this is the focused window (NIM-849)', () => {
  it('does NOT launch when on-screen but this window is not the focused window', () => {
    // The app is active (so document.hasFocus() would be true here), but main
    // reports this window is not the OS-key window — the old gate misfired here.
    const store = createStore();
    store.set(windowFocusedAtom, false);
    renderStrip(store);
    triggerOnScreen();
    expect(launched()).toBe(false);
  });

  it('launches when on-screen and this is the focused window', () => {
    const store = createStore();
    store.set(windowFocusedAtom, true);
    renderStrip(store);
    triggerOnScreen();
    expect(launched()).toBe(true);
  });

  it('launches a background window once it actually becomes the focused window', () => {
    const store = createStore();
    store.set(windowFocusedAtom, false);
    renderStrip(store);
    triggerOnScreen();
    expect(launched()).toBe(false);

    // User brings the window forward -> main sends window:focus-changed=true,
    // the listener sets the atom, and the strip latches.
    act(() => {
      store.set(windowFocusedAtom, true);
    });
    expect(launched()).toBe(true);
  });
});
