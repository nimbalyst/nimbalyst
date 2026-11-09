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
});
