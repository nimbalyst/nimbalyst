/**
 * The item's discussion thread (`system.comments` on the tracker row).
 *
 * Extracted from `TrackerItemDetail` so the item view and the document view's
 * right panel render the *same* thread -- two copies would drift, and this is
 * the collaboration surface a teammate expects to find in either place.
 *
 * Distinct from the inline comments anchored to document text: those ride the
 * body Y.Doc (see the tracker-document-mode plan, Layer 1). Same relationship a
 * pull request has between its conversation and its review comments.
 *
 * The thread does not know how a comment is written. Desktop posts over IPC and
 * the browser posts through the tracker data source's optimistic path; both hand
 * in a `mutate` that resolves once the write enters its host mutation path.
 * Immediate failures reject; later room refusals arrive through
 * `mutationRejection`, which retires the matching pending entry after the
 * engine has restored its projection.
 */
import React from 'react';
import type { TrackerIdentity } from '../../../runtime/src/core/DocumentService';
import type { TrackerCommentEntry } from '../../../runtime/src/sync/trackerProtocol';
import type { TrackerMutationRejection } from '../trackers/index';
export type TrackerCommentMutation = {
    kind: 'add';
    body: string;
} | {
    kind: 'update';
    commentId: string;
    body: string;
} | {
    kind: 'delete';
    commentId: string;
};
export interface TrackerCommentsSectionProps {
    comments?: TrackerCommentEntry[];
    /** Who "me" is; gates edit and delete to the comment's author (NIM-360). */
    identity: TrackerIdentity | null;
    /** Rejects to surface the failure and roll the optimistic entry back. */
    mutate: (mutation: TrackerCommentMutation) => Promise<unknown>;
    formatTimestamp: (createdAt: number) => string;
    /** Suppresses the composer and the per-comment actions. */
    readOnly?: boolean;
    /** Lets an asynchronous server refusal retire the matching optimistic row. */
    mutationRejection?: TrackerMutationRejection | null;
    collapsedComposer?: boolean;
    draft?: string;
    onDraftChange?: (text: string) => void;
}
export declare const TrackerCommentsSection: React.FC<TrackerCommentsSectionProps>;
