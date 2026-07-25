/** Genuine-open recency, deliberately separate from unread read receipts. */

import { useEffect } from 'react';
import { useAtomValue, useSetAtom } from 'jotai';
import { recordTrackerOpenedAtom, trackerPersonalStateHydratedAtom } from '../store/atoms/trackerPersonalState';

const GENUINE_OPEN_DEBOUNCE_MS = 400;

export function useRecordTrackerOpened(itemId: string | null | undefined, workspacePath: string | undefined): void {
  const recordOpened = useSetAtom(recordTrackerOpenedAtom);
  const hydrated = useAtomValue(trackerPersonalStateHydratedAtom);
  useEffect(() => {
    if (!itemId || !workspacePath || !hydrated) return;
    const timer = setTimeout(() => {
      void recordOpened({ itemId, openedAt: Date.now() });
    }, GENUINE_OPEN_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [itemId, workspacePath, hydrated, recordOpened]);
}
