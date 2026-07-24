/**
 * OpenAI Codex Auth Listener (Renderer)
 *
 * Subscribes to `openai-codex:auth-updated` ONCE and bumps
 * openAICodexAuthVersionAtom. OpenAICodexPanel re-fetches its status when the
 * counter changes.
 *
 * Follows IPC_LISTENERS.md: one centralized subscription at startup.
 * Call initOpenAICodexAuthListeners() once in App.tsx on mount.
 */

import { store } from '@nimbalyst/runtime/store';
import { openAICodexAuthVersionAtom } from '../atoms/openAICodexAuth';

export function initOpenAICodexAuthListeners(): () => void {
  if (!window.electronAPI) return () => {};

  return window.electronAPI.on('openai-codex:auth-updated', () => {
    store.set(openAICodexAuthVersionAtom, (version) => version + 1);
  });
}
