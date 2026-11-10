import type { ReactNode } from 'react';
import type { LexicalEditor, TextFormatType } from 'lexical';
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
import type { TrackerReferenceResolver } from '@nimbalyst/collab-client/trackers-ui/references';
import type { UploadedEditorAsset } from '@nimbalyst/runtime/editor/EditorConfig';
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
  /**
   * A commenter: the room accepts comment threads but refuses any change to
   * the document body (`canWrite: false, canComment: true`). The editor is
   * read-only and comments are written without touching the body.
   */
  | 'comment-only'
  | 'read-only'
  | 'revoked';

export interface CollabEditorWriteRejection {
  code: 'document_read_only';
  message: string;
  /** Present when the server rejected a specific docUpdate. */
  clientUpdateId?: string;
}


export interface CollabEditorTermination {
  /**
   * `comment-update-refused` (close 4009): the room refused a commenter's
   * update because it changed more than the comment threads
   * (`document_comment_update_refused`). Terminal for this mount's Y.Doc:
   * every later update from its Yjs client depends on the refused one. The
   * host remounts with a fresh provider (a fresh Y.Doc and client id) and tells
   * the user the last comment was not saved.
   */
  reason:
    | 'removed-from-org'
    | 'document-access-revoked'
    | 'deleted-document'
    | 'comment-update-refused';
  closeCode: 4002 | 4003 | 4004 | 4009;
  message: string;
  /** The refused docUpdate, for `comment-update-refused` when the server named it. */
  clientUpdateId?: string;
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
        | 'deleted-document'
        | 'comment-update-refused';
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
  /**
   * Whether this user's role permits changing the document body, answered by
   * the host. `false` with `canComment` true is a commenter: the editor is
   * read-only and comments are stored without touching the body. Combined with
   * the room's own verdict (`canWrite: false, canComment: true`); the more
   * restrictive answer wins. Resolved as a function for the same reasons as
   * `canComment`; call `refreshCommentAccess` after it changes. Omitted means
   * permitted.
   */
  canEditBody?: () => boolean;
  onMention?: (recipientUserIds: string[], payload: CommentMentionPayload) => void;
  onReply?: (recipientUserIds: string[], payload: CommentReplyPayload) => void;
}

/** The part of a type definition the placed-view slash entries read. */
export interface PlacedViewTypeOption {
  type: string;
  displayName?: string;
  displayNamePlural?: string;
  fields: ReadonlyArray<{ name: string; type: string }>;
}

/** The host's live list of types, for the placed-view slash entries. */
export interface PlacedViewTypeSource {
  list(): readonly PlacedViewTypeOption[];
  subscribe(listener: () => void): () => void;
}

/** A page the `@` picker can link to, with the link as this host writes it. */
export interface PageLinkOption {
  id: string;
  title: string;
  /** The link destination, relative to the open page (`Personas/CMO.md`). */
  href: string;
  /** The link's title attribute; the local wiki writes `id=<id>` so the link survives moves. */
  linkTitle?: string;
  /** Folder shown beside the title. */
  folderPath?: string;
  /** Material symbol; a page icon when absent. */
  icon?: string;
}

/** An embedded file link (`[Label](diagram.excalidraw "width=800 height=600")`). */
export interface FileEmbedRequest {
  /** The link destination as written, relative to the document. */
  src: string;
  label: string;
  /** Title attributes (`width`, `height`). */
  attrs: Readonly<Record<string, string>>;
}

/** The host's pages for the `@` page-link picker. */
export interface PageLinkSource {
  /** Every page the open page can link to, read when the menu opens. */
  list(): readonly PageLinkOption[];
  /** Creates a page with this title and returns how to link it; the picker then offers "Create page". */
  createPage?(title: string): Promise<PageLinkOption>;
  /** A create that failed; its placeholder link has already reverted to text. */
  onError?(error: unknown): void;
}

export interface CollabEditorMountOptions {
  element: HTMLElement;
  source: CollabEditorSource;
  user: CollabEditorUser;
  readOnly?: boolean;
  comments?: CollabEditorCommentsOptions;
  /**
   * Optional live preview supplied by the document host; never resolves local
   * files itself. `embed` is set when the artifact is an embed block in the
   * document rather than a decision's artifact, carrying the link title's
   * attributes (`width`, `height`) the host sizes the preview from.
   */
  renderDecisionArtifact?: (entryId: string, artifact: string, embed?: Omit<FileEmbedRequest, 'src'>) => ReactNode;
  /**
   * Live data for tracker references in the document. Without it references
   * render as key-only chips; with it they show live title and status, and
   * card and statements references render their full views.
   */
  trackerReferences?: TrackerReferenceResolver;
  /**
   * How inline references render in prose. `'chip'` (the default) is the
   * bordered key-and-title pill; `'quiet'` is the title as a kind-tinted link
   * with key, kind and state in a hover peek. Presentation only.
   */
  trackerReferenceAppearance?: 'chip' | 'quiet';
  /**
   * The typed page this body belongs to. Its links then offer the relations
   * the pair of types allows (the hover picker), as on the desktop. Read when
   * the editor mounts; omit it for plain pages.
   */
  trackerReferenceSource?: { itemId: string; type: string };
  /**
   * The project's types a page can place a view of. With it, a team-room
   * mount's slash menu offers "Table: <type>", "2x2: <type>" and the
   * decisions and open questions lists, written as this project's console
   * view links. Omit it and the menu offers no placed views.
   */
  placedViewTypes?: PlacedViewTypeSource;
  /**
   * Stores a pasted or dropped file and says what to write for it: an image
   * node or a link. Without it a team room keeps the editor's own handling and
   * an in-memory document inlines images as data URLs. The local wiki browser
   * view stores them in the page's `.assets/` folder.
   */
  onUploadAsset?: (file: File) => Promise<UploadedEditorAsset>;
  /**
   * Turns an image src written in the document into a URL this host can load,
   * or null to leave it to the editor. Consulted after a team room's own
   * `collab-asset://` resolver. The local wiki maps page-relative paths to its
   * file route.
   */
  resolveImageSrc?: (src: string) => Promise<string | null>;
  /**
   * Pages linked by relative path. With it, `@` offers them and inserts a
   * plain markdown link (`[Title](path.md "id=...")`). Hosts with shared
   * documents leave it out.
   */
  pageLinks?: PageLinkSource;
  /**
   * Draws an embed of a file the document links to by path. Null keeps the
   * "unavailable" note. The local wiki renders the linked page's editor.
   */
  renderFileEmbed?: (embed: FileEmbedRequest) => ReactNode | null;
  /** Cmd/Ctrl+F inside the document opens a find and replace bar above it. */
  findInPage?: boolean;
  /** Cmd/Ctrl+S inside the document; for hosts that write the document somewhere themselves. */
  onSaveRequest?: () => void;
  onStateChange?:(state: CollabEditorState) => void;
  onPresenceChange?: (presence: CollabEditorPresence) => void;
  onWriteRejected?: (rejection: CollabEditorWriteRejection) => void;
  onTermination?: (termination: CollabEditorTermination) => void;
  onReady?: (handle: CollabEditorHandle) => void;
  onLexicalEditor?: (editor: LexicalEditor | null) => void;
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
  /** True until local document writes have server acknowledgement. */
  hasPendingWrites?(): boolean;
  getMarkdown(): string;
  /**
   * Replace the whole body with `markdown` as one collaborative edit, the way
   * restoring a page history version does on the desktop. Throws when the
   * editor is not ready or the document is read-only.
   */
  replaceMarkdown?(markdown: string): void;
  /** Largest server sequence this client has seen; a revision's `basisSequence`. */
  getBasisSequence?(): number;
  getState(): CollabEditorState;
  getPresence(): CollabEditorPresence;
  /** Announce departure/backgrounding or rejoin for host-managed lifecycles. */
  setPresenceActive(active: boolean): void;
  /**
   * Relabel this participant for everyone else in the room, e.g. once a roster
   * request resolves the name. Does not remount; the member id must not change.
   */
  setUser(user: CollabEditorUser): void;
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
  TrackerReferenceResolver,
  TeamJwt,
  TeamMemberId,
  TextFormatType,
  UploadedEditorAsset,
};
