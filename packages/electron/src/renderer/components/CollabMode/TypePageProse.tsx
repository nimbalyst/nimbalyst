/**
 * The prose at the top of a type's page: the document `type-page:<typeId>`.
 * A team type's prose is a shared document in the team index under the type's
 * parent page, edited live like any shared document; a Personal type's is a
 * Personal page. The tree never lists it as a row: the type node stands for it.
 *
 * Created lazily. A type nobody has written about shows one faint line; the
 * document is created when someone clicks it to start writing, so opening a
 * type never adds a document to the team index on its own.
 */

import type { LexicalEditor } from 'lexical';
import React, { useCallback, useEffect, useState } from 'react';
import type { CollabScope } from '@nimbalyst/collab-client/core';
import { TYPE_PAGE_DOCUMENT_PREFIX, type SharedDocument } from '@nimbalyst/collab-client/docs';
import { CollaborativeEmbedEditor } from '../EmbedFrame/CollaborativeEmbedEditor';
import { resolveCollaborativeEmbedRequest } from '../EmbedFrame/resolveCollaborativeEmbedRequest';
import { ensureTypePageDocument } from '../../services/collaborativeDocumentCreationOrchestrator';
import { PersonalPageBodyEditor } from './PersonalPageBodyEditor';

export interface TypePageProseProps {
  typeId: string;
  onEditorReady?: (editor: LexicalEditor | null) => void;
  /** The type's plural name: the prose document's name in the index. */
  typeName: string;
  /** The singular name, for the empty-page prompt. */
  itemName: string;
  lane: 'team' | 'personal';
  /** Null while the team scope resolves, or when the project has no team. */
  scope: CollabScope | null;
  workspacePath: string;
  /** The page the type sits under (its placement parent); null at the root. */
  parentFolderId: string | null;
  documents: readonly SharedDocument[];
}

export const TypePageProse: React.FC<TypePageProseProps> = ({
  typeId,
  typeName,
  itemName,
  lane,
  scope,
  workspacePath,
  parentFolderId,
  documents,
  onEditorReady,
}) => {
  const documentId = `${TYPE_PAGE_DOCUMENT_PREFIX}${typeId}`;
  const [created, setCreated] = useState<SharedDocument | null>(null);
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    setCreated(null);
    setError(null);
  }, [documentId]);
  const document = documents.find((candidate) => candidate.documentId === documentId) ?? created;

  const startWriting = useCallback(async () => {
    if (!scope || creating) return;
    setCreating(true);
    setError(null);
    try {
      setCreated(await ensureTypePageDocument({ scope, typeId, typeName, parentFolderId }));
    } catch (cause) {
      console.error('[TypePageProse] Failed to create the type page:', cause);
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setCreating(false);
    }
  }, [scope, creating, typeId, typeName, parentFolderId]);

  if (!document) {
    return (
      <div className="type-page-prose type-page-prose--empty tracker-page-view-gutter" data-testid="type-page-prose">
        <button
          type="button"
          className="type-page-prose-start w-full cursor-text border-none bg-transparent p-0 py-3 text-left text-[15px] text-nim-faint hover:text-nim-muted disabled:cursor-default"
          disabled={!scope || creating}
          onClick={() => void startWriting()}
          data-testid="type-page-prose-start"
        >
          {creating ? 'Creating the page...' : `Describe what a ${itemName.toLowerCase()} is and what belongs here`}
        </button>
        {error && <div className="pb-2 text-xs text-nim-error" role="alert">This page could not be created: {error}</div>}
      </div>
    );
  }

  if (lane === 'personal') {
    return (
      <div className="type-page-prose tracker-page-view-body" data-testid="type-page-prose" data-document-id={documentId}>
        <PersonalPageBodyEditor documentId={documentId} workspacePath={workspacePath} onEditorReady={onEditorReady} />
      </div>
    );
  }

  if (!scope) return null;
  const resolution = resolveCollaborativeEmbedRequest({
    orgId: scope.orgId,
    documentId,
    workspacePath,
    sharedTitle: document.title,
    sharedDocumentType: document.documentType,
    sharedFileExtension: document.fileExtension,
    sharedEditorId: document.editorId,
    fallbackTitle: typeName,
    allowLexical: true,
  });
  return (
    <div className="type-page-prose tracker-page-view-body" data-testid="type-page-prose" data-document-id={documentId}>
      {resolution.status === 'ready' ? (
        <CollaborativeEmbedEditor editor={resolution.editor} request={resolution.request} readOnly={false} toolbar={false} publishHistory onEditorReady={onEditorReady} />
      ) : (
        <div className="tracker-page-view-gutter py-3 text-sm text-nim-muted">{resolution.error}</div>
      )}
    </div>
  );
};
