// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest';
import { renderHook } from '@testing-library/react';
import { useDialogRequestTrigger } from '../useDialogRequestTrigger';

describe('useDialogRequestTrigger', () => {
  it('does not fire on initial mount (no increment yet)', () => {
    const onTrigger = vi.fn();
    renderHook(
      ({ version, ready }) => useDialogRequestTrigger(version, ready, onTrigger),
      { initialProps: { version: 0, ready: true } },
    );
    expect(onTrigger).not.toHaveBeenCalled();
  });

  it('fires once when the version increments while ready', () => {
    const onTrigger = vi.fn();
    const { rerender } = renderHook(
      ({ version, ready }) => useDialogRequestTrigger(version, ready, onTrigger),
      { initialProps: { version: 0, ready: true } },
    );
    rerender({ version: 1, ready: true });
    expect(onTrigger).toHaveBeenCalledTimes(1);
  });

  // This is the #480 regression: an unrelated dependency change (workspace
  // switch) must NOT re-open the dialog. The trigger consumes the version on
  // fire, so a re-render at the same version is a no-op.
  it('does NOT re-fire when an unrelated re-render happens at the same version', () => {
    const onTrigger = vi.fn();
    const { rerender } = renderHook(
      ({ version, ready, unrelated }) => {
        // `unrelated` stands in for workspacePath changing; it forces a
        // re-render and a new onTrigger identity, exactly like App.tsx.
        void unrelated;
        return useDialogRequestTrigger(version, ready, onTrigger);
      },
      { initialProps: { version: 0, ready: true, unrelated: 'a' } },
    );
    rerender({ version: 1, ready: true, unrelated: 'a' }); // increment -> fires
    rerender({ version: 1, ready: true, unrelated: 'b' }); // workspace switch
    rerender({ version: 1, ready: true, unrelated: 'c' }); // another switch
    expect(onTrigger).toHaveBeenCalledTimes(1);
  });

  it('defers firing until ready, then fires exactly once', () => {
    const onTrigger = vi.fn();
    const { rerender } = renderHook(
      ({ version, ready }) => useDialogRequestTrigger(version, ready, onTrigger),
      { initialProps: { version: 0, ready: false } },
    );
    rerender({ version: 1, ready: false }); // incremented but not ready -> no fire
    expect(onTrigger).not.toHaveBeenCalled();
    rerender({ version: 1, ready: true }); // becomes ready -> fires once
    expect(onTrigger).toHaveBeenCalledTimes(1);
    rerender({ version: 1, ready: true }); // stays ready, same version -> no re-fire
    expect(onTrigger).toHaveBeenCalledTimes(1);
  });

  it('fires again on a subsequent increment', () => {
    const onTrigger = vi.fn();
    const { rerender } = renderHook(
      ({ version, ready }) => useDialogRequestTrigger(version, ready, onTrigger),
      { initialProps: { version: 0, ready: true } },
    );
    rerender({ version: 1, ready: true });
    rerender({ version: 2, ready: true });
    expect(onTrigger).toHaveBeenCalledTimes(2);
  });
});
