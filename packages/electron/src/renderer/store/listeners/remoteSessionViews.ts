import {stytchAuthAtom} from '../atoms/stytchAuth';
import {selectedMachineAtom, machineSessionSelectionsAtom} from '../atoms/remoteMachines';
import {sessionRegistryAtom, sessionDraftInputAtom, sessionDraftAttachmentsAtom, sessionDraftHydratedAtom, sessionDraftLocalModifiedAtAtom} from '../atoms/sessions';
import { atom } from 'jotai';
import { atomFamily } from '../debug/atomFamilyRegistry';
import { store } from '@nimbalyst/runtime/store';
import type { RemoteSessionSnapshot } from '../../../shared/remoteSessions';

export const remoteSessionSnapshotAtom = atomFamily((_sessionId: string) => atom<RemoteSessionSnapshot | null>(null));
export const remoteSessionErrorAtom = atomFamily((_sessionId: string) => atom<string | null>(null));
const watches = new Map<string, { sessionId: string; refs: number }>();
let unlisten: (() => void) | undefined;

/** Installed once at app startup; mounted views own only their remote watches. */
export function initRemoteSessionListeners(): () => void {
  if (unlisten) return () => {};
  let identity = store.get(stytchAuthAtom)?.user?.user_id;
  const stopAuth = store.sub(stytchAuthAtom, () => {
    const next = store.get(stytchAuthAtom)?.user?.user_id;
    if (identity && identity !== next) {
      for (const session of store.get(sessionRegistryAtom).values()) {
        if (!session.remoteHostDeviceId) continue;
        store.set(sessionDraftInputAtom(session.id), '');
        store.set(sessionDraftAttachmentsAtom(session.id), []);
        store.set(sessionDraftHydratedAtom(session.id), false);
        store.set(sessionDraftLocalModifiedAtAtom(session.id), 0);
      }
      for (const workspace of selectedMachineAtom.getParams()) {
        store.set(selectedMachineAtom(workspace), '');
        store.set(machineSessionSelectionsAtom(workspace), {});
      }
    }
    identity = next;
  });
  const unsubscribe = window.electronAPI?.on?.('ai:remoteSessionSnapshot', (payload: { watchId: string; snapshot: RemoteSessionSnapshot }) => {
    const watch = watches.get(payload.watchId);
    if (!watch || watch.sessionId !== payload.snapshot.session.id) return;
    store.set(remoteSessionSnapshotAtom(watch.sessionId), payload.snapshot);
  });
  unlisten = () => { stopAuth(); if (typeof unsubscribe === 'function') unsubscribe(); };
  return () => {
    unlisten?.();
    unlisten = undefined;
    for (const [watchId, { sessionId }] of watches) {
      void window.electronAPI.invoke('ai:unwatchRemoteSession', watchId).catch(() => {});
      store.set(remoteSessionSnapshotAtom(sessionId), null);
      store.set(remoteSessionErrorAtom(sessionId), null);
      remoteSessionSnapshotAtom.remove(sessionId);
      remoteSessionErrorAtom.remove(sessionId);
    }
    watches.clear();
  };
}

export function acquireRemoteSession(sessionId: string, workspacePath: string): () => void {
  const existing = [...watches.entries()].find(([, watch]) => watch.sessionId === sessionId);
  const watchId = existing?.[0] ?? crypto.randomUUID();
  if (existing) existing[1].refs++;
  else {
    watches.set(watchId, { sessionId, refs: 1 });
    void window.electronAPI.invoke('ai:watchRemoteSession', sessionId, workspacePath, watchId).catch(error => {
      if (watches.has(watchId)) store.set(remoteSessionErrorAtom(sessionId), error instanceof Error ? error.message : 'Could not open the remote session.');
    });
  }
  let released = false;
  return () => {
    if (released) return; released = true;
    const watch = watches.get(watchId);
    if (!watch || --watch.refs > 0) return;
    watches.delete(watchId);
    void window.electronAPI.invoke('ai:unwatchRemoteSession', watchId).catch(() => {});
    store.set(remoteSessionSnapshotAtom(sessionId), null);
    store.set(remoteSessionErrorAtom(sessionId), null);
    remoteSessionSnapshotAtom.remove(sessionId); remoteSessionErrorAtom.remove(sessionId);
  };
}
