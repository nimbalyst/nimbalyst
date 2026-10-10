/**
 * Local changes that can change the desktop's marks list, read from the atoms
 * the central listeners already keep:
 *
 * - a Personal page or Personal type page body, or the Personal page tree
 *   (`personal-pages:changed`, counted per workspace);
 * - a typed page body or any tracker item (a local save or a teammate's
 *   applied edit updates the tracker item map);
 * - the active team's page list (a team page trashed, restored or renamed).
 *
 * The listener runs on every change; the marks source coalesces them.
 */

import { atom } from 'jotai';
import { store } from '@nimbalyst/runtime/store';
import { trackerItemsMapAtom } from '@nimbalyst/runtime/plugins/TrackerPlugin/trackerDataAtoms';
import { sharedDocumentsAtom } from '@nimbalyst/collab-client/docs';

import { activeWorkspacePathAtom } from '../store/atoms/openProjects';
import { initPersonalPagesListeners, personalPagesRevisionAtomFamily } from '../store/listeners/personalPagesListeners';

const localPageMarksInputsAtom = atom((get) => {
  const workspacePath = get(activeWorkspacePathAtom);
  return [
    workspacePath ? get(personalPagesRevisionAtomFamily(workspacePath)) : 0,
    get(trackerItemsMapAtom),
    get(sharedDocumentsAtom),
  ] as const;
});

export function watchLocalPageMarks(listener: () => void): () => void {
  // Idempotent; the Personal pages session may not have installed it yet.
  initPersonalPagesListeners();
  return store.sub(localPageMarksInputsAtom, listener);
}
