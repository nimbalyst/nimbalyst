import { atom } from 'jotai';
import { store } from '@nimbalyst/runtime/store';
import type { PendingFileOpen } from '../../../main/file/FileOperations';

// Negative IDs are renderer-local requests from legacy open-document senders.
// Main-owned requests have positive IDs and survive renderer reload until ack.
export const pendingFileOpensAtom = atom<PendingFileOpen[]>([]);
let nextLocalId = 0;
let listenerUsers = 0;
let unsubscribe: (() => void) | undefined;

function mergeRequests(requests: PendingFileOpen[]): void {
  store.set(pendingFileOpensAtom, current => {
    const byId = new Map(current.map(request => [request.requestId, request]));
    for (const request of requests) {
      if (!byId.has(request.requestId)) byId.set(request.requestId, request);
    }
    return [...byId.values()].sort((a, b) => a.requestId > 0 && b.requestId > 0 ? a.requestId - b.requestId : 0);
  });
}

export async function refreshPendingFileOpens(workspacePath: string, isCurrent: () => boolean): Promise<void> {
  const requests: PendingFileOpen[] = await window.electronAPI.invoke('file:pending-opens', workspacePath);
  // A response from a disposed editor must not resurrect requests that its
  // replacement has already opened and acknowledged.
  if (isCurrent()) mergeRequests(requests);
}

export async function acknowledgePendingFileOpen(request: PendingFileOpen, workspacePath: string): Promise<void> {
  // Drop locally first: the editor drains the head of this list, so a failed
  // ack must not stall every later open behind it. Main replays it on remount.
  store.set(pendingFileOpensAtom, requests => requests.filter(candidate => candidate.requestId !== request.requestId));
  if (request.requestId > 0) {
    await window.electronAPI.invoke('file:acknowledge-open', workspacePath, request.requestId);
  }
}

/** One subscription; pending state survives App/StrictMode cleanup and remount. */
export function initFileOpenListeners(): () => void {
  if (listenerUsers++ === 0) {
    unsubscribe = window.electronAPI.on('open-document', (data: Omit<PendingFileOpen, 'requestId'> & { requestId?: number }) => {
      mergeRequests([{ ...data, requestId: data.requestId ?? --nextLocalId }]);
    });
  }
  return () => {
    if (--listenerUsers === 0) {
      unsubscribe?.();
      unsubscribe = undefined;
    }
  };
}
