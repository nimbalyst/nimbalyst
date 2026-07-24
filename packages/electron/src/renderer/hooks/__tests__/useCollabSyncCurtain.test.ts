/**
 * @vitest-environment jsdom
 *
 * NIM-1985 regression: the shared-tracker body renders on first open and is
 * covered by a stuck "Loading content..." curtain on every reopen.
 *
 * The curtain latch is driven by two inputs that arrive in a DIFFERENT ORDER
 * depending on whether `BodyDocCache` was cold or warm:
 *
 *   cold: status 'disconnected' replayed -> epoch bump -> status 'connected'
 *   warm: status 'connected' replayed (OLD epoch) -> epoch bump
 *
 * The warm ordering is the one that broke: the latch is set, then cleared by
 * the epoch bump, and `status` never changes again to re-set it.
 */

import { describe, it, expect } from 'vitest';
import { renderHook } from '@testing-library/react';
import type { DocumentSyncStatus } from '@nimbalyst/runtime/sync';
import { useCollabSyncCurtain } from '../useCollabSyncCurtain';

type Props = { status: DocumentSyncStatus; epoch: number };

function render(initial: Props) {
  return renderHook(({ status, epoch }: Props) => useCollabSyncCurtain(status, epoch), {
    initialProps: initial,
  });
}

describe('useCollabSyncCurtain', () => {
  it('warm reopen: stays lifted when the epoch bumps AFTER a replayed connected status', () => {
    // BodyDocCache replays the warm entry's 'connected' status to the new
    // subscriber while `providerEpoch` is still the previous generation.
    const { result, rerender } = render({ status: 'connected', epoch: 1 });
    expect(result.current).toBe(true);

    // The acquire continuation then mints the new CollabLexicalProvider and
    // bumps the epoch. Status does NOT change -- it is already 'connected'.
    rerender({ status: 'connected', epoch: 2 });
    expect(result.current).toBe(true);
  });

  it('cold open: curtain stays down until the socket reaches connected', () => {
    const { result, rerender } = render({ status: 'disconnected', epoch: 0 });
    expect(result.current).toBe(false);

    rerender({ status: 'disconnected', epoch: 1 });
    expect(result.current).toBe(false);

    rerender({ status: 'connecting', epoch: 1 });
    expect(result.current).toBe(false);

    rerender({ status: 'connected', epoch: 1 });
    expect(result.current).toBe(true);
  });

  it('switching to a not-yet-connected item re-covers the editor', () => {
    const { result, rerender } = render({ status: 'connected', epoch: 1 });
    expect(result.current).toBe(true);

    // New item: the hook tears down, status resets, a fresh provider mounts.
    rerender({ status: 'disconnected', epoch: 2 });
    expect(result.current).toBe(false);

    rerender({ status: 'connected', epoch: 2 });
    expect(result.current).toBe(true);
  });

  it('a mid-session disconnect does not re-cover an already-painted editor', () => {
    const { result, rerender } = render({ status: 'connected', epoch: 3 });
    expect(result.current).toBe(true);

    // Transient socket blip on the SAME provider generation: the editor still
    // holds the painted content, so do not slam a curtain over it.
    rerender({ status: 'disconnected', epoch: 3 });
    expect(result.current).toBe(true);
  });
});
