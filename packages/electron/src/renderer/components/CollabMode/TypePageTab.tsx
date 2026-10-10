/**
 * A tracker type opened as a page in Pages mode (`type://<typeId>`), laid out
 * like a document tab: the crumb (where the type sits in the tree), the type's
 * name, one row of facts about the type, its prose (`TypePageProse`), then the
 * table of every item of the type (collab-client's `TypePageTable`).
 *
 * The table reads the same tracker atoms Tracker mode does and writes through
 * the same IPC paths, through the desktop tracker data source given to it.
 */

import type { LexicalEditor } from 'lexical';
import { ensureTypePageDocument } from '../../services/collaborativeDocumentCreationOrchestrator';
import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { atom, useAtom, useAtomValue, useSetAtom, useStore, type Atom } from 'jotai';
import type { CollabOpenOptions, CollabScope } from '@nimbalyst/collab-client/core';
import type { SharedDocument } from '@nimbalyst/collab-client/docs';
import { DESKTOP_TRACKER_UI_CAPABILITIES, TrackersUIProvider } from '@nimbalyst/collab-client/trackers-ui';
import { PageHeaderBar, TypePageTable, crumbItemLookup, trackerPageCrumbFolderRefs, typePageTypeIds } from '@nimbalyst/collab-client/trackers-ui/page';
import { openPageAncestor } from './pageHeaderNavigation';
import { TYPE_PAGE_DOCUMENT_PREFIX } from '@nimbalyst/collab-client/docs';
import { buildCollabUri } from '@nimbalyst/collab-protocol';
import '@nimbalyst/collab-client/trackers-ui/page.css';
import { MaterialSymbol } from '@nimbalyst/runtime/ui/icons/MaterialSymbol';
import { globalRegistry } from '@nimbalyst/runtime/plugins/TrackerPlugin/models';
import { resolveColumnsForType } from '@nimbalyst/runtime/plugins/TrackerPlugin/components/trackerColumns';
import { trackerItemCountByTypeAtom, trackerItemsMapAtom } from '@nimbalyst/runtime/plugins/TrackerPlugin/trackerDataAtoms';
import { ElectronTrackerDataSource } from '../../services/ElectronTrackerDataSource';
import {
  getElectronCollabDocsSession,
  getPersonalCollabHost,
  resolveDesktopCollabScope,
} from '../../store/atoms/collabDocuments';
import { createDesktopTrackerDataSource } from '../EmbedFrame/desktopTrackerDataSource';
import { useDesktopTrackerIdentity } from '../EmbedFrame/useDesktopTrackerIdentity';
import { useTrackerTeamMembers } from '../TrackerMode/useTrackerTeamMembers';
import { isTeamTrackerSharing } from '../Settings/panels/trackerConfigUpgrade';
import { typePageTitle } from './collabPageTabs';
import { TypePageProse } from './TypePageProse';
import { useTypePageMenuItems } from './usePageMenuItems';
import { editorExportMenuItems } from '../TabEditor/editorExport';
import { personalPageHistoryKey } from '../../../shared/personalPageUri';
import { historyDialogFileAtom } from '../../store/atoms/historyDialog';
import { temporaryTypeViewAtom, temporaryTypeViewKey } from './temporaryTypeViews';
import { useNamedPageViewsController } from './useNamedPageViewsController';
import './TypePageTab.css';

type Lane = 'team' | 'personal';
interface TypePlacementRow { typeId: string; parentFolderId?: string | null; parentKind?: 'page' | 'item' }
interface ItemPlacementRow { itemId: string; parentId?: string | null; parentKind?: 'page' | 'item' }
interface PageRow { folderId: string; parentFolderId?: string | null; parentKind?: 'page' | 'item'; name: string }

const NO_TYPE_PLACEMENTS: Atom<readonly TypePlacementRow[]> = atom([]);
const NO_ITEM_PLACEMENTS: Atom<readonly ItemPlacementRow[]> = atom([]);
const NO_PAGES: Atom<readonly PageRow[]> = atom([]);
const NO_DOCUMENTS: Atom<readonly SharedDocument[]> = atom([]);

/** The section a type's page lives in: Personal types in Personal, team types in the team tree. */
function useTypePageScope(workspacePath: string, lane: Lane): CollabScope | null {
  const [teamScope, setTeamScope] = useState<CollabScope | null>(null);
  useEffect(() => {
    if (lane !== 'team') return;
    let cancelled = false;
    void resolveDesktopCollabScope(workspacePath).then(({ scope }) => {
      if (!cancelled) setTeamScope(scope);
    });
    return () => {
      cancelled = true;
    };
  }, [lane, workspacePath]);
  const personalScope = useMemo(
    () => (lane === 'personal' ? getPersonalCollabHost(workspacePath).scope : null),
    [lane, workspacePath],
  );
  return lane === 'personal' ? personalScope : teamScope;
}

/** The type's own field names, as the table heads them (title and tags aside). */
function typeFieldLabels(typeId: string): string[] {
  const model = globalRegistry.get(typeId);
  if (!model) return [];
  const own = new Set(model.fields.map((field) => field.name));
  return resolveColumnsForType(typeId)
    .filter((column) => own.has(column.id) && column.role !== 'title' && column.id !== 'tags')
    .map((column) => column.label);
}

export interface TypePageTabProps {
  typeId: string;
  workspacePath: string;
  /** Opens a row's item as a page tab in this mode. */
  onOpenItem: (itemId: string, options?: CollabOpenOptions) => void;
}

export const TypePageTab: React.FC<TypePageTabProps> = ({ typeId, workspacePath, onOpenItem }) => {
  const store = useStore();
  const identity = useDesktopTrackerIdentity(workspacePath);
  const teamMembers = useTrackerTeamMembers(workspacePath);
  const writer = useMemo(() => new ElectronTrackerDataSource({ workspacePath }), [workspacePath]);
  useEffect(() => () => writer.dispose(), [writer]);
  const dataSource = useMemo(
    () => createDesktopTrackerDataSource({ workspacePath, store, writer }),
    [workspacePath, store, writer],
  );
  // `TrackerIdentity.email` is nullable; the provider's "me" needs one to stamp `by` on an edit.
  const trackerIdentity = identity?.email ? identity : null;

  const model = globalRegistry.get(typeId);
  const lane: Lane = model && isTeamTrackerSharing(model.sharing ?? 'personal') ? 'team' : 'personal';
  const typeName = typePageTitle(typeId);
  const scope = useTypePageScope(workspacePath, lane);
  const [temporaryView, setTemporaryView] = useAtom(temporaryTypeViewAtom(temporaryTypeViewKey(workspacePath, scope?.scopeKey ?? '', typeId)));
  const editorKey = JSON.stringify([workspacePath, scope?.scopeKey, typeId]);
  const [viewsEditor, setViewsEditor] = useState<{ key: string; editor: LexicalEditor | null } | null>(null);
  const onViewsEditor = useCallback((editor: LexicalEditor | null) => setViewsEditor(current => current?.key === editorKey && current.editor === editor ? current : { key: editorKey, editor }), [editorKey]);
  const session = useMemo(() => (scope ? getElectronCollabDocsSession(scope) : null), [scope]);
  const typePlacements = useAtomValue<readonly TypePlacementRow[]>(session?.atoms.typePlacements ?? NO_TYPE_PLACEMENTS);
  const itemPlacements = useAtomValue<readonly ItemPlacementRow[]>(session?.atoms.itemPlacements ?? NO_ITEM_PLACEMENTS);
  // In the page tree every page can be a parent, and the session lists the pages here.
  const pages = useAtomValue<readonly PageRow[]>(session?.atoms.sharedFolders ?? NO_PAGES);
  const documents = useAtomValue<readonly SharedDocument[]>(session?.atoms.allSharedDocuments ?? NO_DOCUMENTS);
  // The type and every type that extends it: the tree row counts them all, so the table lists them all.
  const typeIds = useMemo(() => typePageTypeIds(typeId), [typeId, model]);
  const itemCountAtom = useMemo(
    () => atom((get) => typeIds.reduce((total, id) => total + get(trackerItemCountByTypeAtom(id)), 0)),
    [typeIds],
  );
  const itemCount = useAtomValue(itemCountAtom);

  // Typed-page titles above the type are read when the tree changes, not on every tracker edit.
  const itemLookup = useMemo(
    () => crumbItemLookup(store.get(trackerItemsMapAtom)),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [store, typePlacements, itemPlacements, pages],
  );
  const crumbPath = useMemo(
    () => trackerPageCrumbFolderRefs(typeId, typePlacements, pages, { itemPlacements, item: itemLookup }),
    [typeId, typePlacements, pages, itemPlacements, itemLookup],
  );
  const parentFolderId = typePlacements.find((placement) => placement.typeId === typeId)?.parentFolderId ?? null;
  const fieldLabels = useMemo(() => typeFieldLabels(typeId), [typeId, model]);
  const itemTitle = useMemo(() => (itemId: string) => itemLookup(itemId)?.title ?? null, [itemLookup]);
  // The prose's history, once someone has started writing it.
  const proseId = `${TYPE_PAGE_DOCUMENT_PREFIX}${typeId}`;
  const proseExists = documents.some((document) => document.documentId === proseId);
  const historyKey = !proseExists ? null : lane === 'personal' ? personalPageHistoryKey(proseId) : scope ? buildCollabUri(scope.orgId, proseId) : null;
  const openHistory = useSetAtom(historyDialogFileAtom);
  const proseEditor = viewsEditor?.key === editorKey ? viewsEditor.editor : null;
  const viewsController = useNamedPageViewsController(proseEditor, typeId);
  const exportItems = useMemo(() => editorExportMenuItems(proseEditor, typeName), [proseEditor, typeName]);
  const menuItems = useTypePageMenuItems(lane, typeId, typePlacements.some((placement) => placement.typeId === typeId), exportItems);

  return (
    <div className="type-page-tab tracker-page-view flex h-full min-h-0 flex-col overflow-hidden bg-nim" data-testid="type-page-tab" data-type-id={typeId}>
      <PageHeaderBar
        testId="type-page-header-bar"
        section={lane === 'personal' ? 'Personal' : null}
        path={crumbPath}
        title={typeName}
        titleIcon={model?.icon || 'table'}
        onOpenAncestor={(ancestor) => {
          if (lane === 'personal') openPageAncestor(ancestor, { personal: true, workspacePath });
          else if (scope) openPageAncestor(ancestor, { personal: false, scope });
        }}
        onShowHistory={historyKey ? () => openHistory(historyKey) : undefined}
        menuItems={menuItems}
      />
      <div className="type-page-tab-scroller min-h-0 flex-1 overflow-y-auto">
        <div className="type-page-tab-column">
          <div className="tracker-page-view-header tracker-page-view-header--bar">
            <h1 className="type-page-tab-title m-0 mb-3 flex items-center gap-2 break-words text-[28px] font-medium leading-tight text-nim select-text">
              {model?.icon ? <MaterialSymbol icon={model.icon} size={26} style={{ color: model.color }} /> : null}
              {typeName}
            </h1>
            <div className="tracker-page-view-props flex flex-wrap items-center gap-x-[18px] gap-y-1.5 border-b border-nim pb-3 text-xs" data-testid="type-page-props">
              <span className="type-page-tab-type-chip inline-flex items-center gap-1 rounded px-1.5 py-0.5 font-medium">
                <MaterialSymbol icon="table" size={13} />
                Type
              </span>
              <span className="inline-flex items-center gap-1.5">
                <span className="text-nim-faint">Pages</span>
                <span className="text-nim">{itemCount}</span>
              </span>
              {fieldLabels.length > 0 && (
                <span className="inline-flex min-w-0 items-center gap-1.5">
                  <span className="text-nim-faint">Fields</span>
                  <span className="truncate text-nim">{fieldLabels.join(', ')}</span>
                </span>
              )}
            </div>
          </div>
          <TypePageProse
            key={editorKey}
            onEditorReady={onViewsEditor}
            typeId={typeId}
            typeName={typeName}
            itemName={model?.displayName || typeName}
            lane={lane}
            scope={scope}
            workspacePath={workspacePath}
            parentFolderId={parentFolderId}
            documents={documents}
          />
          <TrackersUIProvider dataSource={dataSource} identity={trackerIdentity} capabilities={DESKTOP_TRACKER_UI_CAPABILITIES} teamMembers={teamMembers}>
            <TypePageTable
              key={editorKey}
              viewsController={viewsController}
              viewScope={lane === 'personal' ? 'local' : scope?.indexConfig.teamProjectId ? { orgId: scope.orgId, projectId: scope.indexConfig.teamProjectId } : undefined}
              onPrepareViewsDocument={async () => {
                if (!scope) throw new Error('The page is still opening.');
                await ensureTypePageDocument({ scope, typeId, typeName, parentFolderId });
              }}
              typeId={typeId}
              temporaryView={scope ? temporaryView : null}
              onClearTemporaryView={() => setTemporaryView(null)}
              typeLabel={typeName}
              rootLabel={lane === 'personal' ? 'Personal' : 'Team'}
              itemPlacements={itemPlacements}
              pages={pages}
              itemTitle={itemTitle}
              onOpenItem={onOpenItem}
            />
          </TrackersUIProvider>
        </div>
      </div>
    </div>
  );
};
