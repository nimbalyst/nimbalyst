/**
 * The desktop wiring for the page tree agent tools: which docs session a
 * section means, its type resolver, page creation through the normal creation
 * path, and Set type through the same decision sequence the page menu runs.
 *
 * The Personal session is never the window's active collaboration scope, so it
 * is reached by workspace path, never through `activeCollabScopeAtom`; that is
 * what lets these tools work with no account. Its data source is the Local
 * wiki folder (`@nimbalyst/local-wiki` in main), so `section: personal` reads
 * and writes files; a page's `personal://<id>` uri resolves to its file in
 * `personalAgentEdit`.
 */
import { store } from '@nimbalyst/runtime/store';
import { globalRegistry } from '@nimbalyst/runtime/plugins/TrackerPlugin/models';
import { trackerItemsMapAtom } from '@nimbalyst/runtime/plugins/TrackerPlugin/trackerDataAtoms';
import { buildCollabUri, isCollabUri, parseCollabUri } from '@nimbalyst/collab-protocol';
import type { CollabScope } from '@nimbalyst/collab-client/core';
import type { CollabDocsSession, SharedDocument } from '@nimbalyst/collab-client/docs';
import {
  activeCollabScopeAtom,
  getElectronCollabDocsSession,
  getPersonalCollabDocsSession,
} from '../../store/atoms/collabDocuments';
import { activeWorkspacePathAtom } from '../../store/atoms/openProjects';
import { buildCollabTypeResolver } from '../../components/CollabMode/collabTypeResolver';
import { setPageType } from '../../components/CollabMode/setPageType';
import { buildSetPageTypeDependencies, type SetPageTypeContext } from '../../components/CollabMode/useSetPageType';
import { PERSONAL_PAGE_TAB_PREFIX } from '../../contexts/TabsContext';
import { createCollaborativeDocument } from '../collaborativeDocumentCreationOrchestrator';
import { personalPageSupportsType } from '../personalPageTypes';
import { isLocalWikiPage, setLocalWikiPageType } from '../localWikiSetType';
import { getCollaborativeDocumentTypeCatalog } from '../CollaborativeDocumentTypeCatalog';
import type { PageTreeSection, PageTreeToolEnv } from '@nimbalyst/collab-client/docs/pageTreeToolCore';
import { pagesTabStrip, type PagesTabStrip } from './pagesTabStrip';

function teamScope(): CollabScope {
  const scope = store.get(activeCollabScopeAtom);
  if (!scope) throw new Error('No active collaboration scope is available. Use section "personal" for Personal pages.');
  return scope;
}

/**
 * Set type looks for an open tab of the page so it can flush that editor's
 * unsent edits before copying the body. For that flush the agent hands over
 * the page's own uri as the only "tab": an open editor of the page is still
 * found in the replica cache and flushed, and nothing else is read.
 */
function pageOnlyTabs(filePath: string): SetPageTypeContext['tabsActions'] {
  const tab = { id: 'agent-set-page-type', filePath };
  return {
    getSnapshot: () => ({ tabs: new Map([[tab.id, tab]]), tabOrder: [tab.id] }),
  } as unknown as SetPageTypeContext['tabsActions'];
}

function hasPageTab(strip: PagesTabStrip, section: PageTreeSection, documentId: string): boolean {
  return [...strip.getSnapshot().tabs.values()].some((tab) => {
    if (section === 'personal') return tab.filePath === `${PERSONAL_PAGE_TAB_PREFIX}${documentId}`;
    if (!isCollabUri(tab.filePath)) return false;
    try {
      return parseCollabUri(tab.filePath).documentId === documentId;
    } catch {
      return false;
    }
  });
}

export function createDesktopPageTreeEnv(payloadWorkspacePath: string | undefined): PageTreeToolEnv {
  const workspacePath = (): string => {
    const path = payloadWorkspacePath || store.get(activeWorkspacePathAtom);
    if (!path) throw new Error('No open workspace for Personal pages.');
    return path;
  };

  const pageUri = (section: PageTreeSection, documentId: string): string | null => {
    if (section === 'personal') return `${PERSONAL_PAGE_TAB_PREFIX}${documentId}`;
    const scope = store.get(activeCollabScopeAtom);
    return scope ? buildCollabUri(scope.orgId, documentId) : null;
  };

  return {
    session: async (section) => (section === 'personal'
      ? getPersonalCollabDocsSession(workspacePath())
      : getElectronCollabDocsSession(teamScope())),

    resolver: (section) => buildCollabTypeResolver(globalRegistry, store.get(trackerItemsMapAtom), section),

    // The core types sessions narrowly (pageTreeSession.ts); this env only ever gets its own back.
    typePlacements: (session: CollabDocsSession) => store.get(session.atoms.typePlacements),

    findItem: (ref) => {
      const records = store.get(trackerItemsMapAtom);
      const record = records.get(ref) ?? [...records.values()].find((candidate) => candidate.issueKey === ref);
      if (!record || record.archived) return null;
      return { itemId: record.id, typeId: record.primaryType, ...(record.issueKey ? { issueKey: record.issueKey } : {}) };
    },

    createPage: async (section, session: CollabDocsSession, input) => {
      if (section === 'personal' && !personalPageSupportsType(input.documentType)) {
        throw new Error(`A Local page cannot be a "${input.documentType}" page; create it in the team section.`);
      }
      const catalog = getCollaborativeDocumentTypeCatalog();
      const resolution = catalog.resolveMetadata(input.documentType, catalog.inferFileExtension(input.documentType, input.title));
      if (resolution.state !== 'ready') throw new Error(resolution.reason);
      const document = await createCollaborativeDocument({
        scope: session.scope,
        descriptor: resolution.descriptor,
        requestedName: input.title,
        parentFolderId: input.parentId,
        ...(input.parentId && input.parentKind === 'item' ? { parentKind: 'item' as const } : {}),
        // No content for a drawing, sheet or other structured type means its own empty document, not ''.
        sourceContent: input.content || input.documentType === 'markdown' ? input.content : undefined,
        // An agent filing dozens of pages must not open a tab for each.
        openAfterCreate: false,
        analyticsSource: 'agent_tool',
        analyticsActorType: 'agent',
      });
      return document.documentId;
    },

    setPageType: async (section, session: CollabDocsSession, page: SharedDocument, typeId) => {
      // A Local wiki page takes its type in place: same file, same id.
      if (section === 'personal' && isLocalWikiPage(workspacePath(), page.documentId)) {
        return { status: 'done', itemId: await setLocalWikiPageType(workspacePath(), page.documentId, typeId) } as Awaited<ReturnType<typeof setPageType>>;
      }
      const title = page.title.trim() || 'Untitled';
      const scope = section === 'team' ? teamScope() : null;
      const uri = pageUri(section, page.documentId) ?? '';
      const context: SetPageTypeContext = {
        lane: section,
        workspacePath: workspacePath(),
        session,
        teamScope: scope,
        tabsActions: pageOnlyTabs(uri),
      };
      // An open tab of the page gives its place to the typed page, so nobody
      // keeps typing into a page in Trash; the agent opens nothing else.
      const openItem = (itemId: string, pageId: string) => {
        const strip = pagesTabStrip(context.workspacePath);
        if (!strip || !hasPageTab(strip, section, pageId)) return;
        buildSetPageTypeDependencies({ ...context, tabsActions: strip }, title).openItem(itemId, pageId);
      };
      return setPageType(
        {
          lane: section,
          typeId,
          page: {
            documentId: page.documentId,
            title,
            documentType: page.documentType,
            parentId: page.parentFolderId ?? null,
            parentKind: page.parentKind ?? 'page',
            sortOrder: page.sortOrder ?? null,
          },
        },
        { ...buildSetPageTypeDependencies(context, title), openItem },
      );
    },

    pageUri,
  };
}
