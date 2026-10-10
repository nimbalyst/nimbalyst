/**
 * CollabHistoryDialog
 *
 * Shared-document revision history, for the desktop app and the web console.
 * Parallel to the desktop's local-file `HistoryDialog`, but driven by the REST
 * API exposed by the document's room and a host-supplied controller.
 *
 * Behavior:
 *   - List newest-first; one click selects, shows metadata, enables restore.
 *   - The selection is compared with the revision before it (default) or with
 *     the page as it is now, or shown in full -- see `collabHistoryCompare`.
 *   - Restore goes through `restoreCollabRevision`: a `restore-pre`
 *     checkpoint, the snapshot applied through the live editor, and a
 *     `restore-head` revision.
 *   - Restore is blocked while sync state is `offline-unsynced`, `replaying`,
 *     or `disconnected` -- the live document may not reflect peer changes yet.
 *
 * What differs per host is injected: how a revision's bytes become text
 * (`previewRevision`), how two texts render as a diff (`renderDiff`, which
 * carries the editor graph), and the editor theme.
 *
 * Out of scope: deletion, manual save-version button (host-driven).
 */
import React, { type ReactNode } from 'react';
import { type CollabHistoryController } from './collabHistoryController';
export interface CollabHistoryDiffNavigationState {
    currentIndex: number;
    totalGroups: number;
    canGoPrevious: boolean;
    canGoNext: boolean;
}
export interface CollabHistoryDiffProps {
    /** Changes whenever the compared pair changes; remount on it. */
    diffKey: string;
    oldText: string;
    newText: string;
    /** Markdown renders as a rich diff; everything else as a text diff. */
    isMarkdown: boolean;
    onNavigationStateChange: (state: CollabHistoryDiffNavigationState) => void;
}
export interface CollabHistoryDialogProps {
    /** Null until the document is open and connected. */
    controller: CollabHistoryController | null;
    onClose: () => void;
    /** A stored revision as text, or null when the format has no text projection. */
    previewRevision: (contentFormat: string, bytes: Uint8Array) => string | null;
    renderDiff: (props: CollabHistoryDiffProps) => ReactNode;
    formatRelativeTime?: (timestamp: number) => string;
}
export declare const CollabHistoryDialog: React.FC<CollabHistoryDialogProps>;
