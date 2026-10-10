/**
 * Opening a page from a Pages header crumb. The crumb names pages, typed pages
 * and types; each opens through its section's host (the team's or Personal),
 * the same way a sidebar click does.
 */
import type { CollabArtifactRef, CollabScope } from '@nimbalyst/collab-client/core';
import type { PageTreeAncestor } from '@nimbalyst/collab-client/trackers-ui/page';
import { getElectronCollabHost, getPersonalCollabHost } from '../../store/atoms/collabDocuments';

export function pageAncestorArtifact(ancestor: PageTreeAncestor, scope: CollabScope): CollabArtifactRef {
  if (ancestor.kind === 'item') return { kind: 'tracker', scope, trackerId: ancestor.id };
  if (ancestor.kind === 'type') return { kind: 'type', scope, typeId: ancestor.id };
  return { kind: 'document', scope, documentId: ancestor.id, teamProjectId: scope.indexConfig.teamProjectId ?? null };
}

/** Opens `ancestor` in Pages, in the Personal section or the team's. */
export function openPageAncestor(
  ancestor: PageTreeAncestor,
  section: { personal: true; workspacePath: string } | { personal: false; scope: CollabScope },
): void {
  if (section.personal) {
    const host = getPersonalCollabHost(section.workspacePath);
    host.openArtifact(pageAncestorArtifact(ancestor, host.scope), 'sidebar');
    return;
  }
  getElectronCollabHost(section.scope).openArtifact(pageAncestorArtifact(ancestor, section.scope), 'sidebar');
}
