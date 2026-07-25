import { describe, expect, it } from 'vitest';

import { vi } from 'vitest';

import {
  applyProjectSyncChange,
  persistProjectSyncSelection,
  selectionState,
  type ProjectSyncSelection,
} from '../projectSyncSelection';

const ALL = ['/a', '/b', '/c'];

function selection(overrides: Partial<ProjectSyncSelection> = {}): ProjectSyncSelection {
  return { enabledProjects: [], docSyncEnabledProjects: [], ...overrides };
}

describe('applyProjectSyncChange', () => {
  it('selects every project in one interaction', () => {
    const result = applyProjectSyncChange(selection({ enabledProjects: ['/b'] }), {
      axis: 'mobile',
      projectPaths: ALL,
      enabled: true,
    });

    expect(result.next.enabledProjects).toEqual(['/b', '/a', '/c']);
    expect(result.next.enabled).toBe(true);
    // Only the projects that actually changed membership are toggled.
    expect(result.syncToggles).toEqual([
      { projectPath: '/a', enabled: true },
      { projectPath: '/c', enabled: true },
    ]);
  });

  it('deselects every project in one interaction and turns sync off', () => {
    const result = applyProjectSyncChange(
      selection({ enabledProjects: ['/a', '/b'], docSyncEnabledProjects: ['/a'] }),
      { axis: 'mobile', projectPaths: ALL, enabled: false },
    );

    expect(result.next.enabledProjects).toEqual([]);
    expect(result.next.enabled).toBe(false);
    // Docs cannot outlive mobile access.
    expect(result.next.docSyncEnabledProjects).toEqual([]);
    expect(result.syncToggles).toEqual([
      { projectPath: '/a', enabled: false },
      { projectPath: '/b', enabled: false },
    ]);
  });

  it('emits no toggles when the selection is already in the requested state', () => {
    const result = applyProjectSyncChange(selection({ enabledProjects: ALL }), {
      axis: 'mobile',
      projectPaths: ALL,
      enabled: true,
    });

    expect(result.syncToggles).toEqual([]);
    expect(result.next.enabledProjects).toEqual(ALL);
  });

  it('toggles a single project without disturbing the others', () => {
    const result = applyProjectSyncChange(selection({ enabledProjects: ['/a', '/b'] }), {
      axis: 'mobile',
      projectPaths: ['/a'],
      enabled: false,
    });

    expect(result.next.enabledProjects).toEqual(['/b']);
    expect(result.syncToggles).toEqual([{ projectPath: '/a', enabled: false }]);
  });

  it('pulls a project into mobile sync when its docs are turned on', () => {
    const result = applyProjectSyncChange(selection(), {
      axis: 'docs',
      projectPaths: ['/a'],
      enabled: true,
    });

    expect(result.next.docSyncEnabledProjects).toEqual(['/a']);
    expect(result.next.enabledProjects).toEqual(['/a']);
    expect(result.syncToggles).toEqual([{ projectPath: '/a', enabled: true }]);
    expect(result.docSyncTurnedOn).toEqual(['/a']);
  });

  it('turns docs off for every project while leaving mobile access alone', () => {
    const result = applyProjectSyncChange(
      selection({ enabledProjects: ALL, docSyncEnabledProjects: ['/a', '/c'] }),
      { axis: 'docs', projectPaths: ALL, enabled: false },
    );

    expect(result.next.docSyncEnabledProjects).toEqual([]);
    expect(result.next.enabledProjects).toEqual(ALL);
    expect(result.syncToggles).toEqual([]);
    expect(result.docSyncTurnedOn).toEqual([]);
  });

  it('does not mutate the selection it was given', () => {
    const current = selection({ enabledProjects: ['/a'], docSyncEnabledProjects: ['/a'] });
    applyProjectSyncChange(current, { axis: 'mobile', projectPaths: ALL, enabled: true });

    expect(current.enabledProjects).toEqual(['/a']);
    expect(current.docSyncEnabledProjects).toEqual(['/a']);
  });
});

describe('persistProjectSyncSelection', () => {
  // Selecting N projects must not become N read-modify-writes plus N sync
  // triggers in main — the handler takes the whole membership set at once.
  it('sends one write for a bulk change, however many projects moved', async () => {
    const manyProjects = Array.from({ length: 20 }, (_, index) => `/project-${index}`);
    const { next } = applyProjectSyncChange(selection(), {
      axis: 'mobile',
      projectPaths: manyProjects,
      enabled: true,
    });
    const invoke = vi.fn().mockResolvedValue({ success: true });

    await persistProjectSyncSelection(invoke, next);

    expect(invoke).toHaveBeenCalledTimes(1);
    expect(invoke).toHaveBeenCalledWith('sync:set-project-selection', {
      enabledProjects: manyProjects,
      docSyncEnabledProjects: [],
    });
  });

  it('sends the same single write for a one-project change', async () => {
    const invoke = vi.fn().mockResolvedValue({ success: true });

    await persistProjectSyncSelection(invoke, {
      enabledProjects: ['/a'],
      docSyncEnabledProjects: ['/a'],
    });

    expect(invoke).toHaveBeenCalledTimes(1);
    expect(invoke.mock.calls[0][0]).toBe('sync:set-project-selection');
  });
});

describe('selectionState', () => {
  it('reports none / some / all for the header control', () => {
    expect(selectionState([], ALL)).toBe('none');
    expect(selectionState(['/a'], ALL)).toBe('some');
    expect(selectionState(ALL, ALL)).toBe('all');
  });

  it('reports none when there are no projects to select', () => {
    expect(selectionState([], [])).toBe('none');
  });

  it('ignores selected projects that are no longer listed', () => {
    expect(selectionState(['/gone'], ALL)).toBe('none');
    expect(selectionState([...ALL, '/gone'], ALL)).toBe('all');
  });
});
