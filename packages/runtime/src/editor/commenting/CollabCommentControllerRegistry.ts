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
  createComment,
  createThread,
  getCommentAnchorSupport,
  normalizeCommentActor,
  type CommentRepositorySnapshot,
  type ThreadSnapshot,
  type YDocCommentRepository,
} from './YDocCommentRepository';
import {
  findQuoteMatches,
  findThreadQuoteOffset,
  joinCommentTextBlocks,
} from './quoteMatch';
import type {
  AgentCommentActor,
  Comment,
  CommentAnchor,
  CommentActor,
  Comments,
  EntityCommentAnchor,
  Thread,
  CommentCapabilities,
  CommentMember,
  TextQuoteCommentAnchor,
} from './types';
import {
  assertCommentMutationAllowed,
  COMMENT_BOUNDS,
  CollabCommentControllerError,
  normalizeCommentPage,
  normalizeVisibleCommentText,
  truncateCommentUtf8,
  validateCommentBody,
  validateCommentMentions,
  validateCommentMutationId,
  validateTextQuoteSelector,
} from './commentValidation';

export { CollabCommentControllerError } from './commentValidation';
export type { CommentControllerErrorCode } from './commentValidation';

type CommentStoreLike = {
  getComments(): Comments;
  addComment(
    commentOrThread: Comment | Thread,
    thread?: Thread,
    offset?: number,
  ): void;
  deleteCommentOrThread(
    commentOrThread: Comment | Thread,
    thread?: Thread,
  ): { markedComment: Comment; index: number } | null;
};

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
  /**
   * The stored structured anchor, present whenever the thread has one. Every
   * controller projects this through `normalizeThread`, so a caller cannot tell
   * a mounted result from a headless one. `quote` and `anchorState` remain for
   * consumers that only need the human-readable target.
   */
  anchor?: CommentAnchor;
  anchorState: CommentAnchorState;
  comments: NormalizedComment[];
  id: string;
  quote: string;
  resolved: boolean;
};

export type CommentAnchorState = 'attached' | 'orphaned' | 'unsupported';

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

/** A text-quote anchor. `kind` may be omitted for the legacy selector shape. */
export type TextQuoteCommentAnchorInput = CommentAnchorSelector & {
  kind?: 'text-quote';
};

/**
 * An anchor kind this build does not implement. Callers pass it through
 * unchanged and get a typed failure rather than having it coerced into a text
 * selection, which is what keeps future kinds readable instead of guessed at.
 */
export type ForwardCommentAnchorInput = {
  kind: string;
  [key: string]: unknown;
};

export type CommentAnchorInput =
  | TextQuoteCommentAnchorInput
  | EntityCommentAnchor
  | ForwardCommentAnchorInput;

/**
 * The routed form of a `CommentAnchorInput`. Controllers switch on this instead
 * of reading `exact` off whatever they were handed, so an extension never has
 * to describe an entity as if it were a text selection.
 */
export type ClassifiedCommentAnchor =
  | { kind: 'text-quote'; selector: CommentAnchorSelector }
  | { kind: 'entity'; anchor: EntityCommentAnchor }
  | { kind: 'other' };

export function classifyCommentAnchorInput(
  value: unknown,
): ClassifiedCommentAnchor {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return { kind: 'other' };
  }
  const raw = value as Record<string, unknown>;
  if (
    (raw.kind === undefined || raw.kind === 'text-quote') &&
    typeof raw.exact === 'string'
  ) {
    return {
      kind: 'text-quote',
      selector: {
        exact: raw.exact,
        ...(typeof raw.prefix === 'string' ? { prefix: raw.prefix } : {}),
        ...(typeof raw.suffix === 'string' ? { suffix: raw.suffix } : {}),
      },
    };
  }
  if (raw.kind === 'entity') {
    // Only string-typed members are carried over. Anything missing or
    // mistyped drops out here and is rejected by getCommentAnchorSupport,
    // which owns the bounds.
    return {
      kind: 'entity',
      anchor: {
        kind: 'entity',
        ...(typeof raw.entityType === 'string'
          ? { entityType: raw.entityType }
          : {}),
        ...(typeof raw.entityId === 'string' ? { entityId: raw.entityId } : {}),
        ...(typeof raw.field === 'string' ? { field: raw.field } : {}),
        ...(typeof raw.labelSnapshot === 'string'
          ? { labelSnapshot: raw.labelSnapshot }
          : {}),
      } as EntityCommentAnchor,
    };
  }
  return { kind: 'other' };
}

export type ReplyToCommentInput = {
  body: string;
  clientMutationId: string;
  mentionedUserIds?: string[];
  replyToCommentId?: string;
  threadId: string;
};

export type ReplyToCommentResult = {
  anchor?: CommentAnchor;
  comment: NormalizedComment;
  duplicate: boolean;
  threadId: string;
};

export type CreateAnchoredCommentInput = {
  anchor: CommentAnchorInput;
  body: string;
  clientMutationId: string;
  mentionedUserIds?: string[];
};

export type CreateAnchoredCommentResult = {
  anchor?: CommentAnchor;
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
  private readonly byDocument = new Map<
    string,
    Map<string, ControllerRegistration>
  >();

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
    const registration: ControllerRegistration = {
      controller,
      instanceId,
      registeredAt: Date.now(),
    };
    registrations.set(instanceId, registration);
    return () => {
      const current = this.byDocument.get(documentUri);
      if (current?.get(instanceId) === registration) {
        current.delete(instanceId);
      }
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

export interface MountedCommentAnchorAdapterLike {
  handles(anchor: CommentAnchor): boolean;
  getState(anchor: CommentAnchor): 'attached' | 'orphaned';
  describe(anchor: CommentAnchor): string;
  focus(anchor: CommentAnchor): boolean | Promise<boolean>;
  /**
   * Optional operation-scoped read view. Headless extension codecs use this to
   * inspect one detached Y.Doc snapshot for an entire list/create operation.
   */
  createReadSnapshot?(): Pick<
    MountedCommentAnchorAdapterLike,
    'getState' | 'describe'
  >;
}

export interface CommentAnchorReadSession {
  getState(anchor: CommentAnchor): CommentAnchorState;
  describe(anchor: CommentAnchor): string | undefined;
}

type AnchorAdapterRegistration = {
  adapter: MountedCommentAnchorAdapterLike;
  instanceId: string;
  isActive: () => boolean;
  isVisible: () => boolean;
  order: number;
};

class CollabCommentAnchorAdapterRegistry {
  private readonly byDocument = new Map<
    string,
    Map<number, AnchorAdapterRegistration>
  >();
  private readonly listeners = new Map<string, Set<() => void>>();
  private nextRegistrationId = 1;
  private nextOrder = 1;

  register(input: {
    documentUri: string;
    instanceId: string;
    adapter: MountedCommentAnchorAdapterLike;
    isActive: () => boolean;
    isVisible: () => boolean;
  }): () => void {
    const registrationId = this.nextRegistrationId++;
    let registrations = this.byDocument.get(input.documentUri);
    if (!registrations) {
      registrations = new Map();
      this.byDocument.set(input.documentUri, registrations);
    }
    registrations.set(registrationId, {
      ...input,
      order: this.nextOrder++,
    });
    this.emit(input.documentUri);

    let registered = true;
    return () => {
      if (!registered) return;
      registered = false;
      const current = this.byDocument.get(input.documentUri);
      current?.delete(registrationId);
      if (current?.size === 0) this.byDocument.delete(input.documentUri);
      this.emit(input.documentUri);
    };
  }

  subscribe(documentUri: string, listener: () => void): () => void {
    let listeners = this.listeners.get(documentUri);
    if (!listeners) {
      listeners = new Set();
      this.listeners.set(documentUri, listeners);
    }
    listeners.add(listener);
    return () => {
      const current = this.listeners.get(documentUri);
      current?.delete(listener);
      if (current?.size === 0) this.listeners.delete(documentUri);
    };
  }

  createReadSession(documentUri: string): CommentAnchorReadSession {
    const readAdapters = new Map<
      AnchorAdapterRegistration,
      Pick<MountedCommentAnchorAdapterLike, 'getState' | 'describe'> | null
    >();
    const getReadAdapter = (
      registration: AnchorAdapterRegistration,
    ): Pick<
      MountedCommentAnchorAdapterLike,
      'getState' | 'describe'
    > | null => {
      if (readAdapters.has(registration)) {
        return readAdapters.get(registration) ?? null;
      }
      try {
        const adapter =
          registration.adapter.createReadSnapshot?.() ?? registration.adapter;
        readAdapters.set(registration, adapter);
        return adapter;
      } catch {
        readAdapters.set(registration, null);
        return null;
      }
    };

    return {
      getState: (anchor) => {
        const registration = this.resolve(documentUri, anchor);
        if (!registration) return 'unsupported';
        try {
          return getReadAdapter(registration)?.getState(anchor) ?? 'orphaned';
        } catch {
          return 'orphaned';
        }
      },
      describe: (anchor) => {
        const registration = this.resolve(documentUri, anchor);
        if (!registration) return undefined;
        try {
          return getReadAdapter(registration)?.describe(anchor);
        } catch {
          return undefined;
        }
      },
    };
  }

  getState(
    documentUri: string,
    anchor: CommentAnchor,
  ): 'attached' | 'orphaned' | 'unsupported' {
    return this.createReadSession(documentUri).getState(anchor);
  }

  describe(documentUri: string, anchor: CommentAnchor): string | undefined {
    return this.createReadSession(documentUri).describe(anchor);
  }

  async focus(documentUri: string, anchor: CommentAnchor): Promise<boolean> {
    const registration = this.resolve(documentUri, anchor);
    if (!registration) return false;
    try {
      if (registration.adapter.getState(anchor) !== 'attached') return false;
      return (await registration.adapter.focus(anchor)) === true;
    } catch {
      return false;
    }
  }

  hasInstance(documentUri: string, instanceId: string): boolean {
    return [...(this.byDocument.get(documentUri)?.values() ?? [])].some(
      (registration) => registration.instanceId === instanceId,
    );
  }

  clear(): void {
    const documentUris = [...this.byDocument.keys()];
    this.byDocument.clear();
    for (const documentUri of documentUris) this.emit(documentUri);
  }

  private resolve(
    documentUri: string,
    anchor: CommentAnchor,
  ): AnchorAdapterRegistration | undefined {
    const registrations = [
      ...(this.byDocument.get(documentUri)?.values() ?? []),
    ]
      .filter((registration) => {
        try {
          return registration.adapter.handles(anchor);
        } catch {
          return false;
        }
      })
      .sort((left, right) => {
        const activeDelta =
          Number(this.safeFlag(right.isActive)) -
          Number(this.safeFlag(left.isActive));
        if (activeDelta !== 0) return activeDelta;
        const visibleDelta =
          Number(this.safeFlag(right.isVisible)) -
          Number(this.safeFlag(left.isVisible));
        return visibleDelta !== 0 ? visibleDelta : right.order - left.order;
      });
    return registrations[0];
  }

  private safeFlag(read: () => boolean): boolean {
    try {
      return read();
    } catch {
      return false;
    }
  }

  private emit(documentUri: string): void {
    for (const listener of this.listeners.get(documentUri) ?? []) listener();
  }
}

export const collabCommentAnchorAdapterRegistry =
  new CollabCommentAnchorAdapterRegistry();

function normalizeComment(comment: Comment): NormalizedComment {
  return {
    actor: normalizeCommentActor(comment.actor, comment.author),
    body: truncateCommentUtf8(comment.content, COMMENT_BOUNDS.maxBodyBytes),
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

type ThreadLike = {
  anchor?: CommentAnchor;
  comments: ReadonlyArray<Comment>;
  id: string;
  quote: string;
  resolved: boolean;
};

/**
 * The single thread projection every `list` implementation returns.
 *
 * Mounted and headless results must be indistinguishable to an agent — a
 * caller asking "which element is comment 3 on?" cannot get structured anchor
 * data only when the tab happens to be closed. Only the anchor-state lookup
 * varies per controller; everything else is built here once.
 */
function normalizeThread(
  thread: ThreadLike,
  resolveAnchorState: (thread: ThreadLike) => CommentAnchorState,
): NormalizedCommentThread {
  return {
    id: thread.id,
    quote: truncateCommentUtf8(
      thread.quote,
      COMMENT_BOUNDS.maxAnchorExactBytes,
    ),
    resolved: thread.resolved,
    // An anchor kind this build cannot evaluate stays readable and reports
    // `unsupported` rather than being dropped or guessed at.
    anchorState:
      thread.anchor !== undefined &&
      getCommentAnchorSupport(thread.anchor) === 'unsupported'
        ? 'unsupported'
        : resolveAnchorState(thread),
    ...(thread.anchor === undefined ? {} : { anchor: thread.anchor }),
    comments: thread.comments.map(normalizeComment),
  };
}

function sameAnchor(
  left: CommentAnchor | undefined,
  right: CommentAnchor | undefined,
): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

/**
 * The human-readable quote stored alongside a structured anchor. A mounted
 * adapter's description wins when one is registered; otherwise the anchor's own
 * label carries it.
 */
export function deriveAnchorQuote(
  documentUri: string,
  anchor: CommentAnchor,
  readSession = collabCommentAnchorAdapterRegistry.createReadSession(
    documentUri,
  ),
): string {
  const described = normalizeVisibleCommentText(
    readSession.describe(anchor) ?? '',
  ).trim();
  const fallback =
    anchor.kind === 'text-quote'
      ? anchor.exact
      : anchor.labelSnapshot || `${anchor.entityType}: ${anchor.entityId}`;
  return truncateCommentUtf8(
    described || fallback,
    COMMENT_BOUNDS.maxAnchorExactBytes,
  );
}

function actorIdentity(actor: CommentActor): string {
  return actor.kind === 'agent'
    ? `agent:${actor.sessionId}:${actor.onBehalfOfUserId}`
    : `user:${actor.userId ?? ''}:${actor.displayName}`;
}

function getThreads(commentStore: CommentStoreLike): Thread[] {
  return commentStore
    .getComments()
    .filter((comment): comment is Thread => comment.type === 'thread');
}

function findMutation(
  commentStore: CommentStoreLike,
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

export function collectMarkIds(editor: LexicalEditor | undefined): Set<string> {
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

export type CommentTextSegment = {
  end: number;
  node: TextNode;
  start: number;
};
type TextSegment = CommentTextSegment;

/**
 * The document's visible text as quote anchors see it: top-level blocks joined
 * by a newline, each text node's span recorded so a match maps back to Lexical
 * points. Build it once per pass when resolving several anchors.
 */
export type CommentTextIndex = { text: string; segments: CommentTextSegment[] };

export type ResolvedCommentAnchor = {
  end: { key: string; offset: number };
  quote: string;
  start: { key: string; offset: number };
};

/**
 * The selector a thread is found by: its structured text-quote anchor, or its
 * legacy `quote` when it predates structured anchors. Null for anchor kinds a
 * Lexical document cannot evaluate.
 */
export function getThreadQuoteSelector(
  thread: Pick<Thread, 'anchor' | 'quote'>,
): TextQuoteCommentAnchor | null {
  if (thread.anchor) {
    return thread.anchor.kind === 'text-quote' ? thread.anchor : null;
  }
  return thread.quote ? { kind: 'text-quote', exact: thread.quote } : null;
}

/** Must run inside a Lexical read or update. */
export function $buildCommentTextIndex(): CommentTextIndex {
  return buildTextSegments();
}

function buildTextSegments(): { text: string; segments: TextSegment[] } {
  const root = $getRoot();
  const topLevelChildren = root.getChildren();
  const segments: TextSegment[] = [];

  const blocks: string[] = [];
  // Offset of the current block in the joined text: the blocks before it plus
  // one `\n` separator each, which is how `joinCommentTextBlocks` joins them.
  let blockStart = 0;

  for (const child of topLevelChildren) {
    const textNodes = $isTextNode(child)
      ? [child]
      : $isElementNode(child)
      ? child.getAllTextNodes()
      : [];
    let block = '';
    for (const textNode of textNodes) {
      // Normalized per node so segment offsets match the joined text;
      // normalizing again inside joinCommentTextBlocks is then a no-op.
      const content = normalizeVisibleCommentText(textNode.getTextContent());
      const start = blockStart + block.length;
      block += content;
      segments.push({ start, end: start + content.length, node: textNode });
    }
    blocks.push(block);
    blockStart += block.length + 1;
  }

  return { text: joinCommentTextBlocks(blocks), segments };
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

export function resolveAnchor(
  selector: CommentAnchorSelector,
): ResolvedCommentAnchor {
  return resolveAnchorInIndex(buildTextSegments(), selector);
}

/**
 * The exact-and-unique quote match every text-quote anchor uses: MarkNode
 * creation, orphan re-anchoring, and the decoration highlights of threads that
 * have no MarkNode. Throws ANCHOR_NOT_FOUND or ANCHOR_AMBIGUOUS.
 */
export function resolveAnchorInIndex(
  index: CommentTextIndex,
  selector: CommentAnchorSelector,
): ResolvedCommentAnchor {
  // Validated here as well so an invalid selector keeps throwing its specific
  // error; findQuoteMatches alone would answer "no match".
  const { exact } = validateTextQuoteSelector(selector);

  const { text, segments } = index;
  const matches = findQuoteMatches(text, selector);

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

  return mapMatch(segments, matches[0], exact);
}

function mapMatch(
  segments: TextSegment[],
  startOffset: number,
  exact: string,
): ResolvedCommentAnchor {
  const start = resolvePoint(segments, startOffset, false);
  const end = resolvePoint(segments, startOffset + exact.length, true);
  if (!start || !end) {
    throw new CollabCommentControllerError(
      'ANCHOR_NOT_FOUND',
      'The requested anchor could not be mapped to editable document text.',
    );
  }
  return { start, end, quote: exact };
}

/**
 * Where an existing thread's quote is now, by `findThreadQuoteOffset`: its
 * full selector, or, when the context no longer matches anywhere, its bare
 * quote if that occurs exactly once. Used by every reader of an existing
 * thread (re-anchoring, highlights, `list()`); creating a thread stays strict
 * (`resolveAnchorInIndex`). Throws ANCHOR_NOT_FOUND or ANCHOR_AMBIGUOUS.
 */
export function resolveThreadAnchorInIndex(
  index: CommentTextIndex,
  selector: CommentAnchorSelector,
): ResolvedCommentAnchor {
  const { exact } = validateTextQuoteSelector(selector);
  const offset = findThreadQuoteOffset(index.text, selector);
  if (offset === null) {
    const ambiguous =
      findQuoteMatches(index.text, selector).length > 1 ||
      findQuoteMatches(index.text, { exact: selector.exact }).length > 1;
    throw ambiguous
      ? new CollabCommentControllerError(
          'ANCHOR_AMBIGUOUS',
          'The anchor text occurs in more than one place.',
        )
      : new CollabCommentControllerError(
          'ANCHOR_NOT_FOUND',
          'The requested anchor text is no longer present.',
        );
  }
  return mapMatch(index.segments, offset, exact);
}

function ensureReadable(capabilities: CommentCapabilities): void {
  if (!capabilities.read) {
    throw new CollabCommentControllerError(
      'READ_FORBIDDEN',
      'You do not have permission to read document comments.',
    );
  }
}

export function createCollabCommentController(options: {
  commentStore: CommentStoreLike;
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
      ...(existing.thread.anchor === undefined
        ? {}
        : { anchor: existing.thread.anchor }),
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
      const { cursor, limit } = normalizeCommentPage(input);
      const markIds = collectMarkIds(editor);
      const eligible = getThreads(commentStore).filter(
        (thread) => includeResolved || !thread.resolved,
      );
      const page = eligible.slice(cursor, cursor + limit);
      // A thread with no MarkNode is still attached when its quote occurs
      // exactly once: that is where the editor draws its highlight.
      const quoteAttached = new Set<string>();
      if (editor) {
        editor.getEditorState().read(() => {
          let index: CommentTextIndex | null = null;
          for (const thread of page) {
            if (markIds.has(thread.id)) continue;
            const selector = getThreadQuoteSelector(thread);
            if (!selector) continue;
            index ??= buildTextSegments();
            try {
              resolveThreadAnchorInIndex(index, selector);
              quoteAttached.add(thread.id);
            } catch {
              // Not found or ambiguous: orphaned.
            }
          }
        });
      }
      const nextOffset = cursor + page.length;
      return {
        document: {
          uri: documentUri,
          ...(documentTitle ? { title: documentTitle } : {}),
        },
        threads: page.map((thread) =>
          normalizeThread(thread, (candidate) =>
            // A Lexical text controller cannot evaluate a non-text anchor.
            candidate.anchor !== undefined &&
            candidate.anchor.kind !== 'text-quote'
              ? 'unsupported'
              : markIds.has(candidate.id) || quoteAttached.has(candidate.id)
              ? 'attached'
              : 'orphaned',
          ),
        ),
        ...(nextOffset < eligible.length
          ? { nextCursor: String(nextOffset) }
          : {}),
      };
    },

    async reply(input, actor) {
      assertCommentMutationAllowed(getCapabilities(), isHydrated());
      const body = validateCommentBody(input.body);
      const clientMutationId = validateCommentMutationId(
        input.clientMutationId,
      );
      const mentionedUserIds = validateCommentMentions(
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

      const comment = createComment(
        body,
        actor.kind === 'agent' ? actor.sessionName : actor.displayName,
        {
          actor,
          clientMutationId,
          replyToCommentId: input.replyToCommentId,
        },
      );
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
        ...(thread.anchor === undefined ? {} : { anchor: thread.anchor }),
      };
    },

    async createAnchored(input, actor) {
      const capabilities = getCapabilities();
      assertCommentMutationAllowed(capabilities, isHydrated());
      // Commenter mode: a MarkNode is a write to `root`, which the server
      // refuses from this user, so the thread is stored with its text-quote
      // anchor only and the editor draws the highlight from the quote.
      const quoteOnly = capabilities.editBody === false;
      if (!editor) {
        throw new CollabCommentControllerError(
          'DOCUMENT_NOT_MOUNTED',
          'Creating an anchored comment requires a mounted collaborative editor.',
        );
      }
      const classified = classifyCommentAnchorInput(input.anchor);
      if (classified.kind !== 'text-quote') {
        throw new CollabCommentControllerError(
          'ANCHOR_NOT_FOUND',
          `A collaborative Markdown editor anchors comments to quoted text, not to a ${
            classified.kind === 'entity' ? 'document entity' : 'non-text anchor'
          }.`,
        );
      }
      const selector = classified.selector;
      const body = validateCommentBody(input.body);
      const clientMutationId = validateCommentMutationId(
        input.clientMutationId,
      );
      const mentionedUserIds = validateCommentMentions(
        input.mentionedUserIds,
        getMembers(),
      );
      const duplicate = findMutation(commentStore, clientMutationId);
      if (duplicate) {
        return createDuplicateResult(duplicate, {
          actor,
          body,
          quote: normalizeVisibleCommentText(selector.exact),
        }) as CreateAnchoredCommentResult;
      }

      // Resolve and validate the anchor in a read context first. editor.update
      // routes closure throws through the editor's onError, which may swallow
      // them and flatten ANCHOR_AMBIGUOUS / ANCHOR_NOT_FOUND into the generic
      // post-check below. A read() lets the specific error code propagate, and
      // there is no await before the mutation so offsets cannot shift.
      const resolved = editor
        .getEditorState()
        .read(() => resolveAnchor(selector));

      let created: { comment: Comment; thread: Thread } | undefined;
      const buildThread = () => {
        const comment = createComment(
          body,
          actor.kind === 'agent' ? actor.sessionName : actor.displayName,
          {
            actor,
            clientMutationId,
          },
        );
        const thread = createThread(
          resolved.quote,
          [comment],
          undefined,
          undefined,
          {
            kind: 'text-quote',
            exact: resolved.quote,
            ...(selector.prefix === undefined
              ? {}
              : { prefix: normalizeVisibleCommentText(selector.prefix) }),
            ...(selector.suffix === undefined
              ? {}
              : { suffix: normalizeVisibleCommentText(selector.suffix) }),
          },
        );
        return { comment, thread };
      };
      if (quoteOnly) {
        created = buildThread();
        commentStore.addComment(created.thread);
      } else {
        editor.update(
          () => {
            const next = buildThread();
            const selection = $createRangeSelection();
            selection.anchor.set(
              resolved.start.key,
              resolved.start.offset,
              'text',
            );
            selection.focus.set(resolved.end.key, resolved.end.offset, 'text');
            $setSelection(selection);
            $wrapSelectionInMarkNode(selection, false, next.thread.id);
            commentStore.addComment(next.thread);
            created = next;
          },
          { discrete: true },
        );
      }

      if (!created) {
        throw new CollabCommentControllerError(
          'ANCHOR_NOT_FOUND',
          'The requested anchor could not be created.',
        );
      }
      if (!quoteOnly && !collectMarkIds(editor).has(created.thread.id)) {
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
        ...(created.thread.anchor === undefined
          ? {}
          : { anchor: created.thread.anchor }),
      };
    },
  };
}

function getRepositoryThreads(
  snapshot: CommentRepositorySnapshot,
): ThreadSnapshot[] {
  return snapshot.filter(
    (candidate): candidate is ThreadSnapshot => candidate.type === 'thread',
  );
}

function findRepositoryMutation(
  snapshot: CommentRepositorySnapshot,
  clientMutationId: string,
): { comment: Readonly<Comment>; thread: ThreadSnapshot } | undefined {
  for (const thread of getRepositoryThreads(snapshot)) {
    const comment = thread.comments.find(
      (candidate) => candidate.clientMutationId === clientMutationId,
    );
    if (comment) return { comment, thread };
  }
  return undefined;
}

/**
 * Repository-backed controller for mounted extension documents.
 *
 * Unlike the Lexical compatibility controller above, this controller never
 * creates a second comment store or editor. It reads and mutates the same
 * Y.Doc repository used by the extension comments service, so a mounted tab
 * and a headless acquisition built on the same document return identical
 * results. Mounted user creation is performed by the host-owned SDK service
 * after adapter validation; agent creation goes through `createAnchored`.
 */
export function createRepositoryCollabCommentController(options: {
  repository: YDocCommentRepository;
  documentTitle?: string;
  documentUri: string;
  currentUser: { id: string; name: string };
  getCapabilities: () => CommentCapabilities;
  getMembers: () => CommentMember[];
  isHydrated: () => boolean;
  isVisible: () => boolean;
  beforeMutation?: () => void | Promise<void>;
  now?: () => number;
  onCommitted?: (event: {
    actor: CommentActor;
    comment: Readonly<Comment>;
    mentionedUserIds: string[];
    replyRecipientUserIds: string[];
    thread: ThreadSnapshot;
  }) => void;
}): CollabCommentController {
  const {
    repository,
    documentTitle,
    documentUri,
    currentUser,
    getCapabilities,
    getMembers,
    isHydrated,
    isVisible,
    beforeMutation,
    now = Date.now,
    onCommitted,
  } = options;

  return {
    createAgentActor({ sessionId, sessionName }) {
      return {
        kind: 'agent',
        sessionId,
        sessionName,
        onBehalfOfUserId: currentUser.id,
        onBehalfOfDisplayName: currentUser.name,
      };
    },
    getCapabilities,
    isHydrated,
    isVisible,

    list(input = {}) {
      ensureReadable(getCapabilities());
      const { cursor, limit } = normalizeCommentPage(input);
      const anchorReads =
        collabCommentAnchorAdapterRegistry.createReadSession(documentUri);
      const eligible = getRepositoryThreads(repository.getSnapshot()).filter(
        (thread) => (input.includeResolved ?? true) || !thread.resolved,
      );
      const page = eligible.slice(cursor, cursor + limit);
      const nextOffset = cursor + page.length;
      return {
        document: {
          uri: documentUri,
          ...(documentTitle ? { title: documentTitle } : {}),
        },
        threads: page.map((thread) =>
          normalizeThread(thread, (candidate) =>
            candidate.anchor
              ? anchorReads.getState(candidate.anchor)
              : 'orphaned',
          ),
        ),
        ...(nextOffset < eligible.length
          ? { nextCursor: String(nextOffset) }
          : {}),
      };
    },

    async reply(input, actor) {
      await beforeMutation?.();
      assertCommentMutationAllowed(getCapabilities(), isHydrated());
      const body = validateCommentBody(input.body);
      const clientMutationId = validateCommentMutationId(
        input.clientMutationId,
      );
      const mentionedUserIds = validateCommentMentions(
        input.mentionedUserIds,
        getMembers(),
      );
      const duplicate = findRepositoryMutation(
        repository.getSnapshot(),
        clientMutationId,
      );
      if (duplicate) {
        const existingActor = normalizeCommentActor(
          duplicate.comment.actor,
          duplicate.comment.author,
        );
        if (
          actorIdentity(existingActor) !== actorIdentity(actor) ||
          duplicate.comment.content !== body ||
          duplicate.comment.replyToCommentId !== input.replyToCommentId ||
          duplicate.thread.id !== input.threadId
        ) {
          throw new CollabCommentControllerError(
            'MUTATION_CONFLICT',
            'clientMutationId was already used for a different comment mutation.',
          );
        }
        return {
          threadId: duplicate.thread.id,
          comment: normalizeComment(duplicate.comment),
          duplicate: true,
          ...(duplicate.thread.anchor === undefined
            ? {}
            : { anchor: duplicate.thread.anchor }),
        };
      }

      const thread = getRepositoryThreads(repository.getSnapshot()).find(
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

      const replyTarget = input.replyToCommentId
        ? thread.comments.find(
            (comment) => comment.id === input.replyToCommentId,
          )
        : undefined;
      if (input.replyToCommentId && !replyTarget) {
        throw new CollabCommentControllerError(
          'COMMENT_NOT_FOUND',
          'The requested reply target is not in this thread.',
        );
      }

      const comment = createComment(
        body,
        actor.kind === 'agent' ? actor.sessionName : actor.displayName,
        {
          actor,
          clientMutationId,
          replyToCommentId: input.replyToCommentId,
          timeStamp: now(),
        },
      );
      const mutation = repository.appendReply(thread.id, comment);
      const canonicalThread = getRepositoryThreads(
        repository.getSnapshot(),
      ).find((candidate) => candidate.id === thread.id);
      if (!canonicalThread) {
        throw new CollabCommentControllerError(
          'THREAD_NOT_FOUND',
          'The requested comment thread no longer exists.',
        );
      }
      const replyRecipientUserIds =
        replyTarget?.actor?.kind === 'user' && replyTarget.actor.userId
          ? [replyTarget.actor.userId]
          : [];
      if (!mutation.duplicate) {
        onCommitted?.({
          actor,
          comment: mutation.value,
          mentionedUserIds,
          replyRecipientUserIds,
          thread: canonicalThread,
        });
      }
      return {
        threadId: canonicalThread.id,
        comment: normalizeComment(mutation.value),
        duplicate: mutation.duplicate,
        ...(canonicalThread.anchor === undefined
          ? {}
          : { anchor: canonicalThread.anchor }),
      };
    },

    /**
     * Entity-anchored creation. Validation and persistence both run against
     * this controller's own `repository` and `documentUri`: the adapter that
     * confirms the anchor is registered by the same host that owns this
     * repository, so one Y.Doc handle answers "does the target exist?" and
     * "where does the thread go?". Text-quote creation stays on the mounted
     * Lexical path, and any other kind fails closed.
     */
    async createAnchored(input, actor) {
      await beforeMutation?.();
      assertCommentMutationAllowed(getCapabilities(), isHydrated());
      const classified = classifyCommentAnchorInput(input.anchor);
      if (classified.kind !== 'entity') {
        throw new CollabCommentControllerError(
          'DOCUMENT_NOT_MOUNTED',
          classified.kind === 'text-quote'
            ? 'Text-quote comment creation requires a mounted collaborative Markdown editor.'
            : 'This document does not support that comment anchor kind.',
        );
      }
      if (actor.kind !== 'agent' || actor.onBehalfOfUserId !== currentUser.id) {
        throw new CollabCommentControllerError(
          'COMMENT_FORBIDDEN',
          'Agent comment identity must be derived by the collaborative host.',
        );
      }
      const anchor = classified.anchor;
      if (getCommentAnchorSupport(anchor) !== 'supported') {
        throw new CollabCommentControllerError(
          'ANCHOR_NOT_FOUND',
          'The entity anchor is malformed or exceeds its encoded size limit.',
        );
      }

      const body = validateCommentBody(input.body);
      const clientMutationId = validateCommentMutationId(
        input.clientMutationId,
      );
      const mentionedUserIds = validateCommentMentions(
        input.mentionedUserIds,
        getMembers(),
      );
      const duplicate = findRepositoryMutation(
        repository.getSnapshot(),
        clientMutationId,
      );
      if (duplicate) {
        const duplicateActor = normalizeCommentActor(
          duplicate.comment.actor,
          duplicate.comment.author,
        );
        if (
          actorIdentity(duplicateActor) !== actorIdentity(actor) ||
          duplicate.comment.content !== body ||
          !sameAnchor(duplicate.thread.anchor, anchor)
        ) {
          throw new CollabCommentControllerError(
            'MUTATION_CONFLICT',
            'clientMutationId was already used for a different comment mutation.',
          );
        }
        return {
          threadId: duplicate.thread.id,
          comment: normalizeComment(duplicate.comment),
          duplicate: true,
          ...(duplicate.thread.anchor === undefined
            ? {}
            : { anchor: duplicate.thread.anchor }),
        };
      }

      const anchorReads =
        collabCommentAnchorAdapterRegistry.createReadSession(documentUri);
      if (anchorReads.getState(anchor) !== 'attached') {
        throw new CollabCommentControllerError(
          'ANCHOR_NOT_FOUND',
          'No current mounted adapter or codec confirms that entity anchor.',
        );
      }
      const comment = createComment(body, actor.sessionName, {
        actor,
        clientMutationId,
        timeStamp: now(),
      });
      const mutation = repository.addThread(
        createThread(
          deriveAnchorQuote(documentUri, anchor, anchorReads),
          [comment],
          undefined,
          false,
          anchor,
        ),
      );
      const canonicalComment = mutation.value.comments.find(
        (candidate) => candidate.clientMutationId === clientMutationId,
      );
      if (!canonicalComment) {
        throw new CollabCommentControllerError(
          'MUTATION_CONFLICT',
          'The canonical comment mutation was not found after persistence.',
        );
      }
      if (!mutation.duplicate) {
        onCommitted?.({
          actor,
          comment: canonicalComment,
          mentionedUserIds,
          replyRecipientUserIds: [],
          thread: mutation.value,
        });
      }
      return {
        threadId: mutation.value.id,
        comment: normalizeComment(canonicalComment),
        duplicate: mutation.duplicate,
        ...(mutation.value.anchor === undefined
          ? {}
          : { anchor: mutation.value.anchor }),
      };
    },
  };
}
