/**
 * Headless bridge between the host's reactive tracker store and the grid's
 * paint-time {@link TrackerResolutionStore}.
 *
 * `useResolvedTrackerReference` is a hook, so one component instance is mounted
 * per distinct key. They render nothing — their only job is to push resolutions
 * into the store, which repaints the affected cells.
 */

import { useEffect } from 'react';
import { useResolvedTrackerReference } from '@nimbalyst/extension-sdk';

import type { TrackerResolutionStore } from './trackerResolution';

interface TrackerKeyResolverProps {
  referenceKey: string;
  store: TrackerResolutionStore;
}

function TrackerKeyResolver({ referenceKey, store }: TrackerKeyResolverProps) {
  const resolved = useResolvedTrackerReference(referenceKey);

  useEffect(() => {
    store.setResolution(
      referenceKey,
      resolved
        ? {
            itemId: resolved.id,
            title: resolved.title,
            status: resolved.status,
            type: resolved.type,
          }
        : null,
    );
  }, [referenceKey, resolved, store]);

  return null;
}

interface TrackerCellResolversProps {
  keys: readonly string[];
  store: TrackerResolutionStore;
}

export function TrackerCellResolvers({ keys, store }: TrackerCellResolversProps) {
  return (
    <>
      {keys.map((key) => (
        <TrackerKeyResolver key={key} referenceKey={key} store={store} />
      ))}
    </>
  );
}
