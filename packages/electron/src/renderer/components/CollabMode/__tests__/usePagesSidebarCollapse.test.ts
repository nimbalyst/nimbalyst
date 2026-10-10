// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, renderHook, waitFor } from '@testing-library/react';
import { usePagesSidebarCollapse } from '../usePagesSidebarCollapse';

function mockWorkspaceState(state: unknown) {
  const invoke = vi.fn(async (channel: string) => (channel === 'workspace:get-state' ? state : undefined));
  (window as unknown as { electronAPI: unknown }).electronAPI = { invoke };
  return invoke;
}

afterEach(() => {
  delete (window as unknown as { electronAPI?: unknown }).electronAPI;
});

describe('usePagesSidebarCollapse', () => {
  it('defaults by team presence, applies the stored state, and persists a toggle', async () => {
    mockWorkspaceState({});
    const withTeam = renderHook(() => usePagesSidebarCollapse('/ws', true));
    expect(withTeam.result.current.collapsed).toEqual({ team: false, personal: true });
    withTeam.unmount();
    const noTeam = renderHook(() => usePagesSidebarCollapse('/ws', false));
    expect(noTeam.result.current.collapsed.personal).toBe(false);
    noTeam.unmount();

    const invoke = mockWorkspaceState({ pagesSidebarCollapsed: { team: true } });
    const stored = renderHook(() => usePagesSidebarCollapse('/ws', true));
    await waitFor(() => expect(stored.result.current.collapsed).toEqual({ team: true, personal: true }));

    act(() => stored.result.current.toggle('personal'));
    expect(stored.result.current.collapsed).toEqual({ team: true, personal: false });
    expect(invoke).toHaveBeenCalledWith('workspace:update-state', '/ws', { pagesSidebarCollapsed: { personal: false } });
  });

  it('keeps the loaded Team preference when Personal was toggled before the load landed', async () => {
    let resolveState!: (state: unknown) => void;
    const invoke = vi.fn((channel: string) => (channel === 'workspace:get-state'
      ? new Promise((resolve) => { resolveState = resolve; })
      : Promise.resolve(undefined)));
    (window as unknown as { electronAPI: unknown }).electronAPI = { invoke };
    const { result } = renderHook(() => usePagesSidebarCollapse('/ws', true));
    act(() => result.current.toggle('personal'));
    await act(async () => resolveState({ pagesSidebarCollapsed: { team: true } }));
    expect(result.current.collapsed).toEqual({ team: true, personal: false });
  });
});
