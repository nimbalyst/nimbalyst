/**
 * Central listener for background project moves.
 *
 * `project:move` returns as soon as the move starts; main then broadcasts
 * `project:move-progress` to every window as the move advances and finishes.
 * Seeds from `project:move-jobs` so a window opened mid-move sees it too.
 */

import { store } from '../index';
import { projectMoveJobsAtom } from '../atoms/projectMoves';

export function initProjectMoveListeners(): () => void {
  const upsert = (job: ProjectMoveJob) => {
    if (!job?.oldPath) return;
    store.set(projectMoveJobsAtom, (current) => ({ ...current, [job.oldPath]: job }));
  };

  const cleanup = window.electronAPI.projectMigration.onMoveProgress(upsert);
  void window.electronAPI.projectMigration
    .getMoveJobs()
    .then((jobs) => {
      // A broadcast that already arrived is newer than the snapshot.
      store.set(projectMoveJobsAtom, (current) => {
        const next = { ...current };
        for (const job of jobs) {
          if (!next[job.oldPath]) next[job.oldPath] = job;
        }
        return next;
      });
    })
    .catch((error) => console.error('[projectMoveListeners] Failed to load move jobs:', error));
  return cleanup;
}
