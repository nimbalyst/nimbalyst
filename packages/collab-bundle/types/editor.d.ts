import type { Binding, Provider, ProviderAwareness } from '@lexical/yjs';
import type { Klass, LexicalEditor, LexicalNode, TextFormatType } from 'lexical';
import type { ComponentType } from 'react';
import type { Awareness } from 'y-protocols/awareness';
import type { Doc } from 'yjs';
import type { TeamJwt, TeamMemberId } from './internal/runtime/src/auth/jwtScopes';
import type {
  CollaborationContext,
  CollaborationStatus,
  EditorContext,
  EditorContextItem,
  EditorHost,
  EditorHostCapabilities,
  EditorHostCapability,
  EditorHostCapabilityGap,
  EditorMenuItem,
  RevisionSnapshotAdapter,
} from './internal/extension-sdk/src/types/editor';

declare const teamOrgIdBrand: unique symbol;
declare const teamProjectIdBrand: unique symbol;
declare const teamDocumentIdBrand: unique symbol;

export type { TeamJwt, TeamMemberId } from './internal/runtime/src/auth/jwtScopes';
export { asTeamJwt, asTeamMemberId } from './internal/runtime/src/auth/jwtScopes';
export type TeamOrgId = string & { readonly [teamOrgIdBrand]: true };
export type TeamProjectId = string & { readonly [teamProjectIdBrand]: true };
export type TeamDocumentId = string & { readonly [teamDocumentIdBrand]: true };

export declare const asTeamOrgId: (value: string) => TeamOrgId;
export declare const asTeamProjectId: (value: string) => TeamProjectId;
export declare const asTeamDocumentId: (value: string) => TeamDocumentId;

export interface TeamRoomIdentity {
  orgId: TeamOrgId;
  projectId: TeamProjectId;
  documentId: TeamDocumentId;
}

export interface TeamRoomAuth {
  scope: 'team';
  memberId: TeamMemberId;
  getTeamJwt(options?: { forceRefresh?: boolean }): Promise<TeamJwt>;
}

export interface TeamMemberSummary {
  memberId: TeamMemberId;
  email?: string | null;
  name?: string | null;
  role?: string | null;
}

export interface TeamRoomSource {
  kind: 'team-room';
  serverUrl: string;
  room: TeamRoomIdentity;
  auth: TeamRoomAuth;
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
  readOnly: boolean;
  hostReadOnly: boolean;
  serverAccess: CollabEditorServerAccess;
  termination: CollabEditorTermination | null;
}

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
  participants: CollabEditorParticipant[];
}

export interface CommentMember {
  userId: string;
  name: string;
  personalOrgId?: string | null;
}

interface CommentMentionPayload {
  actorName?: string;
  sourceTitle?: string;
  snippet?: string;
  commentId?: string;
  threadId?: string;
  markId?: string;
  url?: string;
}

interface CommentReplyPayload extends CommentMentionPayload {
  commentId: string;
  clientMutationId: string;
  replyToCommentId?: string;
}

export interface CollabEditorCommentsOptions {
  currentUser: { id: string; name: string };
  getMembers(): CommentMember[];
  documentTitle: string;
  documentId: string;
  documentUri: string;
  /**
   * Whether this user's role permits authoring comments, answered by the host.
   *
   * Comment threads live in the document's Y.Doc, so authoring one needs the
   * same server write authority as editing the prose, and the transport learns
   * that only by having a write accepted or refused. A host that knows the
   * answer up front supplies it here; the bundle ANDs it with what the
   * transport has observed.
   *
   * Resolved as a function, never captured: a host reading it off an
   * asynchronous roster answers "not yet known" (`false`, fail closed) first.
   * Call `CollabEditorHandle.refreshCommentAccess` after the answer changes.
   *
   * Omitted means "this host does not model per-role comment access", which the
   * bundle treats as permitted.
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
  onStateChange?(state: CollabEditorState): void;
  onPresenceChange?(presence: CollabEditorPresence): void;
  onWriteRejected?(rejection: CollabEditorWriteRejection): void;
  onTermination?(termination: CollabEditorTermination): void;
  onReady?(handle: CollabEditorHandle): void;
  onError?(error: Error): void;
  /**
   * The document reached the Y.Doc but the Lexical binding threw while
   * rendering it, so nothing painted. Distinct from `onError`: sync is healthy
   * and the connection is live, but what the host is showing is an empty
   * editor. Hosts must not present that as a document the user can type into.
   */
  onBindingError?(error: Error): void;
}

export interface CollabEditorHandle {
  getDocument(): Doc;
  getMarkdown(): string;
  getState(): CollabEditorState;
  getPresence(): CollabEditorPresence;
  /** Announce departure/backgrounding or rejoin for host-managed lifecycles. */
  setPresenceActive(active: boolean): void;
  flush(options?: { timeoutMs?: number }): Promise<CollabEditorFlushResult>;
  setReadOnly(readOnly: boolean): void;
  /**
   * Re-read `comments.canComment` and re-render if the answer changed. The
   * bundle owns its own React root, so a host answer that resolves after mount
   * reaches nothing until something renders again.
   */
  refreshCommentAccess(): void;
  markClean(): void;
  focus(): void;
  insertText(text: string): void;
  formatText(format: TextFormatType): void;
  destroy(): void;
}

export interface BridgeMountRequest {
  source: {
    kind: 'team-room';
    serverUrl: string;
    room: { orgId: string; projectId: string; documentId: string };
    auth: { scope: 'team'; memberId: string; jwt: string };
  };
  user: Omit<CollabEditorUser, 'memberId'>;
  readOnly?: boolean;
}

export interface BridgeAuthResponse {
  requestId: string;
  scope: 'team';
  jwt: string;
}

export interface BridgeFlushRequest {
  requestId: string;
  timeoutMs?: number;
}

export type EditorBridgeMessage =
  | { type: 'editorReady' }
  | { type: 'stateChanged'; state: CollabEditorState }
  | { type: 'presenceChanged'; presence: CollabEditorPresence }
  | { type: 'authRequested'; requestId: string; scope: 'team'; forceRefresh: boolean }
  | { type: 'writeRejected'; rejection: CollabEditorWriteRejection }
  | { type: 'terminated'; termination: CollabEditorTermination }
  | { type: 'flushCompleted'; requestId: string; result: CollabEditorFlushResult }
  | { type: 'error'; message: string; stack?: string };

export interface NimbalystEditorBridgeApi {
  mount(request: BridgeMountRequest): void;
  provideTeamJwt(response: BridgeAuthResponse): void;
  flush(request: BridgeFlushRequest): Promise<CollabEditorFlushResult>;
  setPresenceActive(active: boolean): void;
  setReadOnly(readOnly: boolean): void;
  markClean(): void;
  getContent(): string;
  focus(): void;
  insertText(text: string): void;
  formatText(format: TextFormatType): void;
  destroy(): void;
}

export interface InstallEditorBridgeOptions {
  element: HTMLElement;
  target?: Window & typeof globalThis;
  postMessage?(message: EditorBridgeMessage): void;
  mountEditor?(options: CollabEditorMountOptions): CollabEditorHandle;
}

export declare function mountCollabEditor(options: CollabEditorMountOptions): CollabEditorHandle;
export declare function resolveCollabEditorUser(user: CollabEditorUser): ResolvedCollabEditorUser;
export declare function installCollabEditorBridge(options: InstallEditorBridgeOptions): () => void;

interface CollabLexicalProviderOptions {
  deferInitialSync?: boolean;
}

type DocumentSyncStatus =
  | 'disconnected'
  | 'connecting'
  | 'syncing'
  | 'replaying'
  | 'offline-unsynced'
  | 'connected'
  | 'error';

/** Public shape of the embedded Lexical-to-Yjs provider adapter. */
export declare class CollabLexicalProvider implements Provider {
  awareness: ProviderAwareness;
  constructor(syncProvider: unknown, options?: CollabLexicalProviderOptions);
  getYDoc(): Doc;
  prepareForBinding(): void;
  connect(): Promise<void>;
  disconnect(): void;
  on(type: 'sync', cb: (isSynced: boolean) => void): void;
  on(type: 'status', cb: (arg: { status: string }) => void): void;
  on(type: 'update', cb: (arg: unknown) => void): void;
  on(type: 'reload', cb: (doc: Doc) => void): void;
  off(type: 'sync', cb: (isSynced: boolean) => void): void;
  off(type: 'status', cb: (arg: { status: string }) => void): void;
  off(type: 'update', cb: (arg: unknown) => void): void;
  off(type: 'reload', cb: (doc: Doc) => void): void;
  handleStatusChange(status: DocumentSyncStatus): void;
  handleRemoteUpdate(origin: unknown): void;
  destroy(): void;
  announceDeparture(): boolean;
}

export interface HeadlessLexicalYDocOptions {
  doc: Doc;
  rootId?: string;
  provider: Provider;
  nodes: ReadonlyArray<Klass<LexicalNode> | {
    replace: Klass<LexicalNode>;
    with: any;
  }>;
  namespace?: string;
}

export declare class HeadlessLexicalYDoc {
  readonly editor: LexicalEditor;
  readonly binding: Binding;
  constructor(options: HeadlessLexicalYDocOptions);
  hydrateFromYDoc(): void;
  applyUpdate(seed: () => void): void;
  destroy(): void;
}

interface CollabContentAdapterMigration {
  from: number;
  to: number;
  run(document: Doc): void;
}

interface CollabContentAdapter<TStructured = unknown> {
  documentType: string;
  fileExtensions: string[];
  mimeType?: string;
  layoutVersion: number;
  migrations?: CollabContentAdapterMigration[];
  isEmpty(document: Doc): boolean;
  seedFromFile(document: Doc, source: string | Uint8Array): void;
  applyFromFile(document: Doc, source: string | Uint8Array): void;
  exportToFile(document: Doc): string | Uint8Array;
  toPlainText(document: Doc): string;
  toStructured?(document: Doc): TStructured;
  applyStructuredPatch?(document: Doc, patch: unknown): void;
  exportRevisionSnapshot?(document: Doc): Uint8Array;
  restoreRevisionSnapshot?(document: Doc, bytes: Uint8Array): void;
  serializableDescriptor?: {
    kind: 'text';
    documentType: string;
    fileExtensions: string[];
    mimeType?: string;
    textField: string;
    layoutVersion: number;
  };
}

export declare const MarkdownCollabContentAdapter: CollabContentAdapter;

// ---------------------------------------------------------------------------
// Extension-provided editors
//
// The editor contract is the extension SDK's own declaration, inlined by
// `scripts/build-types.mjs` rather than restated here: a hand-kept copy of
// `EditorHost` would be a second definition that has to agree with the SDK
// forever, and the first time it did not, an extension would typecheck against
// one host and run against another.
// ---------------------------------------------------------------------------

export type {
  CollaborationContext,
  CollaborationStatus,
  EditorContext,
  EditorContextItem,
  EditorHost,
  EditorHostCapabilities,
  EditorHostCapability,
  EditorHostCapabilityGap,
  EditorHostProps,
  EditorMenuItem,
  RevisionSnapshotAdapter,
} from './internal/extension-sdk/src/types/editor';

/** Identifies this host in `EditorHostCapabilities.environment`. */
export declare const BROWSER_EDITOR_ENVIRONMENT = 'browser';

/** Capabilities a browser collaborative host provides for real. */
export declare const BROWSER_EDITOR_SUPPORTED_CAPABILITIES:
  readonly EditorHostCapability[];

/** Capabilities no browser host can provide, each with its reason. */
export declare const BROWSER_EDITOR_CAPABILITY_GAPS:
  readonly EditorHostCapabilityGap[];

/**
 * Capabilities the embedding page grants by supplying the matching hook.
 * Absent hook, absent capability -- there is no partial version of these.
 */
export interface BrowserEditorGrantedCapabilities {
  history?: boolean;
  menuItems?: boolean;
  aiContext?: boolean;
  binaryContent?: boolean;
  externalLinks?: boolean;
}

export declare function createBrowserEditorCapabilities(
  granted?: BrowserEditorGrantedCapabilities,
): EditorHostCapabilities;

/**
 * Thrown by a host member the host has already declared unavailable. Carries
 * the capability id so a caller can map back to
 * `EditorHostCapabilities.unavailable`.
 */
export declare class BrowserEditorCapabilityError extends Error {
  readonly capability: EditorHostCapability;
  constructor(capability: EditorHostCapability, reason: string);
}

/**
 * The manifest permission block, narrowed to what a browser host actually
 * answers. `ai` and `network` are deliberately absent: a browser host shares
 * its realm with the bundle and can enforce neither, so declaring them would
 * read as a gate that does not exist. The capability table is an API contract,
 * not a sandbox -- see `src/editor/browserEditorCapabilities.ts`.
 */
export interface BrowserExtensionPermissions {
  filesystem?: boolean;
}

export interface BrowserPermissionOutcome {
  declared: boolean;
  granted: boolean;
  reason?: string;
}

/**
 * How a browser host answers `permissions: { filesystem: true }`:
 * declared-but-ungranted. Loading is never refused over the declaration, and
 * the filesystem-backed host members are absent or reject.
 */
export declare function resolveBrowserFilesystemPermission(
  permissions: BrowserExtensionPermissions | undefined,
): BrowserPermissionOutcome;

/** A stable synthetic `filePath` for a document that has no path on disk. */
export declare function browserDocumentPath(
  documentId: string,
  fileName: string,
): string;

export interface BrowserCollaborationContextOptions {
  yDoc: Doc;
  awareness: Awareness;
  user: { id: string; name: string; color: string };
  getStatus(): CollaborationStatus;
  onStatusChange(callback: (status: CollaborationStatus) => void): () => void;
  loadInitialContent(): Promise<string | ArrayBuffer>;
  /** Resolve only on a server-persisted ack, never merely a socket write. */
  flushWithAck(timeoutMs?: number): Promise<boolean>;
  hasUndecodedContent?(): boolean;
  reportSeedOutcome?(outcome: { ok: boolean; error?: unknown }): void;
  onRevisionAdapterChange?(adapter: RevisionSnapshotAdapter | null): void;
}

/**
 * A `CollaborationContext` over an already-established browser session.
 * Transport-agnostic: it takes the Y.Doc, the awareness instance and a flush.
 */
export declare function createBrowserCollaborationContext(
  options: BrowserCollaborationContextOptions,
): CollaborationContext;

export interface BrowserExtensionEditorHostOptions {
  filePath: string;
  fileName: string;
  collaboration: CollaborationContext;
  permissions?: BrowserExtensionPermissions;
  getTheme?(): string;
  subscribeToThemeChanges?(callback: (theme: string) => void): () => void;
  isActive?(): boolean;
  isVisible?(): boolean;
  subscribeToVisibilityChanges?(callback: (visible: boolean) => void): () => void;
  isReadOnly?(): boolean;
  subscribeToReadOnlyChanges?(callback: (readOnly: boolean) => void): () => void;
  getInitialContent?(): string;
  getInitialBinaryContent?(): ArrayBuffer;
  onDirtyChange?(isDirty: boolean): void;
  onOpenHistory?(): void;
  onMenuItemsChange?(items: EditorMenuItem[]): void;
  onEditorContextChange?(context: EditorContext | null): void;
  onEditorContextItemsChange?(items: EditorContextItem[] | null): void;
  onEditorAPIChange?(api: unknown | null): void;
  openExternal?(url: string): Promise<void>;
  onCapabilityRefused?(error: BrowserEditorCapabilityError): void;
}

/**
 * Build the browser-shaped `EditorHost`. Members for a capability this host
 * cannot provide reject or throw; optional ones are omitted entirely.
 */
export declare function createBrowserExtensionEditorHost(
  options: BrowserExtensionEditorHostOptions,
): BrowserExtensionEditorHost;

export interface BrowserExtensionEditorHost {
  readonly host: EditorHost;
  readonly capabilities: EditorHostCapabilities;
  readonly filesystemPermission: BrowserPermissionOutcome;
  getEditorAPI(): unknown | null;
  getMenuItems(): readonly EditorMenuItem[];
  notifyThemeChanged(theme: string): void;
  notifyVisibilityChanged(visible: boolean): void;
  notifyReadOnlyChanged(readOnly: boolean): void;
}

/**
 * Drain every registered binding's pending local content into the Y.Doc, then
 * wait for the server's persisted ack.
 */
export declare function flushBrowserCollaborativeContent(
  collaboration: CollaborationContext,
): Promise<boolean>;

/** What an extension's editor contribution exports. */
export type ExtensionEditorComponent = ComponentType<{ host: EditorHost }>;

export interface ExtensionEditorMountOptions {
  element: HTMLElement;
  source: CollabEditorSource;
  user: CollabEditorUser;
  component: ExtensionEditorComponent;
  fileName: string;
  documentId?: string;
  initialContent?: string;
  initialBinaryContent?: ArrayBuffer;
  permissions?: BrowserExtensionPermissions;
  readOnly?: boolean;
  theme?: string;
  onStateChange?(state: CollabEditorState): void;
  onPresenceChange?(presence: CollabEditorPresence): void;
  onWriteRejected?(rejection: CollabEditorWriteRejection): void;
  onTermination?(termination: CollabEditorTermination): void;
  onReady?(handle: ExtensionEditorHandle): void;
  onError?(error: Error): void;
  /**
   * The editor reached for something this host declared unavailable. The call
   * already failed; this is the page's chance to see it, because a rejection
   * inside an extension's effect is otherwise silent.
   */
  onCapabilityRefused?(error: BrowserEditorCapabilityError): void;
  onOpenHistory?(): void;
  onMenuItemsChange?(items: EditorMenuItem[]): void;
  onEditorContextChange?(context: EditorContext | null): void;
  onEditorContextItemsChange?(items: EditorContextItem[] | null): void;
  onRevisionAdapterChange?(adapter: RevisionSnapshotAdapter | null): void;
  openExternal?(url: string): Promise<void>;
}

export interface ExtensionEditorHandle {
  getDocument(): Doc;
  getState(): CollabEditorState;
  getPresence(): CollabEditorPresence;
  getHost(): EditorHost;
  readonly capabilities: EditorHostCapabilities;
  getEditorAPI(): unknown | null;
  getMenuItems(): readonly EditorMenuItem[];
  setPresenceActive(active: boolean): void;
  setTheme(theme: string): void;
  setVisible(visible: boolean): void;
  setReadOnly(readOnly: boolean): void;
  /** Drain pending binding content into the Y.Doc, then await the server ack. */
  flushContent(): Promise<boolean>;
  flush(options?: { timeoutMs?: number }): Promise<CollabEditorFlushResult>;
  markClean(): void;
  destroy(): void;
}

/**
 * Mount an extension-provided editor over a collaborative document: the
 * non-Lexical sibling of `mountCollabEditor`, sharing its transport,
 * termination and flush semantics.
 */
export declare function mountExtensionEditor(
  options: ExtensionEditorMountOptions,
): ExtensionEditorHandle;

export type { TextFormatType };
