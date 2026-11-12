// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest';
import { renderHook } from '@testing-library/react';
import { runWorkspaceGuardedRequest, useResetOnWorkspaceChange } from '../useResetOnWorkspaceChange';

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

describe('runWorkspaceGuardedRequest', () => {
  function setup() {
    const { result, rerender } = renderHook(
      ({ path }) => useResetOnWorkspaceChange(path, vi.fn()),
      { initialProps: { path: '/a' } },
    );
    const callbacks = { onResult: vi.fn(), onError: vi.fn(), onSettled: vi.fn() };
    let resolve!: (value: string) => void;
    let reject!: (error: Error) => void;
    const pending = new Promise<string>((res, rej) => { resolve = res; reject = rej; });
    const run = runWorkspaceGuardedRequest({ isCurrent: result.current(), request: () => pending, ...callbacks });
    return { rerender, callbacks, resolve, reject, run };
  }

  it('applies the result and settles while the workspace is current', async () => {
    const t = setup();
    t.resolve('sessions');
    await t.run;
    expect(t.callbacks.onResult).toHaveBeenCalledWith('sessions');
    expect(t.callbacks.onSettled).toHaveBeenCalledTimes(1);
    expect(t.callbacks.onError).not.toHaveBeenCalled();
  });

  it('applies the error and settles while the workspace is current', async () => {
    const t = setup();
    t.reject(new Error('boom'));
    await t.run;
    expect(t.callbacks.onError).toHaveBeenCalledTimes(1);
    expect(t.callbacks.onSettled).toHaveBeenCalledTimes(1);
    expect(t.callbacks.onResult).not.toHaveBeenCalled();
  });

  it('calls nothing when a superseded workspace resolves', async () => {
    const t = setup();
    t.rerender({ path: '/b' });
    t.resolve('sessions-from-a');
    await t.run;
    expect(t.callbacks.onResult).not.toHaveBeenCalled();
    expect(t.callbacks.onError).not.toHaveBeenCalled();
    expect(t.callbacks.onSettled).not.toHaveBeenCalled();
  });

  it('calls nothing when a superseded workspace rejects', async () => {
    const t = setup();
    t.rerender({ path: '/b' });
    t.reject(new Error('A failed'));
    await t.run;
    expect(t.callbacks.onResult).not.toHaveBeenCalled();
    expect(t.callbacks.onError).not.toHaveBeenCalled();
    expect(t.callbacks.onSettled).not.toHaveBeenCalled();
  });

  it('routes a throwing onResult to onError', async () => {
    const t = setup();
    t.callbacks.onResult.mockImplementation(() => { throw new Error('map failed'); });
    t.resolve('sessions');
    await t.run;
    expect(t.callbacks.onError).toHaveBeenCalledTimes(1);
    expect(t.callbacks.onSettled).toHaveBeenCalledTimes(1);
  });
});
