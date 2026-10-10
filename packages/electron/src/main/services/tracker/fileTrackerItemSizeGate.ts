/**
 * The pre-write size check for a file-backed tracker item (frontmatter or
 * inline), the same one `update-tracker-item` runs through `beforeWrite`: a
 * shared item its room would refuse is refused before the file is written,
 * and the caller (a placed view's cell, the detail pane) shows the refusal.
 */
import type { TrackerItem } from '@nimbalyst/runtime';
import { trackerItemToRecord, trackerRecordToItem } from '@nimbalyst/runtime/core/TrackerRecord';
import { sharedTrackerItemTooLarge } from './trackerItemShareGate';
import { pgliteRowToTrackerItem } from './TrackerPGLiteStore';

type TrackerItemRow = Parameters<typeof pgliteRowToTrackerItem>[0];

/**
 * `current` with `updates` applied, as the room would receive it. A
 * frontmatter item's `description` is its body, which travels by version, not
 * in the item payload.
 */
function fileTrackerItemCandidate(current: TrackerItem, updates: Record<string, unknown>, bodyInFields: boolean): TrackerItem {
  const { description, ...rest } = updates;
  const fields = bodyInFields && description !== undefined ? { ...rest, description } : rest;
  const record = trackerItemToRecord(current);
  return trackerRecordToItem({ ...record, fields: { ...record.fields, ...fields } });
}

/** The refusal message for writing `updates` to `current`, or null when the write may go ahead. */
export function fileTrackerItemUpdateRefusal(
  current: TrackerItem | null,
  updates: Record<string, unknown>,
  workspacePath: string,
  options: { bodyInFields?: boolean } = {},
): string | null {
  if (!current) return null;
  const candidate = fileTrackerItemCandidate(current, updates, options.bodyInFields ?? false);
  return sharedTrackerItemTooLarge(candidate, workspacePath)?.message ?? null;
}

/** `fileTrackerItemUpdateRefusal` for the item's `tracker_items` row, as the file-write handler reads it. */
export function fileTrackerItemRowUpdateRefusal(row: TrackerItemRow, updates: Record<string, unknown>): string | null {
  return fileTrackerItemUpdateRefusal(pgliteRowToTrackerItem(row, row.workspace), updates, row.workspace, {
    bodyInFields: row.source === 'inline',
  });
}
