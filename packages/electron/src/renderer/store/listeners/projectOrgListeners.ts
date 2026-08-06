import type { Store } from 'jotai/vanilla/store';

// The store singleton, not the `store/index` barrel, which would drag every
// renderer atom module in behind it.
import { store } from '@nimbalyst/runtime/store';
import { projectOrgRevisionAtom } from '../atoms/orgScope';

/**
 * Installs the renderer-wide subscription for "this workspace's organization
 * changed".
 *
 * Which org a project belongs to is resolved once per workspace, so creating
 * one had to invalidate that answer explicitly. Doing it in the wizard only
 * reached the window the wizard was in; main broadcasts to every window, which
 * is where the other project windows come from.
 *
 * The payload is deliberately not read: the revision is a "re-resolve" signal,
 * and the windows that care each ask for their own workspace.
 */
export function initProjectOrgListeners(targetStore: Store = store): () => void {
  return window.electronAPI.on('team:workspace-org-changed', () => {
    targetStore.set(projectOrgRevisionAtom, (revision) => revision + 1);
  });
}
