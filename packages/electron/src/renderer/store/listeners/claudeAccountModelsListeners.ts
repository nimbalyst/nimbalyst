/**
 * Claude account models listener (renderer)
 *
 * Subscribes to `claude-code:account-models-changed` ONCE and bumps
 * `claudeAccountModelsVersionAtom`. The chat model picker reads the model list again when the
 * counter changes.
 *
 * Follows IPC_LISTENERS.md: one central subscription at startup.
 * Call initClaudeAccountModelsListeners() once in App.tsx on mount.
 */

import { store } from '@nimbalyst/runtime/store';
import { claudeAccountModelsVersionAtom } from '../atoms/claudeAccountModels';

export function initClaudeAccountModelsListeners(): () => void {
  if (!window.electronAPI) return () => {};

  return window.electronAPI.on('claude-code:account-models-changed', () => {
    store.set(claudeAccountModelsVersionAtom, (version) => version + 1);
  });
}
