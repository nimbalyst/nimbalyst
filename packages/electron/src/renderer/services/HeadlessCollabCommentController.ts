import { createEditor } from 'lexical';

import {
  CommentCollabProvider,
  CommentStore,
  CollabCommentControllerError,
  createCollabCommentController,
  type CollabCommentController,
  type CommentMentionPayload,
} from '@nimbalyst/runtime/editor';

import {
  getTeamSyncProvider,
  getSharedDocumentsForWorkspace,
} from '../store/atoms/collabDocuments';
import { parseCollabUri } from '../utils/collabUri';
import { notifyDocumentCommentRecipients } from './documentCommentNotifier';
import { collaborativeEmbedProviderCache } from './CollaborativeEmbedProviderCache';
import { getCollaborativeDocumentTypeCatalog } from './CollaborativeDocumentTypeCatalog';

const HYDRATION_TIMEOUT_MS = 10_000;
const FLUSH_TIMEOUT_MS = 5_000;

async function waitUntil(
  predicate: () => boolean,
  timeoutMs: number,
  message: string,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) {
      throw new CollabCommentControllerError('SYNC_TIMEOUT', message);
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

export interface HeadlessCollabCommentAcquisition {
  controller: CollabCommentController;
  flush(): Promise<void>;
  release(): void;
}

/**
 * Acquire a non-visual comment controller through the same authenticated
 * replica/provider lifecycle used by embedded collaborative documents.
 * It supports list/reply only; anchored creation deliberately remains mounted.
 */
export async function acquireHeadlessCollabCommentController(
  documentUri: string,
  workspacePath: string,
): Promise<HeadlessCollabCommentAcquisition> {
  const { orgId, documentId } = parseCollabUri(documentUri);
  const document = getSharedDocumentsForWorkspace(workspacePath)
    .find((candidate) => candidate.documentId === documentId);
  if (!document) {
    throw new Error(
      `The shared document ${documentId} is not available in this workspace.`,
    );
  }
  if (document.documentType !== 'markdown') {
    throw new Error(
      'Inline comments are currently supported only for collaborative markdown documents.',
    );
  }

  const catalog = getCollaborativeDocumentTypeCatalog();
  const resolution = catalog.resolveMetadata(
    document.documentType,
    document.fileExtension,
    document.editorId,
  );
  if (resolution.state !== 'ready') throw new Error(resolution.reason);
  const descriptor = resolution.descriptor;
  const acquisition = await collaborativeEmbedProviderCache.acquire({
    workspacePath,
    orgId,
    documentId,
    title: document.title,
    documentType: document.documentType,
    metadata: {
      metadataVersion: 2,
      fileExtension: document.fileExtension ?? descriptor.defaultExtension,
      editorId:
        document.editorId ?? catalog.editorIdForDescriptor(descriptor),
    },
  });

  let unregisterComments: (() => void) | undefined;
  try {
    await waitUntil(
      () => acquisition.resource.syncProvider.isSynced(),
      HYDRATION_TIMEOUT_MS,
      'Timed out while hydrating collaborative document comments.',
    );

    const editor = createEditor({
      namespace: `HeadlessCollabComments:${documentId}`,
      onError(error) {
        throw error;
      },
    });
    const commentStore = new CommentStore(editor);
    unregisterComments = commentStore.registerCollaboration(
      new CommentCollabProvider(acquisition.resource.syncProvider.getYDoc()),
    );
    const config = acquisition.resource.config;
    const currentUser = {
      id: config.userId,
      name: config.userName || config.userEmail || config.userId,
    };
    const teamProvider = getTeamSyncProvider(workspacePath);
    const getMembers = () =>
      (teamProvider?.getTeamState()?.members ?? [])
        .filter((member) => member.userId !== currentUser.id)
        .map((member) => ({
          userId: member.userId,
          name: member.email || member.userId,
          personalOrgId: member.personalOrgId,
        }));
    const controller = createCollabCommentController({
      commentStore,
      currentUser,
      documentTitle: document.title,
      documentUri,
      // resolveCollabConfigForUri + DocumentSyncProvider are the authorization
      // boundary for this headless acquisition. The team roster is only a
      // mention directory and must not deny document access.
      getCapabilities: () => ({ read: true, comment: true }),
      getMembers,
      isHydrated: () => acquisition.resource.syncProvider.isSynced(),
      isVisible: () => false,
      onCommitted: ({
        actor,
        comment,
        mentionedUserIds,
        replyRecipientUserIds,
        thread,
      }) => {
        const actorName =
          actor.kind === 'agent' ? actor.sessionName : actor.displayName;
        const mentionRecipients = mentionedUserIds.filter(
          (id) => id !== currentUser.id,
        );
        const payload: CommentMentionPayload = {
          actorName,
          sourceTitle: document.title,
          snippet: comment.content.slice(0, 200),
          commentId: comment.id,
          threadId: thread.id,
          markId: thread.id,
          url: documentUri,
        };
        notifyDocumentCommentRecipients({
          workspacePath,
          documentId,
          reason: 'mention',
          recipientUserIds: mentionRecipients,
          payload,
        });
        // A mention already reached these recipients; a second delivery for the
        // same comment would be deduped server-side but still muddies the ack.
        notifyDocumentCommentRecipients({
          workspacePath,
          documentId,
          reason: 'reply',
          recipientUserIds: replyRecipientUserIds.filter(
            (id) => id !== currentUser.id && !mentionRecipients.includes(id),
          ),
          payload,
        });
      },
    });

    let released = false;
    return {
      controller,
      async flush() {
        // Let the async Y.Doc observer enqueue the update, then keep the
        // provider alive until its durable outbox is acknowledged.
        await new Promise((resolve) => setTimeout(resolve, 0));
        await waitUntil(
          () =>
            acquisition.resource.replica.getOutboxState() === 'clean' &&
            acquisition.resource.syncProvider.getStatus() === 'connected',
          FLUSH_TIMEOUT_MS,
          'Timed out while flushing the collaborative comment reply.',
        );
      },
      release() {
        if (released) return;
        released = true;
        unregisterComments?.();
        acquisition.release();
      },
    };
  } catch (error) {
    unregisterComments?.();
    acquisition.release();
    throw error;
  }
}
