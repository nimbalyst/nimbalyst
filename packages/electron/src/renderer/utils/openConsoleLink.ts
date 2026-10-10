/**
 * Open a console link's target in this window, per `planConsoleLinkOpen`.
 * Returns false when the link belongs in the browser instead.
 */
import { store } from '@nimbalyst/runtime/store';
import { trackerItemByReferenceKeyAtom } from '@nimbalyst/runtime/plugins/TrackerPlugin/trackerDataAtoms';
import {
  setTrackerReferenceHomeScope,
  setTrackerReferenceHrefBuilder,
} from '@nimbalyst/runtime/plugins/TrackerLinkPlugin/trackerReferenceHref';
import type { CollabArtifactRef, CollabOpenOptions, CollabScope } from '@nimbalyst/collab-client/core';

import {
  activeCollabScopeAtom,
  getElectronCollabHost,
  getPersonalCollabHost,
} from '../store/atoms/collabDocuments';
import { activeWorkspacePathAtom } from '../store/atoms/openProjects';
import { setWindowModeAtom } from '../store/atoms/windowMode';
import { errorNotificationService } from '../services/ErrorNotificationService';
import { openSharedDocumentInTab } from './openSharedDocumentInTab';
import { planConsoleLinkOpen, trackerReferenceLinkFor } from './consoleLinkPlan';

const SOURCE = 'deep_link';

type PageRef = { kind: 'tracker'; id: string } | { kind: 'type'; id: string };

function artifactRef(page: PageRef, scope: CollabScope): CollabArtifactRef {
  return page.kind === 'tracker' ? { kind: 'tracker', scope, trackerId: page.id } : { kind: 'type', scope, typeId: page.id };
}

/** Opens an item or type as a page: through the team host when there is a team and it is not personal, else the personal host. */
function openPage(page: PageRef, personal: boolean, workspacePath: string | null, options?: CollabOpenOptions): void {
  store.set(setWindowModeAtom, 'collab');
  const scope = store.get(activeCollabScopeAtom);
  if (scope && !personal) {
    getElectronCollabHost(scope).openArtifact(artifactRef(page, scope), SOURCE, options);
    return;
  }
  if (!workspacePath) return;
  const host = getPersonalCollabHost(workspacePath);
  void host.resolveScope().then((personalScope) => {
    host.openArtifact(artifactRef(page, personalScope), SOURCE, options);
  });
}

function activeTeam(): { orgId: string; teamProjectId: string } | null {
  const scope = store.get(activeCollabScopeAtom);
  const teamProjectId = scope?.indexConfig.teamProjectId;
  return scope && teamProjectId ? { orgId: scope.orgId, teamProjectId } : null;
}

/**
 * New typed-page references in this window's editors are written as console
 * links (`trackerReferenceLinkFor`), read from the active team at the moment
 * the reference is created. The same team is the project references resolve
 * in: a link to another project's item shows as an external link.
 */
export function installTrackerReferenceLinks(): () => void {
  setTrackerReferenceHrefBuilder((referenceKey) =>
    trackerReferenceLinkFor(referenceKey, activeTeam(), store.get(trackerItemByReferenceKeyAtom(referenceKey))));
  const publishHomeScope = () => {
    const team = activeTeam();
    setTrackerReferenceHomeScope(team ? { orgId: team.orgId, projectId: team.teamProjectId } : null);
  };
  publishHomeScope();
  const unsubscribe = store.sub(activeCollabScopeAtom, publishHomeScope);
  return () => {
    unsubscribe();
    setTrackerReferenceHrefBuilder(null);
    setTrackerReferenceHomeScope(undefined);
  };
}

/** `options`: a click on a link in a page shown in Pages, which navigates like any page link there. */
export function openConsoleLinkInWindow(href: string, options?: CollabOpenOptions): boolean {
  const workspacePath = store.get(activeWorkspacePathAtom);
  const plan = planConsoleLinkOpen(href, {
    team: activeTeam(),
    resolveItem: (itemRef) => store.get(trackerItemByReferenceKeyAtom(itemRef))?.id ?? null,
  });
  if (!plan || plan.action === 'browser') return false;

  switch (plan.action) {
    case 'team-document':
      return openSharedDocumentInTab(plan.documentId, SOURCE, options);
    case 'item':
      // A key resolves in either store; the team host opens team and personal items alike.
      openPage({ kind: 'tracker', id: plan.itemId }, false, workspacePath, options);
      return true;
    case 'type':
      openPage({ kind: 'type', id: plan.typeId }, plan.personal, workspacePath, options);
      return true;
    case 'personal-page': {
      if (!workspacePath) return false;
      const host = getPersonalCollabHost(workspacePath);
      void host.resolveScope().then((personalScope) => {
        store.set(setWindowModeAtom, 'collab');
        host.openArtifact({ kind: 'document', scope: personalScope, documentId: plan.pageId, teamProjectId: null }, SOURCE, options);
      });
      return true;
    }
    case 'session':
      window.dispatchEvent(new CustomEvent('open-ai-session', { detail: { sessionId: plan.sessionId, workspacePath } }));
      return true;
    case 'missing':
      errorNotificationService.showWarning(
        plan.what === 'view' ? 'View not available' : 'Page not in this project',
        plan.what === 'view'
          ? 'This list is not available to open on its own.'
          : 'The page this link points at is not in this project.',
        { duration: 6000 },
      );
      return true;
  }
}
