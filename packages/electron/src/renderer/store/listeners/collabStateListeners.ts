import type {
  DocumentSyncStatus,
  LocalDocumentReplicaOutboxState,
  LocalDocumentReplicaState,
} from '@nimbalyst/runtime/sync';
import { store } from '@nimbalyst/runtime/store';
import {
  DEFAULT_COLLAB_DOCUMENT_STATE,
  collabDocumentStateAtom,
} from '../atoms/collabEditor';

const TRANSPORT_DEBOUNCE_MS = 120;
const transportTimers = new Map<string, ReturnType<typeof setTimeout>>();

export function setCollabReplicaState(
  filePath: string,
  replica: LocalDocumentReplicaState,
): void {
  const atom = collabDocumentStateAtom(filePath);
  store.set(atom, { ...store.get(atom), replica });
}

export function setCollabOutboxState(
  filePath: string,
  outbox: LocalDocumentReplicaOutboxState,
): void {
  const atom = collabDocumentStateAtom(filePath);
  store.set(atom, { ...store.get(atom), outbox });
}

/** Debounces transport-only flaps while replica/outbox safety remains immediate. */
export function publishCollabTransportState(
  filePath: string,
  transport: DocumentSyncStatus,
): void {
  const existing = transportTimers.get(filePath);
  if (existing) clearTimeout(existing);
  transportTimers.set(filePath, setTimeout(() => {
    transportTimers.delete(filePath);
    const atom = collabDocumentStateAtom(filePath);
    store.set(atom, { ...store.get(atom), transport });
  }, TRANSPORT_DEBOUNCE_MS));
}

export function resetCollabDocumentState(filePath: string): void {
  const existing = transportTimers.get(filePath);
  if (existing) clearTimeout(existing);
  transportTimers.delete(filePath);
  store.set(collabDocumentStateAtom(filePath), DEFAULT_COLLAB_DOCUMENT_STATE);
}
