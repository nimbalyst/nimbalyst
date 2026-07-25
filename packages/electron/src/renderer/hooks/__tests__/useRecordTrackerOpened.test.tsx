import React from 'react';
import { act, renderHook } from '@testing-library/react';
import { Provider, createStore } from 'jotai';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { trackerPersonalStateService } from '../../services/RendererTrackerPersonalStateService';
import { trackerPersonalStateAtom } from '../../store/atoms/trackerPersonalState';
import { useRecordTrackerOpened } from '../useRecordTrackerOpened';

describe('useRecordTrackerOpened', () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('records a newer genuine-open time when an unchanged item is reopened later', async () => {
    vi.useFakeTimers();
    const recordOpened = vi.spyOn(trackerPersonalStateService, 'recordOpened').mockResolvedValue(null);
    const store = createStore();
    store.set(trackerPersonalStateAtom, {
      workspacePath: '/ws',
      scope: 'org:org-1:tracker:project-1',
      identityEmail: 'me@example.com',
      hydrated: true,
      rowsByItemId: new Map(),
    });
    const wrapper = ({ children }: { children: React.ReactNode }) => <Provider store={store}>{children}</Provider>;

    vi.setSystemTime(1_000);
    const first = renderHook(() => useRecordTrackerOpened('item-1', '/ws'), { wrapper });
    await act(async () => { await vi.advanceTimersByTimeAsync(400); });
    first.unmount();

    vi.setSystemTime(5_000);
    const second = renderHook(() => useRecordTrackerOpened('item-1', '/ws'), { wrapper });
    await act(async () => { await vi.advanceTimersByTimeAsync(400); });
    second.unmount();

    expect(recordOpened.mock.calls.map(([input]) => input.lastOpenedAt)).toEqual([1_400, 5_400]);
  });
});
