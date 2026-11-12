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
} from '@nimbalyst/extension-sdk';
import type { Doc } from 'yjs';

import {
  createComment,
  createThread,
  getCommentAnchorSupport,
  normalizeCommentActor,
  type CommentRepositorySnapshot,
  type ThreadSnapshot,
  YDocCommentRepository,
} from '@nimbalyst/runtime/editor/commenting/YDocCommentRepository';
import type {
  CollaborativeCommentsSource,
  CommentAnchorState,
} from '@nimbalyst/runtime/editor/commenting/ui/types';
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
  collabCommentAnchorAdapterRegistry,
  collabCommentControllerRegistry,
  createRepositoryCollabCommentController,
  type CollabCommentController,
} from '@nimbalyst/runtime/editor/commenting/CollabCommentControllerRegistry';
import type {
  Comment,
  CommentActor,
  CommentMentionPayload,
  CommentReplyPayload,
} from '@nimbalyst/runtime/editor/commenting/types';

const NO_COMMENT_CAPABILITIES = Object.freeze({
  read: false,
  comment: false,
});
const EMPTY_SNAPSHOT = Object.freeze([]) as CollaborativeCommentsSnapshot;
const EMPTY_THREADS_SNAPSHOT = Object.freeze(
  [],
) as readonly ThreadSnapshot[];

type RepositoryLease = {
  references: number;
  repository: YDocCommentRepository;
};

const repositoryByDocument = new WeakMap<Doc, RepositoryLease>();

function acquireRepository(yDoc: Doc): RepositoryLease {
  const existing = repositoryByDocument.get(yDoc);
  if (existing) {
    existing.references += 1;
    return existing;
  }
  const lease = {
    references: 1,
    repository: new YDocCommentRepository(yDoc),
  };
  repositoryByDocument.set(yDoc, lease);
  return lease;
}

function releaseRepository(yDoc: Doc, lease: RepositoryLease): void {
  lease.references -= 1;
  if (lease.references > 0) return;
  lease.repository.destroy();
  repositoryByDocument.delete(yDoc);
}

export interface CollaborationCommentsHostConfig {
  currentUser: { id: string; name: string };
  documentId: string;
  documentTitle: string;
  documentUri: string;
  getMembers(): CommentMember[];
  isActive(): boolean;
  isHydrated(): boolean;
  isVisible(): boolean;
  instanceId: string;
  resolveCapabilities(): Promise<CommentCapabilities>;
  now?: () => number;
  onMention?: (
    recipientUserIds: string[],
    payload: CommentMentionPayload
  ) => void;
  onOpenPanel?: (input?: { threadId?: string; anchor?: CommentAnchor }) => void;
  onReply?: (recipientUserIds: string[], payload: CommentReplyPayload) => void;
}

/**
 * What the host-owned panel reads and does, over the same repository the SDK
 * service and the agent controller use.
 *
 * Deliberately NOT part of `CollaborationCommentsService`: deleting a comment
 * is a platform affordance on a platform-owned panel, not something an
 * extension may drive. `focusThread` is re-exposed here so the panel never has
 * to reach for the anchor registry itself.
 */
export interface HostedCommentsPanelSource extends CollaborativeCommentsSource {
  /** Resolves false when nothing mounted can bring the anchor into view. */
  focusThread(threadId: string): Promise<boolean>;
  deleteThread(threadId: string): Promise<void>;
  deleteComment(threadId: string, commentId: string): Promise<void>;
}

export interface HostedCollaborationComments {
  controller: CollabCommentController;
  destroy(): void;
  /** Live view + platform-only mutations for the host's comments panel. */
  panelSource: HostedCommentsPanelSource;
  service: CollaborationCommentsService;
  /**
   * Re-resolve capabilities now. The host calls this when the body's
   * writability changes (the room's verdict arrived or the user was demoted),
   * so the extension sees `editBody: false` before its next write rather than
   * at its next comment mutation.
   */
  refreshCapabilities(): Promise<CommentCapabilities>;
}

function asSdkComment(comment: Readonly<Comment>): CollaborativeComment {
  return comment as CollaborativeComment;
}

function asSdkThread(thread: ThreadSnapshot): CollaborativeCommentThread {
  return thread as CollaborativeCommentThread;
}

function runtimeAnchor(anchor: CommentAnchor) {
  return anchor as import('@nimbalyst/runtime/editor/commenting/types').CommentAnchor;
}

function findThread(
  repository: YDocCommentRepository,
  threadId: string
): ThreadSnapshot | undefined {
  const candidate = repository
    .getSnapshot()
    .find((entry) => entry.type === 'thread' && entry.id === threadId);
  return candidate?.type === 'thread' ? candidate : undefined;
}

function findMutation(
  repository: YDocCommentRepository,
  clientMutationId: string
): { comment: Readonly<Comment>; thread: ThreadSnapshot } | undefined {
  for (const entry of repository.getSnapshot()) {
    if (entry.type !== 'thread') continue;
    const comment = entry.comments.find(
      (candidate) => candidate.clientMutationId === clientMutationId
    );
    if (comment) return { comment, thread: entry };
  }
  return undefined;
}

function sameActor(left: CommentActor, right: CommentActor): boolean {
  if (left.kind !== right.kind) return false;
  return left.kind === 'user' && right.kind === 'user'
    ? left.userId === right.userId && left.displayName === right.displayName
    : left.kind === 'agent' && right.kind === 'agent'
    ? left.sessionId === right.sessionId &&
      left.onBehalfOfUserId === right.onBehalfOfUserId
    : false;
}

function sameAnchor(
  left:
    | import('@nimbalyst/runtime/editor/commenting/types').CommentAnchor
    | undefined,
  right: CommentAnchor
): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function canonicalCommentForMutation(
  thread: ThreadSnapshot,
  clientMutationId: string
): Readonly<Comment> {
  const comment = thread.comments.find(
    (candidate) => candidate.clientMutationId === clientMutationId
  );
  if (!comment) {
    throw new CollabCommentControllerError(
      'MUTATION_CONFLICT',
      'The canonical comment mutation was not found after persistence.'
    );
  }
  return comment;
}

/**
 * Build one tab-scoped comments service and controller over the editor's
 * existing live Y.Doc. All authority-bearing inputs come from the host config.
 */
export function createHostedCollaborationComments(input: {
  yDoc: Doc;
  host: CollaborationCommentsHostConfig;
}): HostedCollaborationComments {
  const { yDoc, host } = input;
  const lease = acquireRepository(yDoc);
  const { repository } = lease;
  const listeners = new Set<() => void>();
  const adapterDisposers = new Set<() => void>();
  let destroyed = false;
  let capabilities: CommentCapabilities = NO_COMMENT_CAPABILITIES;
  /**
   * Bumped on every capability change. The panel renders from capabilities as
   * well as from threads, and `useSyncExternalStore` bails out of a re-render
   * when the snapshot identity is unchanged — without this, a revoked comment
   * permission would leave the composer on screen until something else moved.
   */
  let capabilityEpoch = 0;

  const emit = (): void => {
    for (const listener of listeners) listener();
  };

  const refreshCapabilities = async (): Promise<CommentCapabilities> => {
    if (destroyed) return NO_COMMENT_CAPABILITIES;
    let next: CommentCapabilities = NO_COMMENT_CAPABILITIES;
    try {
      const resolved = await host.resolveCapabilities();
      if (
        typeof resolved?.read === 'boolean' &&
        typeof resolved?.comment === 'boolean'
      ) {
        next = Object.freeze({
          read: resolved.read,
          comment: resolved.read && resolved.comment,
          // Only an explicit false locks the body (commenter mode).
          ...(resolved.editBody === false ? { editBody: false } : {}),
        });
      }
    } catch {
      next = NO_COMMENT_CAPABILITIES;
    }
    if (destroyed) return NO_COMMENT_CAPABILITIES;
    if (
      next.read !== capabilities.read ||
      next.comment !== capabilities.comment ||
      next.editBody !== capabilities.editBody
    ) {
      capabilities = next;
      capabilityEpoch += 1;
      emit();
    }
    return capabilities;
  };

  const requireMutationAccess = async (): Promise<void> => {
    if (destroyed) {
      throw new CollabCommentControllerError(
        'DOCUMENT_NOT_MOUNTED',
        'The collaborative document is no longer mounted.'
      );
    }
    const current = await refreshCapabilities();
    if (!host.isHydrated()) {
      throw new CollabCommentControllerError(
        'DOCUMENT_NOT_HYDRATED',
        'The collaborative document has not finished hydrating.'
      );
    }
    if (!current.comment) {
      throw new CollabCommentControllerError(
        'COMMENT_FORBIDDEN',
        'You do not have permission to comment on this document.'
      );
    }
  };

  const prepareControllerMutation = async (): Promise<void> => {
    if (destroyed) {
      throw new CollabCommentControllerError(
        'DOCUMENT_NOT_MOUNTED',
        'The collaborative document is no longer mounted.'
      );
    }
    await refreshCapabilities();
  };

  const currentActor: CommentActor = {
    kind: 'user',
    userId: host.currentUser.id,
    displayName: host.currentUser.name,
  };

  const notifyCommitted = (event: {
    actor: CommentActor;
    comment: Readonly<Comment>;
    mentionedUserIds: string[];
    replyRecipientUserIds: string[];
    thread: ThreadSnapshot;
  }): void => {
    const actorName =
      event.actor.kind === 'agent'
        ? event.actor.sessionName
        : event.actor.displayName;
    const mentionRecipients = event.mentionedUserIds.filter(
      (id) => id !== host.currentUser.id
    );
    const payload: CommentMentionPayload = {
      actorName,
      sourceTitle: host.documentTitle,
      snippet: truncateCommentUtf8(
        event.comment.content,
        COMMENT_BOUNDS.maxAnchorContextBytes
      ),
      commentId: event.comment.id,
      threadId: event.thread.id,
      url: host.documentUri,
    };
    host.onMention?.(mentionRecipients, payload);

    if (!event.comment.clientMutationId) return;
    host.onReply?.(
      event.replyRecipientUserIds.filter(
        (id) => id !== host.currentUser.id && !mentionRecipients.includes(id)
      ),
      {
        ...payload,
        commentId: event.comment.id,
        clientMutationId: event.comment.clientMutationId,
        ...(event.comment.replyToCommentId
          ? { replyToCommentId: event.comment.replyToCommentId }
          : {}),
      }
    );
  };

  const controller = createRepositoryCollabCommentController({
    repository,
    currentUser: host.currentUser,
    documentTitle: host.documentTitle,
    documentUri: host.documentUri,
    getCapabilities: () => capabilities,
    getMembers: host.getMembers,
    isHydrated: host.isHydrated,
    isVisible: host.isActive,
    beforeMutation: prepareControllerMutation,
    now: host.now,
    onCommitted: notifyCommitted,
  });
  const unregisterController = collabCommentControllerRegistry.register(
    host.documentUri,
    host.instanceId,
    controller
  );
  const unsubscribeRepository = repository.subscribe(emit);
  const unsubscribeAdapters = collabCommentAnchorAdapterRegistry.subscribe(
    host.documentUri,
    emit
  );
  const focusThread = async (threadId: string): Promise<boolean> => {
    if (destroyed) return false;
    const current = await refreshCapabilities();
    if (!current.read) return false;
    const anchor = findThread(repository, threadId)?.anchor;
    return anchor
      ? collabCommentAnchorAdapterRegistry.focus(host.documentUri, anchor)
      : false;
  };

  // Panel opening is a structural capability: a host that has no real panel
  // surface must not publish a method that silently does nothing. Collaborative
  // extension tabs mount one (see CollabCommentsPanelDock) and always pass
  // `onOpenPanel`, so the method is real there; a host that cannot show a panel
  // still omits it rather than answering with a no-op. The SDK interface models
  // the fully-capable shape, so assert only after the conditional omission.
  const service = {
    getSnapshot() {
      if (destroyed || !capabilities.read) return EMPTY_SNAPSHOT;
      return repository.getSnapshot() as CollaborativeCommentsSnapshot;
    },

    subscribe(listener) {
      if (destroyed) return () => {};
      listeners.add(listener);
      return () => listeners.delete(listener);
    },

    getCapabilities() {
      return destroyed ? NO_COMMENT_CAPABILITIES : capabilities;
    },

    getMentionableMembers() {
      if (destroyed || !capabilities.read) return [];
      return host
        .getMembers()
        .filter((member) => member.userId !== host.currentUser.id)
        .map((member) => ({ ...member }));
    },

    async createThread(extensionInput): Promise<CreateCommentThreadResult> {
      await requireMutationAccess();
      const content = validateCommentBody(extensionInput.content);
      const clientMutationId = validateCommentMutationId(
        extensionInput.clientMutationId
      );
      const mentionedUserIds = validateCommentMentions(
        extensionInput.mentionedUserIds,
        host.getMembers()
      );
      const anchor = runtimeAnchor(extensionInput.anchor);
      if (getCommentAnchorSupport(anchor) !== 'supported') {
        throw new CollabCommentControllerError(
          'ANCHOR_NOT_FOUND',
          'The comment anchor is malformed or exceeds its encoded size limit.'
        );
      }

      const duplicate = findMutation(repository, clientMutationId);
      if (duplicate) {
        const duplicateActor = normalizeCommentActor(
          duplicate.comment.actor,
          duplicate.comment.author
        );
        if (
          duplicate.comment.content !== content ||
          !sameActor(duplicateActor, currentActor) ||
          !sameAnchor(duplicate.thread.anchor, extensionInput.anchor)
        ) {
          throw new CollabCommentControllerError(
            'MUTATION_CONFLICT',
            'clientMutationId was already used for a different comment mutation.'
          );
        }
        return {
          duplicate: true,
          thread: asSdkThread(duplicate.thread),
          comment: asSdkComment(duplicate.comment),
        };
      }

      if (
        collabCommentAnchorAdapterRegistry.getState(
          host.documentUri,
          anchor
        ) !== 'attached'
      ) {
        throw new CollabCommentControllerError(
          'ANCHOR_NOT_FOUND',
          'The requested comment anchor is not attached in a mounted editor.'
        );
      }
      const adapterDescription = collabCommentAnchorAdapterRegistry.describe(
        host.documentUri,
        anchor
      );
      const described =
        typeof adapterDescription === 'string'
          ? normalizeVisibleCommentText(adapterDescription).trim()
          : '';
      const fallbackQuote =
        anchor.kind === 'text-quote'
          ? anchor.exact
          : anchor.labelSnapshot || `${anchor.entityType}: ${anchor.entityId}`;
      const quote = truncateCommentUtf8(
        described || fallbackQuote,
        COMMENT_BOUNDS.maxAnchorExactBytes
      );
      const comment = createComment(content, host.currentUser.name, {
        actor: currentActor,
        clientMutationId,
        timeStamp: host.now?.() ?? Date.now(),
      });
      const mutation = repository.addThread(
        createThread(quote, [comment], undefined, false, anchor)
      );
      const canonicalComment = canonicalCommentForMutation(
        mutation.value,
        clientMutationId
      );
      if (!mutation.duplicate) {
        notifyCommitted({
          actor: currentActor,
          comment: canonicalComment,
          mentionedUserIds,
          replyRecipientUserIds: [],
          thread: mutation.value,
        });
      }
      return {
        duplicate: mutation.duplicate,
        thread: asSdkThread(mutation.value),
        comment: asSdkComment(canonicalComment),
      };
    },

    async reply(extensionInput): Promise<ReplyToCommentResult> {
      const result = await controller.reply(
        {
          threadId: extensionInput.threadId,
          body: extensionInput.content,
          clientMutationId: extensionInput.clientMutationId,
          mentionedUserIds: extensionInput.mentionedUserIds,
          replyToCommentId: extensionInput.replyToCommentId,
        },
        currentActor
      );
      return {
        ...result,
        comment: {
          actor: result.comment.actor,
          author:
            result.comment.actor.kind === 'agent'
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

    async setResolved(threadId, resolved) {
      await requireMutationAccess();
      if (!findThread(repository, threadId)) {
        throw new CollabCommentControllerError(
          'THREAD_NOT_FOUND',
          'The requested comment thread no longer exists.'
        );
      }
      repository.setThreadResolved(threadId, resolved);
    },

    focusThread,

    ...(host.onOpenPanel
      ? {
          openPanel(panelInput?: {
            threadId?: string;
            anchor?: CommentAnchor;
          }) {
            if (destroyed) return;
            host.onOpenPanel?.(panelInput);
            // A thread target is focused by the panel that selects it, not
            // here: focusing in both places runs the extension's focus handler
            // twice for one request. An anchor with no thread has no selection
            // to hang off, so it stays this call's job.
            if (!panelInput?.threadId && panelInput?.anchor) {
              void collabCommentAnchorAdapterRegistry.focus(
                host.documentUri,
                runtimeAnchor(panelInput.anchor)
              );
            }
          },
        }
      : {}),

    registerAnchorAdapter(adapter: MountedCommentAnchorAdapter) {
      if (destroyed) return () => {};
      const unregister = collabCommentAnchorAdapterRegistry.register({
        documentUri: host.documentUri,
        instanceId: host.instanceId,
        adapter,
        isActive: host.isActive,
        isVisible: host.isVisible,
      });
      const dispose = (): void => {
        if (!adapterDisposers.delete(dispose)) return;
        unregister();
      };
      adapterDisposers.add(dispose);
      return dispose;
    },
  } as CollaborationCommentsService;

  // The panel reads threads through the same repository snapshot the agent
  // controller lists from, so the two cannot describe the same document
  // differently. Cached on snapshot identity because `useSyncExternalStore`
  // calls this during render: a fresh array every call is an infinite loop.
  let cachedThreads: readonly ThreadSnapshot[] = EMPTY_THREADS_SNAPSHOT;
  let cachedFrom: CommentRepositorySnapshot | null = null;
  let cachedEpoch = -1;
  const readThreads = (): readonly ThreadSnapshot[] => {
    if (destroyed || !capabilities.read) return EMPTY_THREADS_SNAPSHOT;
    const snapshot = repository.getSnapshot();
    if (cachedFrom !== snapshot || cachedEpoch !== capabilityEpoch) {
      cachedFrom = snapshot;
      cachedEpoch = capabilityEpoch;
      cachedThreads = Object.freeze(
        snapshot.filter(
          (entry): entry is ThreadSnapshot => entry.type === 'thread',
        ),
      );
    }
    return cachedThreads;
  };

  const panelSource: HostedCommentsPanelSource = {
    subscribe(listener) {
      if (destroyed) return () => {};
      listeners.add(listener);
      return () => listeners.delete(listener);
    },

    getThreads: () =>
      readThreads() as unknown as ReturnType<
        CollaborativeCommentsSource['getThreads']
      >,

    // Read every call, never memoized: access can be revoked behind an
    // unchanged source object, and the composer must go with it.
    getCapabilities: () => (destroyed ? NO_COMMENT_CAPABILITIES : capabilities),

    getAnchorState(thread): CommentAnchorState {
      // Matches the repository controller's `list`: without an anchor there is
      // nothing any adapter can point at, so the thread is honestly detached
      // rather than quietly presented as attached. The registry answers for
      // anchors it does not handle with `unsupported`, never a guess.
      if (!thread.anchor) return 'orphaned';
      return collabCommentAnchorAdapterRegistry.getState(
        host.documentUri,
        thread.anchor,
      );
    },

    describeAnchor(thread) {
      if (!thread.anchor) return undefined;
      return collabCommentAnchorAdapterRegistry.describe(
        host.documentUri,
        thread.anchor,
      );
    },

    focusThread,

    async deleteThread(threadId) {
      await requireMutationAccess();
      repository.deleteThread(threadId);
    },

    async deleteComment(threadId, commentId) {
      await requireMutationAccess();
      repository.deleteComment(threadId, commentId);
    },
  };

  void refreshCapabilities();

  return {
    controller,
    panelSource,
    service,
    refreshCapabilities,
    destroy() {
      if (destroyed) return;
      destroyed = true;
      capabilities = NO_COMMENT_CAPABILITIES;
      for (const dispose of [...adapterDisposers]) dispose();
      unsubscribeAdapters();
      unsubscribeRepository();
      unregisterController();
      listeners.clear();
      releaseRepository(yDoc, lease);
    },
  };
}
