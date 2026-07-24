import { atom } from 'jotai';
import { atomFamily } from '../debug/atomFamilyRegistry';
import type {
  DocumentSyncStatus,
  LocalDocumentReplicaOutboxState,
  LocalDocumentReplicaState,
} from '@nimbalyst/runtime/sync';

export interface CollabDocumentState {
  replica: LocalDocumentReplicaState;
  transport: DocumentSyncStatus;
  outbox: LocalDocumentReplicaOutboxState;
}

export type CollabProductStatusKind =
  | 'opening-local-copy'
  | 'connecting'
  | 'synced'
  | 'offline-safe'
  | 'replaying'
  | 'access-changed'
  | 'local-copy-damaged'
  | 'local-saving-unavailable';

export interface CollabProductStatus {
  kind: CollabProductStatusKind;
  label: string;
  detail: string | null;
  severity: 'neutral' | 'info' | 'success' | 'warning' | 'error';
  showPresence: boolean;
  showRejectedActions: boolean;
}

export const DEFAULT_COLLAB_DOCUMENT_STATE: CollabDocumentState = {
  replica: 'loading',
  transport: 'disconnected',
  outbox: 'clean',
};

export function deriveCollabProductStatus(
  state: CollabDocumentState,
): CollabProductStatus {
  if (state.replica === 'corrupt') {
    return {
      kind: 'local-copy-damaged',
      label: 'Local copy damaged — downloading a clean copy',
      detail: 'The damaged local replica was quarantined. A complete copy will be downloaded when the server is reachable.',
      severity: 'error',
      showPresence: false,
      showRejectedActions: state.outbox === 'rejected',
    };
  }
  if (state.replica === 'unavailable') {
    return {
      kind: 'local-saving-unavailable',
      label: 'Changes are not saved locally',
      detail: 'Local persistence is unavailable. Keep this document open and reconnect before closing it.',
      severity: 'error',
      showPresence: state.transport === 'connected',
      showRejectedActions: state.outbox === 'rejected',
    };
  }
  if (state.replica === 'loading') {
    return {
      kind: 'opening-local-copy',
      label: 'Opening local copy…',
      detail: null,
      severity: 'neutral',
      showPresence: false,
      showRejectedActions: state.outbox === 'rejected',
    };
  }
  if (state.outbox === 'rejected') {
    return {
      kind: 'access-changed',
      label: 'Access changed — local edits have not been uploaded',
      detail: 'Copy the current document before discarding this local copy.',
      severity: 'error',
      showPresence: false,
      showRejectedActions: true,
    };
  }
  if (state.outbox === 'replaying' || state.transport === 'replaying') {
    return {
      kind: 'replaying',
      label: 'Syncing offline changes…',
      detail: null,
      severity: 'info',
      showPresence: false,
      showRejectedActions: false,
    };
  }
  // A pending outbox while connected is normal in-flight typing (every
  // keystroke enqueues durably, the server ack clears it moments later).
  // Surfacing it flip-flopped the pill between "Synced" and "Syncing…" on
  // every keystroke. A genuine post-reconnect backlog reports the distinct
  // outbox 'replaying' state, which is handled above.
  if (state.transport === 'connected') {
    return {
      kind: 'synced',
      label: 'Synced',
      detail: null,
      severity: 'success',
      showPresence: true,
      showRejectedActions: false,
    };
  }
  if (state.transport === 'connecting' || state.transport === 'syncing') {
    return {
      kind: 'connecting',
      label: 'Connecting…',
      detail: null,
      severity: 'info',
      showPresence: false,
      showRejectedActions: false,
    };
  }
  return {
    kind: 'offline-safe',
    label: 'Offline — changes saved on this device',
    detail: 'Offline changes are saved locally and shared with other open windows on this device.',
    severity: 'warning',
    showPresence: false,
    showRejectedActions: false,
  };
}

export function deriveLegacyDocumentSyncStatus(
  state: CollabDocumentState,
): DocumentSyncStatus {
  if (state.outbox === 'rejected') return 'offline-unsynced';
  if (state.outbox === 'replaying') return 'replaying';
  if (state.outbox === 'pending') {
    return state.transport === 'connected' ? 'replaying' : 'offline-unsynced';
  }
  return state.transport;
}

/** Authoritative three-dimensional state per collaborative document. */
export const collabDocumentStateAtom = atomFamily(
  (_uri: string) => atom<CollabDocumentState>(DEFAULT_COLLAB_DOCUMENT_STATE)
);

export const collabProductStatusAtom = atomFamily(
  (uri: string) => atom((get) => deriveCollabProductStatus(get(collabDocumentStateAtom(uri))))
);

/** Legacy single transport view for surfaces not yet migrated. */
export const collabConnectionStatusAtom = atomFamily(
  (uri: string) => atom(
    (get) => deriveLegacyDocumentSyncStatus(get(collabDocumentStateAtom(uri))),
    (get, set, transport: DocumentSyncStatus) => {
      set(collabDocumentStateAtom(uri), {
        ...get(collabDocumentStateAtom(uri)),
        transport,
      });
    },
  )
);

export interface RemoteUser {
  name: string;
  color: string;
}

/** Remote user awareness per collab document. */
export const collabAwarenessAtom = atomFamily(
  (_uri: string) => atom<Map<string, RemoteUser>>(new Map())
);

export function hasCollabUnsyncedChanges(status: DocumentSyncStatus): boolean {
  return status === 'offline-unsynced' || status === 'replaying';
}

/**
 * Monotonically increasing counter bumped when the org encryption key is rotated.
 * CollaborativeTabEditor watches this to teardown/recreate providers with the new key.
 */
export const collabKeyRotationEpochAtom = atom(0);
