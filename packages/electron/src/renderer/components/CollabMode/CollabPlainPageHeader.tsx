/**
 * A plain page's title and type row (team or Personal), drawn inside the editor's scroller
 * above the body (the editor's `documentHeader`). Renames go through the
 * page tree like a sidebar rename; the type chip asks the sidebar to run
 * Set type.
 */
import React, { useCallback, useMemo } from 'react';
import { atom, useAtomValue, useSetAtom, type Atom } from 'jotai';
import type { CollabScope } from '@nimbalyst/collab-client/core';
import { getSharedDocumentDisplayName, pageDisplayName, type SharedDocument } from '@nimbalyst/collab-client/docs';
import { PlainPageHeader, pageTimeFacts } from '@nimbalyst/collab-client/trackers-ui/page';
import { getElectronCollabDocsSession } from '../../store/atoms/collabDocuments';
import { errorNotificationService } from '../../services/ErrorNotificationService';
import { pageTypeRequestAtom } from './pageTypeRequest';
import { useHideTitleHeading } from './useTitleHeading';
import type { PageTypeLane } from '@nimbalyst/collab-client/docs/pageTypes';

const NO_DOCUMENTS: Atom<readonly SharedDocument[]> = atom([]);

export const CollabPlainPageHeader: React.FC<{
  scope: CollabScope;
  documentId: string;
  lane?: PageTypeLane;
}> = ({ scope, documentId, lane = 'team' }) => {
  const session = useMemo(() => getElectronCollabDocsSession(scope), [scope]);
  const pageAtom = useMemo(
    () => atom((get) => get(session.atoms.allSharedDocuments ?? NO_DOCUMENTS).find((document) => document.documentId === documentId) ?? null),
    [session, documentId],
  );
  const page = useAtomValue(pageAtom);
  const fieldsSupported = useAtomValue(session.atoms.pageFields);
  const requestType = useSetAtom(pageTypeRequestAtom);
  const title = page ? pageDisplayName(getSharedDocumentDisplayName(page.title, page.documentId), page.documentType) : '';
  useHideTitleHeading(title);

  const handleRename = useCallback((name: string) => {
    if (!page) return;
    void session.updateDocumentTitle(page.documentId, pageDisplayName(name, page.documentType)).catch((error: unknown) => {
      errorNotificationService.showError('Could not rename this page', error instanceof Error ? error.message : String(error));
    });
  }, [page, session]);

  const handleUpdateField = useCallback((name: string, value: unknown) => {
    void session.updateDocumentFields(documentId, { [name]: value }).then((result) => {
      if (!result.ok) errorNotificationService.showError('Could not update this page', result.error);
    });
  }, [session, documentId]);

  if (!page) return null;
  return (
    <PlainPageHeader
      title={title}
      editable
      onRename={handleRename}
      // Set type converts markdown pages only.
      onSetType={page.documentType === 'markdown' ? () => requestType({ lane, page }) : undefined}
      facts={pageTimeFacts(page)}
      fields={page.fields}
      onUpdateField={fieldsSupported ? handleUpdateField : undefined}
    />
  );
};
