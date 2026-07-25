import { $isMarkNode, $wrapSelectionInMarkNode } from '@lexical/mark';
import {
  $createRangeSelection,
  $getRoot,
  $isElementNode,
  $isTextNode,
  $setSelection,
  type LexicalEditor,
  type TextNode,
} from 'lexical';

import {
  CommentStore,
  createComment,
  createThread,
  normalizeCommentActor,
  type AgentCommentActor,
  type Comment,
  type CommentActor,
  type Thread,
} from './index';
import type { CommentCapabilities, CommentMember } from './types';

const MAX_BODY_BYTES = 32 * 1024;
const MAX_EXACT_BYTES = 4 * 1024;
const MAX_CONTEXT_BYTES = 512;
const MAX_MENTIONS = 50;
const MAX_PAGE_SIZE = 100;

export type CommentControllerErrorCode =
  | 'DOCUMENT_NOT_MOUNTED'
  | 'DOCUMENT_NOT_HYDRATED'
  | 'READ_FORBIDDEN'
  | 'COMMENT_FORBIDDEN'
  | 'THREAD_NOT_FOUND'
  | 'COMMENT_NOT_FOUND'
  | 'THREAD_RESOLVED'
  | 'ANCHOR_NOT_FOUND'
  | 'ANCHOR_AMBIGUOUS'
  | 'MUTATION_CONFLICT'
  | 'BODY_TOO_LARGE'
  | 'MENTION_FORBIDDEN'
  | 'SYNC_TIMEOUT';

export class CollabCommentControllerError extends Error {
  readonly code: CommentControllerErrorCode;

  constructor(code: CommentControllerErrorCode, message: string) {
    super(message);
    this.name = 'CollabCommentControllerError';
    this.code = code;
  }
}

export type NormalizedComment = {
  actor: CommentActor;
  body: string;
  clientMutationId?: string;
  createdAt: number;
  deleted: boolean;
  id: string;
  replyToCommentId?: string;
};

export type NormalizedCommentThread = {
  anchorState: 'attached' | 'orphaned';
  comments: NormalizedComment[];
  id: string;
  quote: string;
  resolved: boolean;
};

export type CommentControllerListResult = {
  document: {
    title?: string;
    uri: string;
  };
  nextCursor?: string;
  threads: NormalizedCommentThread[];
};

export type CommentAnchorSelector = {
  exact: string;
  prefix?: string;
  suffix?: string;
};

export type ReplyToCommentInput = {
  body: string;
  clientMutationId: string;
  mentionedUserIds?: string[];
  replyToCommentId?: string;
  threadId: string;
};

export type ReplyToCommentResult = {
  comment: NormalizedComment;
  duplicate: boolean;
  threadId: string;
};

export type CreateAnchoredCommentInput = {
  anchor: CommentAnchorSelector;
  body: string;
  clientMutationId: string;
  mentionedUserIds?: string[];
};

export type CreateAnchoredCommentResult = {
  comment: NormalizedComment;
  duplicate: boolean;
  threadId: string;
};

export interface CollabCommentController {
  createAgentActor(input: {
    sessionId: string;
    sessionName: string;
  }): AgentCommentActor;
  createAnchored(
    input: CreateAnchoredCommentInput,
    actor: CommentActor,
  ): Promise<CreateAnchoredCommentResult>;
  getCapabilities(): CommentCapabilities;
  isHydrated(): boolean;
  isVisible(): boolean;
  list(input?: {
    cursor?: string;
    includeResolved?: boolean;
    limit?: number;
  }): CommentControllerListResult;
  reply(
    input: ReplyToCommentInput,
    actor: CommentActor,
  ): Promise<ReplyToCommentResult>;
}

type ControllerRegistration = {
  controller: CollabCommentController;
  instanceId: string;
  registeredAt: number;
};

class CollabCommentControllerRegistry {
  private readonly byDocument = new Map<string, Map<string, ControllerRegistration>>();

  register(
    documentUri: string,
    instanceId: string,
    controller: CollabCommentController,
  ): () => void {
    let registrations = this.byDocument.get(documentUri);
    if (!registrations) {
      registrations = new Map();
      this.byDocument.set(documentUri, registrations);
    }
    registrations.set(instanceId, {
      controller,
      instanceId,
      registeredAt: Date.now(),
    });
    return () => {
      const current = this.byDocument.get(documentUri);
      current?.delete(instanceId);
      if (current?.size === 0) {
        this.byDocument.delete(documentUri);
      }
    };
  }

  get(documentUri: string): CollabCommentController | undefined {
    const registrations = this.byDocument.get(documentUri);
    if (!registrations || registrations.size === 0) return undefined;
    const ordered = [...registrations.values()].sort(
      (left, right) => right.registeredAt - left.registeredAt,
    );
    return (
      ordered.find((registration) => {
        try {
          return registration.controller.isVisible();
        } catch {
          return false;
        }
      })?.controller ?? ordered[0]?.controller
    );
  }

  has(documentUri: string): boolean {
    return this.byDocument.has(documentUri);
  }

  clear(): void {
    this.byDocument.clear();
  }
}

export const collabCommentControllerRegistry =
  new CollabCommentControllerRegistry();

function byteLength(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

function truncateUtf8(value: string, maxBytes: number): string {
  const encoded = new TextEncoder().encode(value);
  if (encoded.byteLength <= maxBytes) return value;
  return new TextDecoder().decode(encoded.slice(0, maxBytes));
}

function normalizeVisibleText(value: string): string {
  return value.replace(/\r\n?/g, '\n').replace(/\u00a0/g, ' ');
}

function normalizeComment(comment: Comment): NormalizedComment {
  return {
    actor: normalizeCommentActor(comment.actor, comment.author),
    body: truncateUtf8(comment.content, MAX_BODY_BYTES),
    ...(comment.clientMutationId
      ? { clientMutationId: comment.clientMutationId }
      : {}),
    createdAt: comment.timeStamp,
    deleted: comment.deleted,
    id: comment.id,
    ...(comment.replyToCommentId
      ? { replyToCommentId: comment.replyToCommentId }
      : {}),
  };
}

function actorIdentity(actor: CommentActor): string {
  return actor.kind === 'agent'
    ? `agent:${actor.sessionId}:${actor.onBehalfOfUserId}`
    : `user:${actor.userId ?? ''}:${actor.displayName}`;
}

function getThreads(commentStore: CommentStore): Thread[] {
  return commentStore
    .getComments()
    .filter((comment): comment is Thread => comment.type === 'thread');
}

function findMutation(
  commentStore: CommentStore,
  clientMutationId: string,
): { comment: Comment; thread: Thread } | undefined {
  for (const thread of getThreads(commentStore)) {
    const comment = thread.comments.find(
      (candidate) => candidate.clientMutationId === clientMutationId,
    );
    if (comment) return { comment, thread };
  }
  return undefined;
}

function validateBody(body: string): string {
  const trimmed = body.trim();
  if (!trimmed) {
    throw new CollabCommentControllerError(
      'BODY_TOO_LARGE',
      'Comment body must not be empty.',
    );
  }
  if (byteLength(trimmed) > MAX_BODY_BYTES) {
    throw new CollabCommentControllerError(
      'BODY_TOO_LARGE',
      `Comment body exceeds ${MAX_BODY_BYTES} bytes.`,
    );
  }
  return trimmed;
}

function validateMutationId(clientMutationId: string): string {
  const value = clientMutationId.trim();
  if (!value || value.length > 200) {
    throw new CollabCommentControllerError(
      'MUTATION_CONFLICT',
      'clientMutationId must be between 1 and 200 characters.',
    );
  }
  return value;
}

function validateMentions(
  mentionedUserIds: string[] | undefined,
  members: CommentMember[],
): string[] {
  const requested = [...new Set(mentionedUserIds ?? [])];
  if (requested.length > MAX_MENTIONS) {
    throw new CollabCommentControllerError(
      'MENTION_FORBIDDEN',
      `A comment may mention at most ${MAX_MENTIONS} users.`,
    );
  }
  const allowed = new Set(members.map((member) => member.userId));
  if (requested.some((userId) => !allowed.has(userId))) {
    throw new CollabCommentControllerError(
      'MENTION_FORBIDDEN',
      'One or more mentioned users are not available in this organization.',
    );
  }
  return requested;
}

function collectMarkIds(editor: LexicalEditor | undefined): Set<string> {
  const ids = new Set<string>();
  if (!editor) return ids;
  editor.getEditorState().read(() => {
    for (const textNode of $getRoot().getAllTextNodes()) {
      let parent = textNode.getParent();
      while (parent) {
        if ($isMarkNode(parent)) {
          for (const id of parent.getIDs()) ids.add(id);
        }
        parent = parent.getParent();
      }
    }
  });
  return ids;
}

type TextSegment = {
  end: number;
  node: TextNode;
  start: number;
};

function buildTextSegments(): { text: string; segments: TextSegment[] } {
  const root = $getRoot();
  const topLevelChildren = root.getChildren();
  const segments: TextSegment[] = [];
  let text = '';

  topLevelChildren.forEach((child, childIndex) => {
    const textNodes = $isTextNode(child)
      ? [child]
      : $isElementNode(child)
        ? child.getAllTextNodes()
        : [];
    for (const textNode of textNodes) {
      const content = normalizeVisibleText(textNode.getTextContent());
      const start = text.length;
      text += content;
      segments.push({ start, end: text.length, node: textNode });
    }
    if (childIndex < topLevelChildren.length - 1) {
      text += '\n';
    }
  });

  return { text, segments };
}

function resolvePoint(
  segments: TextSegment[],
  offset: number,
  isEnd: boolean,
): { key: string; offset: number } | null {
  for (const segment of segments) {
    const contains = isEnd
      ? offset > segment.start && offset <= segment.end
      : offset >= segment.start && offset < segment.end;
    if (contains) {
      return {
        key: segment.node.getKey(),
        offset: offset - segment.start,
      };
    }
  }
  return null;
}

function resolveAnchor(
  selector: CommentAnchorSelector,
): {
  end: { key: string; offset: number };
  quote: string;
  start: { key: string; offset: number };
} {
  const exact = normalizeVisibleText(selector.exact);
  const prefix = normalizeVisibleText(selector.prefix ?? '');
  const suffix = normalizeVisibleText(selector.suffix ?? '');

  if (!exact || byteLength(exact) > MAX_EXACT_BYTES) {
    throw new CollabCommentControllerError(
      'ANCHOR_NOT_FOUND',
      `Anchor exact text must be between 1 and ${MAX_EXACT_BYTES} bytes.`,
    );
  }
  if (
    byteLength(prefix) > MAX_CONTEXT_BYTES ||
    byteLength(suffix) > MAX_CONTEXT_BYTES
  ) {
    throw new CollabCommentControllerError(
      'ANCHOR_NOT_FOUND',
      `Anchor prefix and suffix must not exceed ${MAX_CONTEXT_BYTES} bytes each.`,
    );
  }

  const { text, segments } = buildTextSegments();
  const matches: number[] = [];
  let searchFrom = 0;
  while (searchFrom <= text.length - exact.length) {
    const index = text.indexOf(exact, searchFrom);
    if (index === -1) break;
    const prefixMatches =
      !prefix || text.slice(Math.max(0, index - prefix.length), index) === prefix;
    const endOffset = index + exact.length;
    const suffixMatches =
      !suffix || text.slice(endOffset, endOffset + suffix.length) === suffix;
    if (prefixMatches && suffixMatches) matches.push(index);
    searchFrom = index + Math.max(1, exact.length);
  }

  if (matches.length === 0) {
    throw new CollabCommentControllerError(
      'ANCHOR_NOT_FOUND',
      'The requested anchor text is no longer present.',
    );
  }
  if (matches.length > 1) {
    throw new CollabCommentControllerError(
      'ANCHOR_AMBIGUOUS',
      `The requested anchor matches ${matches.length} locations.`,
    );
  }

  const startOffset = matches[0];
  const endOffset = startOffset + exact.length;
  const start = resolvePoint(segments, startOffset, false);
  const end = resolvePoint(segments, endOffset, true);
  if (!start || !end) {
    throw new CollabCommentControllerError(
      'ANCHOR_NOT_FOUND',
      'The requested anchor could not be mapped to editable document text.',
    );
  }
  return { start, end, quote: exact };
}

function ensureReadable(capabilities: CommentCapabilities): void {
  if (!capabilities.read) {
    throw new CollabCommentControllerError(
      'READ_FORBIDDEN',
      'You do not have permission to read document comments.',
    );
  }
}

function ensureWritable(
  capabilities: CommentCapabilities,
  hydrated: boolean,
): void {
  if (!hydrated) {
    throw new CollabCommentControllerError(
      'DOCUMENT_NOT_HYDRATED',
      'The collaborative document has not finished hydrating.',
    );
  }
  if (!capabilities.comment) {
    throw new CollabCommentControllerError(
      'COMMENT_FORBIDDEN',
      'You do not have permission to comment on this document.',
    );
  }
}

export function createCollabCommentController(options: {
  commentStore: CommentStore;
  documentTitle?: string;
  documentUri: string;
  editor?: LexicalEditor;
  currentUser: { id: string; name: string };
  getCapabilities: () => CommentCapabilities;
  getMembers: () => CommentMember[];
  isHydrated: () => boolean;
  isVisible: () => boolean;
  onCommitted?: (event: {
    actor: CommentActor;
    comment: Comment;
    mentionedUserIds: string[];
    replyRecipientUserIds: string[];
    thread: Thread;
  }) => void;
}): CollabCommentController {
  const {
    commentStore,
    documentTitle,
    documentUri,
    editor,
    currentUser,
    getCapabilities,
    getMembers,
    isHydrated,
    isVisible,
    onCommitted,
  } = options;

  const createDuplicateResult = (
    existing: { comment: Comment; thread: Thread },
    expected: {
      actor: CommentActor;
      body: string;
      quote?: string;
      replyToCommentId?: string;
      threadId?: string;
    },
  ): ReplyToCommentResult | CreateAnchoredCommentResult => {
    const existingActor = normalizeCommentActor(
      existing.comment.actor,
      existing.comment.author,
    );
    if (
      actorIdentity(existingActor) !== actorIdentity(expected.actor) ||
      existing.comment.content !== expected.body ||
      existing.comment.replyToCommentId !== expected.replyToCommentId ||
      (expected.threadId && existing.thread.id !== expected.threadId) ||
      (expected.quote !== undefined && existing.thread.quote !== expected.quote)
    ) {
      throw new CollabCommentControllerError(
        'MUTATION_CONFLICT',
        'clientMutationId was already used for a different comment mutation.',
      );
    }
    return {
      threadId: existing.thread.id,
      comment: normalizeComment(existing.comment),
      duplicate: true,
    };
  };

  return {
    isVisible,
    isHydrated,
    getCapabilities,
    createAgentActor({ sessionId, sessionName }) {
      return {
        kind: 'agent',
        sessionId,
        sessionName,
        onBehalfOfUserId: currentUser.id,
        onBehalfOfDisplayName: currentUser.name,
      };
    },

    list(input = {}) {
      const capabilities = getCapabilities();
      ensureReadable(capabilities);
      const includeResolved = input.includeResolved ?? true;
      const limit = Math.max(
        1,
        Math.min(MAX_PAGE_SIZE, Math.floor(input.limit ?? MAX_PAGE_SIZE)),
      );
      const cursor = Math.max(0, Number.parseInt(input.cursor ?? '0', 10) || 0);
      const markIds = collectMarkIds(editor);
      const eligible = getThreads(commentStore).filter(
        (thread) => includeResolved || !thread.resolved,
      );
      const page = eligible.slice(cursor, cursor + limit);
      const nextOffset = cursor + page.length;
      return {
        document: {
          uri: documentUri,
          ...(documentTitle ? { title: documentTitle } : {}),
        },
        threads: page.map((thread) => ({
          id: thread.id,
          quote: truncateUtf8(thread.quote, MAX_EXACT_BYTES),
          resolved: thread.resolved,
          anchorState: markIds.has(thread.id) ? 'attached' : 'orphaned',
          comments: thread.comments.map(normalizeComment),
        })),
        ...(nextOffset < eligible.length
          ? { nextCursor: String(nextOffset) }
          : {}),
      };
    },

    async reply(input, actor) {
      ensureWritable(getCapabilities(), isHydrated());
      const body = validateBody(input.body);
      const clientMutationId = validateMutationId(input.clientMutationId);
      const mentionedUserIds = validateMentions(
        input.mentionedUserIds,
        getMembers(),
      );
      const duplicate = findMutation(commentStore, clientMutationId);
      if (duplicate) {
        return createDuplicateResult(duplicate, {
          actor,
          body,
          replyToCommentId: input.replyToCommentId,
          threadId: input.threadId,
        }) as ReplyToCommentResult;
      }

      const thread = getThreads(commentStore).find(
        (candidate) => candidate.id === input.threadId,
      );
      if (!thread) {
        throw new CollabCommentControllerError(
          'THREAD_NOT_FOUND',
          'The requested comment thread no longer exists.',
        );
      }
      if (thread.resolved) {
        throw new CollabCommentControllerError(
          'THREAD_RESOLVED',
          'The requested comment thread is resolved.',
        );
      }

      let replyTarget: Comment | undefined;
      if (input.replyToCommentId) {
        replyTarget = thread.comments.find(
          (comment) => comment.id === input.replyToCommentId,
        );
        if (!replyTarget) {
          throw new CollabCommentControllerError(
            'COMMENT_NOT_FOUND',
            'The requested reply target is not in this thread.',
          );
        }
      }

      const comment = createComment(body, actor.kind === 'agent'
        ? actor.sessionName
        : actor.displayName, {
        actor,
        clientMutationId,
        replyToCommentId: input.replyToCommentId,
      });
      commentStore.addComment(comment, thread);

      const replyRecipientUserIds =
        replyTarget?.actor?.kind === 'user' && replyTarget.actor.userId
          ? [replyTarget.actor.userId]
          : [];
      onCommitted?.({
        actor,
        comment,
        mentionedUserIds,
        replyRecipientUserIds,
        thread,
      });
      return {
        threadId: thread.id,
        comment: normalizeComment(comment),
        duplicate: false,
      };
    },

    async createAnchored(input, actor) {
      ensureWritable(getCapabilities(), isHydrated());
      if (!editor) {
        throw new CollabCommentControllerError(
          'DOCUMENT_NOT_MOUNTED',
          'Creating an anchored comment requires a mounted collaborative editor.',
        );
      }
      const body = validateBody(input.body);
      const clientMutationId = validateMutationId(input.clientMutationId);
      const mentionedUserIds = validateMentions(
        input.mentionedUserIds,
        getMembers(),
      );
      const duplicate = findMutation(commentStore, clientMutationId);
      if (duplicate) {
        return createDuplicateResult(duplicate, {
          actor,
          body,
          quote: normalizeVisibleText(input.anchor.exact),
        }) as CreateAnchoredCommentResult;
      }

      // Resolve and validate the anchor in a read context first. editor.update
      // routes closure throws through the editor's onError, which may swallow
      // them and flatten ANCHOR_AMBIGUOUS / ANCHOR_NOT_FOUND into the generic
      // post-check below. A read() lets the specific error code propagate, and
      // there is no await before the mutation so offsets cannot shift.
      const resolved = editor
        .getEditorState()
        .read(() => resolveAnchor(input.anchor));

      let created:
        | { comment: Comment; thread: Thread }
        | undefined;
      editor.update(
        () => {
          const comment = createComment(body, actor.kind === 'agent'
            ? actor.sessionName
            : actor.displayName, {
            actor,
            clientMutationId,
          });
          const thread = createThread(resolved.quote, [comment]);
          const selection = $createRangeSelection();
          selection.anchor.set(
            resolved.start.key,
            resolved.start.offset,
            'text',
          );
          selection.focus.set(resolved.end.key, resolved.end.offset, 'text');
          $setSelection(selection);
          $wrapSelectionInMarkNode(selection, false, thread.id);
          commentStore.addComment(thread);
          created = { comment, thread };
        },
        { discrete: true },
      );

      if (!created) {
        throw new CollabCommentControllerError(
          'ANCHOR_NOT_FOUND',
          'The requested anchor could not be created.',
        );
      }
      if (!collectMarkIds(editor).has(created.thread.id)) {
        commentStore.deleteCommentOrThread(created.thread);
        throw new CollabCommentControllerError(
          'ANCHOR_NOT_FOUND',
          'The requested anchor could not be attached to the document.',
        );
      }
      onCommitted?.({
        actor,
        comment: created.comment,
        mentionedUserIds,
        replyRecipientUserIds: [],
        thread: created.thread,
      });
      return {
        threadId: created.thread.id,
        comment: normalizeComment(created.comment),
        duplicate: false,
      };
    },
  };
}
