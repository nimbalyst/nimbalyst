// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';
import React from 'react';
import { Provider } from 'jotai';
import { act, renderHook, waitFor } from '@testing-library/react';
import { store } from '../../../store';
import { activeWorkspacePathAtom } from '../../../store/atoms/openProjects';
import { pageInfoPanelOpenAtom, pageInfoPanelWidthAtom, setPageInfoPanelWidth, usePageInfoPanelOpen } from '../pageInfoPanelState';

const invoke = vi.fn();
const wrapper = ({ children }: { children: React.ReactNode }) => React.createElement(Provider, { store }, children);

beforeEach(() => {
  invoke.mockReset();
  (window as any).electronAPI = { invoke };
  store.set(pageInfoPanelOpenAtom, false);
});

describe('Page info open state', () => {
  it('restores the saved choice and width for the project and saves changes', async () => {
    invoke.mockResolvedValueOnce({ pageInfoPanelOpen: true, pageInfoPanelWidth: 410 });
    store.set(activeWorkspacePathAtom, '/ws/a');
    const { result } = renderHook(() => usePageInfoPanelOpen(), { wrapper });
    await waitFor(() => expect(result.current[0]).toBe(true));
    expect(invoke).toHaveBeenCalledWith('workspace:get-state', '/ws/a');
    expect(store.get(pageInfoPanelWidthAtom)).toBe(410);

    invoke.mockResolvedValue(undefined);
    act(() => result.current[1](false));
    expect(result.current[0]).toBe(false);
    expect(invoke).toHaveBeenLastCalledWith('workspace:update-state', '/ws/a', { pageInfoPanelOpen: false });

    // A drag past the limit saves the clamped width.
    setPageInfoPanelWidth(5000);
    expect(store.get(pageInfoPanelWidthAtom)).toBe(640);
    expect(invoke).toHaveBeenLastCalledWith('workspace:update-state', '/ws/a', { pageInfoPanelWidth: 640 });
  });

  it('keeps a toggle made while the saved choice is still loading', async () => {
    let resolveState!: (state: unknown) => void;
    invoke.mockImplementation((channel: string) => (channel === 'workspace:get-state'
      ? new Promise((resolve) => { resolveState = resolve; })
      : Promise.resolve()));
    store.set(activeWorkspacePathAtom, '/ws/b');
    const { result } = renderHook(() => usePageInfoPanelOpen(), { wrapper });
    act(() => result.current[1](true));
    await act(async () => resolveState({ pageInfoPanelOpen: false }));
    expect(result.current[0]).toBe(true);
  });
});
