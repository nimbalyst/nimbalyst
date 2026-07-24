/**
 * SessionTranscript Atoms
 *
 * Centralized state for SessionTranscript component.
 * These atoms are updated by sessionTranscriptListeners.ts in response to IPC events.
 * SessionTranscript reads from these atoms instead of subscribing to IPC directly.
 *
 * This follows the centralized IPC listener architecture pattern to avoid:
 * - Race conditions when switching sessions
 * - Stale closures capturing old component state
 * - MaxListenersExceededWarning from multiple component subscriptions
 * - State loss on component unmount
 */

import { atom } from 'jotai';
import { atomFamily } from '../debug/atomFamilyRegistry';

/**
 * Per-session error state.
 * Set when ai:error event fires for this session.
 */
export const sessionErrorAtom = atomFamily((_sessionId: string) =>
  atom<{
    message: string;
    isAuthError?: boolean;
    isBedrockToolError?: boolean;
    isServerError?: boolean;
    isCodexAuthRequired?: boolean;
  } | null>(null)
);

// Note: ExitPlanMode uses inline widget rendering from tool call data via ExitPlanModeWidget
// No atoms needed - see packages/runtime/src/ui/AgentTranscript/components/CustomToolWidgets/ExitPlanModeWidget.tsx

/**
 * Per-session queued prompts.
 * Updated when ai:queuedPromptsReceived event fires.
 * Array of queued prompts waiting to be processed.
 */
export interface QueuedPrompt {
  id: string;
  prompt: string;
  timestamp: number;
  documentContext?: any;
  attachments?: any[];
}

export const sessionQueuedPromptsAtom = atomFamily((_sessionId: string) =>
  atom<QueuedPrompt[]>([])
);

/**
 * Per-session stream completion signal.
 * Incremented when ai:streamResponse fires with isComplete:true or ai:error fires.
 * Used by code that needs to await stream completion without subscribing to IPC.
 */
export const streamCompletionSignalAtom = atomFamily((_sessionId: string) =>
  atom<number>(0)
);

/**
 * Per-session transcript-event signal.
 * Incremented whenever a `transcript:event` IPC event fires for this session.
 * Components that want to react to transcript activity (e.g. the kanban
 * transcript peek refetching on new turns) subscribe via useAtomValue rather
 * than calling window.electronAPI.on directly.
 */
export const transcriptEventSignalAtom = atomFamily((_sessionId: string) =>
  atom<number>(0)
);

