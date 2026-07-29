import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { MaterialSymbol } from '@nimbalyst/runtime';

import { ActivityRow, shouldGroupWithPrevious, suppressDuplicateActivity } from './ActivityRow';
import { CommentComposer, type ComposerSubmission } from './CommentComposer';
import { CommentRow } from './CommentRow';
import { buildCommentView } from './commentViewModel';
import { segmentsToPlainText } from './commentBodyParser';
import { EMPTY_POOL, type DraftPool } from './composerDraft';
import { useResourcePreviews } from './useResourcePreviews';
import { mentionUrn, agentMentionUrn, resourceRefToUrn } from './resourceUrn';
import type {
  ActivityView,
  Actor,
  Comment,
  CommentActionKind,
  CommentAdapter,
  CommentCapabilities,
  CreateCommentInput,
  CommentRef,
  CommentView,
  ConversationContext,
  MentionDirectory,
  ResourceCandidate,
  ResourcePillView,
  ResourcePreviewResolver,
  ResourceRef,
  TimelineEntry,
} from './commentTypes';

/** Stable identity, so an absent `activity` prop does not churn the timeline memo. */
const NO_ACTIVITY: ActivityView[] = [];

type PendingSend = {
  tempId: string;
  input: CreateCommentInput;
};

/**
 * The surface that binds a `CommentAdapter` to the shared renderer and
 * composer. Rooms, DMs, document discussions, tracker comments, and inline
 * document comments all mount this; only the adapter differs.
 *
 * It owns exactly three things the pieces below cannot own themselves:
 * subscription lifecycle, batched preview resolution across the whole visible
 * page, and the reply/edit interaction state that spans a row and the composer.
 */
export function CommentThread({
  adapter,
  capabilities,
  context,
  directory,
  orgId,
  viewerUserId,
  viewerActor,
  resolver = null,
  resourceCandidates = [],
  activity = NO_ACTIVITY,
  now,
  onCopyLink,
  onOpenResource,
  onOpenSession,
  onOpenMention,
  emptyLabel = 'No messages yet.',
}: {
  adapter: CommentAdapter;
  /** Surface-level capabilities, used for the composer. Rows use their own. */
  capabilities: CommentCapabilities;
  context: ConversationContext;
  directory: MentionDirectory;
  orgId: string;
  viewerUserId: string;
  viewerActor: Actor;
  resolver?: ResourcePreviewResolver | null;
  resourceCandidates?: ResourceCandidate[];
  activity?: ActivityView[];
  now?: number;
  /** Defaults to the system clipboard. Overridden in tests. */
  onCopyLink?: (urn: string) => void;
  onOpenResource?: (pill: ResourcePillView) => void;
  onOpenSession?: (sessionId: string) => void;
  onOpenMention?: (userId: string) => void;
  emptyLabel?: string;
}) {
  const [comments, setComments] = useState<Comment[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadFailed, setLoadFailed] = useState(false);
  const [loadingEarlier, setLoadingEarlier] = useState(false);
  const [nextCursor, setNextCursor] = useState<string | undefined>();
  const [replyTo, setReplyTo] = useState<CommentRef | null>(null);
  const [editing, setEditing] = useState<CommentRef | null>(null);
  const [failedKeys, setFailedKeys] = useState<Set<string>>(new Set());
  const [pendingKeys, setPendingKeys] = useState<Set<string>>(new Set());
  const [pendingSends, setPendingSends] =
    useState<Map<string, PendingSend>>(new Map());

  // Reactions are absent, not disabled, when the adapter does not implement
  // them -- tracker comments and inline document comments in V1.
  const reactionsSupported = typeof adapter.react === 'function';

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setLoadFailed(false);
    void adapter.list().then((page) => {
      if (cancelled) return;
      setComments((current) => mergeComments(current, page.comments));
      setNextCursor(page.nextCursor);
      setLoading(false);
    }).catch(() => {
      if (cancelled) return;
      setLoadFailed(true);
      setLoading(false);
    });
    const unsubscribe = adapter.subscribe((change) => {
      setComments((current) => {
        if (change.type === 'removed') {
          return current.filter((comment) => comment.ref.commentId !== change.ref.commentId);
        }
        return mergeComments(current, [change.comment]);
      });
    });
    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, [adapter]);

  const allRefs = useMemo<ResourceRef[]>(() => {
    const seen = new Set<string>();
    const refs: ResourceRef[] = [];
    for (const comment of comments) {
      for (const ref of comment.resourceRefs ?? []) {
        const urn = resourceRefToUrn(ref);
        if (seen.has(urn)) continue;
        seen.add(urn);
        refs.push(ref);
      }
    }
    return refs;
  }, [comments]);

  const previews = useResourcePreviews(allRefs, resolver);
  const clock = now ?? Date.now();

  const byId = useMemo(() => new Map(comments.map((comment) => [comment.ref.commentId, comment])), [comments]);

  const views = useMemo<CommentView[]>(
    () =>
      comments.map((comment) =>
        buildCommentView(comment, {
          viewerUserId,
          directory,
          previews,
          reactionsSupported,
          now: clock,
          replyParent: comment.replyToCommentId ? byId.get(comment.replyToCommentId) ?? null : undefined,
          pending: pendingKeys.has(comment.ref.commentId),
          pendingLabel: pendingKeys.has(comment.ref.commentId) ? 'Sending' : undefined,
          failed: failedKeys.has(comment.ref.commentId),
        }),
      ),
    [byId, clock, comments, directory, failedKeys, pendingKeys, previews, reactionsSupported, viewerUserId],
  );

  /**
   * Rule 1 of "Activity and Chat Composition": the comment row is a comment's
   * canonical record. An audit row correlated to a comment that is rendered
   * here is dropped, so one human utterance never appears twice. The rule has
   * to be applied by the surface -- the helper alone changes nothing.
   *
   * Ordering stays comments-then-activity rather than interleaved, because
   * `ActivityView` carries only formatted timestamps and there is nothing
   * numeric to sort a merged timeline by yet.
   */
  const visibleActivity = useMemo<ActivityView[]>(() => {
    if (activity.length === 0) return NO_ACTIVITY;
    const entries: TimelineEntry[] = [
      ...views.map((comment) => ({ kind: 'comment' as const, comment })),
      ...activity.map((entry) => ({ kind: 'activity' as const, activity: entry })),
    ];
    return suppressDuplicateActivity(entries).flatMap((entry) =>
      entry.kind === 'activity' ? [entry.activity] : [],
    );
  }, [activity, views]);

  const copyLink = useCallback(
    (urn: string) => {
      if (onCopyLink) {
        onCopyLink(urn);
        return;
      }
      void navigator?.clipboard?.writeText?.(urn);
    },
    [onCopyLink],
  );

  const handleAction = useCallback(
    (action: CommentActionKind, view: CommentView) => {
      switch (action) {
        case 'reply':
          setEditing(null);
          setReplyTo(view.ref);
          break;
        case 'edit':
          setReplyTo(null);
          setEditing(view.ref);
          break;
        case 'delete':
          void adapter.remove(view.ref);
          break;
        case 'copyLink':
          if (view.messageUrn) copyLink(view.messageUrn);
          break;
        default:
          break;
      }
    },
    [adapter, copyLink],
  );

  const handleToggleReaction = useCallback(
    (emoji: string, on: boolean, view: CommentView) => {
      void adapter.react?.(view.ref, emoji, on);
    },
    [adapter],
  );

  const attemptSend = useCallback(
    async (pending: PendingSend) => {
      setPendingKeys((current) => new Set(current).add(pending.tempId));
      setFailedKeys((current) => {
        const next = new Set(current);
        next.delete(pending.tempId);
        return next;
      });
      try {
        const created = await adapter.create(pending.input);
        setComments((current) => mergeComments(
          current.filter(
            (comment) => comment.ref.commentId !== pending.tempId,
          ),
          [created],
        ));
        setPendingKeys((current) => {
          const next = new Set(current);
          next.delete(pending.tempId);
          return next;
        });
        setPendingSends((current) => {
          const next = new Map(current);
          next.delete(pending.tempId);
          return next;
        });
      } catch {
        setPendingKeys((current) => {
          const next = new Set(current);
          next.delete(pending.tempId);
          return next;
        });
        setFailedKeys((current) => new Set(current).add(pending.tempId));
      }
    },
    [adapter],
  );

  const submit = useCallback(
    async (submission: ComposerSubmission) => {
      const clientMutationId = createClientMutationId();
      const tempId = `pending:${clientMutationId}`;
      const input: CreateCommentInput = {
        actor: viewerActor,
        body: submission.body,
        clientMutationId,
        replyToCommentId: replyTo?.commentId,
        resourceRefs: submission.resourceRefs,
        deliveryHints: {
          mentionedUserIds: submission.mentionedUserIds,
          mentionedAgentSessionIds: submission.mentionedAgentSessionIds,
          assignedUserIds: [],
        },
      };
      const pending: PendingSend = { tempId, input };
      const optimistic: Comment = {
        ref: {
          orgId,
          sourceKind: comments[0]?.ref.sourceKind ?? 'roomMessage',
          sourceId:
            comments[0]?.ref.sourceId
            ?? context.conversationId
            ?? 'conversation',
          commentId: tempId,
        },
        actor: viewerActor,
        body: submission.body,
        createdAt: Date.now(),
        replyToCommentId: replyTo?.commentId,
        resourceRefs: submission.resourceRefs,
        reactions: [],
        capabilities,
        deliveryHints: input.deliveryHints,
      };
      setComments((current) => mergeComments(current, [optimistic]));
      setPendingSends((current) => new Map(current).set(tempId, pending));
      setReplyTo(null);
      await attemptSend(pending);
    },
    [
      attemptSend,
      capabilities,
      comments,
      context.conversationId,
      orgId,
      replyTo,
      viewerActor,
    ],
  );

  const loadEarlier = useCallback(async () => {
    if (!nextCursor || loadingEarlier) return;
    setLoadingEarlier(true);
    try {
      const page = await adapter.list(nextCursor);
      setComments((current) => mergeComments(current, page.comments));
      setNextCursor(page.nextCursor);
      setLoadFailed(false);
    } catch {
      setLoadFailed(true);
    } finally {
      setLoadingEarlier(false);
    }
  }, [adapter, loadingEarlier, nextCursor]);

  const replyView = replyTo ? views.find((view) => view.ref.commentId === replyTo.commentId) : undefined;
  const editingComment = editing ? byId.get(editing.commentId) : undefined;

  return (
    <div className="comment-thread [container-type:inline-size] [container-name:comment-surface] flex h-full min-h-0 flex-col" data-testid="comment-thread">
      <div className="comment-thread-list min-h-0 flex-1 overflow-y-auto py-2" role="list" data-testid="comment-thread-list">
        {loading && (
          <p className="m-0 px-3 py-4 text-[13px] text-[var(--nim-text-faint)]" data-testid="comment-thread-loading">
            Loading conversation…
          </p>
        )}

        {!loading && loadFailed && (
          <p
            className="m-0 px-3 py-2 text-[12px] text-[var(--nim-error)]"
            data-testid="comment-thread-load-error"
          >
            Could not load conversation history.
          </p>
        )}

        {!loading && nextCursor && (
          <div className="comment-thread-pagination flex justify-center px-3 py-2">
            <button
              type="button"
              className="rounded-md border border-[var(--nim-border)] px-2.5 py-1 text-[12px] text-[var(--nim-text-muted)] hover:bg-[var(--nim-bg-hover)] disabled:opacity-60"
              data-testid="comment-thread-load-earlier"
              disabled={loadingEarlier}
              onClick={() => { void loadEarlier(); }}
            >
              {loadingEarlier ? 'Loading' : 'Load earlier messages'}
            </button>
          </div>
        )}

        {!loading && views.length === 0 && activity.length === 0 && (
          <p className="m-0 px-3 py-6 text-center text-[13px] text-[var(--nim-text-faint)]" data-testid="comment-thread-empty">
            {emptyLabel}
          </p>
        )}

        {views.map((view, index) =>
          editingComment && editingComment.ref.commentId === view.ref.commentId ? (
            <div key={view.key} className="comment-thread-edit px-3 py-1" data-testid="comment-thread-edit">
              <CommentComposer
                capabilities={capabilities}
                context={context}
                directory={directory}
                orgId={orgId}
                resolver={resolver}
                resourceCandidates={resourceCandidates}
                submitLabel="Save"
                autoFocus
                initialText={editingComment.body.text}
                initialPool={poolForComment(editingComment, directory)}
                onCancel={() => setEditing(null)}
                onSubmit={async (submission) => {
                  await adapter.edit(editingComment.ref, submission.body);
                  setEditing(null);
                }}
              />
            </div>
          ) : (
            <CommentRow
              key={view.key}
              view={view}
              grouped={shouldGroupWithPrevious(comments[index], comments[index - 1])}
              onAction={handleAction}
              onToggleReaction={handleToggleReaction}
              onOpenResource={onOpenResource}
              onOpenSession={onOpenSession}
              onOpenMention={onOpenMention}
              onRetry={(view) => {
                const pending = pendingSends.get(view.ref.commentId);
                if (pending) void attemptSend(pending);
              }}
            />
          ),
        )}

        {visibleActivity.map((entry) => (
          <ActivityRow key={entry.key} activity={entry} />
        ))}
      </div>

      {reactionsSupported === false && capabilities.react && (
        <p
          className="comment-thread-no-reactions m-0 flex items-center gap-1.5 px-3 pb-1 text-[11px] text-[var(--nim-text-faint)]"
          data-testid="comment-thread-no-reactions"
        >
          <MaterialSymbol icon="info" size={12} />
          Reactions are not available on this surface yet.
        </p>
      )}

      <CommentComposer
        capabilities={capabilities}
        context={context}
        directory={directory}
        orgId={orgId}
        resolver={resolver}
        resourceCandidates={resourceCandidates}
        replyingTo={
          replyView
            ? {
                commentId: replyView.ref.commentId,
                actorLabel: replyView.actor.displayName,
                snippet: segmentsToPlainText(replyView.segments).slice(0, 120),
              }
            : null
        }
        onCancelReply={() => setReplyTo(null)}
        onSubmit={submit}
      />
    </div>
  );
}

/**
 * Seed the composer's pool when editing, so an existing mention or pill in the
 * body stays a mention or pill instead of decaying to plain text the moment the
 * author touches the message.
 */
function poolForComment(comment: Comment, directory: MentionDirectory): DraftPool {
  const pool: DraftPool = { refs: { ...EMPTY_POOL.refs }, people: {}, agents: {} };
  for (const ref of comment.resourceRefs ?? []) pool.refs[resourceRefToUrn(ref)] = ref;
  for (const userId of comment.deliveryHints?.mentionedUserIds ?? []) {
    const person = directory.people.find((entry) => entry.userId === userId);
    if (person) pool.people[mentionUrn(userId)] = person;
  }
  for (const sessionId of comment.deliveryHints?.mentionedAgentSessionIds ?? []) {
    const agent = directory.agents.find((entry) => entry.sessionId === sessionId);
    if (agent) pool.agents[agentMentionUrn(sessionId)] = agent;
  }
  return pool;
}

function mergeComments(
  current: readonly Comment[],
  incoming: readonly Comment[],
): Comment[] {
  const byId = new Map(
    current.map((comment) => [comment.ref.commentId, comment]),
  );
  for (const comment of incoming) byId.set(comment.ref.commentId, comment);
  return [...byId.values()].sort(
    (left, right) =>
      left.createdAt - right.createdAt
      || left.ref.commentId.localeCompare(right.ref.commentId),
  );
}

function createClientMutationId(): string {
  return globalThis.crypto?.randomUUID?.()
    ?? `local-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}
