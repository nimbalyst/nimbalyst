/**
 * Centralized IPC listeners for deep-link navigation events.
 *
 * Follows the pattern from IPC_LISTENERS.md:
 * - Components NEVER subscribe to IPC events directly
 * - Central listeners update atoms / dispatch
 * - Components react to the atoms
 *
 * Two delivery paths for each link kind:
 * - Live: main sends an event to an already-mounted window.
 * - Pending queue: when main creates a new window to host the link's
 *   workspace, the renderer drains the queued payload via
 *   `deep-link:consume-pending-*` on listener init and again any time the
 *   active workspace changes (covers rail-switch flows too).
 */

import { store } from '../index';
import { setWindowModeAtom } from '../atoms/windowMode';
import { pendingCollabDocumentAtom, pendingCollabFolderAtom } from '../atoms/collabDocuments';
import { setTrackerModeLayoutAtom } from '../atoms/trackers';
import { activeWorkspacePathAtom } from '../atoms/openProjects';
import { errorNotificationService } from '../../services/ErrorNotificationService';

interface SharedDocPayload {
  documentId: string;
  orgId: string;
  workspacePath: string;
}

interface SharedFolderPayload {
  folderId: string;
  orgId: string;
  workspacePath: string;
}

interface TrackerPayload {
  trackerId: string;
  orgId: string;
  workspacePath: string;
}

function ensureActiveWorkspace(workspacePath: string): void {
  const activePath = store.get(activeWorkspacePathAtom);
  if (activePath !== workspacePath) {
    // The matching workspace is warm in the project rail but not the
    // visible one. Switch to it first.
    store.set(activeWorkspacePathAtom, workspacePath);
  }
}

function applySharedDocPayload(data: SharedDocPayload): void {
  if (!data?.documentId || !data?.workspacePath) return;
  ensureActiveWorkspace(data.workspacePath);
  store.set(setWindowModeAtom, 'collab');
  store.set(pendingCollabDocumentAtom, { documentId: data.documentId });
}

function applySharedFolderPayload(data: SharedFolderPayload): void {
  if (!data?.folderId || !data?.workspacePath) return;
  ensureActiveWorkspace(data.workspacePath);
  store.set(setWindowModeAtom, 'collab');
  store.set(pendingCollabFolderAtom, { folderId: data.folderId });
}

function applyTrackerPayload(data: TrackerPayload): void {
  if (!data?.trackerId || !data?.workspacePath) return;
  ensureActiveWorkspace(data.workspacePath);
  store.set(setWindowModeAtom, 'tracker');
  // 'all' so the tracker shows in the list regardless of its primaryType.
  store.set(setTrackerModeLayoutAtom, {
    selectedType: 'all',
    selectedItemId: data.trackerId,
  });
}

async function drainPendingFor(workspacePath: string | null): Promise<void> {
  if (!workspacePath) return;
  try {
    const [docPending, folderPending, trackerPending] = await Promise.all([
      window.electronAPI.invoke('deep-link:consume-pending-shared-doc', workspacePath) as Promise<SharedDocPayload | null>,
      window.electronAPI.invoke('deep-link:consume-pending-shared-folder', workspacePath) as Promise<SharedFolderPayload | null>,
      window.electronAPI.invoke('deep-link:consume-pending-tracker', workspacePath) as Promise<TrackerPayload | null>,
    ]);
    if (docPending) applySharedDocPayload(docPending);
    if (folderPending) applySharedFolderPayload(folderPending);
    if (trackerPending) applyTrackerPayload(trackerPending);
  } catch (err) {
    console.error('[DeepLink] Failed to consume pending payload:', err);
  }
}

/**
 * Initialize deep-link IPC listeners. Should be called once at startup.
 */
export function initDeepLinkListeners(): () => void {
  const cleanups: Array<() => void> = [];

  // Live: shared document link routed to this window.
  cleanups.push(
    window.electronAPI.on('deep-link:open-shared-document', (data: SharedDocPayload) => {
      applySharedDocPayload(data);
    })
  );

  // Live: shared folder link routed to this window.
  cleanups.push(
    window.electronAPI.on('deep-link:open-shared-folder', (data: SharedFolderPayload) => {
      applySharedFolderPayload(data);
    })
  );

  // Live: no known workspace matches the folder link's orgId, or not signed in.
  cleanups.push(
    window.electronAPI.on('deep-link:shared-folder-not-available', (data: {
      folderId: string;
      orgId: string;
      reason?: 'not-authenticated' | 'no-workspace';
    }) => {
      if (data?.reason === 'not-authenticated') {
        errorNotificationService.showWarning(
          'Sign in required',
          'Sign in to your Nimbalyst team account to open this shared folder.',
          { duration: 6000 }
        );
      } else {
        errorNotificationService.showWarning(
          'No matching workspace',
          'You do not have a workspace open for the team that owns this folder.',
          { duration: 6000 }
        );
      }
      console.warn('[DeepLink] No workspace available for shared folder:', data);
    })
  );

  // Live: tracker link routed to this window.
  cleanups.push(
    window.electronAPI.on('deep-link:open-tracker', (data: TrackerPayload) => {
      applyTrackerPayload(data);
    })
  );

  // Live: no known workspace matches the link's orgId, or the user isn't signed in.
  cleanups.push(
    window.electronAPI.on('deep-link:shared-document-not-available', (data: {
      documentId: string;
      orgId: string;
      reason?: 'not-authenticated' | 'no-workspace';
    }) => {
      if (data?.reason === 'not-authenticated') {
        errorNotificationService.showWarning(
          'Sign in required',
          'Sign in to your Nimbalyst team account to open this shared document.',
          { duration: 6000 }
        );
      } else {
        errorNotificationService.showWarning(
          'No matching workspace',
          'You do not have a workspace open for the team that owns this document.',
          { duration: 6000 }
        );
      }
      console.warn('[DeepLink] No workspace available for shared doc:', data);
    })
  );

  cleanups.push(
    window.electronAPI.on('deep-link:tracker-not-available', (data: {
      trackerId: string;
      orgId: string;
      reason?: 'not-authenticated' | 'no-workspace';
    }) => {
      if (data?.reason === 'not-authenticated') {
        errorNotificationService.showWarning(
          'Sign in required',
          'Sign in to your Nimbalyst team account to open this tracker.',
          { duration: 6000 }
        );
      } else {
        errorNotificationService.showWarning(
          'No matching workspace',
          'You do not have a workspace open for the team that owns this tracker.',
          { duration: 6000 }
        );
      }
      console.warn('[DeepLink] No workspace available for tracker:', data);
    })
  );

  // Drain any pending payload queued before this listener mounted (newly
  // created window case).
  void drainPendingFor(store.get(activeWorkspacePathAtom));

  // Also drain when the active workspace changes — covers users switching
  // projects in the rail to one that has a queued link.
  const unsubscribe = store.sub(activeWorkspacePathAtom, () => {
    void drainPendingFor(store.get(activeWorkspacePathAtom));
  });
  cleanups.push(unsubscribe);

  return () => {
    cleanups.forEach((fn) => fn?.());
  };
}
