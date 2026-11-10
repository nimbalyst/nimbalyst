/**
 * Mount an extension-provided editor over a collaborative document.
 *
 * The non-Lexical sibling of `mountCollabEditor`. Same transport, same
 * connection/termination/flush semantics (both sit on `./session`), but the
 * thing that paints is a React component the extension shipped, and what it
 * receives is the SDK's `EditorHost` rather than a Lexical config.
 *
 * The bundle deliberately knows nothing about which extension this is. It is
 * handed a component and, later, a codec; loading bundles, resolving document
 * types and deciding which editor owns a file all belong to the embedding page.
 */

import React from 'react';
import { createRoot, type Root } from 'react-dom/client';

import { createExtensionAwarenessBridge } from '@nimbalyst/runtime/sync/extensionAwarenessBridge';
import type {
  CollaborationStatus,
  EditorContext,
  EditorContextItem,
  EditorHost,
  EditorMenuItem,
  EditorViewport,
  RevisionSnapshotAdapter,
} from '@nimbalyst/extension-sdk/types/editor';
import type { Doc } from 'yjs';

import {
  browserDocumentPath,
  createBrowserCollaborationContext,
  createBrowserExtensionEditorHost,
  flushBrowserCollaborativeContent,
  type BrowserExtensionEditorHost,
} from './browserExtensionHost';
import type {
  BrowserEditorCapabilityError,
  BrowserExtensionPermissions,
  EditorHostCapabilities,
} from './browserEditorCapabilities';
import { resolveCollabEditorUser } from './presence';
import { createCollabDocumentSession } from './session';
import {
  createExtensionCommentsService,
  type HostedExtensionComments,
} from './extensionComments';
import type {
  CollabEditorCommentsOptions,
  CollabEditorFlushResult,
  CollabEditorPresence,
  CollabEditorSource,
  CollabEditorState,
  CollabEditorTermination,
  CollabEditorUser,
  CollabEditorWriteRejection,
} from './types';

/** What an extension's editor contribution exports. */
export type ExtensionEditorComponent = React.ComponentType<{ host: EditorHost }>;

export interface ExtensionEditorMountOptions {
  element: HTMLElement;
  source: CollabEditorSource;
  user: CollabEditorUser;
  /** The extension's editor component, already loaded by the page. */
  component: ExtensionEditorComponent;

  /** Display name of the document, e.g. `budget.csv`. */
  fileName: string;
  /**
   * Stable document identity for `host.filePath`. Defaults to the team room's
   * document id, or the file name for an in-memory source.
   */
  documentId?: string;
  /**
   * Seed content used when this client is the first to open the document.
   * Absent means "there is nothing local to seed from" and the Y.Doc is filled
   * by the server's sync response.
   */
  initialContent?: string;
  /** Bytes for `host.loadBinaryContent()`; absent leaves that capability absent. */
  initialBinaryContent?: ArrayBuffer;

  /** The extension's manifest permissions, so the host can answer them. */
  permissions?: BrowserExtensionPermissions;

  /**
   * The page's comment seam -- the same object the Lexical mount takes.
   * Supplying it puts a `comments` service on the collaboration context the
   * extension receives; omitting it leaves `collaboration.comments` absent, and
   * an extension that offers commenting hides the affordance rather than
   * simulating it locally.
   */
  comments?: CollabEditorCommentsOptions;

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

  /** Optional host surfaces. Supplying one grants the matching capability. */
  onOpenHistory?(): void;
  onMenuItemsChange?(items: EditorMenuItem[]): void;
  onEditorContextChange?(context: EditorContext | null): void;
  onEditorContextItemsChange?(items: EditorContextItem[] | null): void;
  onRevisionAdapterChange?(adapter: RevisionSnapshotAdapter | null): void;
  openExternal?(url: string): Promise<void>;
  onViewportRegistered?(viewport: EditorViewport | null): void;

  /**
   * Offer this document a raw-source view, granting the `sourceMode`
   * capability. Only a page that has somewhere to render one and a codec that
   * can project this document to text and back may set it.
   *
   * **The mount owns the flag, not the page.** Two things drive it -- the
   * extension calling `host.toggleSourceMode()`, and the page's own control --
   * and a second copy of the answer is a second copy that can be wrong. It also
   * has to survive a page re-render, because the alternative shape (swap which
   * component the page passes) makes the toggle a mount dependency, and a new
   * `component` destroys a live Y.Doc behind a flush. The component this mount
   * is given renders both modes and picks between them from
   * `host.onSourceModeChanged`, so a toggle costs nothing but a React render.
   */
  enableSourceMode?: boolean;
  /** Told whenever the mode changes, so the page can update its own chrome. */
  onSourceModeChange?(active: boolean): void;

  /**
   * Render as an embed rather than a full page, so the extension drops chrome
   * that only makes sense at page scale. An inline preview or a detail popover
   * sets this; the document page does not.
   */
  embedded?: boolean;
}

export interface ExtensionEditorHandle {
  getDocument(): Doc;
  getState(): CollabEditorState;
  getPresence(): CollabEditorPresence;
  /** The host handed to the editor. Exposed for diagnostics and tests. */
  getHost(): EditorHost;
  readonly capabilities: EditorHostCapabilities;
  /** The imperative API the editor published via `registerEditorAPI`. */
  getEditorAPI(): unknown | null;
  getMenuItems(): readonly EditorMenuItem[];
  setPresenceActive(active: boolean): void;
  /** Relabel this participant once the host resolves a name; see `CollabEditorHandle.setUser`. */
  setUser(user: CollabEditorUser): void;
  setTheme(theme: string): void;
  setVisible(visible: boolean): void;
  setReadOnly(readOnly: boolean): void;
  /**
   * Drain the binding's pending local content into the Y.Doc, then wait for the
   * server's persisted ack. This is the extension-editor equivalent of the
   * markdown flush, and it drains first on purpose: a binding that debounces
   * its pushes holds the newest edit outside the CRDT, where a peer update can
   * still discard it.
   */
  flushContent(): Promise<boolean>;
  /** Wait for the room's persisted ack without draining bindings first. */
  flush(options?: { timeoutMs?: number }): Promise<CollabEditorFlushResult>;
  markClean(): void;
  /**
   * Re-publish comment capability to the mounted extension.
   *
   * The counterpart of `CollabEditorHandle.refreshCommentAccess`. `canComment`
   * is answered by the page from a roster that resolves after this mount, so
   * the first answer on a cold open is "not yet known" and the affordance is
   * correctly absent; this is what makes it appear once the real answer lands.
   */
  refreshCommentAccess(): void;
  /**
   * Whether the raw-source view is showing. Always false for a mount that was
   * not granted source mode.
   */
  isSourceModeActive(): boolean;
  /**
   * Drive the source view from the page's own control, the counterpart of the
   * extension calling `host.toggleSourceMode()`. Both end up here, so the two
   * can never disagree. A no-op when source mode was not granted.
   */
  setSourceMode(active: boolean): void;
  destroy(): void;
}

class ExtensionEditorErrorBoundary extends React.Component<{
  children: React.ReactNode;
  onError: (error: Error) => void;
}, { failed: boolean }> {
  state = { failed: false };

  static getDerivedStateFromError(): { failed: boolean } {
    return { failed: true };
  }

  componentDidCatch(error: Error): void {
    this.props.onError(error);
  }

  render(): React.ReactNode {
    return this.state.failed ? null : this.props.children;
  }
}

function statusFromState(state: CollabEditorState): CollaborationStatus {
  // `local` and `terminated` are bundle-level states with no SDK equivalent.
  // A local (harness) document is fully synced by definition; a terminated one
  // is not connected, and the SDK contract says treat anything that is not
  // `connected` as "the server may not have our latest edits".
  if (state.connection === 'local') return 'connected';
  if (state.connection === 'terminated') return 'disconnected';
  return state.connection;
}

export function mountExtensionEditor(
  options: ExtensionEditorMountOptions,
): ExtensionEditorHandle {
  const resolvedUser = resolveCollabEditorUser(options.user);
  const documentId = options.documentId
    ?? (options.source.kind === 'team-room'
      ? options.source.room.documentId
      : options.fileName);

  let root: Root | null = createRoot(options.element);
  let destroyed = false;
  let theme = options.theme ?? 'auto';
  let visible = true;
  const statusListeners = new Set<(status: CollaborationStatus) => void>();
  // Assigned once the host exists. The session can report a status or a
  // read-only demotion from inside its own construction, before there is a
  // host to tell.
  let notifyReadOnlyChanged: (readOnly: boolean) => void = () => {};
  // Same reason, and the same guard: the session reports its first status from
  // inside its own construction, before this has been built.
  let hostedComments: HostedExtensionComments | null = null;
  let sourceModeActive = false;
  const sourceModeListeners = new Set<(active: boolean) => void>();
  const setSourceMode = (active: boolean): void => {
    if (destroyed || !options.enableSourceMode || sourceModeActive === active) return;
    sourceModeActive = active;
    for (const listener of sourceModeListeners) listener(active);
    options.onSourceModeChange?.(active);
  };

  const hostCanComment = (): boolean => options.comments?.canComment?.() ?? true;
  const hostCanEditBody = (): boolean => options.comments?.canEditBody?.() ?? true;

  const session = createCollabDocumentSession({
    source: options.source,
    memberId: resolvedUser.memberId,
    readOnly: options.readOnly,
    lifecycleElement: options.element,
    hostCanComment,
    hostCanEditBody,
    onStateChange: options.onStateChange,
    onPresenceChange: (presence) => options.onPresenceChange?.(presence),
    onWriteRejected: options.onWriteRejected,
    onTermination: options.onTermination,
    onError: options.onError,
    onBindingError: options.onError,
    onStatusChange: () => {
      const status = statusFromState(session.getState());
      for (const listener of statusListeners) listener(status);
      // Hydration and comment capability both move with the connection, and an
      // extension subscribed to the comments service is otherwise not told.
      hostedComments?.notifyCapabilitiesChanged();
    },
    onSurfaceInvalidated: () => {
      // Effective read-only can change without any user action: the server can
      // demote a writer mid-session. The extension is told through the host it
      // already holds, so nothing has to remount.
      notifyReadOnlyChanged(session.getState().readOnly);
      hostedComments?.notifyCapabilitiesChanged();
    },
  });

  const awarenessBridge = createExtensionAwarenessBridge({
    syncProvider: session.presence,
    yDoc: session.sharedDocument,
    user: {
      id: resolvedUser.memberId,
      name: resolvedUser.displayName,
      color: resolvedUser.cursorColor,
    },
    // CollabPresenceSurface already re-announces on its own cadence and stamps
    // the freshness metadata bundle peers expire each other on. A second
    // heartbeat here would just double the traffic.
    heartbeatIntervalMs: 0,
  });

  // Built only when the page supplied a comment seam. Everything it needs --
  // who the author is, who can be mentioned, whether this role may comment at
  // all -- comes from the page's authenticated session; there is no honest way
  // to synthesize any of it here, so the absent case stays absent.
  const commentsOptions = options.comments;
  hostedComments = commentsOptions
    ? createExtensionCommentsService({
      yDoc: session.sharedDocument,
      host: {
        currentUser: commentsOptions.currentUser,
        documentId: commentsOptions.documentId,
        documentTitle: commentsOptions.documentTitle,
        documentUri: commentsOptions.documentUri,
        // Two tabs on one document must not share anchor registrations.
        instanceId: `${commentsOptions.documentUri}#${crypto.randomUUID()}`,
        getMembers: () => commentsOptions.getMembers(),
        // Includes `editBody`, false for a commenter.
        getCapabilities: () => session.commentCapabilities(),
        isHydrated: () => session.hasConnectedOnce(),
        onMention: commentsOptions.onMention,
        onReply: commentsOptions.onReply,
      },
    })
    : null;

  const collaboration = createBrowserCollaborationContext({
    yDoc: session.sharedDocument,
    ...(hostedComments ? { comments: hostedComments.service } : {}),
    awareness: awarenessBridge.awareness,
    user: {
      id: resolvedUser.memberId,
      name: resolvedUser.displayName,
      color: resolvedUser.cursorColor,
    },
    getStatus: () => statusFromState(session.getState()),
    onStatusChange: (callback) => {
      statusListeners.add(callback);
      return () => statusListeners.delete(callback);
    },
    loadInitialContent: async () => options.initialContent ?? '',
    flushWithAck: async (timeoutMs) => {
      const result = await session.flush(timeoutMs ? { timeoutMs } : undefined);
      // `not-required` covers the in-memory harness and a genuinely empty
      // document; neither is a failed persist, and reporting false there would
      // make the SDK's seed path warn on every harness run.
      return result.status === 'acknowledged' || result.status === 'not-required';
    },
    reportSeedOutcome: (outcome) => {
      if (outcome.ok) return;
      const cause = outcome.error instanceof Error
        ? outcome.error
        : new Error(String(outcome.error ?? 'The shared document seed was not confirmed.'));
      options.onError?.(cause);
    },
    onRevisionAdapterChange: options.onRevisionAdapterChange,
  });

  const browserHost: BrowserExtensionEditorHost = createBrowserExtensionEditorHost({
    filePath: browserDocumentPath(documentId, options.fileName),
    fileName: options.fileName,
    collaboration,
    permissions: options.permissions,
    getTheme: () => theme,
    isVisible: () => visible,
    isReadOnly: () => session.getState().readOnly,
    getInitialContent: () => options.initialContent ?? '',
    getInitialBinaryContent: options.initialBinaryContent
      ? () => options.initialBinaryContent as ArrayBuffer
      : undefined,
    onDirtyChange: (isDirty) => {
      if (isDirty) session.markDirty();
      else session.markClean();
    },
    onOpenHistory: options.onOpenHistory,
    onMenuItemsChange: options.onMenuItemsChange,
    onEditorContextChange: options.onEditorContextChange,
    onEditorContextItemsChange: options.onEditorContextItemsChange,
    openExternal: options.openExternal,
    onViewportRegistered: options.onViewportRegistered,
    // Supplying `toggleSourceMode` is the grant, so it stays undefined unless
    // the page asked for it -- the capability table reads exactly this.
    toggleSourceMode: options.enableSourceMode
      ? () => setSourceMode(!sourceModeActive)
      : undefined,
    isSourceModeActive: () => sourceModeActive,
    subscribeToSourceModeChanges: (callback) => {
      sourceModeListeners.add(callback);
      return () => {
        sourceModeListeners.delete(callback);
      };
    },
    embedded: options.embedded,
    onCapabilityRefused: options.onCapabilityRefused,
  });
  notifyReadOnlyChanged = (readOnly) => browserHost.notifyReadOnlyChanged(readOnly);

  // Nothing else opens the socket on this path. The markdown mount gets it for
  // free because Lexical's CollaborationPlugin connects the provider it is
  // handed; an extension editor never touches the provider.
  void Promise.resolve(session.presence.connect()).catch((error: unknown) => {
    options.onError?.(error instanceof Error ? error : new Error(String(error)));
  });

  const Component = options.component;
  const handle: ExtensionEditorHandle = {
    getDocument: () => session.sharedDocument,
    getState: () => session.getState(),
    getPresence: () => session.presence.getPresence(),
    getHost: () => browserHost.host,
    capabilities: browserHost.capabilities,
    getEditorAPI: () => browserHost.getEditorAPI(),
    getMenuItems: () => browserHost.getMenuItems(),
    setPresenceActive: (active) => { session.presence.setActive(active); },
    setUser: (user) => { session.presence.setDisplayName(resolveCollabEditorUser(user).displayName); },
    setTheme: (nextTheme) => {
      if (destroyed || theme === nextTheme) return;
      theme = nextTheme;
      browserHost.notifyThemeChanged(nextTheme);
    },
    setVisible: (nextVisible) => {
      if (destroyed || visible === nextVisible) return;
      visible = nextVisible;
      browserHost.notifyVisibilityChanged(nextVisible);
    },
    setReadOnly: (nextReadOnly) => {
      if (destroyed) return;
      session.setReadOnly(nextReadOnly);
    },
    flushContent: () => flushBrowserCollaborativeContent(collaboration),
    flush: (flushOptions) => session.flush(flushOptions),
    markClean: () => session.markClean(),
    refreshCommentAccess: () => {
      session.refreshHostAccess();
      hostedComments?.notifyCapabilitiesChanged();
    },
    isSourceModeActive: () => sourceModeActive,
    setSourceMode: (active) => setSourceMode(active),
    destroy() {
      if (destroyed) return;
      destroyed = true;
      statusListeners.clear();
      sourceModeListeners.clear();
      hostedComments?.destroy();
      session.destroy({
        beforeTransportTeardown: () => {
          root?.unmount();
          root = null;
          awarenessBridge.destroy();
        },
      });
    },
  };

  root.render(
    <ExtensionEditorErrorBoundary onError={(error) => options.onError?.(error)}>
      <Component host={browserHost.host} />
    </ExtensionEditorErrorBoundary>,
  );
  session.emitState();
  options.onReady?.(handle);
  return handle;
}
