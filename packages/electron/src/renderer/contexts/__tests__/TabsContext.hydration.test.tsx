// @vitest-environment jsdom

import React from 'react';
import { act, cleanup, render } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  persistTabsSlot,
  pruneTabsSlot,
  TabsProvider,
  useTabsActions,
} from '../TabsContext';

const workspacePath = '/workspace/empty-hydration';
let actions: ReturnType<typeof useTabsActions>;
let invoke: ReturnType<typeof vi.fn>;

function Harness() {
  actions = useTabsActions();
  return null;
}

describe('TabsContext hydration', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    invoke = vi.fn(async (channel: string) => {
      if (channel === 'workspace:get-state') {
        return { tabs: { tabs: [], tabOrder: [], activeTabId: null, closedTabs: [] } };
      }
      return { success: true };
    });
    Object.defineProperty(window, 'electronAPI', {
      configurable: true,
      value: { invoke, send: vi.fn() },
    });
  });

  afterEach(() => {
    cleanup();
    pruneTabsSlot(workspacePath);
    vi.useRealTimers();
    Reflect.deleteProperty(window, 'electronAPI');
  });

  it('persists an empty layout after an empty workspace hydrated and briefly opened a tab', async () => {
    render(
      <TabsProvider workspacePath={workspacePath}>
        <Harness />
      </TabsProvider>,
    );
    await act(async () => {
      await vi.advanceTimersByTimeAsync(500);
    });

    await act(async () => {
      actions.addTab('/workspace/temporary.md');
      await persistTabsSlot(workspacePath);
      actions.closeAllTabs();
    });
    invoke.mockClear();

    await persistTabsSlot(workspacePath);

    expect(invoke).toHaveBeenCalledWith(
      'workspace:update-state',
      workspacePath,
      { tabs: expect.objectContaining({ tabs: [], tabOrder: [] }) },
    );
  });
});
