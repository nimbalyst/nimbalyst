/**
 * One comment thread: its anchor line, its comments, and the affordances that
 * act on it.
 *
 * The card knows nothing about how the thread is attached to the document. It
 * is handed an anchor state and a label; whether that came from a Lexical
 * MarkNode, a mockup element id, or a graph node is the owning editor's
 * business. A thread whose anchor is gone renders exactly as loudly as one
 * that is attached — the history is the point, and it is never hidden or
 * deleted because the target disappeared.
 */
import type { JSX, Ref } from 'react';
import type { Comment, Thread } from '../types';
import type { CommentAnchorState, CommentMember, CommentThreadActions } from './types';
export interface CommentThreadCardProps extends CommentThreadActions {
    thread: Thread;
    /** Defaults to `attached`. */
    anchorState?: CommentAnchorState;
    /** Falls back to `thread.quote`. */
    anchorLabel?: string;
    isActive: boolean;
    /** False for a read-only viewer: reading stays, authoring disappears. */
    canComment: boolean;
    /**
     * Resolve, reopen and delete of the whole thread. Defaults to `canComment`;
     * a commenter gets it only on threads they started.
     */
    canManageThread?: boolean;
    /**
     * Delete of the whole thread. Defaults to `canManageThread`; a commenter
     * only when every comment in it is theirs.
     */
    canDeleteThread?: boolean;
    /** Per-comment delete. Defaults to `canComment`; a commenter's own only. */
    canDeleteComment?(comment: Comment): boolean;
    getMembers(): CommentMember[];
    /** Set by the panel's roving tabindex; defaults to focusable. */
    tabIndex?: number;
    cardRef?: Ref<HTMLDivElement>;
    /** Composer autofocus, for a thread the user just created. */
    autoFocusComposer?: boolean;
}
export declare function CommentThreadCard({ thread, anchorState, anchorLabel, isActive, canComment, canManageThread, canDeleteThread, canDeleteComment, getMembers, tabIndex, cardRef, autoFocusComposer, onSelectThread, onSetThreadResolved, onDeleteThread, onDeleteComment, onReply, onOpenAgentSession, }: CommentThreadCardProps): JSX.Element;
