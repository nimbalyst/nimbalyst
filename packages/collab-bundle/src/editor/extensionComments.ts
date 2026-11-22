/**
 * The browser host's `CollaborationContext.comments` for extension editors.
 *
 * The Lexical mount hands its comment options to the runtime's editor config
 * and the `CommentPlugin` builds everything from there. An extension editor has
 * no Lexical and no plugin, so the host has to build the service itself and put
 * it on the collaboration context — the same shape the desktop renderer builds
 * for its extension tabs.
 *
 * Every authority-bearing input comes from the embedding page's authenticated
 * session and is passed in here: identity, roster, the role-derived comment
 * answer, hydration, and the notification callbacks. Nothing is read from the
 * extension, and nothing is invented. A host that cannot answer one of them
 * does not build this at all — `comments` is then absent from the context,
 * which is how extensions already feature-detect. A stub that accepted comments
 * into a document nobody else can see is worse than a missing button.
 *
 * `openPanel` is deliberately omitted rather than stubbed. The browser host
 * owns no comments panel surface: an extension editor that shows threads mounts
 * the shared panel inside its own editor and already knows how to open it. A
 * method that silently did nothing would be discovered by a user, not a test.
 */

import type {
  CollaborationCommentsService,
  CollaborativeComment,
  CollaborativeCommentsSnapshot,
  CollaborativeCommentThread,
  CommentAnchor,
  CommentCapabilities,
  CommentMember,
  CreateCommentThreadResult,
  MountedCommentAnchorAdapter,
  ReplyToCommentResult,
} from '@nimbalyst/extension-sdk/types/comments';
import type { Doc } from 'yjs';

import {
  collabCommentAnchorAdapterRegistry,
  createRepositoryCollabCommentController,
} from '@nimbalyst/runtime/editor/commenting/CollabCommentControllerRegistry';
import {
  COMMENT_BOUNDS,
  CollabCommentControllerError,
  normalizeVisibleCommentText,
  truncateCommentUtf8,
  validateCommentBody,
  validateCommentMentions,
  validateCommentMutationId,
} from '@nimbalyst/runtime/editor/commenting/commentValidation';
import {
  createComment,
  createThread,
  getCommentAnchorSupport,
  normalizeCommentActor,
  YDocCommentRepository,
  type ThreadSnapshot,
} from '@nimbalyst/runtime/editor/commenting/YDocCommentRepository';
import type {
  Comment,
  CommentActor,
  CommentAnchor as RuntimeCommentAnchor,
  CommentMentionPayload,
  CommentReplyPayload,
} from '@nimbalyst/runtime/editor/commenting/types';

const NO_CAPABILITIES: CommentCapabilities = Object.freeze({
  read: false,
  comment: false,
});
const EMPTY_SNAPSHOT = Object.freeze([]) as CollaborativeCommentsSnapshot;

export interface ExtensionCommentsHost {
  /** The signed-in author, read live: the roster resolves after the mount. */
  currentUser: { id: string; name: string };
  documentId: string;
  documentTitle: string;
  /** Stable identity the anchor-adapter registry keys on. */
  documentUri: string;
  /** This mount, so two tabs over one document do not share adapters. */
  instanceId: string;
  getMembers(): CommentMember[];
  /**
   * Transport-and-role derived, resolved on every read. Access can be revoked
   * mid-session, and a cached answer leaves the affordances decorative exactly
   * when it matters.
   */
  getCapabilities(): CommentCapabilities;
  /** False until the room has synced once; writing before that can lose data. */
  isHydrated(): boolean;
  onMention?(recipientUserIds: string[], payload: CommentMentionPayload): void;
  onReply?(recipientUserIds: string[], payload: CommentReplyPayload): void;
}

export interface HostedExtensionComments {
  service: CollaborationCommentsService;
  /**
   * Tell subscribers the answer to `getCapabilities()` may have changed.
   *
   * Capabilities are never cached -- they are resolved on every read -- but a
   * mounted extension only re-reads them when React re-renders it, and the two
   * things that move the answer (the roster resolving, the server demoting a
   * writer) are both outside its render path. Without this, the composer of a
   * user whose access was just revoked stays on screen until something
   * unrelated changes.
   */
  notifyCapabilitiesChanged(): void;
  destroy(): void;
}

function asSdkComment(comment: Readonly<Comment>): CollaborativeComment {
  return comment as CollaborativeComment;
}

function asSdkThread(thread: ThreadSnapshot): CollaborativeCommentThread {
  return thread as CollaborativeCommentThread;
}

function asRuntimeAnchor(anchor: CommentAnchor): RuntimeCommentAnchor {
  return anchor as RuntimeCommentAnchor;
}

function findThread(
  repository: YDocCommentRepository,
  threadId: string,
): ThreadSnapshot | undefined {
  const candidate = repository
    .getSnapshot()
    .find((entry) => entry.type === 'thread' && entry.id === threadId);
  return candidate?.type === 'thread' ? candidate : undefined;
}

function findMutation(
  repository: YDocCommentRepository,
  clientMutationId: string,
): { comment: Readonly<Comment>; thread: ThreadSnapshot } | undefined {
  for (const entry of repository.getSnapshot()) {
    if (entry.type !== 'thread') continue;
    const comment = entry.comments.find(
      (candidate) => candidate.clientMutationId === clientMutationId,
    );
    if (comment) return { comment, thread: entry };
  }
  return undefined;
}

function sameActor(left: CommentActor, right: CommentActor): boolean {
  if (left.kind !== right.kind) return false;
  if (left.kind === 'user' && right.kind === 'user') {
    return left.userId === right.userId && left.displayName === right.displayName;
  }
  if (left.kind === 'agent' && right.kind === 'agent') {
    return left.sessionId === right.sessionId
      && left.onBehalfOfUserId === right.onBehalfOfUserId;
  }
  return false;
}

export function createExtensionCommentsService(input: {
  yDoc: Doc;
  host: ExtensionCommentsHost;
}): HostedExtensionComments {
  const { yDoc, host } = input;
  const repository = new YDocCommentRepository(yDoc);
  const listeners = new Set<() => void>();
  const adapterDisposers = new Set<() => void>();
  let destroyed = false;

  const emit = (): void => {
    for (const listener of listeners) listener();
  };

  const capabilities = (): CommentCapabilities => {
    if (destroyed) return NO_CAPABILITIES;
    const resolved = host.getCapabilities();
    // `comment` is gated on `read` so a host that says "no read, yes comment"
    // cannot produce a composer over threads the user is not allowed to see.
    // It is also gated on body write: in v1 a commenter (`editBody: false`)
    // gets read-only, no-comment access on extension pages, because an
    // extension's anchors (mockup pins) live outside `comments` and the room
    // ends a commenter's session on any write there.
    if (resolved.editBody === false) {
      return { read: resolved.read, comment: false, editBody: false };
    }
    return { read: resolved.read, comment: resolved.read && resolved.comment };
  };

  /** The author, rebuilt per use: the display name resolves after the mount. */
  const currentActor = (): CommentActor => ({
    kind: 'user',
    userId: host.currentUser.id,
    displayName: host.currentUser.name,
  });

  const requireMutationAccess = (): void => {
    if (destroyed) {
      throw new CollabCommentControllerError(
        'DOCUMENT_NOT_MOUNTED',
        'The collaborative document is no longer mounted.',
      );
    }
    if (!host.isHydrated()) {
      throw new CollabCommentControllerError(
        'DOCUMENT_NOT_HYDRATED',
        'The collaborative document has not finished hydrating.',
      );
    }
    if (!capabilities().comment) {
      throw new CollabCommentControllerError(
        'COMMENT_FORBIDDEN',
        'You do not have permission to comment on this document.',
      );
    }
  };

  const notifyCommitted = (event: {
    actor: CommentActor;
    comment: Readonly<Comment>;
    mentionedUserIds: string[];
    replyRecipientUserIds: string[];
    thread: ThreadSnapshot;
  }): void => {
    const actorName = event.actor.kind === 'agent'
      ? event.actor.sessionName
      : event.actor.displayName;
    const mentionRecipients = event.mentionedUserIds.filter(
      (id) => id !== host.currentUser.id,
    );
    const payload: CommentMentionPayload = {
      actorName,
      sourceTitle: host.documentTitle,
      snippet: truncateCommentUtf8(
        event.comment.content,
        COMMENT_BOUNDS.maxAnchorContextBytes,
      ),
      commentId: event.comment.id,
      threadId: event.thread.id,
      url: host.documentUri,
    };
    host.onMention?.(mentionRecipients, payload);

    if (!event.comment.clientMutationId) return;
    host.onReply?.(
      event.replyRecipientUserIds.filter(
        (id) => id !== host.currentUser.id && !mentionRecipients.includes(id),
      ),
      {
        ...payload,
        commentId: event.comment.id,
        clientMutationId: event.comment.clientMutationId,
        ...(event.comment.replyToCommentId
          ? { replyToCommentId: event.comment.replyToCommentId }
          : {}),
      },
    );
  };

  // Built for its reply implementation and its validation, not registered in
  // `collabCommentControllerRegistry`: that registry exists so a headless agent
  // can reach a mounted document, and nothing reaches into a browser tab.
  const controller = createRepositoryCollabCommentController({
    repository,
    currentUser: host.currentUser,
    documentTitle: host.documentTitle,
    documentUri: host.documentUri,
    getCapabilities: capabilities,
    getMembers: host.getMembers,
    isHydrated: host.isHydrated,
    isVisible: () => !destroyed,
    now: () => Date.now(),
    onCommitted: notifyCommitted,
  });

  const unsubscribeRepository = repository.subscribe(emit);
  const unsubscribeAdapters = collabCommentAnchorAdapterRegistry.subscribe(
    host.documentUri,
    emit,
  );

  const focusThread = async (threadId: string): Promise<boolean> => {
    if (destroyed || !capabilities().read) return false;
    const anchor = findThread(repository, threadId)?.anchor;
    return anchor
      ? collabCommentAnchorAdapterRegistry.focus(host.documentUri, anchor)
      : false;
  };

  const service = {
    getSnapshot() {
      if (destroyed || !capabilities().read) return EMPTY_SNAPSHOT;
      return repository.getSnapshot() as CollaborativeCommentsSnapshot;
    },

    subscribe(listener: () => void) {
      if (destroyed) return () => {};
      listeners.add(listener);
      return () => listeners.delete(listener);
    },

    getCapabilities: capabilities,

    getMentionableMembers() {
      if (destroyed || !capabilities().read) return [];
      return host
        .getMembers()
        .filter((member) => member.userId !== host.currentUser.id)
        .map((member) => ({ ...member }));
    },

    async createThread(threadInput): Promise<CreateCommentThreadResult> {
      requireMutationAccess();
      const content = validateCommentBody(threadInput.content);
      const clientMutationId = validateCommentMutationId(
        threadInput.clientMutationId,
      );
      const mentionedUserIds = validateCommentMentions(
        threadInput.mentionedUserIds,
        host.getMembers(),
      );
      const anchor = asRuntimeAnchor(threadInput.anchor);
      if (getCommentAnchorSupport(anchor) !== 'supported') {
        throw new CollabCommentControllerError(
          'ANCHOR_NOT_FOUND',
          'The comment anchor is malformed or exceeds its encoded size limit.',
        );
      }

      // A retried placement must not create a second thread on the same pin.
      const duplicate = findMutation(repository, clientMutationId);
      if (duplicate) {
        const duplicateActor = normalizeCommentActor(
          duplicate.comment.actor,
          duplicate.comment.author,
        );
        if (
          duplicate.comment.content !== content
          || !sameActor(duplicateActor, currentActor())
          || JSON.stringify(duplicate.thread.anchor) !== JSON.stringify(threadInput.anchor)
        ) {
          throw new CollabCommentControllerError(
            'MUTATION_CONFLICT',
            'clientMutationId was already used for a different comment mutation.',
          );
        }
        return {
          duplicate: true,
          thread: asSdkThread(duplicate.thread),
          comment: asSdkComment(duplicate.comment),
        };
      }

      // The mounted editor is the only thing that can say whether this anchor
      // points at something real. Refusing here is what keeps a thread from
      // being written against an entity that does not exist.
      if (
        collabCommentAnchorAdapterRegistry.getState(host.documentUri, anchor)
        !== 'attached'
      ) {
        throw new CollabCommentControllerError(
          'ANCHOR_NOT_FOUND',
          'The requested comment anchor is not attached in a mounted editor.',
        );
      }
      const described = collabCommentAnchorAdapterRegistry.describe(
        host.documentUri,
        anchor,
      );
      const label = typeof described === 'string'
        ? normalizeVisibleCommentText(described).trim()
        : '';
      const fallback = anchor.kind === 'text-quote'
        ? anchor.exact
        : anchor.labelSnapshot || `${anchor.entityType}: ${anchor.entityId}`;
      const quote = truncateCommentUtf8(
        label || fallback,
        COMMENT_BOUNDS.maxAnchorExactBytes,
      );

      const actor = currentActor();
      const comment = createComment(content, host.currentUser.name, {
        actor,
        clientMutationId,
        timeStamp: Date.now(),
      });
      const mutation = repository.addThread(
        createThread(quote, [comment], undefined, false, anchor),
      );
      const canonical = mutation.value.comments.find(
        (candidate) => candidate.clientMutationId === clientMutationId,
      );
      if (!canonical) {
        throw new CollabCommentControllerError(
          'MUTATION_CONFLICT',
          'The canonical comment mutation was not found after persistence.',
        );
      }
      if (!mutation.duplicate) {
        notifyCommitted({
          actor,
          comment: canonical,
          mentionedUserIds,
          replyRecipientUserIds: [],
          thread: mutation.value,
        });
      }
      return {
        duplicate: mutation.duplicate,
        thread: asSdkThread(mutation.value),
        comment: asSdkComment(canonical),
      };
    },

    async reply(replyInput): Promise<ReplyToCommentResult> {
      const result = await controller.reply(
        {
          threadId: replyInput.threadId,
          body: replyInput.content,
          clientMutationId: replyInput.clientMutationId,
          mentionedUserIds: replyInput.mentionedUserIds,
          replyToCommentId: replyInput.replyToCommentId,
        },
        currentActor(),
      );
      return {
        ...result,
        comment: {
          actor: result.comment.actor,
          author: result.comment.actor.kind === 'agent'
            ? result.comment.actor.sessionName
            : result.comment.actor.displayName,
          ...(result.comment.clientMutationId
            ? { clientMutationId: result.comment.clientMutationId }
            : {}),
          content: result.comment.body,
          deleted: result.comment.deleted,
          id: result.comment.id,
          ...(result.comment.replyToCommentId
            ? { replyToCommentId: result.comment.replyToCommentId }
            : {}),
          timeStamp: result.comment.createdAt,
          type: 'comment',
        },
      };
    },

    async setResolved(threadId: string, resolved: boolean) {
      requireMutationAccess();
      if (!findThread(repository, threadId)) {
        throw new CollabCommentControllerError(
          'THREAD_NOT_FOUND',
          'The requested comment thread no longer exists.',
        );
      }
      repository.setThreadResolved(threadId, resolved);
    },

    focusThread,

    registerAnchorAdapter(adapter: MountedCommentAnchorAdapter) {
      if (destroyed) return () => {};
      const unregister = collabCommentAnchorAdapterRegistry.register({
        documentUri: host.documentUri,
        instanceId: host.instanceId,
        adapter,
        isActive: () => !destroyed,
        isVisible: () => !destroyed,
      });
      const dispose = (): void => {
        if (!adapterDisposers.delete(dispose)) return;
        unregister();
      };
      adapterDisposers.add(dispose);
      return dispose;
    },
    // `openPanel` is absent on purpose; see the module header.
  } as CollaborationCommentsService;

  return {
    service,
    notifyCapabilitiesChanged: emit,
    destroy() {
      if (destroyed) return;
      destroyed = true;
      for (const dispose of [...adapterDisposers]) dispose();
      unsubscribeAdapters();
      unsubscribeRepository();
      listeners.clear();
      repository.destroy();
    },
  };
}
