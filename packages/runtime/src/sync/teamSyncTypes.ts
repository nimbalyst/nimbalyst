/**
 * Types for TeamSync -- client-side team state sync layer.
 *
 * Wire-protocol message shapes come from `@nimbalyst/collab-protocol` and
 * are shared with the sync server. This file adds the client-side config
 * surface (callbacks, status) and the decrypted projections (`TeamState`,
 * `DocIndexEntry`) that the renderer consumes.
 */

import type {
  ConversationDescriptor,
  FeedbackRequestIndexEntry,
  MemberInfo as ProtocolMemberInfo,
  OrgSettings,
  TeamState as ProtocolTeamState,
  EncryptedDocIndexEntry as ProtocolEncryptedDocIndexEntry,
  EncryptedFolderNode as ProtocolEncryptedFolderNode,
} from '@nimbalyst/collab-protocol';
import type { TeamJwt, TeamMemberId } from '../auth/jwtScopes';

export type {
  TeamClientMessage,
  TeamServerMessage,
  TeamSyncResponseMessage,
  TeamMemberAddedMessage,
  TeamMemberRemovedMessage,
  TeamMemberRoleChangedMessage,
  TeamDocIndexSyncResponseMessage,
  TeamDocIndexBroadcastMessage,
  TeamDocIndexRemoveBroadcastMessage,
  TeamFolderIndexSyncResponseMessage,
  TeamFolderBroadcastMessage,
  TeamFolderRemoveBroadcastMessage,
  TeamProjectAccessChangedMessage,
  TeamDocumentCommentNotifyMessage,
  TeamDocumentCommentNotifyAckMessage,
  TeamErrorMessage,
  FeedbackIndexSyncResponseMessage,
  FeedbackIndexBroadcastMessage,
} from '@nimbalyst/collab-protocol';

/** Re-export wire types under client-side names. */
export type MemberInfo = ProtocolMemberInfo;
export type EncryptedDocIndexEntry = ProtocolEncryptedDocIndexEntry;
export type EncryptedFolderNode = ProtocolEncryptedFolderNode;
/** Wire-format team state (encrypted document titles, sent by server). */
export type ServerTeamState = ProtocolTeamState;

// ============================================================================
// Configuration
// ============================================================================

export interface TeamSyncConfig {
  /** WebSocket server URL (e.g., wss://sync.nimbalyst.com) */
  serverUrl: string;

  /** Optional host WebSocket factory (Electron main and other non-DOM hosts). */
  createWebSocket?: (url: string) => WebSocket;

  /** Function to get fresh JWT for WebSocket auth */
  getJwt: () => Promise<TeamJwt>;

  /** B2B organization ID */
  orgId: string;

  /**
   * Epic H3 P0/A: the active project's tracker-room routing key. Document rooms
   * are org-scoped (`org:{orgId}:doc:{docId}`), but the doc INDEX is now
   * project-partitioned on the server, so each `docIndexRegister` carries this
   * `projectId` to attribute the doc to its project. `null` (or absent) tags the
   * doc to the org's primary project (legacy behavior).
   */
  teamProjectId?: string | null;

  /** Current user's member id in this team organization. */
  teamMemberId: TeamMemberId;


  /** Called when full team state snapshot is received (initial sync) */
  onTeamStateLoaded?: (state: TeamState) => void;

  /**
   * Called with the organization's settings: once per sync snapshot that
   * carries them, and again on every `orgSettingsUpdated` broadcast. Absent on
   * pre-settings servers, which simply never invoke it.
   */
  onOrgSettingsUpdated?: (settings: OrgSettings) => void;

  /**
   * Called on every `conversationDescriptorUpdated` broadcast: a room was
   * renamed, re-topiced, archived or had agent posting toggled. Absent on
   * pre-conversation-registry servers, which never invoke it.
   */
  onConversationDescriptorUpdated?: (
    descriptor: ConversationDescriptor,
  ) => void;

  /** Called with the full participant-filtered feedback index snapshot. */
  onFeedbackIndexLoaded?: (entries: FeedbackRequestIndexEntry[]) => void;

  /** Called when one participant-filtered feedback index entry changes. */
  onFeedbackIndexChanged?: (entry: FeedbackRequestIndexEntry) => void;

  /** Called when a member is added */
  onMemberAdded?: (member: MemberInfo) => void;

  /** Called when a member is removed */
  onMemberRemoved?: (teamMemberId: TeamMemberId) => void;

  /** Called when a member's role changes */
  onMemberRoleChanged?: (teamMemberId: TeamMemberId, role: string) => void;

  /** Called when the full document list is loaded (from teamSync or docIndexSync) */
  onDocumentsLoaded?: (documents: DocIndexEntry[]) => void;

  /** Called when a document is added or updated */
  onDocumentChanged?: (document: DocIndexEntry) => void;

  /** Called when a document is removed */
  onDocumentRemoved?: (documentId: string) => void;

  /** Called when the full folder list is loaded (from teamSync or folderIndexSync) */
  onFoldersLoaded?: (folders: FolderNode[]) => void;

  /** Called when a folder is registered, renamed, or moved */
  onFolderChanged?: (folder: FolderNode) => void;

  /**
   * Called when a folder subtree is removed. Carries every folder id and
   * document id that was deleted so the host can prune its tree and links.
   */
  onFoldersRemoved?: (folderIds: string[], documentIds: string[]) => void;

  /**
   * Called when a member's project-scoped access changed (Epic H1). `projectRole`
   * is the new role, or `null` when access was revoked. The host writes this
   * through to the local org/project projection so `canAccess` stays live.
   */
  onProjectAccessChanged?: (projectId: string, teamMemberId: TeamMemberId, projectRole: string | null) => void;

  /** Called when connection status changes */
  onStatusChange?: (status: TeamSyncStatus) => void;

  /**
   * Override the WebSocket URL construction.
   * Useful for integration tests with auth bypass.
   */
  buildUrl?: (roomId: string) => string;
}

// ============================================================================
// Status
// ============================================================================

export type TeamSyncStatus =
  | 'disconnected'
  | 'connecting'
  | 'syncing'
  | 'connected'
  | 'error';

// ============================================================================
// Decrypted team state (client-side projection)
// ============================================================================

export interface TeamState {
  metadata: {
    orgId: string;
    name: string;
    gitRemoteHash: string | null;
    /**
     * Server-minted UUID that names this team's tracker room
     * (tracker-sync-redesign D8 / NIM-404). May be null when reading
     * snapshots persisted before the migration ran on the server.
     */
    teamProjectId: string | null;
    createdBy: string;
    createdAt: number;
  } | null;
  members: MemberInfo[];
  documents: DocIndexEntry[];
  folders: FolderNode[];
}

/** Decrypted document index entry for UI consumption */
export interface DocIndexEntry {
  documentId: string;
  /** Owning project carried by the team document index. */
  projectId?: string | null;
  title: string;
  documentType: string;
  /** Optional V2 type metadata; absent on legacy rows. */
  metadataVersion?: 2;
  /** Exact normalized suffix, including the leading dot. */
  fileExtension?: string;
  /** Stable owning editor id (built-in or extension id). */
  editorId?: string;
  createdBy: string;
  createdAt: number;
  updatedAt: number;
  /**
   * User id of whoever most recently changed this document (title OR content).
   * Lets the sidebar's unread indicator suppress the user's own edits without
   * opening the doc. Null/undefined for legacy rows.
   */
  lastWriterUserId?: string | null;
  /**
   * First-class folders: the folder this document lives in. Null/undefined =
   * root level (also legacy rows, whose path still lives in the title).
   */
  parentFolderId?: string | null;
  /** Millisecond epoch when moved to Trash; null/undefined means active. */
  trashedAt?: number | null;
  /**
   * True when the server returned a doc index entry whose encrypted title
   * could not be decrypted with the current org key. Preserved in the list
   * so the user can see something exists rather than the entry vanishing
   * silently; the UI should render it as locked / non-interactive.
   */
  decryptFailed?: boolean;
}

/** Explicit type metadata written by V2 shared-document creators. */
export interface SharedDocumentTypeMetadataV2 {
  metadataVersion: 2;
  /** Exact normalized suffix, including the leading dot. */
  fileExtension: string;
  /** Stable owning editor id (built-in or extension id). */
  editorId: string;
}

/** Decrypted folder node for UI consumption (first-class folders). */
export interface FolderNode {
  folderId: string;
  /** Null = root level. */
  parentFolderId?: string | null;
  name: string;
  sortOrder: number;
  projectId?: string | null;
  createdBy: string;
  createdAt: number;
  updatedAt: number;
  /** True when the folder name could not be decrypted (render as locked). */
  decryptFailed?: boolean;
}
