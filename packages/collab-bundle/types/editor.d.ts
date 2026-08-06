import type { Binding, Provider, ProviderAwareness } from '@lexical/yjs';
import type { Klass, LexicalEditor, LexicalNode, TextFormatType } from 'lexical';
import type { Doc } from 'yjs';
import type { TeamJwt, TeamMemberId } from './internal/runtime/src/auth/jwtScopes';

declare const teamOrgIdBrand: unique symbol;
declare const teamProjectIdBrand: unique symbol;
declare const teamDocumentIdBrand: unique symbol;

export type { TeamJwt, TeamMemberId } from './internal/runtime/src/auth/jwtScopes';
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

export interface CollabEditorMountOptions {
  element: HTMLElement;
  source: CollabEditorSource;
  user: CollabEditorUser;
  readOnly?: boolean;
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

export type { TextFormatType };
