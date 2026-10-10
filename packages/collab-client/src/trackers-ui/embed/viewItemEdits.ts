/**
 * How a cell edit in a view embed reaches the item: one `update-items` command
 * through the host's data source, so a placed view and a type page's table
 * write the way the rest of the host does. The host routes each entry (a
 * file-backed item's fields to its file on desktop, the team lane in the
 * browser); this module only decides what may be edited and what to send.
 */

import type { TrackerRecord } from '@nimbalyst/runtime/core/TrackerRecord';
import { globalRegistry } from '@nimbalyst/runtime/plugins/TrackerPlugin/models';
import { resolveTrackerWriteAccess } from '@nimbalyst/runtime/plugins/TrackerPlugin/models/trackerLifecycle';
import type { TrackerDataCommand, TrackerDataSource } from '@nimbalyst/collab-client/trackers';
import type { TrackerGridUpdateEntry } from '../grid/TrackerGridSurface';

/** The table's own rule (`useTrackerRows`): an archived type is read-only; other sources' fields are written where they live. */
export function isViewRecordEditable(record: TrackerRecord): boolean {
  if (!resolveTrackerWriteAccess(globalRegistry.get(record.primaryType ?? '')).canWrite) return false;
  return record.source === 'native'
    || !record.system.documentPath
    || record.source === 'frontmatter'
    || record.source === 'import'
    || record.source === 'inline';
}

export function viewEditsCommand(entries: readonly TrackerGridUpdateEntry[]): TrackerDataCommand {
  return {
    type: 'update-items',
    input: { entries: entries.map(({ itemId, updates }) => ({ itemId, storeUpdates: updates })) },
  };
}

/** Throws when the host refused, so the grid shows the reason instead of a saved-looking cell. */
export async function writeViewEdits(
  dataSource: Pick<TrackerDataSource, 'command'>,
  entries: readonly TrackerGridUpdateEntry[],
): Promise<void> {
  if (entries.length === 0) return;
  const outcome = await dataSource.command(viewEditsCommand(entries));
  const answer = outcome.result as { success?: unknown; error?: unknown; results?: Array<{ success?: unknown; error?: unknown }> } | undefined;
  if (answer?.success !== false) return;
  const firstError = answer.results?.find((entry) => entry.success === false)?.error ?? answer.error;
  throw new Error(typeof firstError === 'string' && firstError ? firstError : 'The change was not saved');
}
