import type { DocumentFeedbackIndexSyncMessage, DocumentFeedbackIndexSnapshotMessage } from './documentFeedbackIndex.js';
import type { TeamPageMarksChangedMessage, TeamPageMarksQueryMessage, TeamPageMarksResponseMessage } from './pageMarks.js';
import type { TeamPageLinksChangedMessage, TeamPageLinksQueryMessage, TeamPageLinksResponseMessage } from './pageLinks.js';
import type { TeamPageSearchQueryMessage, TeamPageSearchResponseMessage } from './pageSearch.js';
export * from './pageMarks.js';
export * from './pageLinks.js';
export * from './pageSearch.js';
/**
 * TeamRoom wire protocol.
 *
 * Consolidated team state: members, roles, and the shared document index.
 * Team content is encrypted at rest under the server-managed team DEK; there
 * is no client-held org key, so no envelope or identity-key traffic.
 */

import type {
  BoundedPreview,
  ConversationDescriptor,
} from './conversation.js';
import type { FeedbackRequestIndexEntry } from './feedbackRequest.js';
import type { PageFields } from './pageFields.js';

export interface OrgSettings {
  version: 1;
  messaging: {
    roomsEnabled: boolean;
    dmsEnabled: boolean;
    roomCreation: 'members' | 'admins';
  };
}

// ============================================================================
// Client -> Server Messages
// ============================================================================

export type TeamClientMessage =
  | DocumentFeedbackIndexSyncMessage
  | TeamSyncRequestMessage
  | FeedbackIndexSyncRequestMessage
  | TeamDocumentCommentNotifyMessage
  | TeamDocIndexSyncRequestMessage
  | TeamDocIndexRegisterMessage
  | TeamDocIndexUpdateMessage
  | TeamDocIndexSetFieldsMessage
  | TeamDocIndexRemoveMessage
  | TeamDocTrashMessage
  | TeamDocRestoreMessage
  | TeamDocMoveMessage
  | TeamFolderIndexSyncRequestMessage
  | TeamFolderRegisterMessage
  | TeamFolderRenameMessage
  | TeamFolderMoveMessage
  | TeamFolderRemoveMessage
  | TeamTypePlacementIndexSyncRequestMessage
  | TeamTypePlacementSetMessage
  | TeamTypePlacementRemoveMessage
  | TeamItemPlacementIndexSyncRequestMessage
  | TeamItemPlacementSetMessage
  | TeamItemPlacementRemoveMessage
  | TeamPageMarksQueryMessage
  | TeamPageLinksQueryMessage
  | TeamPageSearchQueryMessage;

/** Request full team state snapshot */
export interface TeamSyncRequestMessage {
  type: 'teamSync';
}

/** Request the participant-filtered feedback-request index. */
export interface FeedbackIndexSyncRequestMessage {
  type: 'feedbackIndexSync';
}

/** Request the full document list */
export interface TeamDocIndexSyncRequestMessage {
  type: 'docIndexSync';
}

/** Register a new shared document in the index. */
export interface TeamDocIndexRegisterMessage {
  type: 'docIndexRegister';
  documentId: string;
  encryptedTitle: string;
  titleIv: string;
  documentType: string;
  /** Marks entries carrying explicit shared-document type metadata. */
  metadataVersion?: 2;
  /** Exact normalized suffix, including its leading dot. */
  fileExtension?: string;
  /** Stable id of the editor that owns this document type. */
  editorId?: string;
  /**
   * Epic H3 P0: the project this document belongs to (the tracker-room routing
   * `teamProjectId`). Optional for backward compatibility — when omitted the
   * server tags the doc with the org's primary project. Lets a project move
   * answer "which docs travel with this project."
   */
  projectId?: string | null;
  /**
   * First-class folders: the folder this document lives in. Null/omitted = root
   * level. During the dual-write transition new clients also encode the folder
   * path into `encryptedTitle` so un-upgraded clients still render the tree.
   */
  parentFolderId?: string | null;
  /** What `parentFolderId` names. Absent = `'page'`, so older clients are unchanged. */
  parentKind?: PageParentKind;
  /**
   * Position among siblings. A number sets it; absent or null leaves a stored
   * row's order alone and gives a new row none.
   */
  sortOrder?: number | null;
}

/** Update a document's encrypted title. */
export interface TeamDocIndexUpdateMessage {
  type: 'docIndexUpdate';
  documentId: string;
  encryptedTitle: string;
  titleIv: string;
  /** Correlates a refused rename with its caller. */
  requestId?: string;
}

/**
 * Set some of a plain page's own fields (`pageFields.ts`). `fields` is a patch:
 * a key set to null clears that field, a value that does not validate is
 * ignored, and keys left out keep their stored value. The server applies the
 * patch to the stored fields, so two members setting different fields do not
 * overwrite each other. Only sent to a server whose snapshot set `pageFields`.
 */
export interface TeamDocIndexSetFieldsMessage {
  type: 'docIndexSetFields';
  documentId: string;
  fields: Record<string, unknown>;
  /** Echoed on the `error` frame if the server refuses this message. */
  requestId?: string;
}

/** Remove a document from the index. */
export interface TeamDocIndexRemoveMessage {
  type: 'docIndexRemove';
  documentId: string;
  /** Echoed on the `error` frame if the server refuses this message. */
  requestId?: string;
  /**
   * Permanently delete a page already in Trash; only Trash's "Delete
   * permanently" and "Empty Trash" send it. Without it a server that knows
   * the field never permanently deletes. Older servers ignore it.
   */
  purge?: true;
}

/** Move a document into recoverable Trash without changing its folder. */
export interface TeamDocTrashMessage {
  type: 'docTrash';
  documentId: string;
  /** Millisecond epoch used to calculate the retention deadline. */
  trashedAt: number;
}

/** Restore a trashed document to its unchanged parent folder. */
export interface TeamDocRestoreMessage {
  type: 'docRestore';
  documentId: string;
}

/**
 * Reparent a document into a different folder (first-class folders). Null
 * `newParentFolderId` = move to root. Touches only the doc's `parent_folder_id`,
 * never its content, so local-to-shared links stay intact.
 *
 * The same parent (and kind) with a new `sortOrder` is a reorder. Absent
 * `sortOrder` keeps the order when the parent is unchanged and clears it on a
 * move to a new parent; null always clears it.
 */
export interface TeamDocMoveMessage {
  type: 'docMove';
  documentId: string;
  newParentFolderId: string | null;
  /** What `newParentFolderId` names. Absent = `'page'`. */
  parentKind?: PageParentKind;
  sortOrder?: number | null;
  /** Echoed on the `error` frame if the server refuses this message. */
  requestId?: string;
}

/** Request the full folder list (first-class folders). */
export interface TeamFolderIndexSyncRequestMessage {
  type: 'folderIndexSync';
}

/**
 * Register a new folder node. `parentFolderId` null = root level. The folder
 * name is encrypted at rest the same way document titles are.
 */
export interface TeamFolderRegisterMessage {
  type: 'folderRegister';
  folderId: string;
  parentFolderId?: string | null;
  encryptedName: string;
  nameIv: string;
  sortOrder: number;
  projectId?: string | null;
}

/** Rename a folder in place (single-row update of `encryptedName`). */
export interface TeamFolderRenameMessage {
  type: 'folderRename';
  folderId: string;
  encryptedName: string;
  nameIv: string;
}

/**
 * Move a folder to a new parent (single-row update of `parentFolderId`). The
 * server rejects cycles (a folder cannot move under its own descendant). Null
 * `newParentFolderId` = move to root.
 */
export interface TeamFolderMoveMessage {
  type: 'folderMove';
  folderId: string;
  newParentFolderId: string | null;
  sortOrder?: number;
}

/**
 * Delete a folder recursively — the folder, all descendant folders, and every
 * document in that subtree. The server cascades a delete to each affected
 * DocumentRoom and broadcasts the removed id sets.
 */
export interface TeamFolderRemoveMessage {
  type: 'folderRemove';
  folderId: string;
  /** Echoed on the `error` frame if the server refuses this message. */
  requestId?: string;
}

/** Request every tracker-type placement in the page tree. */
export interface TeamTypePlacementIndexSyncRequestMessage {
  type: 'typePlacementIndexSync';
}

/**
 * Place a tracker type as a node in the page tree, or move it. One placement
 * per type per project, so a second set for the same type replaces the first.
 * `parentFolderId` null = root level; a missing folder (a missing or trashed
 * page once `pageTree` is set) is refused with `folder_not_found`. `projectId`
 * omitted = the org's primary project.
 */
export interface TeamTypePlacementSetMessage {
  type: 'typePlacementSet';
  typeId: string;
  projectId?: string | null;
  parentFolderId: string | null;
  /** What `parentFolderId` names. Absent = `'page'`. */
  parentKind?: PageParentKind;
  sortOrder: number;
}

/** Take a tracker type out of the page tree. Idempotent. */
export interface TeamTypePlacementRemoveMessage {
  type: 'typePlacementRemove';
  typeId: string;
  projectId?: string | null;
}

/** Request every tracker-item placement in the page tree. */
export interface TeamItemPlacementIndexSyncRequestMessage {
  type: 'itemPlacementIndexSync';
}

/**
 * Place a tracker item in the page tree, or move it. One placement per item per
 * project, so a second set for the same item replaces the first. `parentId` is
 * a page (document) id, a tracker item id (`parentKind: 'item'`), or null for
 * root; a missing or trashed page is refused with `folder_not_found`, and a
 * parent inside the item's own subtree with `folder_cycle`. `projectId` omitted = the org's primary project. An
 * item with no placement sits under its type.
 */
export interface TeamItemPlacementSetMessage {
  type: 'itemPlacementSet';
  itemId: string;
  projectId?: string | null;
  parentId: string | null;
  /** What `parentId` names. Absent = `'page'`. */
  parentKind?: PageParentKind;
  sortOrder: number;
}

/** Take a tracker item out of the page tree, back under its type. Idempotent. */
export interface TeamItemPlacementRemoveMessage {
  type: 'itemPlacementRemove';
  itemId: string;
  projectId?: string | null;
}

/**
 * Announce that a document comment mentioned members or replied to one, so the
 * server can route org-scoped inbox deliveries for it.
 *
 * Document comments live in the document's Y.Doc rather than a ConversationRoom,
 * so this is the only producer for that lane. Nothing here is trusted as
 * identity: the server derives the actor from the connection's team JWT,
 * re-resolves every recipient's capability, and re-truncates `preview`. The
 * client only names the source, the reason, and who it believes was addressed.
 *
 * Delivery is idempotent per `(recipient, commentId)`, so a client that
 * re-sends after a reconnect does not duplicate anyone's inbox row.
 */
export interface TeamDocumentCommentNotifyMessage {
  type: 'documentCommentNotify';
  documentId: string;
  /** Id of the comment that caused the notification. */
  commentId: string;
  /** Thread the comment belongs to, when it is a threaded reply. */
  threadId?: string;
  reason: 'mention' | 'reply';
  /** Recipients the client believes were addressed; never includes the author. */
  recipientUserIds: string[];
  /** Display-only copy. Never authoritative and always re-bounded server-side. */
  preview?: BoundedPreview;
}

// ============================================================================
// Server -> Client Messages
// ============================================================================

export type TeamServerMessage =
  | DocumentFeedbackIndexSnapshotMessage
  | TeamSyncResponseMessage
  | FeedbackIndexSyncResponseMessage
  | FeedbackIndexBroadcastMessage
  | TeamOrgSettingsUpdatedMessage
  | TeamConversationDescriptorUpdatedMessage
  | TeamMemberAddedMessage
  | TeamMemberRemovedMessage
  | TeamMemberRoleChangedMessage
  | TeamDocIndexSyncResponseMessage
  | TeamDocIndexRegisteredMessage
  | TeamDocIndexBroadcastMessage
  | TeamDocIndexRemoveBroadcastMessage
  | TeamFolderIndexSyncResponseMessage
  | TeamFolderBroadcastMessage
  | TeamFolderRemoveBroadcastMessage
  | TeamTypePlacementIndexSyncResponseMessage
  | TeamTypePlacementBroadcastMessage
  | TeamTypePlacementRemoveBroadcastMessage
  | TeamItemPlacementIndexSyncResponseMessage
  | TeamItemPlacementBroadcastMessage
  | TeamItemPlacementRemoveBroadcastMessage
  | TeamProjectAccessChangedMessage
  | TeamDocumentCommentNotifyAckMessage
  | TeamPageMarksResponseMessage
  | TeamPageMarksChangedMessage
  | TeamPageLinksResponseMessage
  | TeamPageLinksChangedMessage
  | TeamPageSearchResponseMessage
  | TeamErrorMessage;

/** Full team state snapshot */
export interface TeamSyncResponseMessage {
  type: 'teamSyncResponse';
  team: TeamState;
}

/** Full feedback index visible to this team-scoped viewer. */
export interface FeedbackIndexSyncResponseMessage {
  type: 'feedbackIndexSyncResponse';
  entries: FeedbackRequestIndexEntry[];
}

/** One participant-filtered feedback index upsert. */
export interface FeedbackIndexBroadcastMessage {
  type: 'feedbackIndexBroadcast';
  entry: FeedbackRequestIndexEntry;
}

/** Broadcast: organization settings changed. */
export interface TeamOrgSettingsUpdatedMessage {
  type: 'orgSettingsUpdated';
  settings: OrgSettings;
}

/** Broadcast: a conversation registry descriptor changed. */
export interface TeamConversationDescriptorUpdatedMessage {
  type: 'conversationDescriptorUpdated';
  descriptor: ConversationDescriptor;
}

/** Broadcast: member added */
export interface TeamMemberAddedMessage {
  type: 'memberAdded';
  member: MemberInfo;
}

/** Broadcast: member removed */
export interface TeamMemberRemovedMessage {
  type: 'memberRemoved';
  userId: string;
}

/** Broadcast: member role changed */
export interface TeamMemberRoleChangedMessage {
  type: 'memberRoleChanged';
  userId: string;
  role: string;
}

/**
 * Broadcast: a member's project-scoped access changed (Epic H1).
 *
 * Emitted by the TeamRoom when a project_access grant is created, updated, or
 * revoked (via the admin REST mutations or the one-time backfill). Lets every
 * connected member keep its local org/project projection live without polling.
 * `projectRole` is the new role, or `null` when access was revoked.
 */
export interface TeamProjectAccessChangedMessage {
  type: 'projectAccessChanged';
  projectId: string;
  userId: string;
  projectRole: string | null;
}

/** Full document list response */
export interface TeamDocIndexSyncResponseMessage {
  type: 'docIndexSyncResponse';
  documents: EncryptedDocIndexEntry[];
}

/**
 * Ack: this socket's `docIndexRegister` is committed to `document_index`.
 *
 * Sent only to the registering socket (the index broadcast deliberately
 * excludes it, so registration was otherwise unobservable to its author).
 * A client that is about to write into the new document's room must wait for
 * this: `DocumentRoom` binds the id through `document_index` and 404s an id
 * that isn't there yet, so seeding before the ack is a race (NIM-2472).
 */
export interface TeamDocIndexRegisteredMessage {
  type: 'docIndexRegistered';
  documentId: string;
}

/** Broadcast: document registered or updated */
export interface TeamDocIndexBroadcastMessage {
  type: 'docIndexBroadcast';
  document: EncryptedDocIndexEntry;
}

/** Broadcast: document removed */
export interface TeamDocIndexRemoveBroadcastMessage {
  type: 'docIndexRemoveBroadcast';
  documentId: string;
}

/** Full folder list response (first-class folders). */
export interface TeamFolderIndexSyncResponseMessage {
  type: 'folderIndexSyncResponse';
  folders: EncryptedFolderNode[];
}

/** Broadcast: folder registered, renamed, or moved (single upserted node). */
export interface TeamFolderBroadcastMessage {
  type: 'folderBroadcast';
  folder: EncryptedFolderNode;
}

/**
 * Broadcast: a folder subtree was removed. Carries the full set of folder ids
 * and document ids that were deleted so every client can prune its local tree
 * and links in one pass.
 */
export interface TeamFolderRemoveBroadcastMessage {
  type: 'folderRemoveBroadcast';
  folderIds: string[];
  documentIds: string[];
}

/** Full tracker-type placement list. */
export interface TeamTypePlacementIndexSyncResponseMessage {
  type: 'typePlacementIndexSyncResponse';
  placements: TypePlacementNode[];
}

/** Broadcast: a type was placed or moved (single upserted placement). */
export interface TeamTypePlacementBroadcastMessage {
  type: 'typePlacementBroadcast';
  placement: TypePlacementNode;
}

/**
 * Broadcast: placements were removed, either directly or because the folder
 * subtree holding them was removed.
 */
export interface TeamTypePlacementRemoveBroadcastMessage {
  type: 'typePlacementRemoveBroadcast';
  projectId: string;
  typeIds: string[];
}

/** Full tracker-item placement list. */
export interface TeamItemPlacementIndexSyncResponseMessage {
  type: 'itemPlacementIndexSyncResponse';
  placements: ItemPlacementNode[];
}

/** Broadcast: an item was placed or moved (single upserted placement). */
export interface TeamItemPlacementBroadcastMessage {
  type: 'itemPlacementBroadcast';
  placement: ItemPlacementNode;
}

/**
 * Broadcast: item placements were removed, either directly or because the page
 * holding them was removed. The items themselves are untouched.
 */
export interface TeamItemPlacementRemoveBroadcastMessage {
  type: 'itemPlacementRemoveBroadcast';
  projectId: string;
  itemIds: string[];
}

/**
 * Answers `documentCommentNotify`. Sent only to the requesting connection.
 *
 * `suppressedUserIds` covers every recipient the server declined — not an org
 * member, no `receiveNotification` capability, or muted — without saying which,
 * so a sender cannot probe another member's notification settings.
 */
export interface TeamDocumentCommentNotifyAckMessage {
  type: 'documentCommentNotifyAck';
  documentId: string;
  commentId: string;
  deliveredUserIds: string[];
  suppressedUserIds: string[];
}

/** TeamRoom error response */
export interface TeamErrorMessage {
  type: 'error';
  code: string;
  message: string;
  /**
   * The refused message's `requestId` (`docMove`, `docIndexRemove`,
   * `folderRemove`), so a client waiting to confirm that write can fail it.
   * Absent when the message carried none.
   */
  requestId?: string;
}

// ============================================================================
// Data Types
// ============================================================================

/**
 * What a page-tree parent id names: a page (document), or a tracker item. The
 * TeamRoom cannot see tracker items, so it never checks that an item parent
 * exists; it only refuses cycles it can see.
 */
export type PageParentKind = 'page' | 'item';

/** Encrypted document index entry as stored/transmitted */
export interface EncryptedDocIndexEntry {
  documentId: string;
  encryptedTitle: string;
  titleIv: string;
  documentType: string;
  /** Marks entries carrying explicit shared-document type metadata. */
  metadataVersion?: 2;
  /** Exact normalized suffix, including its leading dot. */
  fileExtension?: string;
  /** Stable id of the editor that owns this document type. */
  editorId?: string;
  createdBy: string;
  createdAt: number;
  updatedAt: number;
  /**
   * Epic H3 P0: the project this document belongs to (tracker-room routing
   * `teamProjectId`). Null for legacy/pre-H3 rows (treated as the org's
   * primary project at read time).
   */
  projectId?: string | null;
  /**
   * User id of whoever most recently changed this document (title OR content).
   * Drives the doc-list "unread" indicator's self-edit suppression without
   * opening the doc. Null for legacy rows / never-written index entries.
   */
  lastWriterUserId?: string | null;
  /**
   * First-class folders: the folder this document lives in. Null = root level
   * (also the value for legacy rows, whose structure still lives in the title
   * during the dual-write transition).
   */
  parentFolderId?: string | null;
  /** What `parentFolderId` names. Absent from older servers = `'page'`. */
  parentKind?: PageParentKind;
  /** Position among siblings; null = never reordered. Absent from older servers. */
  sortOrder?: number | null;
  /** Millisecond epoch when moved to Trash; null/undefined means active. */
  trashedAt?: number | null;
  /**
   * False until the body is first edited (a converted folder or a new page).
   * Once true it stays true. Absent from older servers = true.
   */
  hasContent?: boolean;
  /**
   * A plain page's own fields, sent in the clear and encrypted at rest like
   * the title. Null = none set. Absent = this entry does not say (an older
   * server, or a row the server cannot read), so a client keeps what it knew.
   */
  fields?: PageFields | null;
}

/**
 * Encrypted folder node as stored/transmitted (first-class folders).
 *
 * A folder is a real synced entity with a stable `folderId`, so move/rename are
 * single-row updates and every local-to-shared link stays intact when content
 * is reorganized. The name is encrypted with the org key (or team DEK in
 * server-managed mode) — same visibility model as document titles.
 */
export interface EncryptedFolderNode {
  folderId: string;
  /** Null = root level. */
  parentFolderId?: string | null;
  encryptedName: string;
  nameIv: string;
  sortOrder: number;
  /** Mirrors `document_index.project_id` partitioning. */
  projectId?: string | null;
  createdBy: string;
  createdAt: number;
  updatedAt: number;
}

/**
 * A tracker type placed as a node in the page tree. Keyed by
 * `(projectId, typeId)`. Ids only, so nothing here is encrypted.
 */
export interface TypePlacementNode {
  typeId: string;
  projectId: string;
  /** Null = root level. */
  parentFolderId: string | null;
  /** What `parentFolderId` names. Absent from older servers = `'page'`. */
  parentKind?: PageParentKind;
  sortOrder: number;
  createdBy: string;
  createdAt: number;
  updatedAt: number;
}

/**
 * A tracker item placed in the page tree, keyed by `(projectId, itemId)`. No
 * placement means the item sits under its type. Ids only, so nothing here is
 * encrypted.
 */
export interface ItemPlacementNode {
  itemId: string;
  projectId: string | null;
  /** Page (document) or tracker item id, per `parentKind`; null = root level. */
  parentId: string | null;
  /** What `parentId` names. Absent from older servers = `'page'`. */
  parentKind?: PageParentKind;
  sortOrder: number;
  createdBy: string;
  createdAt: number;
  updatedAt: number;
}

/** Full team state snapshot sent on teamSync */
export interface TeamState {
  metadata: {
    orgId: string;
    name: string;
    gitRemoteHash: string | null;
    /**
     * Server-minted UUID that names this team's tracker room
     * (`org:{orgId}:tracker:{teamProjectId}`). Stable across team
     * lifetime; never derived from mutable inputs. Backfilled to null
     * for pre-D8 teams until they reconnect to a TeamRoom that has the
     * migration applied. Tracker-sync-redesign D8 / NIM-404.
     */
    teamProjectId: string | null;
    createdBy: string;
    createdAt: number;
  } | null;
  members: MemberInfo[];
  documents: EncryptedDocIndexEntry[];
  /**
   * First-class folder nodes (omitted by pre-folders servers). Once `pageTree`
   * is set this is a compatibility projection for older clients: every
   * non-trashed document that has a child document or placement.
   */
  folders?: EncryptedFolderNode[];
  /**
   * Set once the room's folders were converted into documents. A client that
   * sees it builds the tree from documents (`parentFolderId` on a document is
   * the parent page id) and ignores `folders`.
   */
  pageTree?: true;
  /**
   * Set when the server sends the author its own `docMove`, `docIndexRemove`
   * and `folderRemove` broadcasts and echoes their `requestId` on a refusal,
   * so a client can wait for the echo to confirm such a write.
   */
  authorWriteEcho?: true;
  /** Rename broadcasts reach the author; refusals carry the rename requestId. */
  authorTitleEcho?: true;
  /**
   * The room stores plain-page fields: it takes `docIndexSetFields`, sends
   * `fields` on document entries, and echoes the write to its author like a
   * rename (a refusal carries the requestId).
   */
  pageFields?: true;
  /** Tracker-type placements in the page tree (omitted by older servers). */
  typePlacements?: TypePlacementNode[];
  /** Tracker-item placements in the page tree (omitted by older servers). */
  itemPlacements?: ItemPlacementNode[];
  /** Organization configuration (omitted by pre-settings servers). */
  settings?: OrgSettings;
}

/** Information about a team member */
export interface MemberInfo {
  userId: string;
  role: string;
  email: string | null;
  name?: string | null;
  /**
   * The member's personal org id, recorded at team create / invite acceptance.
   * Informational roster data; nothing routes on it any more.
   */
  personalOrgId?: string | null;
}
