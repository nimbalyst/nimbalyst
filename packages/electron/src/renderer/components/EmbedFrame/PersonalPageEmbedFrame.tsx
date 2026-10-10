/**
 * A Personal page shown inline in another page or file: its console link
 * (`/app/page/<id>`) with a registered `embedType`, as a Team page's deep link
 * embeds. The page's own editor over its stored body, view only: edits happen
 * in the page's tab (Open), and the embed follows them as they are saved.
 */

import React, { useCallback } from 'react';
import { atom, useAtomValue } from 'jotai';
import type { EmbedFrameProps } from '@nimbalyst/runtime';
import { getSharedDocumentDisplayName, pageDisplayName } from '@nimbalyst/collab-client/docs';
import { personalPagesDocumentsAtomFamily, type SharedDocument } from '../../store/atoms/collabDocuments';
import { activeWorkspacePathAtom } from '../../store/atoms/openProjects';
import { openConsoleLinkInWindow } from '../../utils/openConsoleLink';
import { PersonalExtensionPageView } from '../CollabMode/PersonalExtensionPageBody';
import { EmbedFrameShell, EmbedUnresolved } from './EmbedFrameShell';

const NO_DOCUMENTS_ATOM = atom<SharedDocument[]>([]);

export const PersonalPageEmbedFrame: React.FC<EmbedFrameProps & { pageId: string }> = ({ pageId, src, label, attrs, nodeKey, detached }) => {
  const workspacePath = useAtomValue(activeWorkspacePathAtom);
  const documents = useAtomValue(workspacePath ? personalPagesDocumentsAtomFamily(workspacePath) : NO_DOCUMENTS_ATOM);
  const page = documents.find((doc) => doc.documentId === pageId);
  const onOpen = useCallback(() => {
    openConsoleLinkInWindow(src, { newTab: true });
  }, [src]);

  if (!workspacePath || !page) {
    return (
      <EmbedUnresolved
        displayName={label || src}
        label={label}
        src={src}
        error="This Personal page is not on this device, or it is in Trash."
        onOpen={onOpen}
        testId="personal-page-embed-unresolved"
      />
    );
  }
  const title = pageDisplayName(getSharedDocumentDisplayName(page.title, page.documentId), page.documentType);
  return (
    <EmbedFrameShell
      nodeKey={nodeKey}
      attrs={attrs}
      label={label}
      detached={detached}
      displayName={title}
      onOpen={onOpen}
      markers={{ 'data-embed-personal': 'true', 'data-embed-page-id': pageId }}
      loadingText="Loading page..."
    >
      <PersonalExtensionPageView
        documentId={pageId}
        workspacePath={workspacePath}
        page={{ title, documentType: page.documentType, fileExtension: page.fileExtension }}
        className="h-full"
        revision={page.updatedAt}
      />
    </EmbedFrameShell>
  );
};
