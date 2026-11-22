import { atom } from 'jotai';

/**
 * Background project moves, keyed by the project's old path. Written by
 * projectMoveListeners from `project:move-progress`; read by the Project Manager.
 */
export const projectMoveJobsAtom = atom<Record<string, ProjectMoveJob>>({});
