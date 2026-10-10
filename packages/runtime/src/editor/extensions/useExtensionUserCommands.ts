/**
 * React view of the extension user-command list. Kept out of
 * `extensionContributionsStore.ts` so the store, which the markdown pipeline
 * reads, stays React-free for headless hosts (the collab worker).
 */
import { useSyncExternalStore } from 'react';

import type { UserCommand } from '../types/PluginTypes';
import { getAllExtensionUserCommands, subscribeToExtensionContributions } from './extensionContributionsStore';

/**
 * Subscribe to the user-command list. The snapshot reference changes
 * whenever any contributor's user commands change.
 */
export function useExtensionUserCommands(): ReadonlyArray<UserCommand> {
  return useSyncExternalStore(
    subscribeToExtensionContributions,
    getAllExtensionUserCommands,
    getAllExtensionUserCommands,
  );
}
