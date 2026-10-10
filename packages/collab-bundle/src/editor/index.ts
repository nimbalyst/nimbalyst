export { mountCollabEditor } from './mount';
export { resolveCollabEditorUser } from './presence';
// A host renders placed views (tracker views in a page) inside its own tracker provider.
export { setBrowserPlacedViewRenderer, type BrowserPlacedViewRenderer } from './documentEmbeds';
// The live placed view the host renders there, loaded when a page with a view
// opens. Here rather than in `./trackers-ui` because its 2x2 chart is part of
// the editor graph; the host still wraps it in its `TrackersUIProvider`.
export const loadPlacedViewEmbed = () => import('@nimbalyst/collab-client/trackers-ui/embed');
// Host hooks the editor's page marks and citation chips read: who a new mark
// is by, and what a citation can open on this host.
export { setPageMarkAuthorProvider, type PageMarkAuthor } from '@nimbalyst/runtime/editor/plugins/PageMarkPlugin/pageMarkHost';
export { setCitationHost, type CitationHost } from '@nimbalyst/runtime/editor/plugins/CitationPlugin/citationHost';
export {
  setConsoleLinkOpener,
  setPageReferenceOpener,
  type ConsoleLinkOpener,
  type PageReferenceOpener,
} from './consoleLinkOpener';
// Relative file links (`Personas/CMO.md`): a host that serves a folder of pages resolves them itself.
export { setWorkspaceFileLinkOpener, type WorkspaceFileLinkOpener } from '@nimbalyst/runtime/editor/utils/workspaceLinkNavigation';
// trackers-ui must not load the editor graph, so the host builds the views controller from this entry.
export { createNamedPageViewsController, type NamedPageViewsController } from '@nimbalyst/runtime/editor/plugins/EmbedPlugin/namedPageViewsController';
// Page history: the markdown diff and revision projection. The dialog is in `./docs-ui`.
export { DiffPreviewEditor, previewMarkdownRevisionSnapshot, type DiffNavigationState } from './pageHistory';

// Extension-provided editors. The Lexical mount above is one tenant of the
// collaborative session; this is the generic one, for editors an extension
// bundle supplies. See `browserEditorCapabilities` for what a browser host
// can and cannot do for them.
export { mountExtensionEditor } from './mountExtensionEditor';
export type {
  ExtensionEditorComponent,
  ExtensionEditorHandle,
  ExtensionEditorMountOptions,
} from './mountExtensionEditor';
export {
  BrowserEditorCapabilityError,
  BROWSER_EDITOR_CAPABILITY_GAPS,
  BROWSER_EDITOR_ENVIRONMENT,
  BROWSER_EDITOR_SUPPORTED_CAPABILITIES,
  createBrowserEditorCapabilities,
  resolveBrowserFilesystemPermission,
} from './browserEditorCapabilities';
export type {
  BrowserEditorGrantedCapabilities,
  BrowserExtensionPermissions,
  BrowserPermissionOutcome,
  EditorHostCapabilities,
  EditorHostCapability,
  EditorHostCapabilityGap,
} from './browserEditorCapabilities';
export {
  browserDocumentPath,
  createBrowserCollaborationContext,
  createBrowserExtensionEditorHost,
  flushBrowserCollaborativeContent,
} from './browserExtensionHost';
export type {
  BrowserCollaborationContextOptions,
  BrowserExtensionEditorHost,
  BrowserExtensionEditorHostOptions,
} from './browserExtensionHost';
// Live tracker reference views. The node renderer registered in
// `./referenceNodes` uses these; hosts reuse them for surfaces outside the
// document (a wiki page's backlinks) under the same resolver context. The
// resolver and its provider come from `./trackers-ui`.
export {
  LiveTrackerReferenceRenderer,
  TrackerReferenceChipView,
  TrackerReferenceResolverProvider,
} from '@nimbalyst/collab-client/trackers-ui/references';
export type {
  LiveTrackerReferenceRendererProps,
  TrackerReferenceViewKind,
} from '@nimbalyst/collab-client/trackers-ui/references';
// Tracker body seeding carries the Markdown/Lexical codec, so it ships here
// and hosts inject it into `BrowserTrackerDataSource` from `./trackers-ui`.
export { openBrowserDocumentRoom, readDocumentRoomMarkdown, seedTrackerBody } from '@nimbalyst/collab-client/trackers/body';
export type { BrowserDocumentRoomOptions } from '@nimbalyst/collab-client/trackers/body';
export type { TrackerBodyRoom, TrackerBodySeeder } from '@nimbalyst/collab-client/trackers/body';
export { installCollabEditorBridge } from './bridge';
export type {
  BridgeAuthResponse,
  BridgeFlushRequest,
  BridgeMountRequest,
  EditorBridgeMessage,
  InstallEditorBridgeOptions,
  NimbalystEditorBridgeApi,
} from './bridge';
export type {
  CollabEditorConnectionState,
  CollabEditorCommentsOptions,
  CollabEditorFlushResult,
  CollabEditorHandle,
  CollabEditorMountOptions,
  CollabEditorParticipant,
  CollabEditorPresence,
  CollabEditorSource,
  CollabEditorState,
  CollabEditorServerAccess,
  CollabEditorTermination,
  CollabEditorUser,
  CollabEditorWriteRejection,
  CommentMember,
  InMemorySource,
  PlacedViewTypeOption,
  PlacedViewTypeSource,
  ResolvedCollabEditorUser,
  TeamDocumentId,
  TeamJwt,
  TeamMemberId,
  TeamOrgId,
  TeamProjectId,
  TeamRoomAuth,
  TeamRoomIdentity,
  TeamRoomSource,
  TextFormatType,
  TrackerReferenceResolver,
} from './types';
export {
  asTeamJwt,
  asTeamMemberId,
  asTeamDocumentId,
  asTeamOrgId,
  asTeamProjectId,
} from './types';

// Advanced codec-host exports remain behind the editor entry. The docs-ui
// entry does not pull them, and mobile hosts never need to import the shell.
export {
  CollabLexicalProvider,
  HeadlessLexicalYDoc,
  MarkdownCollabContentAdapter,
} from '@nimbalyst/runtime/collab-lexical';
export type { HeadlessLexicalYDocOptions } from '@nimbalyst/runtime/collab-lexical';
