import { store } from '@nimbalyst/runtime/store';
import {
  activeCollabScopeAtom,
  sharedDocumentsAtom,
} from '../store/atoms/collabDocuments';
import { activeWorkspacePathAtom } from '../store/atoms/openProjects';
import {
  getCollabDocsSession,
  getSharedDocumentsForScopeKey,
  isSharedIndexLoadedForScopeKey,
} from '@nimbalyst/collab-client/docs';

export type SharedDocumentVisibility = {
  kind: 'document';
  sourceId: string;
  teamVisible: boolean;
  orgId: string | null;
  reason: 'shared' | 'notShared' | 'noTeam';
};

/**
 * Read the same shared-document index that backs the Team files UI.
 *
 * `workspacePath` names the project the caller asks about. MCP routes the
 * request to the window whose rail holds that project, which may be showing
 * another project with its own team index; that project's index answers, or
 * the read fails when this window has not loaded it. Without `workspacePath`
 * the active project answers.
 */
export function getSharedDocumentVisibility(sourceId: string, workspacePath?: string): SharedDocumentVisibility {
  const activeScope = store.get(activeCollabScopeAtom);
  // The active project answers from the active scope, including `noTeam` for a
  // project without one. Main sends the path this window holds (see
  // collabReadToolHandlers), so a plain comparison is enough.
  if (workspacePath && workspacePath !== store.get(activeWorkspacePathAtom)) {
    // A team scope is keyed by its workspace path (see CollabMode).
    const session = getCollabDocsSession(workspacePath);
    if (!session || !isSharedIndexLoadedForScopeKey(workspacePath)) {
      throw new Error(`The shared-document index for ${workspacePath} is not loaded in this window. Open that project, then retry.`);
    }
    const shared = getSharedDocumentsForScopeKey(workspacePath).some((document) => document.documentId === sourceId);
    return shared
      ? { kind: 'document', sourceId, teamVisible: true, orgId: session.scope.orgId, reason: 'shared' }
      : { kind: 'document', sourceId, teamVisible: false, orgId: null, reason: 'notShared' };
  }

  const scope = activeScope;
  if (!scope) {
    return { kind: 'document', sourceId, teamVisible: false, orgId: null, reason: 'noTeam' };
  }
  const shared = store.get(sharedDocumentsAtom).some((document) => document.documentId === sourceId);
  return shared
    ? { kind: 'document', sourceId, teamVisible: true, orgId: scope.orgId, reason: 'shared' }
    : { kind: 'document', sourceId, teamVisible: false, orgId: null, reason: 'notShared' };
}

export function registerMcpCollabReadHandlers(): (() => void)[] {
  if (!window.electronAPI.onMcpGetResourceSharingStatus) return [];
  return [window.electronAPI.onMcpGetResourceSharingStatus(({ sourceId, workspacePath, resultChannel }) => {
    try {
      window.electronAPI.sendMcpCollabReadResult(resultChannel, {
        success: true,
        result: getSharedDocumentVisibility(sourceId, workspacePath),
      });
    } catch (error) {
      window.electronAPI.sendMcpCollabReadResult(resultChannel, {
        success: false,
        error: error instanceof Error ? error.message : 'Unknown shared-document read error',
      });
    }
  })];
}
