/**
 * Read-and-edit view of one tracker item.
 *
 * Scoped hard. Desktop's `TrackerItemDetail` is 2,100 lines because the item is
 * also where a session gets launched, a worktree gets created, a pull request
 * gets opened, and a chat panel gets docked -- all desktop capabilities. What a
 * teammate needs in a browser tab is the item: its identity, its fields, its
 * body, and its thread.
 *
 * The body is a slot, not an editor. Item bodies already run through
 * `CollabLexicalProvider`, so the host mounts the `editor` bundle entry it
 * already ships (`CollabEditorMount`) and passes it in. A second editor
 * integration here would be a second cold-paint contract to get wrong: the
 * binding only paints Y.Doc events observed *after* it mounts (NIM-1764), and
 * that is a property of the mount, not of this panel.
 *
 * ## Two ordering rules, both load-bearing
 *
 * **Fields come before the body.** They used to come after it, so opening an
 * item showed the editor's "Opening this document..." placeholder exactly where
 * Status, Priority and Owner belong and pushed every field below the fold until
 * the room answered. The facts a reader opens an item for must not wait on a
 * socket. Desktop has always drawn them in this order.
 *
 * **`bodySlot` stays at one static JSX position.** Every child of the scroll
 * column below is written literally, so React reconciles the slot by a position
 * that cannot move between renders. A layout that chose its wrapper at runtime
 * -- a rail above some width, a stack below it -- would remount the binding on
 * a resize and leave the reader a silently blank editor. Width-dependent layout
 * is therefore CSS (`trackerItemDetail.css`), never a branch.
 */
import React from 'react';
import type { TrackerIdentity } from '../../../../runtime/src/core/DocumentService';
import type { TrackerRecord } from '../../../../runtime/src/core/TrackerRecord';
import type { TrackerMutationRejection } from '../../trackers/index';
import { type TeamMemberOption } from '../../../../runtime/src/plugins/TrackerPlugin/components/TrackerFieldEditor';
import { type TrackerCommentMutation } from '../TrackerCommentsSection';
import { type TrackerItemAction } from './TrackerItemActionsMenu';
import './trackerItemDetail.css';
export interface TrackerItemDetailPanelProps {
    item: TrackerRecord;
    identity: TrackerIdentity | null;
    /** Absent for a read-only permission state; the fields render, disabled. */
    onFieldChange?: (fieldName: string, value: unknown) => void | Promise<unknown>;
    commentMutate: (mutation: TrackerCommentMutation) => Promise<unknown>;
    formatTimestamp: (createdAt: number) => string;
    teamMembers?: TeamMemberOption[];
    /** The item body, mounted by the host through the shared editor entry. */
    bodySlot?: React.ReactNode;
    /**
     * Connectivity and presence for the body, drawn on the header row.
     *
     * A slot rather than a rendered status, because the two hosts report from
     * different places -- the browser publishes it up from the mounted editor
     * through a context channel, the desktop reads its own document state. What
     * matters here is only that it shares the header row instead of spending a
     * full strip of its own on one handoff link.
     */
    headerStatus?: React.ReactNode;
    /** Copied by the header's link button; omit to hide it. */
    copyLinkHref?: string;
    /** Extra header actions, behind the overflow menu. */
    overflowActions?: readonly TrackerItemAction[];
    onClose?: () => void;
    mutationRejection?: TrackerMutationRejection | null;
    /** Phone presentation keeps the same body slot and document binding. */
    compact?: boolean;
    editing?: boolean;
    onEditingChange?: (editing: boolean) => void;
    backLabel?: string;
    commentDraft?: string;
    onCommentDraftChange?: (text: string) => void;
}
export declare function TrackerItemDetailPanel({ item, identity, onFieldChange, commentMutate, formatTimestamp, teamMembers, bodySlot, headerStatus, copyLinkHref, overflowActions, onClose, mutationRejection, compact, editing, onEditingChange, backLabel, commentDraft, onCommentDraftChange, }: TrackerItemDetailPanelProps): React.JSX.Element;
