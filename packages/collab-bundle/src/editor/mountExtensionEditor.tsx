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
import type {
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

  const session = createCollabDocumentSession({
    source: options.source,
    memberId: resolvedUser.memberId,
    readOnly: options.readOnly,
    lifecycleElement: options.element,
    onStateChange: options.onStateChange,
    onPresenceChange: (presence) => options.onPresenceChange?.(presence),
    onWriteRejected: options.onWriteRejected,
    onTermination: options.onTermination,
    onError: options.onError,
    onBindingError: options.onError,
    onStatusChange: () => {
      const status = statusFromState(session.getState());
      for (const listener of statusListeners) listener(status);
    },
    onSurfaceInvalidated: () => {
      // Effective read-only can change without any user action: the server can
      // demote a writer mid-session. The extension is told through the host it
      // already holds, so nothing has to remount.
      notifyReadOnlyChanged(session.getState().readOnly);
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

  const collaboration = createBrowserCollaborationContext({
    yDoc: session.sharedDocument,
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
    destroy() {
      if (destroyed) return;
      destroyed = true;
      statusListeners.clear();
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
