/**
 * Pages mode's left sidebar: the Team section over the Local section (the
 * project's wiki folder, formerly Personal), each a `CollabSidebar` bound to
 * its own docs session. With no team scope the Local section stands alone
 * under a one-line note.
 */

import React, { useEffect, useState } from 'react';
import { atom, useAtom, useAtomValue } from 'jotai';
import type { CollabHost, CollabOpenOptions, CollabScope } from '@nimbalyst/collab-client/core';
import type { CollabDocsSession } from '@nimbalyst/collab-client/docs';
import type { PageTypeLane } from '@nimbalyst/collab-client/docs/pageTypes';
import { CollabSidebar, PagesSectionEntries, type CollabSidebarCreateMenu } from '@nimbalyst/collab-client/docs-ui';
import { NewTypeDialog, SetPageTypeDialog } from '@nimbalyst/collab-client/docs-ui/setPageType';
import {
  getElectronCollabDocsSession,
  getElectronCollabHost,
  getPersonalCollabDocsSession,
  getPersonalCollabHost,
  type SharedDocument,
} from '../../store/atoms/collabDocuments';
import { activeSectionEntry, isHomePageId, type PagesSectionLane, type PagesSectionView } from './pagesSectionTabs';
import { ElectronCollabDocsUIRoot } from './ElectronCollabDocsUIProvider';
import { useCollabTypeResolver } from './useCollabTypeResolver';
import { useDefineTrackerType } from './useDefineTrackerType';
import { useSetPageType } from './useSetPageType';
import { pageActionRequestAtom, pageMoveRequestAtom, pageTypeRequestAtom } from './pageTypeRequest';
import { movePageAcrossSections } from './moveAcrossSectionsDesktop';
import { useTabsActions } from '../../contexts/TabsContext';
import { errorNotificationService } from '../../services/ErrorNotificationService';
import { usePagesSidebarCollapse } from './usePagesSidebarCollapse';
import { archiveTrackerItem } from '../../services/archiveTrackerItem';
import { exportPersonalPagesToFiles } from '../../services/exportPersonalPages';
import { localWikiStatusAtomFamily } from '../../store/atoms/localWiki';

interface PagesSidebarSectionsProps {
  workspacePath: string;
  teamScope: CollabScope | null;
  personalScope: CollabScope;
  activeTeamDocumentId: string | null;
  activePersonalDocumentId: string | null;
  /** The open typed page or type; either section marks it if its tree holds it. */
  activeRow: { itemId: string | null; typeId: string | null };
  /** The active tab, so a section's Home, Search or Types row reads as open. */
  activeTabPath: string | null;
  /** `newTab`: Cmd/Ctrl was held on the click. */
  onOpenSectionView: (view: PagesSectionView, lane: PagesSectionLane, options?: CollabOpenOptions) => void;
  registerTeamCreateMenu: (menu: CollabSidebarCreateMenu | null) => void;
  registerPersonalCreateMenu: (menu: CollabSidebarCreateMenu | null) => void;
}

const NO_DOCUMENTS = atom<SharedDocument[]>([]);

/** A section's Home page id, if it still has one (Home can be deleted). */
export function useSectionHomeId(scope: CollabScope | null, session: CollabDocsSession | null): string | null {
  const documents = useAtomValue<readonly SharedDocument[]>(session?.atoms.sharedDocuments ?? NO_DOCUMENTS);
  const teamHomeId = scope?.indexConfig.teamProjectId ? `home:${scope.indexConfig.teamProjectId}` : null;
  return documents.find((document) => (teamHomeId ? document.documentId === teamHomeId : isHomePageId(document.documentId)))?.documentId ?? null;
}

function openHomePage(host: CollabHost, scope: CollabScope, documentId: string, options: CollabOpenOptions): void {
  host.openArtifact({ kind: 'document', scope, documentId, teamProjectId: scope.indexConfig.teamProjectId ?? null }, 'sidebar', options);
}

export function PagesSidebarSections({
  workspacePath,
  teamScope,
  personalScope,
  activeTeamDocumentId,
  activePersonalDocumentId,
  activeRow,
  activeTabPath,
  onOpenSectionView,
  registerTeamCreateMenu,
  registerPersonalCreateMenu,
}: PagesSidebarSectionsProps) {
  // Database Personal pages from before the Local wiki: exported only when the user asks.
  const { unexportedPageCount, brokenTypes } = useAtomValue(localWikiStatusAtomFamily(workspacePath));
  const teamTypeResolver = useCollabTypeResolver('team');
  const personalTypeResolver = useCollabTypeResolver('personal', brokenTypes);
  const setPageType = useSetPageType(workspacePath, teamScope);
  const [typingPage, setTypingPage] = useState<{ lane: PageTypeLane; page: SharedDocument } | null>(null);
  // A page's own header asks for Set type through this atom.
  const [typeRequest, setTypeRequest] = useAtom(pageTypeRequestAtom);
  useEffect(() => {
    if (!typeRequest) return;
    setTypingPage(typeRequest);
    setTypeRequest(null);
  }, [typeRequest, setTypeRequest]);
  const tabsActions = useTabsActions();
  const [moveRequest, setMoveRequest] = useAtom(pageMoveRequestAtom);
  useEffect(() => {
    if (!moveRequest) return;
    setMoveRequest(null);
    if (!teamScope) {
      errorNotificationService.showError('Could not move this page', 'This project is not connected to its team.');
      return;
    }
    void movePageAcrossSections({ ...moveRequest, workspacePath, teamScope, tabsActions }).then((result) => {
      if (result && !result.ok) errorNotificationService.showError('Could not move this page', result.error);
    });
  }, [moveRequest, setMoveRequest, teamScope, workspacePath, tabsActions]);
  // Rename, Move to..., New page inside and Trash from a page header: its section's tree runs them.
  const [actionRequest, setActionRequest] = useAtom(pageActionRequestAtom);
  const clearActionRequest = () => setActionRequest(null);
  const [creatingType, setCreatingType] = useState(false);
  const defineType = useDefineTrackerType(workspacePath);
  const { collapsed, toggle } = usePagesSidebarCollapse(workspacePath, teamScope !== null);
  // Open sections share the height; a collapsed one keeps only its header row.
  const sectionClass = (isCollapsed: boolean) => (isCollapsed ? 'shrink-0' : 'flex-1 min-h-0');
  const teamHomeId = useSectionHomeId(teamScope, teamScope ? getElectronCollabDocsSession(teamScope) : null);
  const personalHomeId = useSectionHomeId(null, getPersonalCollabDocsSession(workspacePath));
  const localMenuItems = unexportedPageCount > 0 ? [{
    id: 'export-database-pages',
    label: `Export ${unexportedPageCount} database page${unexportedPageCount === 1 ? '' : 's'} to files`,
    icon: 'drive_file_move',
    onSelect: () => { void exportPersonalPagesToFiles(workspacePath, unexportedPageCount); },
  }] : undefined;
  const entries = (lane: PagesSectionLane, scope: CollabScope, host: CollabHost, homeId: string | null, activeDocumentId: string | null) => (
    <PagesSectionEntries
      active={activeSectionEntry(lane, activeTabPath, activeDocumentId)}
      onOpenHome={homeId ? (options) => openHomePage(host, scope, homeId, options) : undefined}
      onOpenSearch={(options) => onOpenSectionView('search', lane, options)}
      onOpenTypes={(options) => onOpenSectionView('types', lane, options)}
    />
  );

  const pickType = (typeId: string) => {
    if (!typingPage) return;
    const { lane, page } = typingPage;
    const session = lane === 'personal'
      ? getPersonalCollabDocsSession(workspacePath)
      : teamScope ? getElectronCollabDocsSession(teamScope) : null;
    if (!session) return;
    void setPageType.run(lane, session, page, typeId)
      .finally(() => setTypingPage(null));
  };

  return (
    <div className="pages-sidebar-sections flex flex-col h-full min-h-0">
      {teamScope ? (
        <div className={`pages-sidebar-team-section ${sectionClass(collapsed.team)}`}>
          {/* No Feedback action here any more: the request list is an
              organization surface, not a shared-docs one, and it moved beside
              the Inbox in Org mode (#3704). A document's own feedback still
              reaches it through the per-artifact backlinks. */}
          <ElectronCollabDocsUIRoot scope={teamScope}>
            <CollabSidebar
              sectionTitle="Team"
              activeDocumentId={activeTeamDocumentId}
              activeItemId={activeRow.itemId}
              activeTypeId={activeRow.typeId}
              sectionEntries={entries('team', teamScope, getElectronCollabHost(teamScope), teamHomeId, activeTeamDocumentId)}
              registerCreateMenu={registerTeamCreateMenu}
              typeResolver={teamTypeResolver}
              onArchiveItem={archiveTrackerItem}
              collapsed={collapsed.team}
              onToggleCollapsed={() => toggle('team')}
              onSetPageType={(page) => setTypingPage({ lane: 'team', page })}
              pageActionRequest={actionRequest?.lane === 'team' ? actionRequest : null}
              onPageActionHandled={clearActionRequest}
            />
          </ElectronCollabDocsUIRoot>
        </div>
      ) : (
        <div
          className="pages-sidebar-team-note px-3 py-2 text-xs text-nim-faint bg-nim-secondary border-r border-b border-nim shrink-0"
          data-testid="pages-sidebar-team-note"
        >
          Sign in and share this project to see team pages
        </div>
      )}
      <div className={`pages-sidebar-personal-section ${sectionClass(collapsed.personal)}`}>
        <ElectronCollabDocsUIRoot scope={personalScope}>
          <CollabSidebar
            sectionTitle="Local"
            extraSectionMenuItems={localMenuItems}
            activeDocumentId={activePersonalDocumentId}
            sectionEntries={entries('personal', personalScope, getPersonalCollabHost(workspacePath), personalHomeId, activePersonalDocumentId)}
            activeItemId={activeRow.itemId}
            activeTypeId={activeRow.typeId}
            registerCreateMenu={registerPersonalCreateMenu}
            typeResolver={personalTypeResolver}
            onArchiveItem={archiveTrackerItem}
            collapsed={collapsed.personal}
            onToggleCollapsed={() => toggle('personal')}
            onSetPageType={(page) => setTypingPage({ lane: 'personal', page })}
            pageActionRequest={actionRequest?.lane === 'personal' ? actionRequest : null}
            onPageActionHandled={clearActionRequest}
          />
        </ElectronCollabDocsUIRoot>
      </div>
      {typingPage && !creatingType && (
        <SetPageTypeDialog
          pageTitle={typingPage.page.title}
          resolver={typingPage.lane === 'team' ? teamTypeResolver : personalTypeResolver}
          running={setPageType.running}
          onPick={pickType}
          onNewType={() => setCreatingType(true)}
          onClose={() => setTypingPage(null)}
        />
      )}
      {/* New type from Set type lands at the section root; closing it returns to the picker, which lists the new type once it registers. */}
      {typingPage && creatingType && (
        <NewTypeDialog
          lane={typingPage.lane}
          resolver={typingPage.lane === 'team' ? teamTypeResolver : personalTypeResolver}
          session={typingPage.lane === 'personal' ? getPersonalCollabDocsSession(workspacePath) : getElectronCollabDocsSession(teamScope!)}
          defineType={defineType}
          onClose={() => setCreatingType(false)}
        />
      )}
    </div>
  );
}
