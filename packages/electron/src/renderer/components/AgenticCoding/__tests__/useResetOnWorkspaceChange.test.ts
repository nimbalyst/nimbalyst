// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest';
import { renderHook } from '@testing-library/react';
import { useResetOnWorkspaceChange } from '../useResetOnWorkspaceChange';

describe('useResetOnWorkspaceChange', () => {
  it('does not reset on first mount', () => {
    const reset = vi.fn();
    renderHook(({ path }) => useResetOnWorkspaceChange(path, reset), { initialProps: { path: '/a' } });
    expect(reset).not.toHaveBeenCalled();
  });

  it('does not reset when rerendered with the same path', () => {
    const reset = vi.fn();
    const { rerender } = renderHook(({ path }) => useResetOnWorkspaceChange(path, reset), { initialProps: { path: '/a' } });
    rerender({ path: '/a' });
    expect(reset).not.toHaveBeenCalled();
  });

  it('resets once when the path changes', () => {
    const reset = vi.fn();
    const { rerender } = renderHook(({ path }) => useResetOnWorkspaceChange(path, reset), { initialProps: { path: '/a' } });
    rerender({ path: '/b' });
    rerender({ path: '/b' });
    expect(reset).toHaveBeenCalledTimes(1);
  });

  it('marks a request started in a superseded workspace as stale once the workspace changes', async () => {
    const { result, rerender } = renderHook(
      ({ path }) => useResetOnWorkspaceChange(path, vi.fn()),
      { initialProps: { path: '/a' } },
    );
    let resolveSearch!: (sessions: string[]) => void;
    const search = new Promise<string[]>(resolve => { resolveSearch = resolve; });
    const applied: string[][] = [];

    const isCurrentA = result.current();
    const run = search.then(sessions => { if (isCurrentA()) applied.push(sessions); });
    rerender({ path: '/b' });
    resolveSearch(['session-from-a']);
    await run;
    expect(applied).toEqual([]);

    const isCurrentB = result.current();
    expect(isCurrentB()).toBe(true);
  });

  it('keeps a request current when the workspace does not change', () => {
    const { result, rerender } = renderHook(
      ({ path }) => useResetOnWorkspaceChange(path, vi.fn()),
      { initialProps: { path: '/a' } },
    );
    const isCurrent = result.current();
    rerender({ path: '/a' });
    expect(isCurrent()).toBe(true);
  });
});
