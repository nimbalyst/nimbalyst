/**
 * The shared collaborative comments panel.
 *
 * Editor-neutral: it is handed thread views and callbacks, and has no idea
 * whether the threads hang off Lexical marks, mockup elements, or graph nodes.
 * The owning editor decides where the panel lives (docked beside a document
 * pane, floating over a canvas) with `className`.
 *
 * Three things here are load-bearing rather than decorative:
 *
 * - **Detached threads keep a home.** Threads whose anchor is gone are grouped
 *   and explained, never filtered out. Losing the target must not lose the
 *   conversation.
 * - **Capabilities are read by the caller on every render.** A read-only
 *   viewer loses the composer and the destructive controls, and keeps every
 *   thread they could already see.
 * - **The list is a real keyboard surface.** Arrow keys move between threads
 *   with a roving tabindex, Escape closes, and focus is handed back to
 *   whatever opened the panel on unmount instead of falling to <body>.
 */
import type { JSX, ReactNode } from 'react';
import type { CommentCapabilities, CommentMember, CommentThreadActions, CommentThreadView } from './types';
interface ThreadGroup {
    key: 'open' | 'detached' | 'resolved';
    heading: string | null;
    views: CommentThreadView[];
}
/**
 * Open threads first, then detached ones, then resolved.
 *
 * Anchor state outranks resolution: a detached-and-resolved thread belongs
 * with the rest of the resolved history, because resolving it was a decision
 * someone made and the detachment is no longer actionable.
 */
export declare function groupCommentThreads(views: CommentThreadView[], showResolved: boolean): ThreadGroup[];
export interface CollaborativeCommentsPanelProps extends CommentThreadActions {
    threads: CommentThreadView[];
    activeThreadId: string | null;
    capabilities: CommentCapabilities;
    /**
     * The signed-in user's id, as written in `actor.userId`. A commenter
     * (`editBody: false`) is offered resolve and delete only on their own
     * threads and comments; without it they are offered neither.
     */
    currentUserId?: string;
    getMembers(): CommentMember[];
    title?: string;
    /** Shown when there are no threads at all. */
    emptyMessage?: string;
    /** Extra header content, e.g. an editor-specific filter. */
    headerExtra?: ReactNode;
    onClose?(): void;
    /** Uncontrolled default; resolved threads stay visible unless hidden. */
    defaultShowResolved?: boolean;
    showResolved?: boolean;
    onShowResolvedChange?(next: boolean): void;
    /** Composer autofocus target — the thread the user just created. */
    autoFocusThreadId?: string | null;
    className?: string;
    /** Restore focus to whatever was focused before the panel mounted. */
    restoreFocusOnUnmount?: boolean;
}
export declare function CollaborativeCommentsPanel({ threads, activeThreadId, capabilities, currentUserId, getMembers, title, emptyMessage, headerExtra, onClose, defaultShowResolved, showResolved: controlledShowResolved, onShowResolvedChange, autoFocusThreadId, className, restoreFocusOnUnmount, ...actions }: CollaborativeCommentsPanelProps): JSX.Element;
export {};
