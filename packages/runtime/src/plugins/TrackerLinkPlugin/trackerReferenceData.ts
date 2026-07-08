/**
 * Live data + navigation seam for tracker reference chips.
 *
 * A `TrackerReferenceNode` stores ONLY a reference key. The chip resolves the
 * item's live title/status from the canonical runtime tracker store
 * (`trackerItemsMapAtom`, populated cross-platform by the host adapter — the
 * Electron IPC sync listener or the mobile adapter). Because it reads the store
 * reactively, editing or closing the item elsewhere updates every chip with no
 * document edit.
 *
 * This keeps the chip platform-agnostic: it depends only on runtime atoms, not
 * on renderer/IPC code. Navigation is dispatched via a window CustomEvent that
 * the host listens for (`nimbalyst:navigate-tracker-item`).
 */

import { useAtomValue } from 'jotai';

import { trackerItemByReferenceKeyAtom } from '../TrackerPlugin/trackerDataAtoms';

/** The minimal live data a chip needs to render. */
export interface ResolvedTrackerReference {
  /** Internal tracker item id (for navigation). */
  id: string;
  /** Human-readable key like NIM-123. */
  issueKey?: string;
  title: string;
  /** Raw status string (e.g. 'in-progress'); the chip maps it to a color. */
  status?: string;
  /** Tracker type (bug/task/plan/...). */
  type?: string;
  priority?: string;
  owner?: string;
}

/**
 * Resolve a reference key to its live tracker item, or `null` when no record
 * matches (unknown / not yet synced / different workspace). Reactive: re-renders
 * the caller when the underlying record changes.
 */
export function useResolvedTrackerReference(
  referenceKey: string,
): ResolvedTrackerReference | null {
  const record = useAtomValue(trackerItemByReferenceKeyAtom(referenceKey));
  if (!record) return null;
  const fields = record.fields as Record<string, unknown>;
  return {
    id: record.id,
    issueKey: record.issueKey,
    title: (fields.title as string) ?? '',
    status: fields.status as string | undefined,
    type: record.primaryType,
    priority: fields.priority as string | undefined,
    owner: fields.owner as string | undefined,
  };
}

/**
 * Ask the host to open/navigate to a tracker item. The Electron renderer
 * listens for this event in `App.tsx` (`handleNavigateTrackerItem`).
 */
export function navigateToTrackerReference(
  reference: ResolvedTrackerReference,
): void {
  if (typeof window === 'undefined') return;
  window.dispatchEvent(
    new CustomEvent('nimbalyst:navigate-tracker-item', {
      detail: { itemId: reference.id },
    }),
  );
}
