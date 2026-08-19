/**
 * Open a team-shared document by id, from anywhere in the renderer.
 *
 * Extracted from `EmbedFrame` when the feedback respond surface needed the same
 * move: switch the window into collab mode and hand the pending-document atom an
 * id, letting the collab surface own resolution. Two callers copying six lines
 * of atom writes is how one of them quietly drifts.
 *
 * The caller supplies its own analytics source, because "the user opened a
 * shared document" answers a different question depending on where they were
 * standing when they did it.
 */

import { store } from '@nimbalyst/runtime/store';
import type { ResourceRef } from '@nimbalyst/collab-protocol';

import {
  activeCollabScopeAtom,
  pendingCollabDocumentAtom,
} from '../store/atoms/collabDocuments';
import type { CollabDocumentOpenSource } from './collabDocumentOpener';
import { setWindowModeAtom } from '../store/atoms/windowMode';

export function openSharedDocumentInTab(
  document: string | ResourceRef,
  analyticsSource: CollabDocumentOpenSource,
): boolean {
  const scope = store.get(activeCollabScopeAtom);
  if (!scope) return false;
  const documentId = typeof document === 'string' ? document : document.sourceId;
  if (typeof document !== 'string') {
    if (document.kind !== 'document' || document.orgId !== scope.orgId) return false;
    const activeProjectId = scope.indexConfig.teamProjectId ?? undefined;
    if (document.projectId && document.projectId !== activeProjectId) return false;
  }
  store.set(setWindowModeAtom, 'collab');
  store.set(pendingCollabDocumentAtom, {
    documentId,
    scopeKey: scope.scopeKey,
    orgId: scope.orgId,
    analyticsSource,
  });
  return true;
}
