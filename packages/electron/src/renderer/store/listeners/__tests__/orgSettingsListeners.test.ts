import { createStore } from 'jotai';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  orgSettingsAtomFamily,
  orgSettingsLoadStateAtomFamily,
} from '../../atoms/orgSettings';
import {
  initOrgSettingsListeners,
  refreshOrgSettings,
} from '../orgSettingsListeners';

describe('org settings listeners', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('hydrates an org, applies broadcast settings, and refetches without them', async () => {
    let changedListener: ((payload: unknown) => void) | undefined;
    const unsubscribe = vi.fn();
    const invoke = vi.fn(async (channel: string, request: { orgId: string }) => {
      expect(channel).toBe('org:settings:get');
      expect(request).toEqual({ orgId: 'org-a' });
      // A server that predates a field answers partially.
      return { messaging: { dmsEnabled: false } };
    });
    vi.stubGlobal('window', {
      electronAPI: {
        invoke,
        on: vi.fn((channel: string, listener: (payload: unknown) => void) => {
          expect(channel).toBe('org:settings-changed');
          changedListener = listener;
          return unsubscribe;
        }),
      },
    });

    const targetStore = createStore();
    const cleanup = initOrgSettingsListeners(targetStore);

    // Nothing has loaded this org yet, so a broadcast is not a reason to start.
    changedListener?.({ orgId: 'org-a' });
    expect(invoke).not.toHaveBeenCalled();

    await refreshOrgSettings('org-a', targetStore);

    expect(targetStore.get(orgSettingsAtomFamily('org-a'))).toEqual({
      version: 1,
      messaging: { roomsEnabled: true, dmsEnabled: false, roomCreation: 'members' },
    });
    expect(targetStore.get(orgSettingsLoadStateAtomFamily('org-a')))
      .toEqual({ status: 'ready' });

    // A broadcast carrying the settings applies without a round trip.
    changedListener?.({
      orgId: 'org-a',
      settings: { version: 1, messaging: { roomsEnabled: false } },
    });
    expect(targetStore.get(orgSettingsAtomFamily('org-a')).messaging).toEqual({
      roomsEnabled: false,
      dmsEnabled: true,
      roomCreation: 'members',
    });
    expect(invoke).toHaveBeenCalledTimes(1);

    // Without settings it re-reads.
    changedListener?.({ orgId: 'org-a' });
    await vi.waitFor(() => expect(invoke).toHaveBeenCalledTimes(2));

    cleanup();
    expect(unsubscribe).toHaveBeenCalledOnce();
  });

  it('ignores a settings read that resolves after the authoritative broadcast', async () => {
    let changedListener: ((payload: unknown) => void) | undefined;
    let releaseRead: (() => void) | undefined;
    const invoke = vi.fn(() => new Promise((resolve) => {
      releaseRead = () => resolve({
        version: 1,
        messaging: { roomsEnabled: true, dmsEnabled: true, roomCreation: 'members' },
      });
    }));
    vi.stubGlobal('window', {
      electronAPI: {
        invoke,
        on: vi.fn((_channel: string, listener: (payload: unknown) => void) => {
          changedListener = listener;
          return vi.fn();
        }),
      },
    });

    const targetStore = createStore();
    initOrgSettingsListeners(targetStore);
    // Hydrate first so the broadcast listener is willing to act on this org.
    const first = refreshOrgSettings('org-a', targetStore);
    releaseRead?.();
    await first;

    // A second read starts, then an admin turns rooms off and the broadcast
    // carrying that lands before the read answers.
    const stale = refreshOrgSettings('org-a', targetStore);
    changedListener?.({
      orgId: 'org-a',
      settings: { version: 1, messaging: { roomsEnabled: false } },
    });
    expect(targetStore.get(orgSettingsAtomFamily('org-a')).messaging.roomsEnabled)
      .toBe(false);

    releaseRead?.();
    await stale;

    // The stale response must not re-enable rooms.
    expect(targetStore.get(orgSettingsAtomFamily('org-a')).messaging.roomsEnabled)
      .toBe(false);
    expect(targetStore.get(orgSettingsLoadStateAtomFamily('org-a')))
      .toEqual({ status: 'ready' });
  });

  // The org window re-reads settings on every focus gain; an unchanged answer
  // must not announce "loading" or hand back a new settings object, or the
  // gated sidebar sections repaint each time the window comes forward.
  it('revalidates loaded settings without a loading flip or a new object', async () => {
    const invoke = vi.fn(async () => ({
      version: 1,
      messaging: { roomsEnabled: true, dmsEnabled: false, roomCreation: 'members' },
    }));
    vi.stubGlobal('window', { electronAPI: { invoke, on: vi.fn(() => vi.fn()) } });

    const targetStore = createStore();
    const settingsAtom = orgSettingsAtomFamily('org-c');
    const loadStateAtom = orgSettingsLoadStateAtomFamily('org-c');
    await refreshOrgSettings('org-c', targetStore);

    const settings = targetStore.get(settingsAtom);
    const loadState = targetStore.get(loadStateAtom);
    const statuses: string[] = [];
    const unsubscribe = targetStore.sub(loadStateAtom, () => {
      statuses.push(targetStore.get(loadStateAtom).status);
    });
    let settingsWrites = 0;
    const unsubscribeSettings = targetStore.sub(settingsAtom, () => {
      settingsWrites += 1;
    });

    await refreshOrgSettings('org-c', targetStore);
    unsubscribe();
    unsubscribeSettings();

    expect(statuses).toEqual([]);
    expect(settingsWrites).toBe(0);
    expect(targetStore.get(settingsAtom)).toBe(settings);
    expect(targetStore.get(loadStateAtom)).toBe(loadState);
  });

  it('records the failure instead of leaving the org stuck loading', async () => {
    vi.stubGlobal('window', {
      electronAPI: {
        invoke: vi.fn(async () => { throw new Error('offline'); }),
        on: vi.fn(() => vi.fn()),
      },
    });

    const targetStore = createStore();
    await expect(refreshOrgSettings('org-b', targetStore)).rejects.toThrow('offline');

    expect(targetStore.get(orgSettingsLoadStateAtomFamily('org-b')))
      .toEqual({ status: 'error', error: 'offline' });
    // Gating still reads the permissive defaults rather than hiding rooms.
    expect(targetStore.get(orgSettingsAtomFamily('org-b')).messaging.roomsEnabled)
      .toBe(true);
  });
});
