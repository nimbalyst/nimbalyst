import type { TextFormatType } from 'lexical';
import type { TeamJwt, TeamMemberId } from '@nimbalyst/runtime/auth/jwtScopes';
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
  reason: 'removed-from-org' | 'document-access-revoked';
  closeCode: 4002 | 4003;
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
        | 'document-access-revoked';
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

export interface CollabEditorMountOptions {
  element: HTMLElement;
  source: CollabEditorSource;
  user: CollabEditorUser;
  readOnly?: boolean;
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
  markClean(): void;
  focus(): void;
  insertText(text: string): void;
  formatText(format: TextFormatType): void;
  destroy(): void;
}

export type {
  TeamJwt,
  TeamMemberId,
  TextFormatType,
};
