// @vitest-environment node
import { describe, it, expect, beforeEach, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  getMostRecentlyFocusedWorkspaceWindow: vi.fn(),
  getWindowId: vi.fn(),
  getMultiProjectMode: vi.fn(() => true),
  seedProjectIntoWindow: vi.fn(),
  flushWindowBeforeClose: vi.fn(),
}));

vi.mock('../WindowManager', () => ({
  getMostRecentlyFocusedWorkspaceWindow: mocks.getMostRecentlyFocusedWorkspaceWindow,
  getWindowId: mocks.getWindowId,
}));

vi.mock('../../utils/store', () => ({
  getMultiProjectMode: mocks.getMultiProjectMode,
}));

vi.mock('../railSeeding', () => ({
  seedProjectIntoWindow: mocks.seedProjectIntoWindow,
}));

vi.mock('../flushWindowBeforeClose', () => ({
  flushWindowBeforeClose: mocks.flushWindowBeforeClose,
}));

vi.mock('../../utils/logger', () => ({
  logger: {
    main: { warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn() },
  },
}));

import { windows, windowStates } from '../windowState';
import { consolidateWorkspaceWindows } from '../consolidateWorkspaceWindows';
import type { WindowState } from '../../types';

function fakeWindow(overrides: Partial<{ isDestroyed: boolean }> = {}) {
  let destroyed = overrides.isDestroyed ?? false;
  return {
    isDestroyed: () => destroyed,
    close: vi.fn(),
    webContents: { send: vi.fn() },
    _destroy: () => {
      destroyed = true;
    },
  };
}

function state(overrides: Partial<WindowState>): WindowState {
  return {
    mode: 'workspace',
    filePath: null,
    workspacePath: null,
    activeWorkspacePath: null,
    additionalWorkspacePaths: [],
    documentEdited: false,
    ...overrides,
  } as WindowState;
}

describe('consolidateWorkspaceWindows', () => {
  let target: ReturnType<typeof fakeWindow>;
  let donorA: ReturnType<typeof fakeWindow>;
  let donorB: ReturnType<typeof fakeWindow>;

  beforeEach(() => {
    vi.clearAllMocks();
    windows.clear();
    windowStates.clear();
    mocks.getMultiProjectMode.mockReturnValue(true);

    target = fakeWindow();
    donorA = fakeWindow();
    donorB = fakeWindow();

    windows.set(1, target as any);
    windows.set(2, donorA as any);
    windows.set(3, donorB as any);

    windowStates.set(1, state({ workspacePath: '/ws/target', activeWorkspacePath: '/ws/target' }));
    windowStates.set(2, state({ workspacePath: '/ws/donor-a' }));
    windowStates.set(3, state({ workspacePath: '/ws/donor-b' }));

    mocks.getMostRecentlyFocusedWorkspaceWindow.mockReturnValue(target);
    mocks.getWindowId.mockImplementation((w: unknown) => (w === target ? 1 : null));
    mocks.seedProjectIntoWindow.mockResolvedValue('added');
    mocks.flushWindowBeforeClose.mockResolvedValue('flushed');
  });

  it('seeds every donor path with activate: false and closes fully-migrated donors', async () => {
    const result = await consolidateWorkspaceWindows();

    expect(mocks.seedProjectIntoWindow).toHaveBeenCalledWith(
      target,
      '/ws/donor-a',
      expect.objectContaining({ activate: false }),
    );
    expect(mocks.seedProjectIntoWindow).toHaveBeenCalledWith(
      target,
      '/ws/donor-b',
      expect.objectContaining({ activate: false }),
    );

    expect(result.seeded).toEqual(['/ws/donor-a', '/ws/donor-b']);
    expect(result.refused).toEqual([]);
    expect(result.closedWindowIds.sort()).toEqual([2, 3]);
    expect(donorA.close).toHaveBeenCalledOnce();
    expect(donorB.close).toHaveBeenCalledOnce();
  });

  it('never touches the target window\'s active path', async () => {
    await consolidateWorkspaceWindows();

    expect(windowStates.get(1)?.activeWorkspacePath).toBe('/ws/target');
  });

  it('stops on the first "at-cap" outcome and refuses the rest without seeding them', async () => {
    mocks.seedProjectIntoWindow.mockResolvedValueOnce('at-cap');

    const result = await consolidateWorkspaceWindows();

    expect(mocks.seedProjectIntoWindow).toHaveBeenCalledTimes(1);
    expect(result.seeded).toEqual([]);
    expect(result.refused).toEqual(['/ws/donor-a', '/ws/donor-b']);
    expect(result.closedWindowIds).toEqual([]);
    expect(result.skippedWindowIds.sort()).toEqual([2, 3]);
    expect(donorA.close).not.toHaveBeenCalled();
    expect(donorB.close).not.toHaveBeenCalled();
  });

  it('a plain "timeout" only refuses that one path -- it does not cascade to the rest', async () => {
    mocks.seedProjectIntoWindow.mockResolvedValueOnce('timeout').mockResolvedValueOnce('added');

    const result = await consolidateWorkspaceWindows();

    expect(mocks.seedProjectIntoWindow).toHaveBeenCalledTimes(2);
    expect(result.seeded).toEqual(['/ws/donor-b']);
    expect(result.refused).toEqual(['/ws/donor-a']);
    // donor-a's only path was refused -- not fully migrated, left open.
    expect(donorA.close).not.toHaveBeenCalled();
    // donor-b's only path landed -- fully migrated, closed.
    expect(donorB.close).toHaveBeenCalledOnce();
  });

  it('leaves a donor with unsaved changes untouched (neither seeded nor closed)', async () => {
    windowStates.set(3, state({ workspacePath: '/ws/donor-b', documentEdited: true }));

    const result = await consolidateWorkspaceWindows();

    expect(mocks.seedProjectIntoWindow).not.toHaveBeenCalledWith(
      target,
      '/ws/donor-b',
      expect.anything(),
    );
    expect(result.skippedWindowIds).toContain(3);
    expect(donorB.close).not.toHaveBeenCalled();
  });

  it('bails out and leaves every donor open if the target window dies mid-merge', async () => {
    mocks.seedProjectIntoWindow.mockImplementation(async (_win: unknown, path: string) => {
      if (path === '/ws/donor-a') {
        target._destroy();
        windowStates.delete(1);
      }
      return 'added';
    });

    const result = await consolidateWorkspaceWindows();

    expect(result.closedWindowIds).toEqual([]);
    expect(result.skippedWindowIds.sort()).toEqual([2, 3]);
    expect(donorA.close).not.toHaveBeenCalled();
    expect(donorB.close).not.toHaveBeenCalled();
  });

  it('re-checks documentEdited immediately before closing, even if a donor went dirty mid-run', async () => {
    mocks.seedProjectIntoWindow.mockImplementation(async (_win: unknown, path: string) => {
      if (path === '/ws/donor-a') {
        // Donor A goes dirty while donor B's seed is still in flight.
        const s = windowStates.get(2);
        if (s) s.documentEdited = true;
      }
      return 'added';
    });

    const result = await consolidateWorkspaceWindows();

    expect(result.skippedWindowIds).toContain(2);
    expect(donorA.close).not.toHaveBeenCalled();
    expect(donorB.close).toHaveBeenCalledOnce();
  });

  it('is a no-op when Multi-Project Mode is off', async () => {
    mocks.getMultiProjectMode.mockReturnValue(false);

    const result = await consolidateWorkspaceWindows();

    expect(result.plan).toBeNull();
    expect(mocks.seedProjectIntoWindow).not.toHaveBeenCalled();
  });

  it('flushes a fully-migrated donor before closing it', async () => {
    const result = await consolidateWorkspaceWindows();

    expect(mocks.flushWindowBeforeClose).toHaveBeenCalledWith(donorA, expect.objectContaining({ timeoutMs: expect.any(Number) }));
    expect(mocks.flushWindowBeforeClose).toHaveBeenCalledWith(donorB, expect.objectContaining({ timeoutMs: expect.any(Number) }));
    expect(result.closedWindowIds.sort()).toEqual([2, 3]);
    expect(donorA.close).toHaveBeenCalledOnce();
    expect(donorB.close).toHaveBeenCalledOnce();
  });

  it('leaves a donor open (and does not close it) when the flush before close times out', async () => {
    mocks.flushWindowBeforeClose.mockImplementation(async (win: unknown) =>
      win === donorA ? 'timeout' : 'flushed',
    );

    const result = await consolidateWorkspaceWindows();

    expect(donorA.close).not.toHaveBeenCalled();
    expect(result.skippedWindowIds).toContain(2);
    expect(donorB.close).toHaveBeenCalledOnce();
    expect(result.closedWindowIds).toEqual([3]);
  });

  it('leaves a donor open when the flush reports dirty editors remain unsaved', async () => {
    mocks.flushWindowBeforeClose.mockResolvedValue('still-dirty');

    const result = await consolidateWorkspaceWindows();

    expect(donorA.close).not.toHaveBeenCalled();
    expect(donorB.close).not.toHaveBeenCalled();
    expect(result.closedWindowIds).toEqual([]);
    expect(result.skippedWindowIds.sort()).toEqual([2, 3]);
  });
});
