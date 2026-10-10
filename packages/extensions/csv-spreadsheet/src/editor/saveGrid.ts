/**
 * Save the grid to disk.
 *
 * The CSV is serialized through the command queue, so an edit issued just
 * before the save (a typed cell committed by the same keystroke) is in the
 * file. Dirty is cleared only when no command wrote the grid while the save
 * was in flight; otherwise the editor would show clean over unsaved edits.
 */

import type { GridOperations } from '../utils/gridOperations';

export interface SaveTarget {
  saveContent(content: string): Promise<void>;
  /** Records the saved bytes for echo detection. */
  updateDiskContent(content: string): void;
  markClean(): void;
}

export async function saveGridContent(
  gridOps: Pick<GridOperations, 'snapshotCSV' | 'executor'>,
  target: SaveTarget,
): Promise<void> {
  const { content, revision } = await gridOps.snapshotCSV();
  // Save first: a rejected write must leave the editor dirty, with the
  // previous disk baseline.
  await target.saveContent(content);
  target.updateDiskContent(content);
  if (gridOps.executor.revision === revision) target.markClean();
}
