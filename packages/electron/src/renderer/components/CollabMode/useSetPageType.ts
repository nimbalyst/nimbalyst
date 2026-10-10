/**
 * The real effects behind `setPageType` for one Pages section: reading the
 * page body (team room or local store), creating and publishing the item
 * through the normal creation path, the read-back IPC, the docs session's
 * placement and trash commands, and reopening the item in the page's tab spot.
 */

import { useCallback, useState } from 'react';
import { store } from '@nimbalyst/runtime/store';
import { globalRegistry } from '@nimbalyst/tracker-schema';
import {
  buildTrackerCreatePayload,
  formatTrackerValidationErrors,
} from '@nimbalyst/runtime/plugins/TrackerPlugin/models/trackerCreatePayload';
import { buildCollabUri, isCollabUri, parseCollabUri } from '@nimbalyst/collab-protocol';
import type { CollabScope } from '@nimbalyst/collab-client/core';
import type { CollabDocsSession, SharedDocument } from '@nimbalyst/collab-client/docs';
import { PERSONAL_PAGE_TAB_PREFIX, useTabsActions, type TabData } from '../../contexts/TabsContext';
import { readHeadlessCollabDocContent } from '../../services/HeadlessCollabDocument';
import { readLocalPageBody } from '../../services/personalAgentEdit';
import { isLocalWikiPage, setLocalWikiPageType } from '../../services/localWikiSetType';
import { flushLocalWikiPageEditor } from '../../services/localWikiPageFlush';
import {
  buildDocumentReplicaCacheKey,
  getDocumentReplicaCache,
  type DocumentReplicaAcquisition,
} from '../../services/DocumentReplicaCache';
import { errorNotificationService } from '../../services/ErrorNotificationService';
import { getCollabConfig } from '../../utils/collabDocumentOpener';
import { openPageTab } from './collabPageTabs';
import { flushPersonalPageBody } from './usePersonalPageBody';
import {
  listPageChildren,
  movePageChild,
  setPageType,
  type CreatedPageItem,
  type ItemBodyCheck,
  type ItemPlacementResult,
  type ItemPosition,
  type PageCopy,
  type PageTypeLane,
  type SetPageTypeDependencies,
} from '@nimbalyst/collab-client/docs/pageTypes';

type TabsActions = ReturnType<typeof useTabsActions>;

export interface SetPageTypeContext {
  lane: PageTypeLane;
  workspacePath: string;
  session: CollabDocsSession;
  /** Team only: the org the page's room belongs to. */
  teamScope: CollabScope | null;
  tabsActions: TabsActions;
}

function isPageTab(tab: TabData, lane: PageTypeLane, pageId: string): boolean {
  if (lane === 'personal') return tab.filePath === `${PERSONAL_PAGE_TAB_PREFIX}${pageId}`;
  if (!isCollabUri(tab.filePath)) return false;
  try {
    return parseCollabUri(tab.filePath).documentId === pageId;
  } catch {
    return false;
  }
}

/** The item takes the page tab's place in the strip; the page tab closes. */
function openItemInPlace(context: SetPageTypeContext, itemId: string, pageId: string, title: string): void {
  const { tabsActions, lane } = context;
  const before = tabsActions.getSnapshot();
  const pageTab = [...before.tabs.values()].find((tab) => isPageTab(tab, lane, pageId));
  const pageIndex = pageTab ? before.tabOrder.indexOf(pageTab.id) : -1;
  const itemTabId = openPageTab(tabsActions.addTab, { kind: 'tracker', artifactId: itemId, title });
  if (!pageTab) return;
  const itemIndex = itemTabId ? tabsActions.getSnapshot().tabOrder.indexOf(itemTabId) : -1;
  if (itemIndex >= 0 && pageIndex >= 0) tabsActions.reorderTabs(itemIndex, pageIndex);
  tabsActions.removeTab(pageTab.id);
}

const OPEN_EDITOR_FLUSH_TIMEOUT_MS = 8_000;

/**
 * Get an open editor's last edits stored before the page is copied. A personal
 * page saves on an 800ms debounce; a team page's tab holds its own room
 * connection, whose outbox can still carry edits the server has not seen.
 */
export async function flushPageEditor(context: SetPageTypeContext, pageId: string): Promise<void> {
  if (context.lane === 'personal') {
    if (isLocalWikiPage(context.workspacePath, pageId)) {
      const page = store.get(context.session.atoms.allSharedDocuments).find((doc) => doc.documentId === pageId);
      await flushLocalWikiPageEditor(context.workspacePath, pageId, page?.title.trim() || 'Untitled');
      return;
    }
    await flushPersonalPageBody(context.workspacePath, pageId);
    return;
  }
  const { teamScope, tabsActions } = context;
  if (!teamScope) return;
  const pageTab = [...tabsActions.getSnapshot().tabs.values()].find((tab) => isPageTab(tab, 'team', pageId));
  const config = pageTab ? getCollabConfig(teamScope, pageTab.filePath) : undefined;
  if (!config) return;
  const cache = getDocumentReplicaCache();
  const key = buildDocumentReplicaCacheKey({ accountId: config.accountId, orgId: config.orgId, documentId: config.documentId });
  if (!cache.has(key)) return;
  let acquisition: DocumentReplicaAcquisition;
  try {
    // Only join the tab's live connection; never open a new one here.
    acquisition = await cache.acquire(key, () => Promise.reject(new Error('The page editor closed')));
  } catch {
    return;
  }
  try {
    if (!(await acquisition.syncProvider.flushWithAck(OPEN_EDITOR_FLUSH_TIMEOUT_MS))) {
      throw new Error('the page has edits that have not reached the team yet');
    }
  } finally {
    acquisition.release();
  }
}

export async function readPageMarkdown(context: SetPageTypeContext, pageId: string): Promise<PageCopy> {
  if (context.lane === 'personal') {
    return readLocalPageBody(context.workspacePath, pageId);
  }
  if (!context.teamScope) throw new Error('This project is not connected to its team.');
  return {
    markdown: await readHeadlessCollabDocContent(buildCollabUri(context.teamScope.orgId, pageId), context.workspacePath),
  };
}

/** Personal: the stored version. Team: the room's text, read again. */
export async function pageUnchangedSince(context: SetPageTypeContext, pageId: string, copy: PageCopy): Promise<boolean> {
  await flushPageEditor(context, pageId);
  const current = await readPageMarkdown(context, pageId);
  return context.lane === 'personal'
    ? current.version === copy.version && current.markdown === copy.markdown
    : current.markdown === copy.markdown;
}

/**
 * The session resolves `{ ok }` once the placement is stored (3b-T). Anything
 * else is unconfirmed, and an unconfirmed placement never lets the page go.
 */
async function placeItem(
  session: CollabDocsSession,
  itemId: string,
  parentId: string | null,
  position: ItemPosition,
): Promise<ItemPlacementResult> {
  const existing = session.getItemPlacements().find((placement) => placement.itemId === itemId);
  const result: unknown = await session.setItemPlacement(
    itemId,
    parentId,
    position.sortOrder ?? existing?.sortOrder ?? undefined,
    parentId ? position.parentKind : undefined,
  );
  if (result && typeof result === 'object' && 'ok' in result) {
    const placed = result as { ok: boolean; error?: string };
    return placed.ok ? { ok: true } : { ok: false, error: placed.error || 'the placement was refused' };
  }
  return { ok: false, error: 'the placement was not confirmed' };
}

async function createItem(
  context: SetPageTypeContext,
  input: { typeId: string; title: string; markdown: string },
): Promise<CreatedPageItem> {
  const { workspacePath } = context;
  const itemId = `${globalRegistry.get(input.typeId)?.idPrefix || input.typeId.slice(0, 3)}_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
  const built = buildTrackerCreatePayload(
    input.typeId,
    { title: input.title, content: input.markdown, creationRequestId: itemId },
    { workspacePath, generateId: () => itemId },
  );
  if (!built.ok) throw new Error(formatTrackerValidationErrors(built.errors));
  const payload = built.payload;
  // The page was already visible to the team, so a draft-by-default team type
  // still publishes it; otherwise the page would vanish for teammates.
  if (context.lane === 'team' && payload.draftByDefault) {
    payload.customFields = { ...payload.customFields, share: { status: 'team', body: 'team' } };
  }
  const result = await window.electronAPI.documentService.createTrackerItem(payload);
  if (!result.success) throw new Error(result.error || 'Could not create the item');
  let publication = result.publication ?? { itemId, status: 'local' as const };
  if (publication.status === 'pending') {
    // Publishes the metadata, seeds the body room from the saved body and
    // waits for the room's acknowledgment.
    publication = await window.electronAPI.documentService.publishTrackerCreation({ workspacePath, itemId });
  }
  return { itemId, publication: publication.status, ...(publication.error ? { error: publication.error } : {}) };
}

export function buildSetPageTypeDependencies(context: SetPageTypeContext, title: string): SetPageTypeDependencies {
  const { session, workspacePath, lane } = context;
  return {
    listChildren: (pageId) => listPageChildren(session, store.get(session.atoms.typePlacements), pageId),
    moveChildUnderItem: (child, itemId) => movePageChild(session, store.get(session.atoms.typePlacements), child, itemId),
    flushPageEditor: (pageId) => flushPageEditor(context, pageId),
    readPageMarkdown: (pageId) => readPageMarkdown(context, pageId),
    createItem: (input) => createItem(context, input),
    verifyItemBody: (itemId, markdown) => window.electronAPI.invoke('tracker-page-type:check-body', {
      workspacePath,
      itemId,
      expected: markdown,
      lane,
    }) as Promise<ItemBodyCheck>,
    removeItem: async (itemId) => {
      const result = await window.electronAPI.documentService.deleteTrackerItem({ itemId });
      if (!result.success) throw new Error(result.error || 'Delete failed');
    },
    setItemPlacement: (itemId, parentId, position) => placeItem(session, itemId, parentId, position),
    pageUnchangedSince: (pageId, copy) => pageUnchangedSince(context, pageId, copy),
    trashPage: async (pageId) => {
      const result = await session.trashDocument(pageId);
      // A refusal must reach the sequence, which then keeps both and says so.
      if (!result.ok) throw new Error(result.error);
    },
    openItem: (itemId, pageId) => openItemInPlace(context, itemId, pageId, title),
    wait: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  };
}

/** Runs Set type for the picked page and reports anything short of success. */
export function useSetPageType(workspacePath: string, teamScope: CollabScope | null) {
  const tabsActions = useTabsActions();
  const [running, setRunning] = useState(false);

  const run = useCallback(async (
    lane: PageTypeLane,
    session: CollabDocsSession,
    page: SharedDocument,
    typeId: string,
  ): Promise<boolean> => {
    setRunning(true);
    try {
      if (lane === 'personal' && isLocalWikiPage(workspacePath, page.documentId)) {
        try {
          // Unsaved edits first: the editor's next save would otherwise drop the new `type:`.
          await flushLocalWikiPageEditor(workspacePath, page.documentId, page.title.trim() || 'Untitled');
          await setLocalWikiPageType(workspacePath, page.documentId, typeId);
          return true;
        } catch (error) {
          errorNotificationService.showWarning('Cannot set the type', error instanceof Error ? error.message : String(error), { allowDuplicate: true });
          return false;
        }
      }
      const title = page.title.trim() || 'Untitled';
      const outcome = await setPageType(
        {
          lane,
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
        buildSetPageTypeDependencies({ lane, workspacePath, session, teamScope, tabsActions }, title),
      );
      if (outcome.status === 'refused') {
        errorNotificationService.showWarning('Cannot set the type', outcome.message, { allowDuplicate: true });
      } else if (outcome.status === 'failed') {
        errorNotificationService.showError('Set type did not finish', outcome.message);
      }
      return outcome.status === 'done';
    } finally {
      setRunning(false);
    }
  }, [workspacePath, teamScope, tabsActions]);

  return { run, running };
}
