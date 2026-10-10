/**
 * Page history for a shared markdown body that is not a collaborative tab: a
 * typed page's body (`tracker-content/<itemId>`) and a type page's prose
 * (`type-page:<typeId>`). Both are ordinary document rooms on the server, with
 * the same revision API as any shared page.
 *
 * While the body editor is mounted this publishes the history controller the
 * history dialog reads (keyed by the body's `collab://` URI) and records the
 * room's bootstrap and idle revisions. Restore goes through the live editor,
 * so peers receive it as an ordinary collaborative edit and it cannot race
 * the open editor's own writes.
 */
import { useEffect } from 'react';
import { useSetAtom } from 'jotai';
import { $getRoot, $setSelection, type LexicalEditor } from 'lexical';
import {
  $convertFromEnhancedMarkdownString,
  $convertToEnhancedMarkdownString,
  getEditorTransformers,
} from '@nimbalyst/runtime/editor';
import type { DocumentSyncProvider } from '@nimbalyst/runtime/sync';
import { startCollabRevisionRecording } from '@nimbalyst/collab-client/docs-ui/history';
import {
  collabHistoryControllerBumpAtom,
  registerCollabHistoryController,
  type CollabHistoryController,
} from '../../store/atoms/collabHistoryControllers';

export interface CollabBodyHistoryOptions {
  /** The body's `collab://` URI; null while the body is not collaborative. */
  uri: string | null;
  /** REST client for the body's room; null until the room is acquired. */
  client: CollabHistoryController['client'] | null;
  syncProvider: Pick<DocumentSyncProvider, 'getLastSeq' | 'getStatus' | 'waitForPendingWrites'> | null;
  /** The mounted body editor, bound to the room. */
  editor: LexicalEditor | null;
  readOnly?: boolean;
}

export function useCollabBodyHistory({ uri, client, syncProvider, editor, readOnly = false }: CollabBodyHistoryOptions): void {
  const bump = useSetAtom(collabHistoryControllerBumpAtom);

  useEffect(() => {
    if (!uri || !client || !syncProvider || !editor) return;
    const encoder = new TextEncoder();
    const decoder = new TextDecoder();
    const controller: CollabHistoryController = {
      client,
      editorType: 'markdown',
      contentFormat: 'markdown',
      previewKind: 'text',
      exportSnapshot: () => encoder.encode(
        editor.getEditorState().read(() => $convertToEnhancedMarkdownString(getEditorTransformers())),
      ),
      applySnapshot: (plaintext) => {
        const markdown = decoder.decode(plaintext);
        editor.update(() => {
          // Clearing a selected node without moving selection first makes
          // Lexical throw "selection has been lost ..." (NIM-2005).
          $setSelection(null);
          $getRoot().clear();
          $convertFromEnhancedMarkdownString(markdown, getEditorTransformers());
        }, { discrete: true });
      },
      getBasisSequence: () => syncProvider.getLastSeq(),
      getStatus: () => syncProvider.getStatus(),
      waitForPendingWrites: (timeoutMs) => syncProvider.waitForPendingWrites(timeoutMs),
      isReadOnly: () => readOnly,
    };
    const unregister = registerCollabHistoryController(uri, controller, () => bump());

    const stopRecording = startCollabRevisionRecording(controller);
    return () => {
      stopRecording();
      unregister();
    };
  }, [uri, client, syncProvider, editor, readOnly, bump]);
}
