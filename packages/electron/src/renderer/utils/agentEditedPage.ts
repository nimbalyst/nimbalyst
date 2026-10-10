/**
 * Name and open a page an agent edited, for the transcript's one-line
 * "Updated <page>" entry, or a page a placed view in a page links to. Pages
 * open in Pages mode:
 *
 *   collab://org:<org>:doc:<id>          a team page
 *   collab://tracker-content/<itemId>    a typed page's body -> the typed page
 *   tracker://<itemId>                   a typed page
 *   personal://<documentId>              a Personal page
 *   personal://tracker-content/<itemId>  a Personal typed page's body -> the typed page
 */
import { store } from '@nimbalyst/runtime/store';
import type { CollabOpenOptions, CollabOpenSource } from '@nimbalyst/collab-client/core';
import { getSharedDocumentDisplayName } from '@nimbalyst/collab-client/docs';
import { isCollabUri, parseCollabUri } from '@nimbalyst/collab-protocol';
import {
  activeCollabScopeAtom,
  getElectronCollabHost,
  getPersonalCollabHost,
  getSharedDocumentsForScope,
} from '../store/atoms/collabDocuments';
import { setWindowModeAtom } from '../store/atoms/windowMode';
import { openSharedDocumentInTab } from './openSharedDocumentInTab';
import { parsePersonalPageUri } from '../../shared/personalPageUri';

const TRACKER_CONTENT_PREFIX = 'collab://tracker-content/';
const TRACKER_TAB_PREFIX = 'tracker://';

/** The page's title when this window knows it; typed pages are named by main. */
export function agentPageTitle(uri: string, workspacePath: string | null | undefined): string | null {
  const personal = parsePersonalPageUri(uri);
  if (personal) {
    return personal.kind === 'page' && workspacePath
      ? getPersonalCollabHost(workspacePath).documentTitle(personal.documentId)
      : null;
  }
  if (!isCollabUri(uri) || uri.startsWith(TRACKER_CONTENT_PREFIX)) return null;
  const scope = store.get(activeCollabScopeAtom);
  if (!scope) return null;
  try {
    const { documentId } = parseCollabUri(uri);
    const document = getSharedDocumentsForScope(scope).find((candidate) => candidate.documentId === documentId);
    return document ? getSharedDocumentDisplayName(document.title, documentId) : null;
  } catch {
    return null;
  }
}

/** How the open was asked for: the analytics source, and a click's options when it came from inside Pages. */
interface PageOpenRequest {
  source: CollabOpenSource;
  options?: CollabOpenOptions;
}

const AGENT_OPEN: PageOpenRequest = { source: 'agent_tool' };

function openTypedPage(itemId: string, workspacePath: string, { source, options }: PageOpenRequest): void {
  const scope = store.get(activeCollabScopeAtom);
  store.set(setWindowModeAtom, 'collab');
  // Both hosts open an item as a page tab; the team host only exists with a team.
  if (scope) {
    getElectronCollabHost(scope).openArtifact({ kind: 'tracker', scope, trackerId: itemId }, source, options);
    return;
  }
  const host = getPersonalCollabHost(workspacePath);
  void host.resolveScope().then((personalScope) => {
    host.openArtifact({ kind: 'tracker', scope: personalScope, trackerId: itemId }, source, options);
  });
}

export async function openAgentEditedPage(uri: string, workspacePath: string, request: PageOpenRequest = AGENT_OPEN): Promise<void> {
  const personal = parsePersonalPageUri(uri);
  if (personal?.kind === 'typed-page') return openTypedPage(personal.itemId, workspacePath, request);
  if (personal?.kind === 'page') {
    const host = getPersonalCollabHost(workspacePath);
    const scope = await host.resolveScope();
    store.set(setWindowModeAtom, 'collab');
    host.openArtifact({ kind: 'document', scope, documentId: personal.documentId, teamProjectId: null }, request.source, request.options);
    return;
  }
  if (uri.startsWith(TRACKER_TAB_PREFIX)) return openTypedPage(uri.slice(TRACKER_TAB_PREFIX.length), workspacePath, request);
  if (uri.startsWith(TRACKER_CONTENT_PREFIX)) return openTypedPage(uri.slice(TRACKER_CONTENT_PREFIX.length), workspacePath, request);
  if (isCollabUri(uri)) {
    if (!openSharedDocumentInTab(parseCollabUri(uri).documentId, request.source, request.options)) {
      throw new Error('Open the team\'s Wiki to view this page.');
    }
    return;
  }
  throw new Error(`Not a page: ${uri}`);
}
