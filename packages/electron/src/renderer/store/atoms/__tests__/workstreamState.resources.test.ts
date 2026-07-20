import { describe, it, expect, beforeEach } from 'vitest';
import { createStore } from 'jotai';
import {
  migrateWorkstreamResources,
  initWorkstreamState,
  workstreamStateAtom,
  workstreamOpenFilesAtom,
  workstreamActiveFileAtom,
  workstreamOpenResourcesAtom,
  workstreamHasOpenFilesAtom,
  workstreamHasOpenResourcesAtom,
  addWorkstreamFileAtom,
  addWorkstreamTrackerAtom,
  closeWorkstreamResourceAtom,
  closeWorkstreamFileAtom,
  setWorkstreamFileResourcesAtom,
  setWorkstreamResourcesAtom,
  setWorkstreamTrackerFocusAtom,
  workstreamTrackerFocusAtom,
  fileResource,
  trackerResource,
  trackerResourceId,
} from '../workstreamState';

/**
 * Slice 1 of the Agent Mode tracker-tabs work: typed workstream resources.
 *
 * These tests pin:
 *   - legacy openFilePaths/activeFilePath -> kind:'file' resource migration
 *   - open/close/dedup semantics on the typed resource list
 *   - tracker resources coexisting with file resources
 *   - the file-subset setter preserving tracker resources (no clobber)
 */

describe('migrateWorkstreamResources', () => {
  it('returns empty for undefined/null input', () => {
    expect(migrateWorkstreamResources(undefined)).toEqual({
      openResources: [],
      activeResourceId: null,
    });
    expect(migrateWorkstreamResources(null)).toEqual({
      openResources: [],
      activeResourceId: null,
    });
  });

  it('migrates legacy openFilePaths into file resources, preserving order and active', () => {
    const result = migrateWorkstreamResources({
      openFilePaths: ['/a.ts', '/b.ts', '/c.ts'],
      activeFilePath: '/b.ts',
    });
    expect(result.openResources.map((t) => t.resource.resourceId)).toEqual([
      '/a.ts',
      '/b.ts',
      '/c.ts',
    ]);
    expect(result.openResources.every((t) => t.resource.kind === 'file')).toBe(true);
    expect(result.activeResourceId).toBe('/b.ts');
  });

  it('falls back to the first file when the legacy active path is not open', () => {
    const result = migrateWorkstreamResources({
      openFilePaths: ['/a.ts', '/b.ts'],
      activeFilePath: '/gone.ts',
    });
    expect(result.activeResourceId).toBe('/a.ts');
  });

  it('normalizes an already-typed resource list and drops malformed entries', () => {
    const result = migrateWorkstreamResources({
      openResources: [
        { resource: { kind: 'file', resourceId: '/a.ts', filePath: '/a.ts' } },
        { resource: { kind: 'tracker', resourceId: 'tracker://T1', trackerItemId: 'T1' } },
        { resource: { kind: 'file' } }, // malformed: no filePath
        null,
        { presentation: {} }, // malformed: no resource
      ] as unknown[],
      activeResourceId: 'tracker://T1',
    });
    expect(result.openResources.map((t) => t.resource.resourceId)).toEqual([
      '/a.ts',
      'tracker://T1',
    ]);
    expect(result.activeResourceId).toBe('tracker://T1');
  });

  it('preserves per-tab presentation state on typed resources', () => {
    const result = migrateWorkstreamResources({
      openResources: [
        {
          resource: { kind: 'tracker', resourceId: 'tracker://T1', trackerItemId: 'T1' },
          presentation: { trackerContentFocus: true },
        },
      ] as unknown[],
      activeResourceId: 'tracker://T1',
    });
    expect(result.openResources[0].presentation?.trackerContentFocus).toBe(true);
  });

  it('resets active to the first file when the persisted active id is not present', () => {
    const result = migrateWorkstreamResources({
      openResources: [
        { resource: { kind: 'file', resourceId: '/a.ts', filePath: '/a.ts' } },
      ] as unknown[],
      activeResourceId: 'tracker://missing',
    });
    expect(result.activeResourceId).toBe('/a.ts');
  });
});

describe('workstream resource actions', () => {
  let store: ReturnType<typeof createStore>;
  const wsId = 'ws-1';

  beforeEach(() => {
    store = createStore();
    // Writer asserts a workspace path is set for persistence scheduling.
    initWorkstreamState('/test-workspace');
  });

  it('reads legacy persisted state as migrated file resources', () => {
    // Simulate a workstream state atom that still has legacy shape by writing
    // through the file action, then verifying the derived file atoms.
    store.set(addWorkstreamFileAtom, { workstreamId: wsId, filePath: '/a.ts' });
    expect(store.get(workstreamOpenFilesAtom(wsId))).toEqual(['/a.ts']);
    expect(store.get(workstreamActiveFileAtom(wsId))).toBe('/a.ts');
  });

  it('opening a file twice focuses the same tab (no duplicate)', () => {
    store.set(addWorkstreamFileAtom, { workstreamId: wsId, filePath: '/a.ts' });
    store.set(addWorkstreamFileAtom, { workstreamId: wsId, filePath: '/b.ts' });
    store.set(addWorkstreamFileAtom, { workstreamId: wsId, filePath: '/a.ts' });
    expect(store.get(workstreamOpenResourcesAtom(wsId))).toHaveLength(2);
    expect(store.get(workstreamActiveFileAtom(wsId))).toBe('/a.ts');
  });

  it('opens a tracker as a tracker:// resource and dedups on re-open', () => {
    store.set(addWorkstreamTrackerAtom, { workstreamId: wsId, trackerItemId: 'T1' });
    store.set(addWorkstreamTrackerAtom, { workstreamId: wsId, trackerItemId: 'T1' });
    const resources = store.get(workstreamOpenResourcesAtom(wsId));
    expect(resources).toHaveLength(1);
    expect(resources[0].resource.resourceId).toBe(trackerResourceId('T1'));
    expect(resources[0].resource.kind).toBe('tracker');
  });

  it('a tracker-only workstream has open resources but no open files', () => {
    store.set(addWorkstreamTrackerAtom, { workstreamId: wsId, trackerItemId: 'T1' });
    expect(store.get(workstreamHasOpenResourcesAtom(wsId))).toBe(true);
    expect(store.get(workstreamHasOpenFilesAtom(wsId))).toBe(false);
    expect(store.get(workstreamOpenFilesAtom(wsId))).toEqual([]);
    // Active resource is a tracker, so the file-centric active atom is null.
    expect(store.get(workstreamActiveFileAtom(wsId))).toBeNull();
  });

  it('layout auto-collapse gate must read hasOpenResources, not hasOpenFiles, or a tracker-only tab flashes closed', () => {
    // Pins AgentWorkstreamPanel's auto-collapse effect contract:
    //   if (!hasTabs && (layoutMode === 'editor' || layoutMode === 'split')) revert to 'transcript'
    // `hasTabs` must be workstreamHasOpenResourcesAtom. Feeding the file-only
    // atom into that gate reverts layoutMode right after a tracker-only tab is
    // opened, unmounting WorkstreamEditorTabs — the tab flashes then closes.
    store.set(addWorkstreamTrackerAtom, { workstreamId: wsId, trackerItemId: 'T1' });
    const layoutMode: string = 'split';

    const wouldCollapse = (hasTabs: boolean) =>
      !hasTabs && (layoutMode === 'editor' || layoutMode === 'split');

    expect(wouldCollapse(store.get(workstreamHasOpenResourcesAtom(wsId)))).toBe(false);
    expect(wouldCollapse(store.get(workstreamHasOpenFilesAtom(wsId)))).toBe(true);
  });

  it('interleaves file and tracker resources', () => {
    store.set(addWorkstreamFileAtom, { workstreamId: wsId, filePath: '/a.ts' });
    store.set(addWorkstreamTrackerAtom, { workstreamId: wsId, trackerItemId: 'T1' });
    store.set(addWorkstreamFileAtom, { workstreamId: wsId, filePath: '/b.ts' });
    expect(
      store.get(workstreamOpenResourcesAtom(wsId)).map((t) => t.resource.resourceId)
    ).toEqual(['/a.ts', trackerResourceId('T1'), '/b.ts']);
  });

  it('mirrors the active editor tab to workstreamActiveFileAtom for agent-chat selection scoping', () => {
    // AgentWorkstreamPanel reads workstreamActiveFileAtom to scope the agent
    // chat's "+ selection" chip to the active editor tab. WorkstreamEditorTabs'
    // persist effect writes the live tab set through setWorkstreamResourcesAtom;
    // this pins that a file-active tab surfaces its path (chip scopes to it) and
    // a tracker-active tab surfaces null (chat passes '' -> no cross-tab leak).
    store.set(setWorkstreamResourcesAtom, {
      workstreamId: wsId,
      resources: [fileResource('/a.ts'), trackerResource('T1')],
      activeResourceId: '/a.ts',
    });
    expect(store.get(workstreamActiveFileAtom(wsId))).toBe('/a.ts');

    store.set(setWorkstreamResourcesAtom, {
      workstreamId: wsId,
      resources: [fileResource('/a.ts'), trackerResource('T1')],
      activeResourceId: trackerResourceId('T1'),
    });
    expect(store.get(workstreamActiveFileAtom(wsId))).toBeNull();
  });

  it('closing the active resource moves focus to the left neighbor', () => {
    store.set(addWorkstreamFileAtom, { workstreamId: wsId, filePath: '/a.ts' });
    store.set(addWorkstreamFileAtom, { workstreamId: wsId, filePath: '/b.ts' });
    store.set(addWorkstreamFileAtom, { workstreamId: wsId, filePath: '/c.ts' });
    // active is /c.ts
    store.set(closeWorkstreamResourceAtom, { workstreamId: wsId, resourceId: '/c.ts' });
    expect(store.get(workstreamActiveFileAtom(wsId))).toBe('/b.ts');
  });

  it('closing a non-active resource keeps the active resource', () => {
    store.set(addWorkstreamFileAtom, { workstreamId: wsId, filePath: '/a.ts' });
    store.set(addWorkstreamFileAtom, { workstreamId: wsId, filePath: '/b.ts' });
    // active is /b.ts; close /a.ts
    store.set(closeWorkstreamFileAtom, { workstreamId: wsId, filePath: '/a.ts' });
    expect(store.get(workstreamActiveFileAtom(wsId))).toBe('/b.ts');
    expect(store.get(workstreamOpenFilesAtom(wsId))).toEqual(['/b.ts']);
  });

  it('closing the last resource clears the active id', () => {
    store.set(addWorkstreamFileAtom, { workstreamId: wsId, filePath: '/a.ts' });
    store.set(closeWorkstreamFileAtom, { workstreamId: wsId, filePath: '/a.ts' });
    expect(store.get(workstreamOpenResourcesAtom(wsId))).toEqual([]);
    expect(store.get(workstreamStateAtom(wsId)).activeResourceId).toBeNull();
  });

  it('setWorkstreamFileResources preserves tracker resources (no clobber)', () => {
    // A tracker tab is open (as if navigated to from a session).
    store.set(addWorkstreamTrackerAtom, { workstreamId: wsId, trackerItemId: 'T1' });
    // The file-tabs component syncs its file list; it must not drop the tracker.
    store.set(setWorkstreamFileResourcesAtom, {
      workstreamId: wsId,
      filePaths: ['/a.ts', '/b.ts'],
      activeFilePath: '/b.ts',
    });
    const ids = store.get(workstreamOpenResourcesAtom(wsId)).map((t) => t.resource.resourceId);
    expect(ids).toContain(trackerResourceId('T1'));
    expect(ids).toContain('/a.ts');
    expect(ids).toContain('/b.ts');
    expect(ids).toHaveLength(3);
  });

  it('setWorkstreamFileResources with an empty file list keeps the tracker tab', () => {
    store.set(addWorkstreamTrackerAtom, { workstreamId: wsId, trackerItemId: 'T1' });
    store.set(setWorkstreamFileResourcesAtom, {
      workstreamId: wsId,
      filePaths: [],
      activeFilePath: null,
    });
    const resources = store.get(workstreamOpenResourcesAtom(wsId));
    expect(resources).toHaveLength(1);
    expect(resources[0].resource.resourceId).toBe(trackerResourceId('T1'));
    // Active tracker is preserved when there are no files to activate.
    expect(store.get(workstreamStateAtom(wsId)).activeResourceId).toBe(trackerResourceId('T1'));
  });
});

describe('per-tab tracker content focus', () => {
  let store: ReturnType<typeof createStore>;
  const wsId = 'ws-focus';

  beforeEach(() => {
    store = createStore();
    initWorkstreamState('/test-workspace');
  });

  const focusKey = (itemId: string) => `${wsId}::${trackerResourceId(itemId)}`;

  it('defaults to false and toggles per tab', () => {
    store.set(addWorkstreamTrackerAtom, { workstreamId: wsId, trackerItemId: 'T1' });
    expect(store.get(workstreamTrackerFocusAtom(focusKey('T1')))).toBe(false);

    store.set(setWorkstreamTrackerFocusAtom, {
      workstreamId: wsId,
      resourceId: trackerResourceId('T1'),
      focus: true,
    });
    expect(store.get(workstreamTrackerFocusAtom(focusKey('T1')))).toBe(true);
  });

  it('focus is independent per tracker tab', () => {
    store.set(addWorkstreamTrackerAtom, { workstreamId: wsId, trackerItemId: 'T1' });
    store.set(addWorkstreamTrackerAtom, { workstreamId: wsId, trackerItemId: 'T2' });
    store.set(setWorkstreamTrackerFocusAtom, {
      workstreamId: wsId,
      resourceId: trackerResourceId('T1'),
      focus: true,
    });
    expect(store.get(workstreamTrackerFocusAtom(focusKey('T1')))).toBe(true);
    expect(store.get(workstreamTrackerFocusAtom(focusKey('T2')))).toBe(false);
  });

  it('setWorkstreamResources preserves per-tab focus (persist effect must not clobber it)', () => {
    store.set(addWorkstreamTrackerAtom, { workstreamId: wsId, trackerItemId: 'T1' });
    store.set(setWorkstreamTrackerFocusAtom, {
      workstreamId: wsId,
      resourceId: trackerResourceId('T1'),
      focus: true,
    });
    // Simulate the persist effect rebuilding openResources from the live tabs
    // (e.g. after opening another file tab).
    store.set(setWorkstreamResourcesAtom, {
      workstreamId: wsId,
      resources: [trackerResource('T1'), fileResource('/a.ts')],
      activeResourceId: '/a.ts',
    });
    expect(store.get(workstreamTrackerFocusAtom(focusKey('T1')))).toBe(true);
  });

  it('focus survives a persisted-state round-trip (restart) via migration', () => {
    store.set(addWorkstreamTrackerAtom, { workstreamId: wsId, trackerItemId: 'T1' });
    store.set(setWorkstreamTrackerFocusAtom, {
      workstreamId: wsId,
      resourceId: trackerResourceId('T1'),
      focus: true,
    });
    // Serialize the persisted shape and re-hydrate through the migration.
    const persisted = store.get(workstreamStateAtom(wsId));
    const rehydrated = migrateWorkstreamResources(persisted as any);
    const trackerTab = rehydrated.openResources.find(
      (t) => t.resource.resourceId === trackerResourceId('T1')
    );
    expect(trackerTab?.presentation?.trackerContentFocus).toBe(true);
  });
});
