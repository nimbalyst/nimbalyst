// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { planWindowConsolidation, type ConsolidationWindowInput } from '../planWindowConsolidation';

function win(overrides: Partial<ConsolidationWindowInput> & { windowId: number }): ConsolidationWindowInput {
  return {
    mode: 'workspace',
    workspacePath: null,
    additionalWorkspacePaths: [],
    documentEdited: false,
    ...overrides,
  };
}

describe('planWindowConsolidation', () => {
  it('folds every other workspace window into the target', () => {
    const windows: ConsolidationWindowInput[] = [
      win({ windowId: 1, workspacePath: '/target' }),
      win({ windowId: 2, workspacePath: '/donor-a' }),
      win({ windowId: 3, workspacePath: '/donor-b' }),
    ];

    const plan = planWindowConsolidation(windows, {
      multiProjectModeEnabled: true,
      targetWindowId: 1,
    });

    expect(plan).toEqual({
      targetWindowId: 1,
      pathsToSeed: ['/donor-a', '/donor-b'],
      windowsToClose: [2, 3],
      windowsSkippedUnsaved: [],
    });
  });

  it('is a no-op with a single workspace window', () => {
    const windows: ConsolidationWindowInput[] = [win({ windowId: 1, workspacePath: '/only' })];

    const plan = planWindowConsolidation(windows, {
      multiProjectModeEnabled: true,
      targetWindowId: 1,
    });

    expect(plan).toBeNull();
  });

  it('does not seed a path already referenced by another donor window', () => {
    const windows: ConsolidationWindowInput[] = [
      win({ windowId: 1, workspacePath: '/target' }),
      win({ windowId: 2, workspacePath: '/shared' }),
      win({ windowId: 3, workspacePath: '/shared' }),
    ];

    const plan = planWindowConsolidation(windows, {
      multiProjectModeEnabled: true,
      targetWindowId: 1,
    });

    expect(plan?.pathsToSeed).toEqual(['/shared']);
    expect(plan?.windowsToClose).toEqual([2, 3]);
  });

  it('is a no-op when multi-project mode is off, regardless of window count', () => {
    const windows: ConsolidationWindowInput[] = [
      win({ windowId: 1, workspacePath: '/target' }),
      win({ windowId: 2, workspacePath: '/donor' }),
    ];

    const plan = planWindowConsolidation(windows, {
      multiProjectModeEnabled: false,
      targetWindowId: 1,
    });

    expect(plan).toBeNull();
  });

  it('leaves a donor window with unsaved changes untouched', () => {
    const windows: ConsolidationWindowInput[] = [
      win({ windowId: 1, workspacePath: '/target' }),
      win({ windowId: 2, workspacePath: '/donor-clean' }),
      win({ windowId: 3, workspacePath: '/donor-dirty', documentEdited: true }),
    ];

    const plan = planWindowConsolidation(windows, {
      multiProjectModeEnabled: true,
      targetWindowId: 1,
    });

    expect(plan?.pathsToSeed).toEqual(['/donor-clean']);
    expect(plan?.windowsToClose).toEqual([2]);
    expect(plan?.windowsSkippedUnsaved).toEqual([3]);
  });

  it('does not re-seed a rail-warm additional path the target already has', () => {
    const windows: ConsolidationWindowInput[] = [
      win({ windowId: 1, workspacePath: '/target', additionalWorkspacePaths: ['/already-warm'] }),
      win({ windowId: 2, workspacePath: '/already-warm' }),
      win({ windowId: 3, workspacePath: '/donor-new' }),
    ];

    const plan = planWindowConsolidation(windows, {
      multiProjectModeEnabled: true,
      targetWindowId: 1,
    });

    expect(plan?.pathsToSeed).toEqual(['/donor-new']);
    expect(plan?.windowsToClose).toEqual([2, 3]);
  });

  it('ignores non-workspace windows (e.g. document mode) entirely', () => {
    const windows: ConsolidationWindowInput[] = [
      win({ windowId: 1, workspacePath: '/target' }),
      win({ windowId: 2, workspacePath: '/donor' }),
      win({ windowId: 4, mode: 'document', workspacePath: null }),
    ];

    const plan = planWindowConsolidation(windows, {
      multiProjectModeEnabled: true,
      targetWindowId: 1,
    });

    expect(plan?.windowsToClose).toEqual([2]);
  });

  it('returns null when targetWindowId does not resolve to an open workspace window', () => {
    const windows: ConsolidationWindowInput[] = [
      win({ windowId: 1, workspacePath: '/a' }),
      win({ windowId: 2, workspacePath: '/b' }),
    ];

    const plan = planWindowConsolidation(windows, {
      multiProjectModeEnabled: true,
      targetWindowId: 999,
    });

    expect(plan).toBeNull();
  });
});
