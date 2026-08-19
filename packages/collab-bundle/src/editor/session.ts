/**
 * The transport half of a mounted collaborative document.
 *
 * Everything here was previously inlined in `mount.tsx`: connection state,
 * server-signal handling, terminal authorization loss, presence lifecycle and
 * the flush guards. None of it is Lexical-specific, and a second mount entry
 * point (extension-provided editors) needs exactly the same answers -- so it
 * lives in one place rather than being reimplemented next to a different
 * renderer, where the two would drift on the questions that matter most
 * (is this document writable, did the server actually persist that).
 *
 * The renderer on top supplies the parts that ARE its own: what to do when the
 * surface's capabilities drift (`onSurfaceInvalidated`), what to tear down
 * before the transport goes away (`destroy`'s `beforeTransportTeardown`).
 */

import { encodeStateAsUpdate, type Doc } from 'yjs';

import { DocumentSyncProvider } from '@nimbalyst/runtime/sync/DocumentSync';
import type {
  AwarenessState,
  DocumentSyncStatus,
} from '@nimbalyst/runtime/sync/documentSyncTypes';

import { deriveCollabEditorCommentsState } from './commenting';
import { CollabPresenceSurface } from './presence';
import {
  classifyDocumentClose,
  parseDocumentServerSignal,
} from './serverSignals';
import type {
  CollabEditorFlushResult,
  CollabEditorSource,
  CollabEditorState,
  CollabEditorTermination,
  CollabEditorWriteRejection,
  TeamMemberId,
} from './types';

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

export interface CollabDocumentSessionOptions {
  source: CollabEditorSource;
  /** The authenticated member. Must match a team-room source's auth. */
  memberId: TeamMemberId;
  /** Host presentation override. Never grants server write authority. */
  readOnly?: boolean;
  /** Element whose window/document drives presence backgrounding. */
  lifecycleElement: HTMLElement;
  /** The host's role-derived comment answer; see `deriveCollabEditorCommentsState`. */
  hostCanComment?(): boolean;

  onStateChange?(state: CollabEditorState): void;
  onPresenceChange?: Parameters<CollabPresenceSurface['onPresenceChange']>[0];
  onWriteRejected?(rejection: CollabEditorWriteRejection): void;
  onTermination?(termination: CollabEditorTermination): void;
  onError?(error: Error): void;
  onBindingError?(error: Error): void;
  /** Raw transport status, for renderers that bridge it (Lexical does). */
  onStatusChange?(status: DocumentSyncStatus): void;
  /** A local edit reached the Y.Doc. */
  onLocalUpdate?(): void;
  /**
   * What the editor is *allowed* to do may have drifted from what is on
   * screen. Renderers re-render from here; the session never renders.
   */
  onSurfaceInvalidated?(): void;
}

export interface CollabDocumentSession {
  readonly sharedDocument: Doc;
  readonly presence: CollabPresenceSurface;
  /** Null for an in-memory source. */
  readonly networkProvider: DocumentSyncProvider | null;
  getState(): CollabEditorState;
  /** Re-emit the current state, e.g. once the renderer's first paint is queued. */
  emitState(): void;
  /** Whether this user may author comments right now. */
  canComment(): boolean;
  hasConnectedOnce(): boolean;
  markDirty(): void;
  markClean(): void;
  setReadOnly(readOnly: boolean): void;
  flush(options?: { timeoutMs?: number }): Promise<CollabEditorFlushResult>;
  destroy(options?: { beforeTransportTeardown?: () => void }): void;
}

function cloneState(state: CollabEditorState): CollabEditorState {
  return { ...state };
}

export function createCollabDocumentSession(
  options: CollabDocumentSessionOptions,
): CollabDocumentSession {
  if (options.source.kind === 'team-room'
    && options.source.auth.memberId !== options.memberId) {
    throw new Error('The editor user must match the authenticated team member.');
  }

  let destroyed = false;
  let hasConnectedOnce = false;
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
  const setDirty = (): void => {
    if (state.edit === 'dirty') return;
    state.edit = 'dirty';
    emitState();
  };
  const updateEffectiveReadOnly = (): void => {
    state.readOnly = hostReadOnly
      || state.serverAccess === 'read-only'
      || state.serverAccess === 'revoked';
  };
  const hostCanComment = (): boolean => options.hostCanComment?.() ?? true;
  const commentsState = () => deriveCollabEditorCommentsState({
    connection: state.connection,
    serverAccess: state.serverAccess,
    hasConnectedOnce,
    hostCanComment: hostCanComment(),
  });
  const interruptFlushes = (result: CollabEditorFlushResult): void => {
    for (const resolve of flushInterruptWaiters) resolve(result);
    flushInterruptWaiters.clear();
  };
  const setServerAccess = (access: CollabEditorState['serverAccess']): void => {
    if (state.termination || state.serverAccess === access) return;
    state.serverAccess = access;
    updateEffectiveReadOnly();
    emitState();
    options.onSurfaceInvalidated?.();
  };
  const setTermination = (termination: CollabEditorTermination): void => {
    if (state.termination) return;
    state.termination = termination;
    state.connection = 'terminated';
    state.serverAccess = 'revoked';
    updateEffectiveReadOnly();
    emitState();
    options.onSurfaceInvalidated?.();
    options.onTermination?.(termination);
    interruptFlushes({ status: 'unavailable', reason: termination.reason });
  };

  let networkProvider: DocumentSyncProvider | null = null;
  let presenceSurface: CollabPresenceSurface;
  let removeInMemoryUpdateListener: (() => void) | null = null;
  let removePresenceListener: (() => void) | null = null;
  let removePresenceLifecycleListeners: (() => void) | null = null;

  if (options.source.kind === 'team-room') {
    const source = options.source;
    networkProvider = new DocumentSyncProvider({
      serverUrl: source.serverUrl,
      orgId: source.room.orgId,
      documentId: source.room.documentId,
      teamMemberId: source.auth.memberId,
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
      onLocalUpdate: () => {
        setDirty();
        options.onLocalUpdate?.();
      },
      onEditorBindingError: (cause) => {
        options.onBindingError?.(
          cause instanceof Error
            ? cause
            : new Error('The shared document could not be rendered.'),
        );
      },
      onStatusChange: (status) => {
        if (!state.termination) state.connection = status;
        hasConnectedOnce = commentsState().hasConnectedOnce;
        options.onStatusChange?.(status);
        emitState();
      },
    });
    presenceSurface = new CollabPresenceSurface(networkProvider);
  } else {
    const sourceDocument = options.source.document;
    presenceSurface = new CollabPresenceSurface(
      new InMemoryDocumentSyncSurface(sourceDocument),
    );
    const onUpdate = (): void => {
      setDirty();
      options.onLocalUpdate?.();
    };
    sourceDocument.on('update', onUpdate);
    removeInMemoryUpdateListener = () => sourceDocument.off('update', onUpdate);
  }

  removePresenceListener = presenceSurface.onPresenceChange((presence) => {
    options.onPresenceChange?.(presence);
  });

  const lifecycleDocument = options.lifecycleElement.ownerDocument;
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

  return {
    sharedDocument,
    presence: presenceSurface,
    networkProvider,
    getState: () => cloneState(state),
    emitState,
    canComment: () => commentsState().capabilities.comment,
    hasConnectedOnce: () => hasConnectedOnce,
    markDirty: setDirty,
    markClean() {
      if (state.edit === 'clean') return;
      state.edit = 'clean';
      emitState();
    },
    setReadOnly(nextReadOnly) {
      if (destroyed || hostReadOnly === nextReadOnly) return;
      hostReadOnly = nextReadOnly;
      state.hostReadOnly = nextReadOnly;
      updateEffectiveReadOnly();
      emitState();
      options.onSurfaceInvalidated?.();
    },
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
    destroy(destroyOptions) {
      if (destroyed) return;
      destroyed = true;
      interruptFlushes({ status: 'unavailable', reason: 'destroyed' });
      presenceSurface.setActive(false);
      removePresenceLifecycleListeners?.();
      removePresenceLifecycleListeners = null;
      // The renderer tears down between presence going inactive and the
      // presence surface being destroyed: a Lexical provider announces its
      // departure through this surface on the way out, and a destroyed surface
      // would swallow it.
      destroyOptions?.beforeTransportTeardown?.();
      removePresenceListener?.();
      removePresenceListener = null;
      presenceSurface.destroy();
      networkProvider?.destroy();
      removeInMemoryUpdateListener?.();
      removeInMemoryUpdateListener = null;
    },
  };
}
