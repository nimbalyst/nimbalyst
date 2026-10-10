/**
 * A personal page opened in Pages mode (`personal://<documentId>`): its title
 * over the markdown body (`PersonalPageBodyEditor`), which is stored in the
 * local database; nothing is written to disk as a file and no account or
 * server is involved.
 */

import React, { useEffect, useMemo, useState } from 'react';
import { useAtomValue, useSetAtom } from 'jotai';
import { PageHeaderBar } from '@nimbalyst/collab-client/trackers-ui/page';
import { getPersonalCollabDocsSession, getPersonalCollabHost, personalPagesDocumentsAtomFamily } from '../../store/atoms/collabDocuments';
import { historyDialogFileAtom } from '../../store/atoms/historyDialog';
import { getSharedDocumentDisplayName } from './collabTree';
import { PersonalPageBodyEditor, personalPageDocumentPath } from './PersonalPageBodyEditor';
import { CollabPlainPageHeader } from './CollabPlainPageHeader';
import { PersonalExtensionPageBody } from './PersonalExtensionPageBody';
import { openPageAncestor } from './pageHeaderNavigation';
import { useSharedPagePath } from './useSharedPagePath';
import { usePageMenuItems } from './usePageMenuItems';
import { editorExportMenuItems } from '../TabEditor/editorExport';
import { resolveDesktopCollabScope } from '../../store/atoms/collabDocuments';
import type { CollabScope } from '@nimbalyst/collab-client/core';
import { HeaderTableOfContents } from '../TabEditor/HeaderTableOfContents';
import type { LexicalEditor } from 'lexical';

interface PersonalPageInfo {
  title: string;
  /** Null until known: no editor mounts on a body whose type is not known yet. */
  documentType: string | null;
  fileExtension?: string | null;
}

/**
 * The page's live title and type from the personal pages list (refreshed on
 * every change push). While the page is not in that list yet (still loading,
 * or just created), a one-time snapshot read, then the tab title, stand in.
 */
function usePersonalPage(workspacePath: string, documentId: string, fallback: string): PersonalPageInfo {
  const documents = useAtomValue(personalPagesDocumentsAtomFamily(workspacePath));
  const doc = documents.find((d) => d.documentId === documentId);
  const [read, setRead] = useState<{ title?: string; documentType: string; fileExtension?: string | null } | null>(null);
  const inList = doc !== undefined;
  useEffect(() => {
    if (inList) return;
    let cancelled = false;
    (async () => {
      try {
        const snapshot = (await window.electronAPI.invoke('personal-pages:snapshot', workspacePath)) as
          | { items?: Array<{ documentId: string; title: string; documentType?: string; fileExtension?: string | null }> }
          | null;
        const item = snapshot?.items?.find((entry) => entry.documentId === documentId);
        // A page not stored at all opens the markdown body, which says it is unavailable.
        if (!cancelled) setRead({ title: item?.title, documentType: item?.documentType ?? 'markdown', fileExtension: item?.fileExtension });
      } catch (error) {
        console.warn('[PersonalPageTab] Failed to load the page:', error);
        if (!cancelled) setRead({ documentType: 'markdown' });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [workspacePath, documentId, inList]);
  if (doc) return { title: getSharedDocumentDisplayName(doc.title, documentId), documentType: doc.documentType, fileExtension: doc.fileExtension };
  return { title: read?.title ?? fallback, documentType: read?.documentType ?? null, fileExtension: read?.fileExtension };
}

export interface PersonalPageTabProps {
  documentId: string;
  workspacePath: string;
  /** Last-known title (the tab's), shown until the snapshot resolves. */
  fallbackTitle: string;
}

export const PersonalPageTab: React.FC<PersonalPageTabProps> = ({ documentId, workspacePath, fallbackTitle }) => {
  const info = usePersonalPage(workspacePath, documentId, fallbackTitle);
  const { title } = info;
  const scope = useMemo(() => getPersonalCollabHost(workspacePath).scope, [workspacePath]);
  const page = useSharedPagePath(scope, documentId);
  const openHistory = useSetAtom(historyDialogFileAtom);
  const [editor, setEditor] = useState<LexicalEditor | null>(null);
  // "Move to Team" shows once this project has a team to move to.
  const [teamScope, setTeamScope] = useState<CollabScope | null>(null);
  useEffect(() => {
    let cancelled = false;
    void resolveDesktopCollabScope(workspacePath).then(({ scope }) => {
      if (!cancelled) setTeamScope(scope);
    }).catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [workspacePath]);
  const session = getPersonalCollabDocsSession(workspacePath);
  const documents = useAtomValue(personalPagesDocumentsAtomFamily(workspacePath));
  const exportItems = useMemo(() => editorExportMenuItems(editor, page.title ?? title), [editor, page.title, title]);
  const menuItems = usePageMenuItems({
    lane: 'personal',
    session,
    page: documents.find((d) => d.documentId === documentId) ?? null,
    canMoveAcross: teamScope !== null,
    exportItems,
  });
  // The same header strip and title block a team page has.
  const documentHeader = useMemo(
    () => <CollabPlainPageHeader scope={scope} documentId={documentId} lane="personal" />,
    [scope, documentId],
  );
  return (
    <div
      className="personal-page-tab flex h-full min-h-0 flex-col overflow-hidden bg-nim"
      data-testid="personal-page-tab"
      data-document-id={documentId}
    >
      <PageHeaderBar
        section="Personal"
        path={page.path}
        title={page.title ?? title}
        onOpenAncestor={(ancestor) => openPageAncestor(ancestor, { personal: true, workspacePath })}
        actions={editor ? <HeaderTableOfContents editor={editor} /> : undefined}
        menuItems={menuItems}
        onShowHistory={() => openHistory(personalPageDocumentPath(documentId))}
      />
      {info.documentType === null ? (
        <div className="py-4 text-center text-sm text-nim-faint" role="status">Loading...</div>
      ) : info.documentType === 'markdown' ? (
        <PersonalPageBodyEditor
          documentId={documentId}
          workspacePath={workspacePath}
          className="flex min-h-0 flex-1 flex-col"
          documentHeader={documentHeader}
          onEditorReady={setEditor}
        />
      ) : (
        <PersonalExtensionPageBody
          documentId={documentId}
          workspacePath={workspacePath}
          page={{ title: page.title ?? title, documentType: info.documentType, fileExtension: info.fileExtension }}
        />
      )}
    </div>
  );
};
