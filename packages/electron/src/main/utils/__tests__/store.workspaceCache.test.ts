// @vitest-environment node
/**
 * `conf` has no read cache: its `get store()` runs readFileSync + JSON.parse on
 * every `.get()`. Against a workspace-settings.json that had grown to 7.5MB that
 * was ~19ms of synchronous main-thread time per call, and `getWorkspaceState`
 * sits on the hot path for team resolution and document sync. These cases pin
 * that the main process reads the file once and serves the rest from memory,
 * and that writes stay visible to the next read.
 */
import { describe, expect, it, beforeEach, vi } from 'vitest';
import { EventEmitter } from 'events';

/** Counts full-store reads the way `conf` would perform them. */
let storeReads = 0;
let backing: Record<string, unknown> = {};

vi.mock('electron-store', () => {
  class FakeStore {
    path = '/mock/path/workspace-settings.json';
    // conf emits 'change' from its store setter, which every in-process write uses.
    events = new EventEmitter();
    get store() {
      storeReads++;
      return JSON.parse(JSON.stringify(backing));
    }
    get(key: string, defaultValue?: unknown) {
      storeReads++;
      return JSON.parse(JSON.stringify(backing))[key] ?? defaultValue;
    }
    set(key: string, value: unknown) {
      backing[key] = JSON.parse(JSON.stringify(value));
      this.events.emit('change');
    }
    delete(key: string) {
      delete backing[key];
      this.events.emit('change');
    }
  }
  return { default: FakeStore };
});

const WORKSPACE = '/tmp/workspace-cache-fixture';

describe('workspace store read-through cache', () => {
  beforeEach(async () => {
    backing = {};
    storeReads = 0;
    const { invalidateWorkspaceStoreCache } = await import('../store');
    invalidateWorkspaceStoreCache();
  });

  it('reads the backing store once across many getWorkspaceState calls', async () => {
    const { getWorkspaceState } = await import('../store');

    getWorkspaceState(WORKSPACE);
    const readsAfterFirst = storeReads;

    for (let i = 0; i < 25; i++) getWorkspaceState(WORKSPACE);

    expect(readsAfterFirst).toBeGreaterThan(0);
    // The 25 follow-up calls must not touch the backing store at all.
    expect(storeReads).toBe(readsAfterFirst);
  });

  it('serves a written value from cache without re-reading', async () => {
    const { getWorkspaceState, updateWorkspaceState } = await import('../store');

    getWorkspaceState(WORKSPACE);
    const readsBefore = storeReads;

    updateWorkspaceState(WORKSPACE, state => {
      state.localKeyPrefix = 'ACME';
    });

    expect(getWorkspaceState(WORKSPACE).localKeyPrefix).toBe('ACME');
    expect(storeReads).toBe(readsBefore);
  });

  it('re-reads the backing store after an explicit invalidation', async () => {
    const { getWorkspaceState, invalidateWorkspaceStoreCache } = await import('../store');

    getWorkspaceState(WORKSPACE);
    const readsBefore = storeReads;

    // Stands in for a writer outside store.ts, e.g. ProjectMigrationService.
    invalidateWorkspaceStoreCache();
    getWorkspaceState(WORKSPACE);

    expect(storeReads).toBeGreaterThan(readsBefore);
  });
});

describe('workspace state field reads', () => {
  it('reads one field without cloning or creating the whole workspace state', async () => {
    const { getWorkspaceStateField, updateWorkspaceState, invalidateWorkspaceStoreCache } = await import('../store');
    backing = {};
    invalidateWorkspaceStoreCache();
    expect(getWorkspaceStateField('/tmp/unknown-ws', 'localOrgBinding')).toBeUndefined();
    expect(Object.keys(backing)).toEqual([]);

    updateWorkspaceState(WORKSPACE, state => { state.localOrgBinding = { orgId: 'org' }; });
    const binding = getWorkspaceStateField(WORKSPACE, 'localOrgBinding')!;
    expect(binding).toEqual({ orgId: 'org' });
    binding.orgId = 'mutated';
    expect(getWorkspaceStateField(WORKSPACE, 'localOrgBinding')).toEqual({ orgId: 'org' });
  });
});

describe('app store extension settings cache', () => {
  beforeEach(() => {
    backing = {};
    storeReads = 0;
  });

  it('parses the settings file once per change, not once per extension check', async () => {
    const { getExtensionEnabled, setExtensionEnabled, getExtensionSettings, setAppSetting } = await import('../store');
    setExtensionEnabled('a', false);
    storeReads = 0;
    for (let i = 0; i < 25; i++) getExtensionEnabled('a');
    expect(storeReads).toBe(1);
    expect(getExtensionEnabled('a')).toBe(false);

    // A caller mutating the returned object must not change what the next read sees.
    getExtensionSettings().a.enabled = true;
    expect(getExtensionEnabled('a')).toBe(false);

    // Any writer invalidates, including the generic settings path.
    setAppSetting('extensionSettings', { a: { enabled: true } });
    expect(getExtensionEnabled('a')).toBe(true);
  });
});
