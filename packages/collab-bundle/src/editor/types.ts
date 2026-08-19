import type { TextFormatType } from 'lexical';
import {
  asTeamJwt,
  asTeamMemberId,
  type TeamJwt,
  type TeamMemberId,
} from '@nimbalyst/runtime/auth/jwtScopes';
import type {
  CommentMember,
  CommentMentionPayload,
  CommentReplyPayload,
} from '@nimbalyst/runtime/editor/commenting/types';
import type { TeamMemberSummary } from '@nimbalyst/collab-client/core';
import type { Doc } from 'yjs';

declare const teamOrgIdBrand: unique symbol;
declare const teamProjectIdBrand: unique symbol;
declare const teamDocumentIdBrand: unique symbol;

export type TeamOrgId = string & { readonly [teamOrgIdBrand]: true };
export type TeamProjectId = string & { readonly [teamProjectIdBrand]: true };
export type TeamDocumentId = string & { readonly [teamDocumentIdBrand]: true };

export const asTeamOrgId = (value: string): TeamOrgId => value as TeamOrgId;
export const asTeamProjectId = (value: string): TeamProjectId => value as TeamProjectId;
export const asTeamDocumentId = (value: string): TeamDocumentId => value as TeamDocumentId;
export { asTeamJwt, asTeamMemberId };

export interface TeamRoomIdentity {
  orgId: TeamOrgId;
  projectId: TeamProjectId;
  documentId: TeamDocumentId;
}

export interface TeamRoomAuth {
  scope: 'team';
  memberId: TeamMemberId;
  getTeamJwt: (options?: { forceRefresh?: boolean }) => Promise<TeamJwt>;
}

export interface TeamRoomSource {
  kind: 'team-room';
  serverUrl: string;
  room: TeamRoomIdentity;
  auth: TeamRoomAuth;
  /** Host transport hook for native proxies and local verification. */
  createWebSocket?: (url: string) => WebSocket;
}

export interface InMemorySource {
  kind: 'in-memory';
  document: Doc;
}

export type CollabEditorSource = TeamRoomSource | InMemorySource;

export type CollabEditorConnectionState =
  | 'local'
  | 'disconnected'
  | 'connecting'
  | 'syncing'
  | 'replaying'
  | 'offline-unsynced'
  | 'connected'
  | 'terminated'
  | 'error';

export type CollabEditorServerAccess =
  | 'not-applicable'
  | 'unknown'
  | 'writable'
  | 'read-only'
  | 'revoked';

export interface CollabEditorWriteRejection {
  code: 'document_read_only';
  message: string;
  /** Present when the server rejected a specific docUpdate. */
  clientUpdateId?: string;
}

export interface CollabEditorTermination {
  reason: 'removed-from-org' | 'document-access-revoked' | 'deleted-document';
  closeCode: 4002 | 4003 | 4004;
  message: string;
}

export type CollabEditorFlushResult =
  | { status: 'acknowledged' }
  | { status: 'not-required'; reason: 'in-memory' | 'empty-document' }
  | { status: 'rejected'; rejection: CollabEditorWriteRejection }
  | {
      status: 'unavailable';
      reason:
        | 'not-mounted'
        | 'destroyed'
        | 'disconnected'
        | 'server-read-only'
        | 'removed-from-org'
        | 'document-access-revoked'
        | 'deleted-document';
    }
  | { status: 'timed-out'; timeoutMs: number }
  | { status: 'failed'; message: string };

export interface CollabEditorState {
  connection: CollabEditorConnectionState;
  edit: 'clean' | 'dirty';
  /** Effective presentation state: hostReadOnly OR a server restriction. */
  readOnly: boolean;
  /** Local presentation override. This never grants server write authority. */
  hostReadOnly: boolean;
  /** Server-observed authority. `unknown` never means the host authorized a write. */
  serverAccess: CollabEditorServerAccess;
  /** Terminal authorization loss, distinct from an ordinary disconnect. */
  termination: CollabEditorTermination | null;
}

/** The current team roster row; the bundle resolves desktop's name/email/id precedence. */
export interface CollabEditorUser extends TeamMemberSummary {
  cursorColor?: string;
}

export interface ResolvedCollabEditorUser {
  memberId: TeamMemberId;
  displayName: string;
  email: string | null;
  role: string | null;
  cursorColor: string;
}

export interface CollabEditorParticipant {
  memberId: TeamMemberId;
  displayName: string;
  cursorColor: string;
  hasSelection: boolean;
}

export interface CollabEditorPresence {
  /** Remote participants only, matching the desktop participant-list shape. */
  participants: CollabEditorParticipant[];
}

/** Browser-owned inputs that the bundle expands into the runtime comments config. */
export interface CollabEditorCommentsOptions {
  currentUser: { id: string; name: string };
  getMembers(): CommentMember[];
  documentTitle: string;
  documentId: string;
  documentUri: string;
  /**
   * Whether this user's role permits authoring comments, answered by the host.
   *
   * The bundle cannot work this out. Comment threads live in the document's
   * Y.Doc, so authoring one requires the same server write authority as editing
   * the prose, and the transport learns that only by having a write accepted or
   * refused. A host that knows the answer up front -- the web console reads it
   * off the org roster it already fetches -- supplies it here, and the bundle
   * ANDs it with what the transport has observed.
   *
   * Resolved as a function, never captured: the roster is asynchronous, so the
   * first answer on a cold open is "not yet known" (`false`, fail closed), and
   * access can be withdrawn mid-session. Call {@link CollabEditorHandle.refreshCommentAccess}
   * after the answer changes so the mounted editor re-renders with it.
   *
   * Omitted means "this host does not model per-role comment access" and the
   * bundle treats it as permitted, matching the runtime's default for a host
   * that supplies no capability resolver at all.
   */
  canComment?: () => boolean;
  onMention?: (recipientUserIds: string[], payload: CommentMentionPayload) => void;
  onReply?: (recipientUserIds: string[], payload: CommentReplyPayload) => void;
}

export interface CollabEditorMountOptions {
  element: HTMLElement;
  source: CollabEditorSource;
  user: CollabEditorUser;
  readOnly?: boolean;
  comments?: CollabEditorCommentsOptions;
  onStateChange?: (state: CollabEditorState) => void;
  onPresenceChange?: (presence: CollabEditorPresence) => void;
  onWriteRejected?: (rejection: CollabEditorWriteRejection) => void;
  onTermination?: (termination: CollabEditorTermination) => void;
  onReady?: (handle: CollabEditorHandle) => void;
  onError?: (error: Error) => void;
  /**
   * The document reached the Y.Doc but the Lexical binding threw while
   * rendering it, so nothing painted. Distinct from `onError`: sync is healthy
   * and the connection is live, but what the host is showing is an empty
   * editor that looks like a blank document. Hosts must not present that as a
   * document the user can type into.
   */
  onBindingError?: (error: Error) => void;
}

export interface CollabEditorHandle {
  getDocument(): Doc;
  getMarkdown(): string;
  getState(): CollabEditorState;
  getPresence(): CollabEditorPresence;
  /** Announce departure/backgrounding or rejoin for host-managed lifecycles. */
  setPresenceActive(active: boolean): void;
  /** Wait for the room's persisted docUpdateAck, never merely a socket write. */
  flush(options?: { timeoutMs?: number }): Promise<CollabEditorFlushResult>;
  setReadOnly(readOnly: boolean): void;
  /**
   * Re-read `comments.canComment` and re-render if the answer changed.
   *
   * The runtime resolves comment capability on every render and never caches
   * it, but the bundle owns its own React root: a host answer that resolves
   * after mount reaches nothing until something renders again. Hosts whose
   * answer can change -- a roster request that lands, a role that is edited --
   * call this; a host with a fixed answer never needs to.
   */
  refreshCommentAccess(): void;
  markClean(): void;
  focus(): void;
  insertText(text: string): void;
  formatText(format: TextFormatType): void;
  destroy(): void;
}

export type {
  CommentMember,
  TeamJwt,
  TeamMemberId,
  TextFormatType,
};
