// @vitest-environment jsdom
import { act, renderHook } from '@testing-library/react';
import React from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  TabsProvider,
  useTabNavigationShortcuts,
  useTabs,
} from '../TabsContext';

const nextTabListeners = new Set<() => void>();
const previousTabListeners = new Set<() => void>();
const onNextTab = vi.fn((callback: () => void) => {
  nextTabListeners.add(callback);
  return () => nextTabListeners.delete(callback);
});
const onPreviousTab = vi.fn((callback: () => void) => {
  previousTabListeners.add(callback);
  return () => previousTabListeners.delete(callback);
});

beforeEach(() => {
  onNextTab.mockClear();
  onPreviousTab.mockClear();
  nextTabListeners.clear();
  previousTabListeners.clear();
  (globalThis as any).window.electronAPI = {
    onNextTab,
    onPreviousTab,
  };
});

function wrapper({ children }: { children: React.ReactNode }) {
  return (
    <TabsProvider workspacePath={null} disablePersistence>
      {children}
    </TabsProvider>
  );
}

describe('useTabNavigationShortcuts', () => {
  it('lets only the active mode own the menu listeners and navigate its tabs', () => {
    const { result, rerender } = renderHook(
      ({ isActive }: { isActive: boolean }) => {
        const tabs = useTabs();
        useTabNavigationShortcuts(isActive);
        return tabs;
      },
      { wrapper, initialProps: { isActive: false } },
    );

    expect(onNextTab).not.toHaveBeenCalled();
    expect(onPreviousTab).not.toHaveBeenCalled();

    let firstTabId: string | null = null;
    act(() => {
      firstTabId = result.current.addTab('collab://documents/first');
      result.current.addTab('collab://documents/second');
    });
    act(() => result.current.switchTab(firstTabId!));

    rerender({ isActive: true });
    expect(nextTabListeners.size).toBe(1);
    expect(previousTabListeners.size).toBe(1);

    act(() => nextTabListeners.forEach((listener) => listener()));
    expect(result.current.activeTab?.filePath).toBe('collab://documents/second');

    act(() => previousTabListeners.forEach((listener) => listener()));
    expect(result.current.activeTab?.filePath).toBe('collab://documents/first');

    rerender({ isActive: false });
    expect(nextTabListeners.size).toBe(0);
    expect(previousTabListeners.size).toBe(0);
  });
});
