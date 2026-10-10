/**
 * The desktop's side of moving a page between the Personal and Team sections
 * (collab-client `moveAcrossSections`): which pages go, how each body is read
 * and written in each section, and the confirm before anything happens.
 */
import { store } from '@nimbalyst/runtime/store';
import { buildCollabUri } from '@nimbalyst/collab-protocol';
import type { CollabScope } from '@nimbalyst/collab-client/core';
import {
  moveAcrossSections,
  readMoveTree,
  type CollabDocsSession,
  type MoveAcrossSectionsDependencies,
  type MoveAcrossSectionsResult,
  type MovePageNode,
} from '@nimbalyst/collab-client/docs';
import type { PageTypeLane } from '@nimbalyst/collab-client/docs/pageTypes';
import { createCollaborativeDocument } from '../../services/collaborativeDocumentCreationOrchestrator';
import { getCollaborativeDocumentTypeCatalog } from '../../services/CollaborativeDocumentTypeCatalog';
import { readHeadlessCollabDocContent } from '../../services/HeadlessCollabDocument';
import { requestConfirmation } from '../../dialogs/requestConfirmation';
import { getElectronCollabDocsSession, getElectronCollabHost, getPersonalCollabDocsSession, getPersonalCollabHost } from '../../store/atoms/collabDocuments';
import type { useTabsActions } from '../../contexts/TabsContext';
import { flushPageEditor, pageUnchangedSince, readPageMarkdown, type SetPageTypeContext } from './useSetPageType';
import { readLocalPageBody } from '../../services/personalAgentEdit';
import { isLocalWikiPage } from '../../services/localWikiSetType';
import { flushLocalWikiPageEditor } from '../../services/localWikiPageFlush';

export interface MoveAcrossSectionsRequest {
  from: PageTypeLane;
  pageId: string;
  workspacePath: string;
  /** The team's scope; a move to or from Team needs it. */
  teamScope: CollabScope;
  tabsActions: ReturnType<typeof useTabsActions>;
}

const sectionName = (lane: PageTypeLane) => (lane === 'team' ? 'Team' : 'Personal');

function countPages(node: MovePageNode): number {
  return 1 + node.children.reduce((total, child) => total + countPages(child), 0);
}

function* pagesOf(node: MovePageNode): Generator<MovePageNode> {
  yield node;
  for (const child of node.children) yield* pagesOf(child);
}

function hasFields(node: MovePageNode): boolean {
  return Boolean(node.fields && Object.keys(node.fields).length > 0) || node.children.some(hasFields);
}

/** Confirms, then moves; the result says what happened. Null when the person cancelled. */
export async function movePageAcrossSections(request: MoveAcrossSectionsRequest): Promise<MoveAcrossSectionsResult | null> {
  const { from, pageId, workspacePath, teamScope, tabsActions } = request;
  const to: PageTypeLane = from === 'team' ? 'personal' : 'team';
  const sessionOf = (lane: PageTypeLane): CollabDocsSession => (lane === 'team'
    ? getElectronCollabDocsSession(teamScope)
    : getPersonalCollabDocsSession(workspacePath));
  const source = sessionOf(from);
  const destination = sessionOf(to);
  const destinationScope = to === 'team' ? teamScope : getPersonalCollabHost(workspacePath).scope;
  const context: SetPageTypeContext = { lane: from, workspacePath, session: source, teamScope, tabsActions };

  const tree = readMoveTree(pageId, store.get(source.atoms.allSharedDocuments), {
    items: store.get(source.atoms.itemPlacements),
    types: store.get(source.atoms.typePlacements),
  });
  if (!tree.ok) return tree;
  const count = countPages(tree.root);
  const fieldsSupported = store.get(destination.atoms.pageFields);
  const accepted = await requestConfirmation({
    title: `Move to ${sectionName(to)}?`,
    message: [
      `"${tree.root.title}"${count > 1 ? ` and ${count - 1} page${count > 2 ? 's' : ''} under it` : ''} will move to the top of ${sectionName(to)}.`,
      to === 'team' ? 'Everyone on the team will be able to read and edit it.' : 'It will be on this device only; teammates will no longer see it.',
      `The original goes to ${sectionName(from)} Trash once the copy is confirmed.`,
      ...(hasFields(tree.root) && !fieldsSupported ? [`Status, owner, summary and tags can't be kept in ${sectionName(to)} yet; they stay with the original.`] : []),
    ].join(' '),
    confirmLabel: 'Move',
  });
  if (!accepted) return null;

  // An open Local page's unsaved edits go to its file before the file is copied.
  if (from === 'personal') {
    for (const node of pagesOf(tree.root)) {
      if (!isLocalWikiPage(workspacePath, node.documentId)) continue;
      try {
        await flushLocalWikiPageEditor(workspacePath, node.documentId, node.title);
      } catch (error) {
        return { ok: false, error: error instanceof Error ? error.message : String(error) };
      }
    }
  }

  const deps: MoveAcrossSectionsDependencies = {
    readTree: () => tree,
    readSource: async (id) => {
      await flushPageEditor(context, id);
      return readPageMarkdown(context, id);
    },
    sourceUnchanged: (id, copy) => pageUnchangedSince(context, id, copy),
    createDestination: async ({ title, markdown, parentId, fields }) => {
      const catalog = getCollaborativeDocumentTypeCatalog();
      const resolution = catalog.resolveMetadata('markdown', catalog.inferFileExtension('markdown', title));
      if (resolution.state !== 'ready') throw new Error(resolution.reason);
      const document = await createCollaborativeDocument({
        scope: destinationScope,
        descriptor: resolution.descriptor,
        requestedName: title,
        parentFolderId: parentId,
        sourceContent: markdown,
        openAfterCreate: false,
      });
      if (fields && fieldsSupported) await destination.updateDocumentFields(document.documentId, { ...fields });
      return document.documentId;
    },
    readDestination: async (id) => {
      if (to === 'team') return readHeadlessCollabDocContent(buildCollabUri(teamScope.orgId, id), workspacePath);
      return (await readLocalPageBody(workspacePath, id)).markdown;
    },
    trashDestination: async (id) => {
      await destination.removePage(id);
    },
    trashSource: (id) => source.removePage(id),
  };
  const result = await moveAcrossSections(pageId, deps);
  if (result.ok) {
    const host = to === 'team' ? getElectronCollabHost(teamScope) : getPersonalCollabHost(workspacePath);
    host.openArtifact({
      kind: 'document',
      scope: destinationScope,
      documentId: result.pageId,
      teamProjectId: to === 'team' ? teamScope.indexConfig.teamProjectId ?? null : null,
    }, 'sidebar');
  }
  return result;
}
