/**
 * Desktop hosts for knowledge pages: the cross-page marks source (local
 * bodies plus the team's marks index), where a citation chip jumps, and who a
 * new mark is attributed to.
 */

import { store } from '@nimbalyst/runtime/store';
import { setCitationHost } from '@nimbalyst/runtime/editor/plugins/CitationPlugin/citationHost';
import { setPageMarkAuthorProvider, type PageMarkAuthor } from '@nimbalyst/runtime/editor/plugins/PageMarkPlugin/pageMarkHost';
import { openWorkspaceFileLink } from '@nimbalyst/runtime/editor/utils/workspaceLinkNavigation';
import { isWebSource } from '@nimbalyst/runtime/core/citationSyntax';
import { setPageMarksSource, type PageMarkRecord, type PageMarksSource } from '@nimbalyst/collab-client/pages';

import { activeWorkspacePathAtom } from '../store/atoms/openProjects';
import { sessionRegistryAtom } from '../store/atoms/sessions';
import { stytchAuthAtom } from '../store/atoms/stytchAuth';
import { activeCollabScopeAtom, getTeamSyncProvider } from '../store/atoms/collabDocuments';
import { createDesktopPageMarksSource } from './desktopPageMarksSource';

export const desktopPageMarksSource: PageMarksSource = createDesktopPageMarksSource({
  async listLocal(query) {
    const workspacePath = store.get(activeWorkspacePathAtom);
    if (!workspacePath) return [];
    const result = await window.electronAPI.invoke('page-marks:list', { workspacePath, query }) as
      { success: boolean; marks?: PageMarkRecord[]; error?: string };
    if (!result?.success) throw new Error(result?.error ?? 'Could not list marks');
    return result.marks ?? [];
  },
  // Plain team pages live only in their rooms; the team's marks index lists them.
  teamIndex() {
    const scope = store.get(activeCollabScopeAtom);
    const provider = scope ? getTeamSyncProvider(scope) : null;
    return scope && provider ? { orgId: scope.orgId, query: (filters) => provider.queryPageMarks({ ...filters, projectId: scope.indexConfig.teamProjectId ?? undefined }) } : null;
  },
});

function signedInAuthor(): PageMarkAuthor | null {
  const user = store.get(stytchAuthAtom)?.user;
  if (!user) return null;
  const name = [user.name?.first_name, user.name?.last_name].filter(Boolean).join(' ').trim();
  return { name: name || null, email: user.emails?.[0]?.email ?? null };
}

export function registerPageKnowledgePlugin(): void {
  setPageMarksSource(desktopPageMarksSource);
  setPageMarkAuthorProvider(signedInAuthor);
  setCitationHost({
    // The snapshot travels with the page; the session itself exists only on
    // the devices that ran it.
    canOpenHumanCitation: (citation) => store.get(sessionRegistryAtom).has(citation.sessionId),
    openHumanCitation: (citation) => {
      window.dispatchEvent(new CustomEvent('open-ai-session', {
        detail: { sessionId: citation.sessionId, workspacePath: store.get(activeWorkspacePathAtom) ?? '' },
      }));
    },
    openSource: (target) => {
      if (isWebSource(target)) {
        void window.electronAPI.openExternal(target);
        return;
      }
      openWorkspaceFileLink(target, null);
    },
  });
}
