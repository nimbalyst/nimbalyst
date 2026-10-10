/**
 * A personal page's markdown body: the editor, and the one-line notice when a
 * save was refused or failed. The body is stored in the local database through
 * `usePersonalPageBody`; nothing is written to disk as a file and no account
 * or server is involved. Used by a `personal://` tab and by a Personal type's
 * page (its prose).
 *
 * Editor host wiring mirrors a local tracker body (`trackerBodyHost.ts`):
 * images go to the workspace's content-addressed store under
 * `<workspace>/.nimbalyst/assets`, and local history is keyed by
 * `personal-doc://<documentId>`, the key main records snapshots under.
 */

import React, { useEffect, useMemo, useRef } from 'react';
import type { LexicalEditor } from 'lexical';
import { NimbalystEditor, type EditorConfig } from '@nimbalyst/runtime/editor';
import type { UploadedEditorAsset } from '@nimbalyst/runtime/editor/EditorConfig';
import { DocumentPathProvider } from '@nimbalyst/runtime/DocumentPathContext';
import { store } from '@nimbalyst/runtime/store';
import { historyDialogFileAtom } from '../../store/atoms/historyDialog';
import { nimAssetUrl } from '../../utils/assetUrl';
import { usePersonalPageBody } from './usePersonalPageBody';

const PERSONAL_DOCUMENT_PREFIX = 'personal-doc://';
const WORKSPACE_ASSET_PREFIX = '.nimbalyst/assets/';

/** The history key and editor identity of a personal page body. */
export function personalPageDocumentPath(documentId: string): string {
  return `${PERSONAL_DOCUMENT_PREFIX}${documentId}`;
}

type PersonalPageHostConfig = Pick<
  EditorConfig,
  'filePath' | 'workspaceId' | 'onUploadAsset' | 'resolveImageSrc' | 'onImageDoubleClick' | 'onImageDragStart' | 'onViewHistory'
>;

function createPersonalPageHostConfig(documentId: string, workspacePath: string): PersonalPageHostConfig {
  const documentPath = personalPageDocumentPath(documentId);
  const workspaceRoot = workspacePath.replace(/\\/g, '/').replace(/\/+$/, '');
  return {
    filePath: documentPath,
    workspaceId: workspacePath,
    onUploadAsset: async (file: File): Promise<UploadedEditorAsset> => {
      const { relativePath } = await window.electronAPI.documentService.stageTrackerImage({
        workspacePath,
        bytes: await file.arrayBuffer(),
        mimeType: file.type,
      });
      return { kind: 'image', src: relativePath, name: file.name, altText: file.name };
    },
    resolveImageSrc: async (src) =>
      src.startsWith(WORKSPACE_ASSET_PREFIX) ? nimAssetUrl(`${workspaceRoot}/${src}`) : null,
    onImageDoubleClick: (src) => {
      void window.electronAPI.openImageInDefaultApp(src).catch((error) => {
        console.error('[PersonalPageBodyEditor] Failed to open image:', error);
      });
    },
    onImageDragStart: (src) => {
      void window.electronAPI.startImageDrag(src).catch((error) => {
        console.error('[PersonalPageBodyEditor] Failed to start image drag:', error);
      });
    },
    onViewHistory: () => store.set(historyDialogFileAtom, documentPath),
  };
}

export interface PersonalPageBodyEditorProps {
  documentId: string;
  workspacePath: string;
  /** Classes for the element holding the editor (layout differs per host). */
  className?: string;
  onEditorReady?: (editor: LexicalEditor | null) => void;
  /** Scrolls with the body, above it (the page's title and type row). */
  documentHeader?: React.ReactNode;
}

export const PersonalPageBodyEditor: React.FC<PersonalPageBodyEditorProps> = ({ documentId, workspacePath, className, onEditorReady, documentHeader }) => {
  const readyRef = useRef(onEditorReady); readyRef.current = onEditorReady;
  useEffect(() => () => readyRef.current?.(null), [documentId, workspacePath]);
  const body = usePersonalPageBody({ workspacePath, documentId });
  const getContentRef = useRef<(() => string) | null>(null);
  const onEditRef = useRef(body.onEdit);
  onEditRef.current = body.onEdit;

  const hostConfig = useMemo(
    () => createPersonalPageHostConfig(documentId, workspacePath),
    [documentId, workspacePath],
  );

  const editorConfig = useMemo((): EditorConfig | null => {
    if (body.status !== 'ready') return null;
    return {
      ...hostConfig,
      documentHeader,
      onEditorReady: editor => readyRef.current?.(editor),
      isRichText: true,
      editable: true,
      showToolbar: false,
      isCodeHighlighted: true,
      hasLinkAttributes: true,
      markdownOnly: true,
      initialContent: body.initialContent,
      onGetContent: (getContentFn: () => string) => {
        getContentRef.current = getContentFn;
      },
      onDirtyChange: (isDirty: boolean) => {
        if (isDirty && getContentRef.current) onEditRef.current(getContentRef.current());
      },
    };
  }, [body.status, body.initialContent, hostConfig, documentHeader]);

  const documentPath = personalPageDocumentPath(documentId);

  return (
    <>
      {body.notice && (
        <div className="personal-page-tab-notice flex shrink-0 items-center gap-2 px-6 py-1.5 text-sm text-nim-muted" role="status">
          <span className="flex-1">{body.notice}</span>
          <button type="button" className="text-xs text-nim-muted hover:text-nim" onClick={body.dismissNotice}>
            Dismiss
          </button>
        </div>
      )}
      <div className={`personal-page-tab-body relative ${className ?? ''}`} data-file-path={documentPath}>
        {editorConfig ? (
          <DocumentPathProvider documentPath={documentPath}>
            <NimbalystEditor key={`${documentId}-${body.editorEpoch}`} config={editorConfig} />
          </DocumentPathProvider>
        ) : (
          <div className="py-4 text-center text-sm text-nim-faint" role="status">
            {body.status === 'unavailable'
              ? 'This page is unavailable on this device. It may have been deleted. Check Wiki Trash for a recoverable copy.'
              : body.status === 'error' ? 'This page could not be loaded.' : 'Loading...'}
            {(body.status === 'unavailable' || body.status === 'error') && (
              <button type="button" className="ml-2 text-nim-link hover:underline" onClick={body.retryLoad}>Try again</button>
            )}
          </div>
        )}
      </div>
    </>
  );
};
