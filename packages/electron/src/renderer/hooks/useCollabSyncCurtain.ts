/**
 * useCollabSyncCurtain
 *
 * Decides whether the "Loading content..." curtain should still cover a
 * collaborative tracker body editor.
 *
 * The curtain exists because the editor can mount against an empty Y.Doc
 * while the WebSocket sync is still in flight -- without it the user sees a
 * blank editor and reads it as "no content".
 *
 * NIM-1985: this used to be two independent effects -- one keyed on
 * `providerEpoch` that reset the latch to false, one keyed on `status` that
 * set it to true. That is order-dependent, and the order inverts on a WARM
 * reopen:
 *
 *   cold open  -> replayed status is 'disconnected', epoch bumps, THEN the
 *                 socket connects: reset runs first, latch runs second. OK.
 *   warm reopen -> `BodyDocCache` replays 'connected' synchronously on
 *                 acquire (still on the OLD epoch), and the epoch bump lands
 *                 in a later render. The latch ran first and the reset ran
 *                 second, so the curtain stayed up forever -- `status` never
 *                 changes again, so nothing re-latches it.
 *
 * Tracking WHICH provider generation reached 'connected' removes the
 * ordering dependency entirely: the effect re-evaluates whenever either
 * input changes and reads the live status, so a post-hoc epoch bump
 * re-latches instead of clearing.
 */

import { useEffect, useState } from 'react';
import type { DocumentSyncStatus } from '@nimbalyst/runtime/sync';

export function useCollabSyncCurtain(
  status: DocumentSyncStatus,
  providerEpoch: number,
): boolean {
  const [syncedEpoch, setSyncedEpoch] = useState<number | null>(null);

  useEffect(() => {
    if (status === 'connected') setSyncedEpoch(providerEpoch);
  }, [status, providerEpoch]);

  return syncedEpoch !== null && syncedEpoch === providerEpoch;
}
