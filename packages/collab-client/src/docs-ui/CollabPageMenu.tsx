/**
 * Context menu entries for the one page tree (documents nest in documents):
 * the page head block (New page inside, Set type, Rename, Move to..., Copy
 * link), the page delete entry with its child count, and the typed-page
 * entries (New page inside, Place type..., Move to..., Back under its type, Page
 * history). The sidebar keeps its per-document extras (favorite, history, local
 * source) between the head and the delete entry. Lazy-loaded (and preloaded
 * once a tree is a page tree) to keep it out of the docs-ui eager bundle.
 */
import React from 'react';
import { CollabMenuButton } from './primitives/CollabMenuButton';

export { CollabMenuButton };

const Separator = () => <div className="my-1 border-t border-[var(--nim-border)]" />;

export const CollabPageMenuHead: React.FC<{
  onNewPageInside: () => void;
  /** Absent until the host can turn a page into a typed page in place. */
  onSetType?: () => void;
  /** Absent without tracker data (no types to place). */
  onPlaceType?: () => void;
  onRename: () => void;
  onMoveTo: () => void;
  onCopyLink: () => void;
  copyLinkDisabled?: boolean;
}> = ({ onNewPageInside, onSetType, onPlaceType, onRename, onMoveTo, onCopyLink, copyLinkDisabled }) => (
  <>
    <CollabMenuButton className="collab-page-new-inside" icon="note_add" label="New page" trailing="inside" onClick={onNewPageInside} />
    {onPlaceType && (
      <CollabMenuButton className="collab-place-type-action" icon="table" label="Place type..." trailing="inside" onClick={onPlaceType} />
    )}
    <CollabMenuButton
      className="collab-page-set-type"
      icon="category"
      label="Set type"
      disabled={!onSetType}
      onClick={() => onSetType?.()}
    />
    <CollabMenuButton icon="edit" label="Rename" onClick={onRename} />
    <CollabMenuButton className="collab-page-move-to" icon="drive_file_move" label="Move to..." onClick={onMoveTo} />
    <Separator />
    <CollabMenuButton icon="link" label="Copy link" disabled={copyLinkDisabled} onClick={onCopyLink} />
  </>
);

/** A page goes to Trash, with its subtree when it has children. */
export const CollabPageDeleteEntry: React.FC<{ childCount: number; onDelete: () => void }> = ({ childCount, onDelete }) => (
  <>
    <Separator />
    <CollabMenuButton
      className="collab-page-delete"
      icon="delete"
      danger
      label="Move to Trash"
      trailing={childCount > 0 ? `${childCount} child page${childCount === 1 ? '' : 's'}` : undefined}
      onClick={onDelete}
    />
  </>
);

/**
 * A typed page's body or a type page's prose history. Agent edits land in
 * pages directly, so this is how a person reverts one.
 */
export const CollabPageHistoryEntry: React.FC<{ onClick: () => void }> = ({ onClick }) => (
  <CollabMenuButton className="collab-page-history" icon="history" label="Page history" onClick={onClick} />
);

/** A typed page's row: pages and types inside it, move it anywhere, back under its type, its history, or archive it. */
export const CollabItemMenu: React.FC<{
  placed: boolean;
  onNewPageInside: () => void;
  /** Absent without tracker data (no types to place). */
  onPlaceType?: () => void;
  onMoveTo: () => void;
  onBackUnderType: () => void;
  /** Absent where the host has no history to open. */
  onHistory?: () => void;
  /** Absent where the host cannot write trackers. */
  onArchive?: () => void;
}> = ({ placed, onNewPageInside, onPlaceType, onMoveTo, onBackUnderType, onHistory, onArchive }) => (
  <>
    <CollabMenuButton className="collab-item-new-inside" icon="note_add" label="New page" trailing="inside" onClick={onNewPageInside} />
    {onPlaceType && (
      <CollabMenuButton className="collab-item-place-type" icon="table" label="Place type..." trailing="inside" onClick={onPlaceType} />
    )}
    <Separator />
    <CollabMenuButton className="collab-item-move-to" icon="drive_file_move" label="Move to..." onClick={onMoveTo} />
    {placed && (
      <CollabMenuButton className="collab-item-back-under-type" icon="table" label="Back under its type" onClick={onBackUnderType} />
    )}
    {onHistory && (
      <>
        <Separator />
        <CollabPageHistoryEntry onClick={onHistory} />
      </>
    )}
    {onArchive && (
      <>
        <Separator />
        <CollabMenuButton className="collab-item-archive" icon="archive" label="Archive" onClick={onArchive} />
      </>
    )}
  </>
);
