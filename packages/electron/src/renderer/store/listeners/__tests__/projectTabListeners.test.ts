// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PROJECT_TAB_MUTATION_CHANNEL, type ProjectTabMutation } from '../../../../shared/projectTabs';

const mocks = vi.hoisted(() => ({
  applyProjectTabMutation: vi.fn(async () => undefined),
  closeActiveProjectTab: vi.fn(async () => ({ success: true })),
  openProjectTab: vi.fn(async () => ({ success: true })),
}));

vi.mock('../../../services/projectTabs', () => ({
  applyProjectTabMutation: mocks.applyProjectTabMutation,
  closeActiveProjectTab: mocks.closeActiveProjectTab,
  openProjectTab: mocks.openProjectTab,
}));

import { initProjectTabListeners } from '../projectTabListeners';

describe('project tab mutation listeners', () => {
  let cleanup: (() => void) | undefined;
  let invoke: ReturnType<typeof vi.fn>;
  let listeners: Map<string, (payload: any) => void>;

  beforeEach(() => {
    listeners = new Map();
    mocks.applyProjectTabMutation.mockClear();
    invoke = vi.fn(async (channel: string) => {
      if (channel === 'workspace:consume-pending-project-tabs') return [];
      if (channel === 'workspace:consume-pending-project-tab-mutations') return [];
      return { success: true };
    });
    Object.defineProperty(window, 'electronAPI', {
      configurable: true,
      value: {
        invoke,
        on: vi.fn((channel: string, callback: (payload: any) => void) => {
          listeners.set(channel, callback);
          return () => listeners.delete(channel);
        }),
      },
    });
  });

  afterEach(() => {
    cleanup?.();
    cleanup = undefined;
  });

  it('applies and acknowledges a live main-owned mutation after hydration', async () => {
    let resolveReady!: () => void;
    const ready = new Promise<void>((resolve) => { resolveReady = resolve; });
    cleanup = initProjectTabListeners(ready);
    const mutation: ProjectTabMutation = {
      id: 'move-1',
      kind: 'add',
      workspacePath: '/ws/b',
      activate: true,
    };

    listeners.get(PROJECT_TAB_MUTATION_CHANNEL)?.(mutation);
    expect(mocks.applyProjectTabMutation).not.toHaveBeenCalled();
    resolveReady();

    await vi.waitFor(() => {
      expect(mocks.applyProjectTabMutation).toHaveBeenCalledWith(mutation);
      expect(invoke).toHaveBeenCalledWith('workspace:ack-project-tab-mutation', {
        mutationId: 'move-1',
      });
    });
  });

  it('deduplicates the same mutation delivered live and from the pending queue', async () => {
    const mutation: ProjectTabMutation = {
      id: 'move-2',
      kind: 'remove',
      workspacePath: '/ws/a',
      replacementWorkspacePath: '/ws/b',
      closeWindowWhenEmpty: false,
    };
    invoke.mockImplementation(async (channel: string) => {
      if (channel === 'workspace:consume-pending-project-tabs') return [];
      if (channel === 'workspace:consume-pending-project-tab-mutations') return [mutation];
      return { success: true };
    });

    cleanup = initProjectTabListeners(Promise.resolve());
    listeners.get(PROJECT_TAB_MUTATION_CHANNEL)?.(mutation);

    await vi.waitFor(() => {
      expect(mocks.applyProjectTabMutation).toHaveBeenCalledTimes(1);
    });
  });
});
