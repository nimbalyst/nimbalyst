/**
 * Pull request review panel listeners.
 *
 * Centralized IPC subscriber that populates the PR atoms. Follows
 * IPC_LISTENERS.md — components never subscribe to IPC directly; this runs
 * once at startup and updates atoms.
 *
 * Responsibilities:
 *   * initial `gh` status probe + `pr:gh-status-changed` -> ghCliStatusAtom
 *   * detect the GitHub remote for the active workspace -> prRemoteAtom,
 *     re-running when the multi-project rail switches the active workspace
 *   * `pr:list-updated` broadcast -> prListUpdatedAtom (request bump the list
 *     view reacts to)
 *
 * Call initPullRequestListeners() once in App.tsx on mount.
 */

import { store } from '@nimbalyst/runtime/store';
import {
  ghCliStatusAtom,
  prRemoteAtom,
  prListUpdatedAtom,
} from '../atoms/pullRequests';
import { activeWorkspacePathAtom } from '../atoms/openProjects';
import { getGhCliService } from '../../services/RendererGhCliService';
import { getPullRequestService } from '../../services/RendererPullRequestService';

export function initPullRequestListeners(): () => void {
  const cleanups: Array<() => void> = [];
  let disposed = false;
  let listUpdatedVersion = 0;

  const ghService = getGhCliService();
  const prService = getPullRequestService();

  // Initial gh status probe so the onboarding banner reflects reality on
  // first paint instead of waiting for a change event that may never come.
  ghService
    .getStatus()
    .then((status) => {
      if (!disposed) store.set(ghCliStatusAtom, status);
    })
    .catch(() => {
      if (!disposed) store.set(ghCliStatusAtom, { installed: false, authed: false });
    });

  // gh status changes (install / login transitions detected by the main
  // process cache eviction).
  cleanups.push(ghService.onStatusChanged((status) => {
    if (!disposed) store.set(ghCliStatusAtom, status);
  }));

  // pr:list-updated -> bump the request atom; the list view re-reads cache.
  cleanups.push(
    prService.onListUpdated((payload) => {
      if (disposed) return;
      listUpdatedVersion += 1;
      store.set(prListUpdatedAtom, { version: listUpdatedVersion, payload });
    }),
  );

  // Detect the GitHub remote for a workspace and publish it to prRemoteAtom.
  const detectRemoteFor = async (workspacePath: string | null): Promise<void> => {
    if (!workspacePath) {
      store.set(prRemoteAtom, null);
      return;
    }
    try {
      const result = await prService.detectRemote(workspacePath);
      if (disposed) return;
      // Guard against a stale resolve after the user switched projects.
      if (store.get(activeWorkspacePathAtom) !== workspacePath) return;
      store.set(prRemoteAtom, result ? { workspacePath, ...result } : null);
    } catch {
      if (!disposed) store.set(prRemoteAtom, null);
    }
  };

  // Initial detection + re-detect on project switch.
  void detectRemoteFor(store.get(activeWorkspacePathAtom));
  const unsubscribeActivePath = store.sub(activeWorkspacePathAtom, () => {
    if (disposed) return;
    void detectRemoteFor(store.get(activeWorkspacePathAtom));
  });
  cleanups.push(unsubscribeActivePath);

  return () => {
    disposed = true;
    cleanups.forEach((cleanup) => cleanup());
  };
}
