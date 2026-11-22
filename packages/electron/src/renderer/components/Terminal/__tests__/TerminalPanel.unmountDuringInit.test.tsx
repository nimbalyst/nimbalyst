// @vitest-environment jsdom
/**
 * GitHub #1818: closing a terminal panel while it is still starting up.
 *
 * Starting a terminal waits on slow steps (loading saved history, replaying it
 * in chunks). If the panel is removed during one of those waits, the start-up
 * code used to carry on anyway. It then tried to watch a screen element that no
 * longer existed, which the browser rejects, and the app logged a start-up error
 * for a terminal nobody was looking at.
 *
 * These tests remove the panel during each wait and check that start-up stops
 * quietly: no error is logged, nothing is left listening, and the terminal
 * engine that was already built is cleaned up.
 */
import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, render } from '@testing-library/react';

const engines = vi.hoisted(() => ({
  disposed: [] as number[],
  created: 0,
  writes: 0,
  // Called on every write; a test can use it to remove the panel mid-replay.
  onWrite: null as null | (() => void),
  // Called when the engine is attached to the page, before the backend starts.
  onOpen: null as null | (() => void),
}));

vi.mock('ghostty-web', () => {
  class FakeTerminal {
    id = ++engines.created;
    cols = 80;
    rows = 24;
    options: Record<string, unknown> = {};
    renderer = { setTheme: () => {} };
    buffer = { active: { length: 24, cursorX: 0, cursorY: 0, getLine: () => undefined } };
    loadAddon() {}
    open() {
      engines.onOpen?.();
    }
    write() {
      engines.writes += 1;
      engines.onWrite?.();
    }
    onData() {
      return { dispose: () => {} };
    }
    registerLinkProvider() {}
    scrollToBottom() {}
    focus() {}
    blur() {}
    dispose() {
      engines.disposed.push(this.id);
    }
  }
  class FakeFitAddon {
    fit() {}
    proposeDimensions() {
      return { cols: 80, rows: 24 };
    }
    dispose() {}
  }
  class FakeLinkProvider {}
  return {
    Terminal: FakeTerminal,
    FitAddon: FakeFitAddon,
    OSC8LinkProvider: FakeLinkProvider,
    UrlRegexProvider: FakeLinkProvider,
  };
});
vi.mock('../ghosttyInstance', () => ({
  loadTerminalGhostty: async () => ({}),
  isGhosttyWasmTrap: () => false,
  writeGuardingWasmTrap: (terminal: { write(data: string): void }, data: string) => {
    terminal.write(data);
    return true;
  },
}));
vi.mock('../terminalVisibility', () => ({
  isElementMeasurable: () => true,
  waitUntilElementMeasurable: async () => 'measurable',
  waitUntilTerminalPainted: async () => 'painted',
}));
vi.mock('../TerminalContextMenu', () => ({ TerminalContextMenu: () => null }));

import { TerminalPanel } from '../TerminalPanel';

type Snapshot = { sequence: number; scrollback?: string };

let resolveSnapshot: (snapshot: Snapshot) => void;
let rejectSnapshot: (error: Error) => void;
let snapshotRequested: Promise<void>;
let subscriptions: { name: string; unsubscribed: boolean }[];
let observed: unknown[];

function track(name: string) {
  return vi.fn(() => {
    const entry = { name, unsubscribed: false };
    subscriptions.push(entry);
    return () => {
      entry.unsubscribed = true;
    };
  });
}

beforeEach(() => {
  engines.disposed = [];
  engines.created = 0;
  engines.writes = 0;
  engines.onWrite = null;
  engines.onOpen = null;
  subscriptions = [];
  observed = [];

  // jsdom has no ResizeObserver. This stand-in rejects a missing element the way
  // the real browser does.
  class FakeResizeObserver {
    observe(target: unknown) {
      observed.push(target);
      if (!(target instanceof Element)) {
        throw new TypeError(
          "Failed to execute 'observe' on 'ResizeObserver': parameter 1 is not of type 'Element'."
        );
      }
    }
    disconnect() {}
  }
  (globalThis as unknown as { ResizeObserver: unknown }).ResizeObserver = FakeResizeObserver;

  let markRequested!: () => void;
  snapshotRequested = new Promise<void>((resolve) => {
    markRequested = resolve;
  });

  (window as unknown as { electronAPI: unknown }).electronAPI = {
    terminal: {
      initialize: vi.fn(async () => ({ success: true })),
      resize: vi.fn(),
      write: vi.fn(),
      updateRenderState: vi.fn(async () => {}),
      clearScrollback: vi.fn(),
      onOutput: track('onOutput'),
      onExited: track('onExited'),
      getRestoreSnapshot: vi.fn(
        () =>
          new Promise<Snapshot>((resolve, reject) => {
            resolveSnapshot = resolve;
            rejectSnapshot = reject;
            markRequested();
          })
      ),
    },
  };
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

async function flush() {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 20));
  });
}

function expectQuietShutdown(errorLog: ReturnType<typeof vi.spyOn>) {
  expect(errorLog).not.toHaveBeenCalled();
  expect(observed).toEqual([]);
  expect(engines.created).toBe(1);
  expect(engines.disposed).toEqual([1]);
  // Every listener the start-up code opened must have been closed again.
  expect(subscriptions.filter((s) => !s.unsubscribed)).toEqual([]);
}

describe('TerminalPanel removed while it is still starting up', () => {
  it('does not start the terminal backend when removed before it starts', async () => {
    const errorLog = vi.spyOn(console, 'error').mockImplementation(() => {});

    // Remove the panel as soon as the engine is attached to the page.
    let unmountPanel!: () => void;
    let markOpened!: () => void;
    const opened = new Promise<void>((resolve) => {
      markOpened = resolve;
    });
    engines.onOpen = () => {
      engines.onOpen = null;
      unmountPanel();
      markOpened();
    };
    const { unmount } = render(
      <TerminalPanel terminalId="t1" workspacePath="/proj" isActive panelVisible />
    );
    unmountPanel = unmount;
    await act(async () => {
      await opened;
    });
    await flush();

    const terminalApi = (window as unknown as {
      electronAPI: { terminal: { initialize: ReturnType<typeof vi.fn> } };
    }).electronAPI.terminal;
    expect(terminalApi.initialize).not.toHaveBeenCalled();
    expectQuietShutdown(errorLog);
  });

  it('stops quietly when removed while saved history is loading', async () => {
    const errorLog = vi.spyOn(console, 'error').mockImplementation(() => {});

    const { unmount } = render(
      <TerminalPanel terminalId="t1" workspacePath="/proj" isActive panelVisible />
    );
    await act(async () => {
      await snapshotRequested;
    });

    unmount();
    await act(async () => {
      resolveSnapshot({ sequence: 0 });
    });
    await flush();

    expectQuietShutdown(errorLog);
  });

  it('writes no saved history when removed before the history arrives', async () => {
    const errorLog = vi.spyOn(console, 'error').mockImplementation(() => {});

    const { unmount } = render(
      <TerminalPanel terminalId="t1" workspacePath="/proj" isActive panelVisible />
    );
    await act(async () => {
      await snapshotRequested;
    });

    // The history arrives after the panel is gone and has text to replay.
    unmount();
    await act(async () => {
      resolveSnapshot({ sequence: 0, scrollback: 'hello\r\n' });
    });
    await flush();

    expect(engines.writes).toBe(0);
    expectQuietShutdown(errorLog);
  });

  it('logs no start-up error when loading saved history fails after removal', async () => {
    const errorLog = vi.spyOn(console, 'error').mockImplementation(() => {});

    const { unmount } = render(
      <TerminalPanel terminalId="t1" workspacePath="/proj" isActive panelVisible />
    );
    await act(async () => {
      await snapshotRequested;
    });

    unmount();
    await act(async () => {
      rejectSnapshot(new Error('history unavailable'));
    });
    await flush();

    expectQuietShutdown(errorLog);
  });

  it('stops quietly when removed while saved history is being replayed', async () => {
    const errorLog = vi.spyOn(console, 'error').mockImplementation(() => {});

    const { unmount } = render(
      <TerminalPanel terminalId="t1" workspacePath="/proj" isActive panelVisible />
    );
    await act(async () => {
      await snapshotRequested;
    });

    // Remove the panel as soon as the first piece of history is written.
    engines.onWrite = () => {
      engines.onWrite = null;
      unmount();
    };
    await act(async () => {
      resolveSnapshot({ sequence: 0, scrollback: 'a'.repeat(40000) });
    });
    await flush();

    expectQuietShutdown(errorLog);
  });
});
