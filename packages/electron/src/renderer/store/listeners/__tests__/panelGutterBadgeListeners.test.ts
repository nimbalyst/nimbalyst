// @vitest-environment node
/**
 * Backend-set panel gutter badges: main's `extension-panels:gutter-badge`
 * broadcast lands in the panelGutterBadges store for the active workspace,
 * follows the multi-project rail, replays what main held before this window
 * mounted, and is not pruned before the panel registers.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { atom } from 'jotai';

vi.mock('../../atoms/openProjects', () => ({ activeWorkspacePathAtom: atom<string | null>(null) }));

import { store } from '@nimbalyst/runtime/store';
import { activeWorkspacePathAtom } from '../../atoms/openProjects';
import { initPanelGutterBadgeListeners } from '../panelGutterBadgeListeners';
import {
  getPanelGutterBadge,
  prunePanelGutterBadges,
  setPanelGutterBadge,
} from '../../../extensions/panels/panelGutterBadges';

const PANEL = 'com.example.owner.desk';
let broadcast: (update: unknown) => void;
let replay: (rows: unknown[]) => void;
let cleanup: () => void;

beforeEach(() => {
  let resolveReplay!: (rows: unknown[]) => void;
  const snapshot = new Promise<unknown[]>((resolve) => (resolveReplay = resolve));
  replay = resolveReplay;
  (globalThis as { window?: unknown }).window = {
    electronAPI: {
      on: (channel: string, cb: (update: unknown) => void) => {
        if (channel === 'extension-panels:gutter-badge') broadcast = cb;
        return () => {};
      },
      invoke: (channel: string) =>
        channel === 'extension-panels:get-gutter-badges' ? snapshot : Promise.reject(new Error(channel)),
    },
  };
  store.set(activeWorkspacePathAtom, '/a');
  cleanup = initPanelGutterBadgeListeners();
});

afterEach(() => {
  cleanup();
  setPanelGutterBadge(PANEL, null);
  delete (globalThis as { window?: unknown }).window;
});

describe('panel gutter badge listener', () => {
  it('shows the active workspace\'s badge with no panel mounted, and survives a prune before the panel registers', () => {
    broadcast({ workspacePath: '/a', panelId: PANEL, value: 4, tone: 'warning' });
    expect(getPanelGutterBadge(PANEL)).toEqual({ count: 4, tone: 'warning' });

    prunePanelGutterBadges(new Set());
    expect(getPanelGutterBadge(PANEL)).toEqual({ count: 4, tone: 'warning' });
    prunePanelGutterBadges(new Set([PANEL]));
    prunePanelGutterBadges(new Set());
    expect(getPanelGutterBadge(PANEL)).toBeUndefined();
  });

  it('keeps each workspace\'s badge and swaps it when the rail switches workspaces', () => {
    broadcast({ workspacePath: '/b', panelId: PANEL, value: 1, tone: 'default' });
    expect(getPanelGutterBadge(PANEL)).toBeUndefined();

    store.set(activeWorkspacePathAtom, '/b');
    expect(getPanelGutterBadge(PANEL)).toEqual({ count: 1, tone: 'default' });
    store.set(activeWorkspacePathAtom, '/a');
    expect(getPanelGutterBadge(PANEL)).toBeUndefined();
  });

  it('replays main\'s snapshot, except where a live update already arrived', async () => {
    broadcast({ workspacePath: '/a', panelId: 'com.example.owner.other', value: null, tone: 'default' });
    replay([
      { workspacePath: '/a', panelId: PANEL, value: 0, tone: 'default' },
      { workspacePath: '/a', panelId: 'com.example.owner.other', value: 9, tone: 'default' },
    ]);
    await vi.waitFor(() => expect(getPanelGutterBadge(PANEL)).toEqual({ count: 0, tone: 'default' }));
    expect(getPanelGutterBadge('com.example.owner.other')).toBeUndefined();
  });
});
