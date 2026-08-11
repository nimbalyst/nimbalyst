/**
 * The PanelHost handed to an extension panel must be a stable service object.
 *
 * Regression this pins: PanelContainer rebuilt `host` from the parent's inline
 * `onOpenPanel` / `onClose` callbacks, so every App render produced a new host.
 * The AI-context effect keys off `host`, so it re-ran and wrote
 * `extensionPanelAIContextAtom` with a fresh object literal; App subscribes to
 * that atom, so the write re-rendered App, which produced new inline callbacks,
 * which produced another host. That loop terminates at React's nested-update
 * limit with error #185 — and because it lives in PanelContainer's own effect
 * rather than in the panel, it escapes PanelErrorBoundary and blanks the whole
 * window. Only panels declaring `aiSupported` reach the effect body.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import React from 'react';
import { render, act } from '@testing-library/react';
import { Provider, useAtomValue } from 'jotai';

const mocks = vi.hoisted(() => ({ storageThrows: false }));

vi.mock('@nimbalyst/runtime', () => ({
  createExtensionStorage: () => {
    // Stands in for any failure in the container's own host wiring.
    if (mocks.storageThrows) throw new Error('storage boom');
    return {
      get: async () => null,
      set: async () => {},
      remove: async () => {},
      clear: async () => {},
    };
  },
}));

vi.mock('../../../hooks/useTheme', () => ({
  useTheme: () => ({ theme: 'dark' }),
}));

import { PanelContainer } from '../PanelContainer';
import { extensionPanelAIContextAtom } from '../../../store/atoms/extensionPanels';
import type { RegisteredPanel } from '../PanelRegistry';

let hostsSeen: unknown[] = [];

function RecordingPanel({ host }: { host: unknown }): React.JSX.Element {
  hostsSeen.push(host);
  return <div data-testid="recording-panel" />;
}

const panel = {
  id: 'com.locallead.ops-cockpit.needs-you',
  extensionId: 'com.locallead.ops-cockpit',
  title: 'Needs you',
  icon: 'notifications',
  placement: 'sidebar',
  aiSupported: true,
  order: 39,
  component: RecordingPanel,
} as unknown as RegisteredPanel;

/** Mirrors App.tsx: subscribes to the AI-context atom, passes inline callbacks. */
function AppLike(): React.JSX.Element {
  useAtomValue(extensionPanelAIContextAtom);
  return (
    <PanelContainer
      panel={panel}
      workspacePath="/ws"
      onOpenFile={() => {}}
      onOpenPanel={() => {}}
      onClose={() => {}}
    />
  );
}

describe('PanelContainer error containment', () => {
  beforeEach(() => {
    hostsSeen = [];
    mocks.storageThrows = false;
  });

  it('contains a failure in its own host wiring instead of blanking the window', async () => {
    mocks.storageThrows = true;
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});

    try {
      // If the throw escapes PanelContainer, render() rethrows and the window
      // is gone in the real app.
      const view = render(
        <Provider>
          <AppLike />
        </Provider>
      );

      expect(view.getByText('Panel Error')).toBeTruthy();
      expect(view.queryByTestId('recording-panel')).toBeNull();
    } finally {
      consoleError.mockRestore();
    }
  });
});

describe('PanelContainer host stability', () => {
  beforeEach(() => {
    hostsSeen = [];
    mocks.storageThrows = false;
  });

  it('does not loop when the parent subscribes to the AI-context atom', async () => {
    await act(async () => {
      render(
        <Provider>
          <AppLike />
        </Provider>
      );
    });

    // With the bug this never settles: React aborts at its nested-update limit.
    expect(hostsSeen.length).toBeLessThanOrEqual(2);
    expect(new Set(hostsSeen).size).toBe(1);
  });

  it('keeps one host across parent re-renders that pass new inline callbacks', async () => {
    function Parent({ tick }: { tick: number }): React.JSX.Element {
      // `tick` only exists to force a parent re-render; the inline callbacks
      // below are what change identity, exactly as they do in App.tsx.
      void tick;
      return (
        <PanelContainer
          panel={panel}
          workspacePath="/ws"
          onOpenFile={() => {}}
          onOpenPanel={() => {}}
          onClose={() => {}}
        />
      );
    }

    let view: ReturnType<typeof render>;
    await act(async () => {
      view = render(
        <Provider>
          <Parent tick={0} />
        </Provider>
      );
    });

    await act(async () => {
      view.rerender(
        <Provider>
          <Parent tick={1} />
        </Provider>
      );
    });

    expect(new Set(hostsSeen).size).toBe(1);
  });
});
