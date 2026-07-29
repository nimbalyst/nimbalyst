import React from 'react';
import { MaterialSymbol } from '@nimbalyst/runtime';

import type { ActivityView, Comment, TimelineEntry } from './commentTypes';

/**
 * Compact source-owned domain change.
 *
 * Deliberately a different visual class from `CommentRow`: no avatar column, no
 * action menu, no reactions. A status change is not a thing anyone replies to,
 * and giving it the same weight as a message is what makes a combined timeline
 * unreadable.
 */
export function ActivityRow({ activity }: { activity: ActivityView }) {
  return (
    <div
      className="activity-row flex items-center gap-2 px-3 py-1 text-[12px] text-[var(--nim-text-faint)]"
      data-testid={`activity-row-${activity.key}`}
      role="listitem"
    >
      <span className="activity-row-icon flex w-7 shrink-0 justify-center">
        <MaterialSymbol icon={activity.icon} size={13} />
      </span>
      <span className="activity-row-actor shrink-0 font-medium text-[var(--nim-text-muted)]">
        {activity.actorLabel}
      </span>
      <span className="activity-row-summary min-w-0 truncate">{activity.summary}</span>
      <span className="activity-row-timestamp ml-auto shrink-0" title={activity.timestampTitle}>
        {activity.timestampLabel}
      </span>
    </div>
  );
}

/**
 * Rule 1 of "Activity and Chat Composition": a comment's canonical record is
 * the comment row. An audit activity row correlated to a comment that is
 * already rendered is suppressed, so the same human utterance never appears
 * twice in one timeline.
 *
 * Correlation is by `sourceCommentId`, never by timestamp or body similarity.
 */
export function suppressDuplicateActivity(
  entries: readonly TimelineEntry[],
): TimelineEntry[] {
  const renderedCommentIds = new Set(
    entries.flatMap((entry) => (entry.kind === 'comment' ? [entry.comment.ref.commentId] : [])),
  );
  return entries.filter(
    (entry) =>
      entry.kind === 'comment' ||
      entry.activity.correlatedCommentId === undefined ||
      !renderedCommentIds.has(entry.activity.correlatedCommentId),
  );
}

/**
 * Consecutive messages from the same actor collapse their header.
 *
 * Grouping breaks on a different actor, on a reply (which needs its own
 * context strip), and after a gap, because a message an hour later is a new
 * thought even from the same person.
 */
export function shouldGroupWithPrevious(comment: Comment, previous: Comment | undefined, gapMs = 5 * 60_000): boolean {
  if (!previous) return false;
  if (comment.replyToCommentId) return false;
  if (comment.deletedAt !== undefined || previous.deletedAt !== undefined) return false;
  if (comment.actor.kind !== previous.actor.kind) return false;
  if (comment.actor.kind === 'agent' && comment.actor.sessionId !== previous.actor.sessionId) return false;
  if (comment.actor.kind === 'user' && comment.actor.userId !== previous.actor.userId) return false;
  return comment.createdAt - previous.createdAt <= gapMs;
}
