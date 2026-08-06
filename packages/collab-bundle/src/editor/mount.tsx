import React from 'react';
import { createRoot, type Root } from 'react-dom/client';
import {
  $getRoot,
  CONTROLLED_TEXT_INSERTION_COMMAND,
  FORMAT_TEXT_COMMAND,
  type LexicalEditor,
} from 'lexical';
import { encodeStateAsUpdate, type Doc } from 'yjs';

import type { EditorConfig } from '@nimbalyst/runtime/editor/EditorConfig';
import '@nimbalyst/runtime/editor/extensions/registerBuiltinExtensions';
import '@nimbalyst/runtime/editor/index.css';
import { registerBrowserReferenceNodes } from './referenceNodes';
import { CollabLexicalProvider } from '@nimbalyst/runtime/sync/CollabLexicalProvider';
import { DocumentSyncProvider } from '@nimbalyst/runtime/sync/DocumentSync';
import type {
  AwarenessState,
  DocumentSyncStatus,
} from '@nimbalyst/runtime/sync/documentSyncTypes';

import {
  BrowserEditorSurface,
  type PresenceSubscription,
} from './BrowserEditorSurface';
import './browserChrome.css';
import { applyBrowserEditorChrome } from './browserChrome';
import {
  CollabPresenceSurface,
  resolveCollabEditorUser,
} from './presence';

import type {
  CollabEditorFlushResult,
  CollabEditorHandle,
  CollabEditorMountOptions,
  CollabEditorState,
  CollabEditorTermination,
  CollabEditorWriteRejection,
} from './types';
import {
  classifyDocumentClose,
  parseDocumentServerSignal,
} from './serverSignals';

// Must run before any editor mounts: `@lexical/yjs` resolves node types against
// `editor._nodes` while applying the first update, and an unregistered type
// aborts the binding so nothing paints. A call rather than a bare import on
// purpose — see the header of `./referenceNodes`.
registerBrowserReferenceNodes();

class InMemoryDocumentSyncSurface {
  constructor(private readonly document: Doc) {}

  getYDoc(): Doc {
    return this.document;
  }

  getStatus(): DocumentSyncStatus {
    return 'connected';
  }

  async connect(): Promise<void> {}

  setLocalAwareness(_state: AwarenessState): void {}

  sendAwarenessDeparture(_user: AwarenessState['user']): boolean {
    return false;
  }

  onAwarenessChange(_listener: (states: Map<string, AwarenessState>) => void): () => void {
    return () => {};
  }
}

class BundleEditorErrorBoundary extends React.Component<{
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

function cloneState(state: CollabEditorState): CollabEditorState {
  return { ...state };
}

/**
 * Mount the collaborative editor in the host's DOM.
 *
 * Network hosts provide a team-room identity and a host-owned TeamJwt callback.
 * The bundle never reads browser storage, sessions, or personal credentials.
 * In-memory hosts are the transport-free harness seam and still use the same
 * CollabLexicalProvider per-mount editor-doc bridge as a live room.
 */
export function mountCollabEditor(options: CollabEditorMountOptions): CollabEditorHandle {
  const resolvedUser = resolveCollabEditorUser(options.user);
  if (options.source.kind === 'team-room'
    && options.source.auth.memberId !== resolvedUser.memberId) {
    throw new Error('The editor user must match the authenticated team member.');
  }
  let root: Root | null = createRoot(options.element);
  let lexicalEditor: LexicalEditor | null = null;
  let getMarkdown = (): string => '';
  let destroyed = false;
  let readyReported = false;
  let hostReadOnly = options.readOnly ?? false;
  let latestWriteRejection: CollabEditorWriteRejection | null = null;
  let transportState: 'not-created' | 'connecting' | 'open' | 'closed' = 'not-created';
  let observedSocket: WebSocket | null = null;
  const flushInterruptWaiters = new Set<(result: CollabEditorFlushResult) => void>();

  const state: CollabEditorState = {
    connection: options.source.kind === 'in-memory' ? 'local' : 'disconnected',
    edit: 'clean',
    readOnly: hostReadOnly,
    hostReadOnly,
    serverAccess: options.source.kind === 'in-memory' ? 'not-applicable' : 'unknown',
    termination: null,
  };

  const emitState = (): void => options.onStateChange?.(cloneState(state));
  const focusDocument = (): void => {
    // The DOM selection survives the trip to the toolbar, so re-focusing the
    // contentEditable puts the caret back exactly where the writer left it —
    // verified in a real browser across collapsed carets, range selections and
    // a dropdown round trip.
    const editable = options.element.querySelector<HTMLElement>('[contenteditable="true"]');
    if (editable) {
      editable.focus();
      return;
    }
    lexicalEditor?.focus();
  };
  const setDirty = (): void => {
    if (state.edit === 'dirty') return;
    state.edit = 'dirty';
    emitState();
  };
  const updateEffectiveReadOnly = (): boolean => {
    const nextReadOnly = hostReadOnly
      || state.serverAccess === 'read-only'
      || state.serverAccess === 'revoked';
    if (state.readOnly === nextReadOnly) return false;
    state.readOnly = nextReadOnly;
    return true;
  };
  const interruptFlushes = (result: CollabEditorFlushResult): void => {
    for (const resolve of flushInterruptWaiters) resolve(result);
    flushInterruptWaiters.clear();
  };
  const setServerAccess = (access: CollabEditorState['serverAccess']): void => {
    if (state.termination || state.serverAccess === access) return;
    state.serverAccess = access;
    const readOnlyChanged = updateEffectiveReadOnly();
    emitState();
    if (readOnlyChanged) renderEditor();
  };
  const setTermination = (termination: CollabEditorTermination): void => {
    if (state.termination) return;
    state.termination = termination;
    state.connection = 'terminated';
    state.serverAccess = 'revoked';
    const readOnlyChanged = updateEffectiveReadOnly();
    emitState();
    if (readOnlyChanged) renderEditor();
    options.onTermination?.(termination);
    interruptFlushes({ status: 'unavailable', reason: termination.reason });
  };

  let lexicalProvider: CollabLexicalProvider;
  let presenceSurface: CollabPresenceSurface;
  let networkProvider: DocumentSyncProvider | null = null;
  let removeInMemoryUpdateListener: (() => void) | null = null;
  let removePresenceListener: (() => void) | null = null;
  let removePresenceLifecycleListeners: (() => void) | null = null;

  if (options.source.kind === 'team-room') {
    const source = options.source;
    networkProvider = new DocumentSyncProvider({
      serverUrl: source.serverUrl,
      orgId: source.room.orgId,
      documentId: source.room.documentId,
      userId: source.auth.memberId,
      getJwt: source.auth.getTeamJwt,
      createWebSocket: (url) => {
        const socket = source.createWebSocket?.(url) ?? new WebSocket(url);
        observedSocket = socket;
        transportState = 'connecting';
        socket.addEventListener('open', () => {
          if (observedSocket !== socket) return;
          transportState = 'open';
        });
        socket.addEventListener('message', (event) => {
          if (observedSocket !== socket) return;
          const signal = parseDocumentServerSignal(event.data);
          if (!signal) return;
          if (signal.type === 'write-acknowledged') {
            setServerAccess('writable');
            return;
          }
          if (signal.type === 'read-only') {
            const rejection: CollabEditorWriteRejection = {
              code: 'document_read_only',
              message: signal.message,
              ...(signal.clientUpdateId ? { clientUpdateId: signal.clientUpdateId } : {}),
            };
            latestWriteRejection = rejection;
            setServerAccess('read-only');
            options.onWriteRejected?.(rejection);
            interruptFlushes({ status: 'rejected', rejection });
            return;
          }
          setTermination({
            reason: 'document-access-revoked',
            closeCode: 4003,
            message: signal.message,
          });
        });
        socket.addEventListener('close', (event) => {
          if (observedSocket !== socket) return;
          observedSocket = null;
          transportState = 'closed';
          const termination = classifyDocumentClose(event.code, event.reason);
          if (!termination) return;
          setTermination(termination);
          // Terminal authorization failures must not enter DocumentSync's
          // ordinary reconnect loop with credentials the server just revoked.
          networkProvider?.disconnect();
        });
        socket.addEventListener('error', () => {
          if (observedSocket !== socket) return;
          transportState = 'closed';
        });
        return socket;
      },
      onLocalUpdate: setDirty,
      onEditorBindingError: (cause) => {
        options.onBindingError?.(
          cause instanceof Error
            ? cause
            : new Error('The shared document could not be rendered.'),
        );
      },
      onStatusChange: (status) => {
        if (!state.termination) state.connection = status;
        lexicalProvider?.handleStatusChange(status);
        emitState();
      },
    });
    presenceSurface = new CollabPresenceSurface(networkProvider);
    lexicalProvider = new CollabLexicalProvider(presenceSurface as unknown as DocumentSyncProvider, {
      deferInitialSync: true,
    });
  } else {
    const sourceDocument = options.source.document;
    const syncSurface = new InMemoryDocumentSyncSurface(sourceDocument);
    presenceSurface = new CollabPresenceSurface(syncSurface);
    lexicalProvider = new CollabLexicalProvider(presenceSurface as unknown as DocumentSyncProvider);
    const onUpdate = (): void => setDirty();
    sourceDocument.on('update', onUpdate);
    removeInMemoryUpdateListener = () => sourceDocument.off('update', onUpdate);
  }
  removePresenceListener = presenceSurface.onPresenceChange((presence) => {
    options.onPresenceChange?.(presence);
  });
  // Stable across re-renders so the announcement region does not reset its
  // roster (and re-announce everyone) when read-only state flips.
  const subscribeToPresence: PresenceSubscription = (listener) => (
    presenceSurface.onPresenceChange(listener)
  );
  const lifecycleDocument = options.element.ownerDocument;
  const lifecycleWindow = lifecycleDocument.defaultView;
  if (lifecycleWindow) {
    const leavePresence = (): void => { presenceSurface.setActive(false); };
    const restorePresence = (): void => { presenceSurface.setActive(true); };
    const handleVisibilityChange = (): void => {
      presenceSurface.setActive(lifecycleDocument.visibilityState !== 'hidden');
    };
    lifecycleWindow.addEventListener('pagehide', leavePresence);
    lifecycleWindow.addEventListener('pageshow', restorePresence);
    lifecycleDocument.addEventListener('visibilitychange', handleVisibilityChange);
    removePresenceLifecycleListeners = () => {
      lifecycleWindow.removeEventListener('pagehide', leavePresence);
      lifecycleWindow.removeEventListener('pageshow', restorePresence);
      lifecycleDocument.removeEventListener('visibilitychange', handleVisibilityChange);
    };
  }

  const sharedDocument = networkProvider?.getYDoc()
    ?? (options.source.kind === 'in-memory' ? options.source.document : null);
  if (!sharedDocument) {
    throw new Error('Collaborative editor source did not provide a Y.Doc.');
  }

  const providerFactory: NonNullable<EditorConfig['collaboration']>['providerFactory'] = (
    id,
    yjsDocMap,
  ) => {
    lexicalProvider.prepareForBinding();
    yjsDocMap.set(id, lexicalProvider.getYDoc());
    return lexicalProvider;
  };

  const handle: CollabEditorHandle = {
    getDocument: () => sharedDocument,
    getMarkdown: () => getMarkdown(),
    getState: () => cloneState(state),
    getPresence: () => presenceSurface.getPresence(),
    setPresenceActive: (active) => { presenceSurface.setActive(active); },
    async flush(flushOptions) {
      if (destroyed) return { status: 'unavailable', reason: 'destroyed' };
      if (!networkProvider) return { status: 'not-required', reason: 'in-memory' };
      if (encodeStateAsUpdate(sharedDocument).length <= 2) {
        return { status: 'not-required', reason: 'empty-document' };
      }
      if (state.termination) {
        return { status: 'unavailable', reason: state.termination.reason };
      }
      if (state.serverAccess === 'read-only') {
        return latestWriteRejection
          ? { status: 'rejected', rejection: latestWriteRejection }
          : { status: 'unavailable', reason: 'server-read-only' };
      }
      if (state.connection === 'disconnected' || state.connection === 'error') {
        return { status: 'unavailable', reason: 'disconnected' };
      }
      if ((transportState === 'closed' || transportState === 'not-created')
        && state.connection !== 'connecting') {
        return { status: 'unavailable', reason: 'disconnected' };
      }
      const requestedTimeout = flushOptions?.timeoutMs ?? 5_000;
      const timeoutMs = Number.isFinite(requestedTimeout) && requestedTimeout > 0
        ? Math.floor(requestedTimeout)
        : 5_000;
      let removeInterruptWaiter = (): void => {};
      const interrupted = new Promise<CollabEditorFlushResult>((resolve) => {
        const waiter = (result: CollabEditorFlushResult): void => resolve(result);
        flushInterruptWaiters.add(waiter);
        removeInterruptWaiter = () => flushInterruptWaiters.delete(waiter);
      });
      try {
        return await Promise.race([
          networkProvider.flushWithAck(timeoutMs).then((acknowledged): CollabEditorFlushResult => {
            if (acknowledged) return { status: 'acknowledged' };
            if (state.termination) {
              return { status: 'unavailable', reason: state.termination.reason };
            }
            if (state.serverAccess === 'read-only') {
              return latestWriteRejection
                ? { status: 'rejected', rejection: latestWriteRejection }
                : { status: 'unavailable', reason: 'server-read-only' };
            }
            if (state.connection === 'disconnected' || state.connection === 'error') {
              return { status: 'unavailable', reason: 'disconnected' };
            }
            if (transportState === 'closed' || transportState === 'not-created') {
              return { status: 'unavailable', reason: 'disconnected' };
            }
            return { status: 'timed-out', timeoutMs };
          }),
          interrupted,
        ]);
      } catch (error) {
        const normalized = error instanceof Error ? error : new Error(String(error));
        options.onError?.(normalized);
        return { status: 'failed', message: normalized.message };
      } finally {
        removeInterruptWaiter();
      }
    },
    setReadOnly(nextReadOnly) {
      if (destroyed || hostReadOnly === nextReadOnly) return;
      hostReadOnly = nextReadOnly;
      state.hostReadOnly = nextReadOnly;
      const readOnlyChanged = updateEffectiveReadOnly();
      emitState();
      if (readOnlyChanged) renderEditor();
    },
    markClean() {
      if (state.edit === 'clean') return;
      state.edit = 'clean';
      emitState();
    },
    focus: focusDocument,
    insertText: (text) => {
      if (!lexicalEditor || state.readOnly) return;
      lexicalEditor.update(() => $getRoot().selectEnd(), { discrete: true });
      lexicalEditor.dispatchCommand(CONTROLLED_TEXT_INSERTION_COMMAND, text);
    },
    formatText: (format) => {
      if (state.readOnly) return;
      lexicalEditor?.dispatchCommand(FORMAT_TEXT_COMMAND, format);
    },
    destroy() {
      if (destroyed) return;
      destroyed = true;
      interruptFlushes({ status: 'unavailable', reason: 'destroyed' });
      presenceSurface.setActive(false);
      removePresenceLifecycleListeners?.();
      removePresenceLifecycleListeners = null;
      root?.unmount();
      root = null;
      lexicalProvider.destroy();
      removePresenceListener?.();
      removePresenceListener = null;
      presenceSurface.destroy();
      networkProvider?.destroy();
      removeInMemoryUpdateListener?.();
      removeInMemoryUpdateListener = null;
    },
  };

  function renderEditor(): void {
    if (!root || destroyed) return;
    const config: EditorConfig = {
      isRichText: true,
      editable: !state.readOnly,
      isCodeHighlighted: true,
      hasLinkAttributes: true,
      markdownOnly: true,
      collaboration: {
        providerFactory,
        shouldBootstrap: false,
        username: resolvedUser.displayName,
        cursorColor: resolvedUser.cursorColor,
      },
      onDirtyChange: (dirty) => {
        if (dirty) setDirty();
      },
      onGetContent: (reader) => {
        getMarkdown = reader;
      },
      onEditorReady: (editor) => {
        lexicalEditor = editor as LexicalEditor;
        applyBrowserEditorChrome(options.element);
        if (!readyReported) {
          readyReported = true;
          options.onReady?.(handle);
        }
      },
    };

    root.render(
      <BundleEditorErrorBoundary onError={(error) => options.onError?.(error)}>
        <BrowserEditorSurface
          config={config}
          subscribeToPresence={subscribeToPresence}
        />
      </BundleEditorErrorBoundary>,
    );
  }

  renderEditor();
  emitState();
  return handle;
}
