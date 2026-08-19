/**
 * Where a project's local-number prefix and counter actually live: workspace
 * settings.
 *
 * Kept apart from `localKeyAllocator` so the allocation rules -- which are the
 * part that has been got wrong twice -- can be tested without electron-store or
 * a workspace on disk.
 */

import {
  getTakenLocalKeyPrefixes,
  getWorkspaceState,
  updateWorkspaceState,
} from '../../utils/store';
import type { LocalKeyStateStore } from './localKeyAllocator';

export const workspaceLocalKeyStore: LocalKeyStateStore = {
  read(workspacePath) {
    const state = getWorkspaceState(workspacePath);
    return { prefix: state.localKeyPrefix, counter: state.localKeyCounter };
  },
  write(workspacePath, next) {
    updateWorkspaceState(workspacePath, (state) => {
      state.localKeyPrefix = next.prefix;
      state.localKeyCounter = next.counter;
    });
  },
  takenPrefixes: (workspacePath) => getTakenLocalKeyPrefixes(workspacePath),
  teamPrefix: (workspacePath) => getWorkspaceState(workspacePath).issueKeyPrefix,
};
