/**
 * Counter bumped whenever the Codex CLI's auth state changes on disk.
 *
 * Updated by: store/listeners/openAICodexAuthListeners.ts (`openai-codex:auth-updated`).
 *
 * A counter rather than the status itself: the status is only meaningful to the
 * settings panel, which already knows how to fetch it. Consumers capture the
 * initial value in a ref and re-fetch when it changes -- see the "counter atoms"
 * reaction pattern in docs/IPC_LISTENERS.md.
 */

import { atom } from 'jotai';

export const openAICodexAuthVersionAtom = atom(0);
