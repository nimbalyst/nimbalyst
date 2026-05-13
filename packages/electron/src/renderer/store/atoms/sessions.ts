/**
 * AI Session Atoms
 *
 * Per-session state using atom families keyed by session ID.
 * Allows efficient updates where only the affected session's UI re-renders.
 *
 * Key principle: Session service WRITES to these atoms via IPC handlers,
 * UI components (SessionListItem, badge) READ via subscriptions.
 *
 * Session list loading pattern:
 * 1. Call initSessionList(workspacePath) at app startup
 * 2. Components use useAtomValue(sessionListAtom) to read sessions
 * 3. Use refreshSessionListAtom to refresh from database
 * 4. Use addSessionAtom/removeSessionAtom for optimistic updates
 */

import { atom } from 'jotai';
import { atomFamily } from '../debug/atomFamilyRegistry';
import { store } from '@nimbalyst/runtime/store';
import { ModelIdentifier, type ChatAttachment, type TranscriptViewMessage } from '@nimbalyst/runtime/ai/server/types';
import type { SessionMeta } from '@nimbalyst/runtime';
import { workstreamStateAtom, setWorkstreamActiveChildAtom } from './workstreamState';
import { aiInputHistoryAtom } from './aiInputUndo';

// SessionMeta is imported from @nimbalyst/runtime (canonical type).
// Re-export for consumers that import from the store.
export type { SessionMeta };

/** @deprecated Use SessionMeta directly */
export type SessionListItem = SessionMeta;

// Monotonically decreasing counter for optimistic message IDs.
// Avoids collisions from -Date.now() when multiple messages are created
// in the same millisecond.
let optimisticIdCounter = -1;
export function nextOptimisticId(): number {
  return optimisticIdCounter--;
}

/**
 * @deprecated Use SessionMeta and sessionRegistryAtom instead
 */
export interface    SessionInfo {
  id: string;
  title: string;
  createdAt: number;
  updatedAt: number;
  workspaceId: string;
}

/**
 * Session registry - lightweight Map for O(1) lookups and efficient updates.
 * This is populated during initSessionList() and kept in sync with all session changes.
 * Single source of truth for session metadata used in lists.
 */
export const sessionRegistryAtom = atom<Map<string, SessionMeta>>(new Map());

/**
 * Derived: Sorted array of all sessions from registry.
 * For use by components that need the full session list.
 */
export const sessionListFromRegistryAtom = atom((get) => {
  const registry = get(sessionRegistryAtom);
  return Array.from(registry.values())
    .sort((a, b) => b.updatedAt - a.updatedAt);
});

/**
 * Derived: Root sessions only from registry (no parent).
 * These are the sessions that should show in the main session history list.
 */
export const sessionListRootFromRegistryAtom = atom((get) => {
  const registry = get(sessionRegistryAtom);
  return Array.from(registry.values())
    .filter(s => {
      if (!s.parentSessionId) return true;
      // Include blitz children (their parent has sessionType='blitz')
      const parent = registry.get(s.parentSessionId);
      return parent?.sessionType === 'blitz';
    })
    .sort((a, b) => b.updatedAt - a.updatedAt);
});

/**
 * Legacy session list - writable atom for backward compatibility.
 * @deprecated Use sessionRegistryAtom and derived atoms instead
 */
export const sessionListAtom = atom<SessionInfo[]>([]);

/**
 * Currently active session ID.
 * Used to determine which session panel is shown and
 * whether new messages should mark a session as unread.
 */
export const activeSessionIdAtom = atom<string | null>(null);

/**
 * Per-session processing state.
 * Set when AI is actively generating a response.
 * SessionListItem subscribes to show processing indicator.
 */
export const sessionProcessingAtom = atomFamily((_sessionId: string) =>
  atom(false)
);

/**
 * Per-session unread state.
 * Set when new messages arrive while session is not active.
 * SessionListItem subscribes to show unread indicator.
 */
export const sessionUnreadAtom = atomFamily((_sessionId: string) =>
  atom(false)
);

/**
 * Per-session pending prompt state.
 * Set when there's a queued prompt waiting to be processed.
 * SessionListItem subscribes to show pending indicator.
 */
export const sessionPendingPromptAtom = atomFamily((_sessionId: string) =>
  atom(false)
);

/**
 * Per-session active scheduled wakeup.
 * Holds the most recent active wakeup row (pending / waiting_for_workspace / overdue)
 * for a session, or null if there is none. Updated by `wakeupListener.ts` in response
 * to `wakeup:changed` IPC events.
 */
export interface SessionWakeupView {
  id: string;
  sessionId: string;
  workspaceId: string;
  prompt: string;
  reason: string | null;
  fireAt: number;
  status: 'pending' | 'firing' | 'fired' | 'waiting_for_workspace' | 'overdue' | 'cancelled' | 'failed';
  createdAt: number;
  firedAt: number | null;
  error: string | null;
}

export const sessionWakeupAtom = atomFamily((_sessionId: string) =>
  atom<SessionWakeupView | null>(null)
);

/**
 * Per-session pending interactive prompt state.
 * Set when any interactive tool is waiting for user input:
 * - AskUserQuestion
 * - ExitPlanMode
 * - ToolPermission
 * - GitCommitProposal
 *
 * Shows a "waiting for input" icon in the sidebar.
 * This is a simple boolean - widgets render the actual prompt from toolCall data.
 */
export const sessionHasPendingInteractivePromptAtom = atomFamily((_sessionId: string) =>
  atom(false)
);

/**
 * Last read timestamp per session.
 * Used to calculate unread message count.
 */
export const sessionLastReadAtom = atomFamily((_sessionId: string) =>
  atom<number>(0)
);

/**
 * Prompt additions data for debugging (dev mode).
 * Shows what was added to the prompt: system additions, user message additions,
 * and attachments.
 * Persists across navigation so the widget remains visible.
 */
export interface PromptAdditionsData {
  systemPromptAddition: string | null;
  userMessageAddition: string | null;
  attachments?: Array<{ type: string; filename: string; mimeType?: string; filepath?: string }>;
  timestamp: number;
  messageIndex: number; // Index of user message this belongs to
}

export const sessionPromptAdditionsAtom = atomFamily((_sessionId: string) =>
  atom<PromptAdditionsData | null>(null)
);

// ============================================================
// Durable Interactive Prompts
// These atoms derive state from the database, making prompts
// survive session switches and app restarts.
// ============================================================

/**
 * Pending interactive prompt from the database.
 * Represents one of: permission_request, ask_user_question_request,
 * exit_plan_mode_request, git_commit_proposal_request, or request_user_input_request.
 */
export interface PendingPrompt {
  id: string;
  sessionId: string;
  promptType:
    | 'permission_request'
    | 'ask_user_question_request'
    | 'exit_plan_mode_request'
    | 'git_commit_proposal_request'
    | 'request_user_input_request';
  promptId: string;  // requestId or questionId
  data: any;         // The full prompt content
  createdAt: number;
}

/**
 * Per-session pending prompts loaded from the database.
 * This is the source of truth for all pending AI-to-user interactions.
 */
export const sessionPendingPromptsAtom = atomFamily((_sessionId: string) =>
  atom<PendingPrompt[]>([])
);

/**
 * Trigger to refresh pending prompts from the database.
 * Increment this to cause a re-fetch.
 */
export const sessionPendingPromptsRefreshAtom = atomFamily((_sessionId: string) =>
  atom<number>(0)
);

/**
 * Action atom to refresh pending prompts for a session.
 * Pending prompts are now derived from canonical transcript events, not ai_agent_messages.
 */
const INTERACTIVE_PROMPT_TOOLS = new Set([
  'AskUserQuestion',
  'ToolPermission',
  'ExitPlanMode',
  'GitCommitProposal',
  // Wire-name for the generic structured-input prompt. NOT `RequestUserInput` --
  // that snake_cases to Codex's built-in `request_user_input`, which is gated to
  // Plan mode and gets refused in Default mode. `RequestUserInput` is kept here
  // so older recorded sessions still detect the pending state.
  'PromptForUserInput',
  'RequestUserInput',
]);

// MCP tools arrive as `mcp__<server>__<toolName>` (server name may contain dashes).
// Match the bare name first; if not found, peel off the MCP prefix and recheck.
function isInteractivePromptTool(toolName: string): boolean {
  if (INTERACTIVE_PROMPT_TOOLS.has(toolName)) return true;
  const match = toolName.match(/^mcp__[^_]+(?:_[^_]+)*__(.+)$/);
  return !!match && INTERACTIVE_PROMPT_TOOLS.has(match[1]);
}

export const refreshPendingPromptsAtom = atom(
  null,
  (get, set, sessionId: string) => {
    // Pending prompts are now rendered from canonical transcript events via widgets.
    // Update the unified pending interactive prompt state from session messages.
    const messages = get(sessionMessagesAtom(sessionId));
    const hasPendingPrompt = messages.some(
      msg => {
        // Interactive prompts projected from canonical events
        if (msg.type === 'interactive_prompt' && msg.interactivePrompt?.status === 'pending') return true;
        // Interactive tools stored as tool_calls (from TranscriptTransformer)
        if (msg.toolCall?.toolName && isInteractivePromptTool(msg.toolCall.toolName) && !msg.toolCall.result) return true;
        return false;
      }
    );
    set(sessionHasPendingInteractivePromptAtom(sessionId), hasPendingPrompt);
  }
);

// ============================================================
// Interactive Prompt Widgets (Durable Prompts Architecture)
// ============================================================
// All interactive prompts render from message data directly via widgets:
// - AskUserQuestion: AskUserQuestionWidget renders from nimbalyst_tool_use messages
// - ExitPlanMode: ExitPlanModeWidget renders from tool_use messages
// - GitCommitProposal: GitCommitConfirmationWidget renders from MCP tool_use messages
// - ToolPermission: ToolPermissionWidget renders from nimbalyst_tool_use messages
//
// No atoms needed - widgets use toolCall.id as promptId and toolCall.arguments for data
// See packages/runtime/src/ui/AgentTranscript/components/CustomToolWidgets/

/**
 * Action atom to respond to an interactive prompt.
 * Creates a response message in the database and notifies the provider.
 */
export const respondToPromptAtom = atom(
  null,
  async (get, set, params: {
    sessionId: string;
    promptId: string;
    promptType: 'permission_request' | 'ask_user_question_request' | 'exit_plan_mode_request' | 'request_user_input_request';
    response: any;
  }) => {
    const { sessionId, promptId, promptType, response } = params;

    try {
      // 1. Persist response to database
      const result = await window.electronAPI.invoke('messages:respond-to-prompt', {
        sessionId,
        promptId,
        promptType,
        response,
        respondedBy: 'desktop',
      });

      if (!result.success) {
        console.error('[respondToPromptAtom] Failed to persist response:', result.error);
        return false;
      }

      // 2. Notify provider directly for immediate resolution
      if (promptType === 'ask_user_question_request') {
        await window.electronAPI.invoke('claude-code:answer-question', {
          questionId: promptId,
          answers: response.answers || response,
          sessionId,
        });
      } else if (promptType === 'permission_request') {
        await window.electronAPI.invoke('claude-code:answer-tool-permission', {
          requestId: promptId,
          sessionId,
          response,
        });
      } else if (promptType === 'exit_plan_mode_request') {
        await window.electronAPI.invoke('ai:exitPlanModeConfirmResponse', promptId, sessionId, response);
      }

      // 3. Refresh pending prompts to remove the answered one
      await set(refreshPendingPromptsAtom, sessionId);

      return true;
    } catch (error) {
      console.error('[respondToPromptAtom] Error:', error);
      return false;
    }
  }
);

// ============================================================
// Per-session draft input state
// These atoms encapsulate input state within AISessionView,
// eliminating the need for AgenticPanel to manage draft state.
// ============================================================

/**
 * Per-session draft input text.
 * AIInput subscribes directly - no props needed from parent.
 * Typing only causes AIInput to re-render, not the entire tree.
 */
export const sessionDraftInputAtom = atomFamily((_sessionId: string) =>
  atom<string>('')
);

/**
 * Per-session draft attachments.
 * File attachments being composed before sending.
 */
export const sessionDraftAttachmentsAtom = atomFamily((_sessionId: string) =>
  atom<ChatAttachment[]>([])
);

/**
 * Per-session timestamp of last prompt submit (epoch ms).
 * Used to reject stale draft echoes from cross-device sync.
 * When a user submits a prompt, we record the timestamp. If a remote device
 * echoes back a non-empty draft with draftUpdatedAt <= lastSubmitAt, we ignore it.
 */
export const sessionLastSubmitAtAtom = atomFamily((_sessionId: string) =>
  atom<number>(0)
);

/**
 * Per-session timestamp of last local draft modification (epoch ms).
 * Tracks when the user last typed in the AIInput on this device.
 * Used to reject stale sync echoes: if a remote draft has draftUpdatedAt
 * older than our local modification time, the remote draft is stale.
 */
export const sessionDraftLocalModifiedAtAtom = atomFamily((_sessionId: string) =>
  atom<number>(0)
);

/**
 * Set draft input for a session.
 *
 * This is the canonical way to set a session's initial prompt when creating
 * or navigating to a session. It:
 * 1. Sets the Jotai atom for immediate display when the session mounts
 * 2. Optionally persists to the database for durability
 *
 * IMPORTANT: Always use this instead of manually setting sessionDraftInputAtom
 * when you need the draft to persist and display correctly.
 *
 * @example
 * // After creating a new session, set its draft prompt:
 * store.set(setSessionDraftInputAtom, {
 *   sessionId: newSessionId,
 *   draftInput: 'Your prompt here',
 *   workspacePath,
 *   persist: true, // Saves to database
 * });
 */
export const setSessionDraftInputAtom = atom(
  null,
  async (_get, set, { sessionId, draftInput, workspacePath, persist = true }: {
    sessionId: string;
    draftInput: string;
    workspacePath?: string;
    persist?: boolean;
  }) => {
    // 1. Set the atom for immediate display
    set(sessionDraftInputAtom(sessionId), draftInput);

    // 2. Persist to database if requested and workspacePath is provided
    if (persist && workspacePath && window.electronAPI) {
      window.electronAPI.invoke('ai:saveDraftInput', sessionId, draftInput, workspacePath)
        .catch((err: Error) => console.error('[setSessionDraftInputAtom] Failed to persist draft input:', err));
    }
  }
);

// ============================================================
// Per-session prompt history navigation
// Allows arrow key navigation through previous user prompts.
// ============================================================

/**
 * Per-session history index for prompt navigation.
 * -1 means at current input (default), 0+ means navigating through history.
 */
export const sessionHistoryIndexAtom = atomFamily((_sessionId: string) =>
  atom<number>(-1)
);

/**
 * Per-session temporary input storage.
 * Stores the current draft when user navigates away to history.
 * Restored when they return to index -1.
 */
export const sessionTempInputAtom = atomFamily((_sessionId: string) =>
  atom<string>('')
);

/**
 * Strip system message additions from a user message for display in history recall.
 * These are internal instructions wrapped in <NIMBALYST_SYSTEM_MESSAGE> tags
 * that should not be shown to the user when navigating prompt history.
 */
function stripSystemMessageAdditions(content: string): string {
  // Remove all <NIMBALYST_SYSTEM_MESSAGE>...</NIMBALYST_SYSTEM_MESSAGE> blocks
  // Including any whitespace before the tag (e.g., newlines)
  return content.replace(/\s*<NIMBALYST_SYSTEM_MESSAGE>[\s\S]*?<\/NIMBALYST_SYSTEM_MESSAGE>/g, '').trim();
}

/**
 * Navigate through prompt history for a session.
 * Uses messages from sessionStoreAtom to find user prompts.
 */
export const navigateSessionHistoryAtom = atom(
  null,
  (get, set, params: { sessionId: string; direction: 'up' | 'down' }) => {
    const { sessionId, direction } = params;

    // Get session data to access user messages
    const sessionData = get(sessionStoreAtom(sessionId));
    if (!sessionData?.messages) return;

    const userMessages = sessionData.messages.filter(m => m.type === 'user_message');
    if (userMessages.length === 0) return;

    const currentIndex = get(sessionHistoryIndexAtom(sessionId));
    const draftInput = get(sessionDraftInputAtom(sessionId));
    let newIndex = currentIndex;

    if (direction === 'up') {
      // Going back in history
      if (currentIndex === -1) {
        // First time pressing up, save current input
        set(sessionTempInputAtom(sessionId), draftInput);
        newIndex = userMessages.length - 1;
      } else if (currentIndex > 0) {
        newIndex = currentIndex - 1;
      }
      // else: already at oldest message, do nothing
    } else {
      // Going forward in history
      if (currentIndex === -1) {
        // Already at current input, do nothing
        return;
      } else if (currentIndex < userMessages.length - 1) {
        newIndex = currentIndex + 1;
      } else if (currentIndex === userMessages.length - 1) {
        // Return to current input
        const tempInput = get(sessionTempInputAtom(sessionId));
        set(sessionDraftInputAtom(sessionId), tempInput);
        set(sessionHistoryIndexAtom(sessionId), -1);
        return;
      }
    }

    if (newIndex >= 0 && newIndex < userMessages.length) {
      set(sessionHistoryIndexAtom(sessionId), newIndex);
      // Strip system message additions when recalling history
      // so user only sees what they originally typed
      const cleanContent = stripSystemMessageAdditions(userMessages[newIndex].text ?? '');
      set(sessionDraftInputAtom(sessionId), cleanContent);
    }
  }
);

/**
 * Reset prompt history state when a message is sent.
 * Called when user sends a message to clear navigation state.
 */
export const resetSessionHistoryAtom = atom(
  null,
  (get, set, sessionId: string) => {
    set(sessionHistoryIndexAtom(sessionId), -1);
    set(sessionTempInputAtom(sessionId), '');
  }
);

// ============================================================
// Per-session full data state
// AISessionView subscribes to this and loads/manages its own data.
// This eliminates the need for AgenticPanel to hold session state.
// ============================================================

import type { SessionData } from '@nimbalyst/runtime/ai/server/types';
import type { AIMode } from '../../components/UnifiedAI/ModeTag';

/**
 * Session tab state - the minimal data AgenticPanel needs for an open session.
 * This replaces the old SessionTab interface with just what's needed for tabs.
 */
export interface OpenSession {
  id: string;
  title: string;
  isPinned?: boolean;
}

/**
 * Per-session full data store.
 * Single source of truth for all session fields including messages, metadata, and state.
 * AISessionView subscribes directly - loads its own data, saves changes.
 * This allows the component to be fully self-contained.
 *
 * Initial value is null - AISessionView loads data on mount.
 * Updates to this atom should go through updateSessionStoreAtom to keep registry in sync.
 */
export const sessionStoreAtom = atomFamily((_sessionId: string) =>
  atom<SessionData | null>(null)
);

/**
 * @deprecated Use sessionStoreAtom instead
 */
export const sessionDataAtom = sessionStoreAtom;

/**
 * Extended session update fields.
 * Includes SessionData fields plus electron-specific metadata fields.
 */
interface SessionUpdateFields extends Partial<SessionData> {
  uncommittedCount?: number;  // From SessionMeta, not in SessionData
}

/**
 * Unified session update atom.
 * SINGLE update point for all session metadata changes.
 * Automatically syncs both sessionStoreAtom and sessionRegistryAtom.
 *
 * This is the ONLY way to update session state - replaces updateSessionDataAtom and updateSessionFullAtom.
 */
export const updateSessionStoreAtom = atom(
  null,
  (get, set, update: { sessionId: string; updates: SessionUpdateFields }) => {
    const { sessionId, updates } = update;

    // 1. Update full session data if loaded
    // Note: Derived atoms (sessionModeAtom, sessionModelAtom, sessionArchivedAtom) automatically sync
    const current = get(sessionStoreAtom(sessionId));
    if (current) {
      set(sessionStoreAtom(sessionId), { ...current, ...updates });
    }

    // 2. Always update registry with metadata fields
    const registry = new Map(get(sessionRegistryAtom));
    const meta = registry.get(sessionId);
    if (meta) {
      registry.set(sessionId, {
        ...meta,
        // Sync fields that exist in both SessionData and SessionMeta
        ...(updates.title !== undefined && { title: updates.title }),
        ...(updates.updatedAt !== undefined && { updatedAt: updates.updatedAt }),
        ...(updates.isArchived !== undefined && { isArchived: updates.isArchived }),
        ...(updates.isPinned !== undefined && { isPinned: updates.isPinned }),
        ...(updates.parentSessionId !== undefined && { parentSessionId: updates.parentSessionId }),
        ...(updates.worktreeId !== undefined && { worktreeId: updates.worktreeId }),
        ...(updates.provider !== undefined && { provider: updates.provider }),
        ...(updates.model !== undefined && { model: updates.model }),
        ...(updates.sessionType !== undefined && { sessionType: updates.sessionType }),
        ...(updates.uncommittedCount !== undefined && { uncommittedCount: updates.uncommittedCount }),
        // Note: messageCount is not in SessionData, only in SessionListItem
        // It gets updated via updateSessionFullAtom for now (Phase 1 backward compat)
      });
      set(sessionRegistryAtom, registry);
    }
  }
);

/**
 * Per-session loading state.
 * True while session data is being fetched from database.
 */
export const sessionLoadingAtom = atomFamily((_sessionId: string) =>
  atom<boolean>(true)
);

/**
 * Per-session AI mode (plan vs agent).
 * This is a read-write derived atom that reads from sessionStoreAtom and writes through it.
 * This ensures the mode stays in sync with session data during reloads.
 */
export const sessionModeAtom = atomFamily((sessionId: string) =>
  atom(
    (get) => get(sessionStoreAtom(sessionId))?.mode || 'agent',
    (get, set, newMode: AIMode) => {
      const current = get(sessionStoreAtom(sessionId));
      if (current) {
        set(sessionStoreAtom(sessionId), { ...current, mode: newMode });
      }
    }
  )
);

/**
 * Derived atom for session parent ID.
 * Returns only the parentSessionId field, avoiding rerenders when other fields change.
 */
export const sessionParentIdDerivedAtom = atomFamily((sessionId: string) =>
  atom((get) => get(sessionStoreAtom(sessionId))?.parentSessionId ?? null)
);

/**
 * Derived atom for session worktree ID.
 * Returns only the worktreeId field, avoiding rerenders when other fields change.
 */
export const sessionWorktreeIdAtom = atomFamily((sessionId: string) =>
  atom((get) => get(sessionStoreAtom(sessionId))?.worktreeId ?? null)
);

/**
 * Per-session current model ID.
 * This is a read-write derived atom that reads from sessionStoreAtom and writes through it.
 * This ensures the model stays in sync with session data during reloads.
 */
export const sessionModelAtom = atomFamily((sessionId: string) =>
  atom(
    (get) => get(sessionStoreAtom(sessionId))?.model || 'claude-code:sonnet',
    (get, set, newModel: string) => {
      const current = get(sessionStoreAtom(sessionId));
      if (current) {
        // Extract provider from model ID so provider stays in sync
        const parsed = ModelIdentifier.tryParse(newModel);
        const updates: Partial<SessionData> = { model: newModel };
        if (parsed) {
          updates.provider = parsed.provider;
        }
        set(sessionStoreAtom(sessionId), { ...current, ...updates });

        // Also update registry so sidebar list item updates immediately
        // (don't wait for the IPC roundtrip broadcast)
        const registry = new Map(get(sessionRegistryAtom));
        const meta = registry.get(sessionId);
        if (meta) {
          registry.set(sessionId, {
            ...meta,
            model: newModel,
            ...(parsed && { provider: parsed.provider }),
          });
          set(sessionRegistryAtom, registry);
        }
      }
    }
  )
);

/**
 * Per-session archived state.
 * This is a read-write derived atom that reads from sessionStoreAtom and writes through it.
 * This ensures the archived state stays in sync with session data during reloads.
 */
export const sessionArchivedAtom = atomFamily((sessionId: string) =>
  atom(
    (get) => get(sessionStoreAtom(sessionId))?.isArchived || false,
    (get, set, isArchived: boolean) => {
      const current = get(sessionStoreAtom(sessionId));
      if (current) {
        set(sessionStoreAtom(sessionId), { ...current, isArchived });
      }
    }
  )
);

/**
 * Per-session active/visible state.
 * Components subscribe to this instead of receiving isActive as a prop.
 * This prevents parent re-renders from cascading to children.
 */
export const sessionActiveAtom = atomFamily((_sessionId: string) =>
  atom<boolean>(false)
);

/**
 * Derived: Session title from sessionData.
 * For use in tabs and lists where only the title is needed.
 * Falls back to sessionRegistryAtom when sessionStoreAtom hasn't been loaded yet
 * (e.g., after app restart before the session tab is opened).
 */
export const sessionTitleAtom = atomFamily((sessionId: string) =>
  atom((get) => {
    const data = get(sessionStoreAtom(sessionId));
    if (data?.title) {
      return data.title;
    }
    // Fall back to registry for sessions that haven't been fully loaded yet
    const registry = get(sessionRegistryAtom);
    const meta = registry.get(sessionId);
    return meta?.title || 'Untitled';
  })
);

/**
 * Derived: Session provider from sessionData.
 * For use in tabs and lists where the provider icon is needed.
 * Falls back to sessionRegistryAtom when sessionStoreAtom hasn't been loaded yet.
 */
export const sessionProviderAtom = atomFamily((sessionId: string) =>
  atom((get) => {
    const data = get(sessionStoreAtom(sessionId));
    if (data?.provider) {
      return data.provider;
    }
    // Fall back to registry for sessions that haven't been fully loaded yet
    const registry = get(sessionRegistryAtom);
    const meta = registry.get(sessionId);
    return meta?.provider || 'claude';
  })
);

/**
 * Derived: Session messages from sessionData.
 * Allows components to subscribe only to messages without re-rendering on other field changes.
 */
export const sessionMessagesAtom = atomFamily((sessionId: string) =>
  atom((get) => {
    const data = get(sessionStoreAtom(sessionId));
    return data?.messages || [];
  })
);

/**
 * Derived: Session token usage from sessionData.
 * Allows components to subscribe only to token usage without re-rendering on other field changes.
 */
export const sessionTokenUsageAtom = atomFamily((sessionId: string) =>
  atom((get) => {
    const data = get(sessionStoreAtom(sessionId));
    return data?.tokenUsage;
  })
);

// ============================================================
// Hierarchical session support (workstreams)
// These atoms enable parent-child session relationships for grouping
// related sessions without requiring git worktrees.
// ============================================================

/**
 * Per-session child IDs.
 * Populated when loading parent sessions that have children.
 * AISessionView uses this to render session tabs.
 */
export const sessionChildrenAtom = atomFamily((_sessionId: string) =>
  atom<string[]>([])
);

/**
 * Currently active child session within a parent.
 * Used for tab selection within a parent session view.
 * null means the parent session itself is active.
 */
export const sessionActiveChildAtom = atomFamily((_sessionId: string) =>
  atom<string | null>(null)
);

// Note: activeSessionInWorkstreamAtom has been moved to workstreamState.ts
// Use workstreamActiveChildAtom from workstreamState instead

/**
 * Derived: whether a session is a workstream (has type 'workstream' or 'worktree').
 * Uses the explicit type from workstreamState instead of counting children.
 */
export const sessionHasChildrenAtom = atomFamily((sessionId: string) =>
  atom((get) => {
    const state = get(workstreamStateAtom(sessionId));
    return state.type === 'workstream' || state.type === 'worktree';
  })
);

/**
 * Derived: index mapping parentSessionId -> child session IDs.
 * Computed once when the registry changes, so child lookups are O(1) instead of
 * scanning the entire registry per session (which was O(N^2) for N sessions).
 */
const parentToChildIdsAtom = atom((get) => {
  const registry = get(sessionRegistryAtom);
  const map = new Map<string, string[]>();
  for (const [id, meta] of registry) {
    if (meta.parentSessionId) {
      const children = map.get(meta.parentSessionId);
      if (children) {
        children.push(id);
      } else {
        map.set(meta.parentSessionId, [id]);
      }
    }
  }
  return map;
});

/**
 * Derived: whether a session OR any of its children is processing.
 * For workstreams, the parent header should show processing if ANY child is running.
 * This atom provides that aggregated view - subscribe to this instead of sessionProcessingAtom
 * when displaying processing state for a session that might be a workstream parent.
 *
 * Checks children from TWO sources:
 * 1. sessionChildrenAtom - populated when workstream is opened (has exact child IDs)
 * 2. parentToChildIdsAtom - pre-computed index from registry (O(1) lookup)
 */
export const sessionOrChildProcessingAtom = atomFamily((sessionId: string) =>
  atom((get) => {
    // Check if this session itself is processing
    if (get(sessionProcessingAtom(sessionId))) {
      return true;
    }

    // Check children from sessionChildrenAtom (populated when workstream is opened)
    const loadedChildren = get(sessionChildrenAtom(sessionId));
    for (const childId of loadedChildren) {
      if (get(sessionProcessingAtom(childId))) {
        return true;
      }
    }

    // Check children from pre-computed registry index (works even before workstream is opened)
    // Uses parentToChildIdsAtom for O(1) lookup instead of scanning the full registry
    const childIds = get(parentToChildIdsAtom).get(sessionId);
    if (childIds) {
      for (const childId of childIds) {
        if (get(sessionProcessingAtom(childId))) {
          return true;
        }
      }
    }

    return false;
  })
);

/**
 * Aggregated status for a group of sessions.
 * Used by GroupCardStatus to show worktree/workstream status without violating hooks rules.
 *
 * The key is a JSON-serialized array of session IDs for stable atom identity.
 * Returns { hasPendingInteractivePrompt, hasProcessing, hasPendingPrompt, hasUnread } for the group.
 */
export const groupSessionStatusAtom = atomFamily((sessionIdsKey: string) =>
  atom((get) => {
    const sessionIds: string[] = JSON.parse(sessionIdsKey);

    let hasPendingInteractivePrompt = false;
    let hasProcessing = false;
    let hasPendingPrompt = false;
    let hasUnread = false;

    for (const sessionId of sessionIds) {
      if (get(sessionHasPendingInteractivePromptAtom(sessionId))) {
        hasPendingInteractivePrompt = true;
      }
      // Use sessionOrChildProcessingAtom to include children of workstreams
      if (get(sessionOrChildProcessingAtom(sessionId))) {
        hasProcessing = true;
      }
      if (get(sessionPendingPromptAtom(sessionId))) {
        hasPendingPrompt = true;
      }
      if (get(sessionUnreadAtom(sessionId))) {
        hasUnread = true;
      }
      // Early exit if all flags are true
      if (hasPendingInteractivePrompt && hasProcessing && hasPendingPrompt && hasUnread) {
        break;
      }
    }

    return { hasPendingInteractivePrompt, hasProcessing, hasPendingPrompt, hasUnread };
  })
);

/**
 * Per-session parent ID.
 * null for root sessions, set for child sessions.
 * Used to determine if session should be shown in main list or as a tab.
 */
export const sessionParentIdAtom = atomFamily((_sessionId: string) =>
  atom<string | null>(null)
);

/**
 * Load child sessions for a parent session.
 * Called when opening a parent session that has children.
 */
export const loadSessionChildrenAtom = atom(
  null,
  async (get, set, { parentSessionId, workspacePath }: { parentSessionId: string; workspacePath: string }) => {
    // console.log('[loadSessionChildrenAtom] Called with:', { parentSessionId, workspacePath });
    if (!parentSessionId || !workspacePath || !window.electronAPI) {
      // console.log('[loadSessionChildrenAtom] Early return - missing params');
      return [];
    }

    try {
      const result = await window.electronAPI.invoke('sessions:list-children', parentSessionId, workspacePath);
      // console.log('[loadSessionChildrenAtom] IPC result:', result);
      if (result.success && Array.isArray(result.children)) {
        const childIds = result.children.map((c: any) => c.id);
        // console.log('[loadSessionChildrenAtom] Setting children:', childIds);
        set(sessionChildrenAtom(parentSessionId), childIds);

        // Set parent ID for each child and populate registry from list-children metadata
        // NOTE: We do NOT call loadSessionDataAtom here - that loads ALL messages which is expensive.
        // The list-children endpoint already returns all metadata needed for the list view.
        // Full session data (with messages) is loaded lazily when a session tab is actually opened.
        for (const child of result.children) {
          set(sessionParentIdAtom(child.id), parentSessionId);

          // Update registry with metadata from list-children (no messages needed for list view)
          const registry = new Map(get(sessionRegistryAtom));
          if (!registry.has(child.id)) {
            registry.set(child.id, {
              id: child.id,
              title: child.title || 'Untitled Session',
              createdAt: child.createdAt,
              updatedAt: child.updatedAt,
              provider: child.provider,
              sessionType: child.sessionType || 'session',
              messageCount: child.messageCount || 0,
              workspaceId: get(sessionListWorkspaceAtom) || '',
              isArchived: child.isArchived || false,
              isPinned: child.isPinned || false,
              worktreeId: child.worktreeId,
              parentSessionId: parentSessionId,
              childCount: 0,
              uncommittedCount: child.uncommittedCount || 0,
              // Metadata fields for TrackerPanel and kanban
              ...(child.phase && { phase: child.phase }),
              ...(child.tags && { tags: child.tags }),
              ...(child.linkedTrackerItemIds && { linkedTrackerItemIds: child.linkedTrackerItemIds }),
            });
            set(sessionRegistryAtom, registry);
          }
        }

        // Update the unified workstream state with children
        // This is critical for workstreamHasChildrenAtom to work
        const currentState = store.get(workstreamStateAtom(parentSessionId));
        const currentActive = currentState.activeChildId;
        // console.log('[loadSessionChildrenAtom] Current workstream state:', currentState);
        // console.log('[loadSessionChildrenAtom] Current active child:', currentActive, 'childIds:', childIds);

        // Determine the active child:
        // - If has children: use current active if valid, else first child
        // - If no children (single session): use the parent session itself
        const newActiveChild = childIds.length > 0
          ? (currentActive && childIds.includes(currentActive) ? currentActive : childIds[0])
          : parentSessionId;
        // console.log('[loadSessionChildrenAtom] Setting activeChildId to:', newActiveChild);

        set(workstreamStateAtom(parentSessionId), {
          type: childIds.length > 0 ? 'workstream' : 'single',
          childSessionIds: childIds,
          activeChildId: newActiveChild,
        });

        return childIds;
      }
    } catch (error) {
      console.error(`[sessions] Failed to load children for session ${parentSessionId}:`, error);
    }

    return [];
  }
);

/**
 * Set the active child session within a parent.
 * Marks the child as active and clears unread state.
 */
export const setActiveChildSessionAtom = atom(
  null,
  (get, set, { parentSessionId, childSessionId }: { parentSessionId: string; childSessionId: string | null }) => {
    set(sessionActiveChildAtom(parentSessionId), childSessionId);
    if (childSessionId) {
      set(markSessionReadAtom, childSessionId);
    }
  }
);

/**
 * Create a child session under a parent.
 * Returns the new session ID.
 */
export const createChildSessionAtom = atom(
  null,
  async (get, set, { parentSessionId, workspacePath, provider, model }: {
    parentSessionId: string;
    workspacePath: string;
    provider?: string;
    model?: string;
  }) => {
    console.log(`[sessions:createChildSessionAtom] Creating child for parent ${parentSessionId} with model: ${model}`);
    if (!parentSessionId || !workspacePath || !window.electronAPI) {
      console.error(`[sessions:createChildSessionAtom] Missing required params: parentSessionId=${parentSessionId}, workspacePath=${workspacePath}, electronAPI=${!!window.electronAPI}`);
      return null;
    }

    try {
      // Get parent session to inherit worktree_id
      const parentData = get(sessionStoreAtom(parentSessionId));
      const worktreeId = parentData?.worktreeId;
      console.log(`[sessions:createChildSessionAtom] Parent data: worktreeId=${worktreeId}, hasMessages=${!!parentData?.messages?.length}`);

      // Derive provider from model ID to prevent provider/model mismatches
      // (e.g., codex provider with opus model when default model differs from parent's provider)
      let resolvedProvider = provider || 'claude-code';
      if (model) {
        const modelId = ModelIdentifier.tryParse(model);
        if (modelId) {
          resolvedProvider = modelId.provider;
        }
      }

      console.log(`[sessions:createChildSessionAtom] Invoking sessions:create-child IPC with provider: ${resolvedProvider}, model: ${model}...`);
      const result = await window.electronAPI.invoke('sessions:create-child', {
        parentSessionId,
        workspacePath,
        worktreeId,
        provider: resolvedProvider,
        model,
      });
      console.log(`[sessions:createChildSessionAtom] IPC result:`, result);

      if (result.success && result.sessionId) {
        // Add to children list
        const children = get(sessionChildrenAtom(parentSessionId));
        const newChildren = [...children, result.sessionId];
        set(sessionChildrenAtom(parentSessionId), newChildren);

        // Set parent ID for the new child
        set(sessionParentIdAtom(result.sessionId), parentSessionId);

        // Initialize sessionStoreAtom with minimal data so derived atoms (mode, model) work
        // This prevents showing default values before loadSessionDataAtom runs
        set(sessionStoreAtom(result.sessionId), {
          id: result.sessionId,
          title: 'New Session',
          provider: resolvedProvider,
          model: model || 'claude-code:sonnet',
          mode: 'agent',
          messages: [],
          parentSessionId,
          worktreeId: worktreeId || undefined,
          createdAt: Date.now(),
          updatedAt: Date.now(),
        } as SessionData);

        // Make it the active child (both atoms need to be updated) and mark as read
        set(sessionActiveChildAtom(parentSessionId), result.sessionId);
        set(setWorkstreamActiveChildAtom, { workstreamId: parentSessionId, childId: result.sessionId });
        set(markSessionReadAtom, result.sessionId);

        // Update unified workstream state
        const { addWorkstreamChildAtom } = await import('./workstreamState');
        set(addWorkstreamChildAtom, {
          workstreamId: parentSessionId,
          childId: result.sessionId,
        });

        // Update the parent's child count in the session list so the UI updates.
        // Why max-with-existing: sessionChildrenAtom(parent) may not have been
        // hydrated yet (e.g. user clicked "+" before loadSessionChildrenAtom
        // populated it), in which case newChildren.length is 1 even though the
        // DB has many siblings. Lowering the registry's existing childCount
        // would mask the new child from SessionHistory's refresh check.
        const existingChildCount = get(sessionRegistryAtom).get(parentSessionId)?.childCount ?? 0;
        set(updateSessionFullAtom, {
          id: parentSessionId,
          childCount: Math.max(newChildren.length, existingChildCount + 1),
        });

        return result.sessionId;
      }
    } catch (error) {
      console.error(`[sessions] Failed to create child session for ${parentSessionId}:`, error);
    }

    return null;
  }
);

/**
 * Reparent a session by changing its parent_session_id.
 * Used for drag-and-drop to move sessions between workstreams.
 *
 * @param sessionId - The session to reparent
 * @param oldParentId - Current parent ID (null if orphan)
 * @param newParentId - New parent ID (null to make orphan)
 * @param workspacePath - Workspace path for validation
 * @returns true if successful, false otherwise
 */
export const reparentSessionAtom = atom(
  null,
  async (get, set, {
    sessionId,
    oldParentId,
    newParentId,
    workspacePath
  }: {
    sessionId: string;
    oldParentId: string | null;
    newParentId: string | null;
    workspacePath: string;
  }) => {
    if (!sessionId || !workspacePath || !window.electronAPI) {
      return false;
    }

    try {
      // Call IPC to update database
      const result = await window.electronAPI.invoke(
        'sessions:set-parent',
        {
          sessionId,
          newParentId,
          workspacePath
        }
      );

      if (!result.success) {
        console.error('[sessions] Failed to reparent session:', result.error);
        return false;
      }

      // Update atoms
      // 1. Update dragged session's parent
      set(sessionParentIdAtom(sessionId), newParentId);

      // 2. Remove from old parent's children (if had a parent)
      if (oldParentId) {
        const oldChildren = get(sessionChildrenAtom(oldParentId));
        const newOldChildren = oldChildren.filter(id => id !== sessionId);
        set(sessionChildrenAtom(oldParentId), newOldChildren);

        // Update old parent's workstream state
        set(workstreamStateAtom(oldParentId), {
          childSessionIds: newOldChildren,
        });
      }

      // 3. Add to new parent's children (if has a new parent)
      if (newParentId) {
        const newChildren = get(sessionChildrenAtom(newParentId));
        const updatedNewChildren = [...newChildren, sessionId];
        set(sessionChildrenAtom(newParentId), updatedNewChildren);

        // Update new parent's workstream state
        set(workstreamStateAtom(newParentId), {
          childSessionIds: updatedNewChildren,
        });

        // Make the reparented session the active child in the new parent and mark as read
        set(setWorkstreamActiveChildAtom, { workstreamId: newParentId, childId: sessionId });
        set(markSessionReadAtom, sessionId);
      }

      // 4. Update session list
      set(updateSessionFullAtom, {
        id: sessionId,
        parentSessionId: newParentId,
      });

      // Update child counts in session list
      if (oldParentId) {
        const oldChildren = get(sessionChildrenAtom(oldParentId));
        set(updateSessionFullAtom, {
          id: oldParentId,
          childCount: oldChildren.length,
        });
      }
      if (newParentId) {
        const newChildren = get(sessionChildrenAtom(newParentId));
        set(updateSessionFullAtom, {
          id: newParentId,
          childCount: newChildren.length,
        });
      }

      return true;
    } catch (error) {
      console.error(`[sessions] Failed to reparent session ${sessionId}:`, error);
      return false;
    }
  }
);

/**
 * Convert a single session into a workstream by:
 * 1. Creating a new parent session (the workstream root)
 * 2. Making the current session a child of the new parent
 * 3. Creating a new sibling session
 * Returns the new parent session ID.
 *
 * IMPORTANT: This operation is guarded against:
 * - Converting a session that already has a parent (is already a child)
 * - Converting a session that is already a workstream root (has children)
 * - Partial failures (rolls back parent creation if subsequent steps fail)
 */
export const convertToWorkstreamAtom = atom(
  null,
  async (get, set, { sessionId, workspacePath, model, skipSiblingCreation }: {
    sessionId: string;
    workspacePath: string;
    model?: string;
    /** When true, skip creating a new sibling session (used for drag-drop where another session takes that role) */
    skipSiblingCreation?: boolean;
  }) => {
    if (!sessionId || !workspacePath || !window.electronAPI) {
      return null;
    }

    try {
      // Get current session data
      const sessionData = get(sessionStoreAtom(sessionId));
      if (!sessionData) {
        console.error(`[sessions] Cannot convert to workstream: session ${sessionId} not found`);
        return null;
      }

      // Don't convert if already has a parent (is already a child session)
      if (sessionData.parentSessionId) {
        console.error(`[sessions] Cannot convert to workstream: session ${sessionId} already has a parent`);
        return null;
      }

      // Don't convert if the session is in a worktree. A worktree IS the workstream —
      // wrapping a worktree-resident session in a workstream container produces a
      // forbidden third layer (worktree → workstream → session). New sessions in a
      // worktree should just be created as flat siblings, never via this conversion path.
      if (sessionData.worktreeId) {
        console.error(`[sessions] Cannot convert to workstream: session ${sessionId} is in worktree ${sessionData.worktreeId} (the worktree is already the workstream)`);
        return null;
      }

      // Don't convert if already a workstream root (has children or isWorkstreamRoot flag)
      // Check children in the atom first
      const existingChildren = get(sessionChildrenAtom(sessionId));
      if (existingChildren.length > 0) {
        console.error(`[sessions] Cannot convert to workstream: session ${sessionId} already has children`);
        return null;
      }

      // Also check database via registry for childCount
      const registry = get(sessionRegistryAtom);
      const sessionMeta = registry.get(sessionId);
      if (sessionMeta?.childCount && sessionMeta.childCount > 0) {
        console.error(`[sessions] Cannot convert to workstream: session ${sessionId} already has ${sessionMeta.childCount} children in database`);
        return null;
      }

      // Check isWorkstreamRoot metadata flag
      if (sessionData.metadata?.isWorkstreamRoot) {
        console.error(`[sessions] Cannot convert to workstream: session ${sessionId} is already marked as workstream root`);
        return null;
      }

      // Check if the original session is pinned - we'll transfer the pin to the parent workstream
      const originalWasPinned = sessionMeta?.isPinned ?? false;

      // Create a new parent session (the workstream root)
      const parentId = crypto.randomUUID();
      const createResult = await window.electronAPI.invoke('sessions:create', {
        session: {
          id: parentId,
          provider: sessionData.provider || 'claude-code',
          model: sessionData.model,
          title: sessionData.title || 'Workstream',
          sessionType: 'workstream',
          metadata: {
            isWorkstreamRoot: true,
          },
        },
        workspaceId: workspacePath,
      });

      if (!createResult.success || !createResult.id) {
        console.error('[sessions] Failed to create workstream parent session');
        return null;
      }

      const parentSessionId = createResult.id;

      // If the original session was pinned, transfer the pin to the new parent workstream
      if (originalWasPinned) {
        try {
          await window.electronAPI.invoke('sessions:update-pinned', parentSessionId, true);
        } catch (error) {
          console.error('[sessions] Failed to pin parent workstream (non-fatal):', error);
          // Continue anyway - pinning is not critical to the conversion
        }
      }

      // Helper to clean up parent on failure
      const rollbackParent = async () => {
        try {
          await window.electronAPI.invoke('sessions:delete', parentSessionId);
          console.log(`[sessions] Rolled back parent session ${parentSessionId}`);
        } catch (rollbackError) {
          console.error(`[sessions] Failed to rollback parent session ${parentSessionId}:`, rollbackError);
        }
      };

      // Update current session to be a child of the new parent
      // Also unpin the original session if it was pinned (pin transfers to parent workstream)
      try {
        await window.electronAPI.invoke('sessions:update-metadata', sessionId, {
          parentSessionId,
          ...(originalWasPinned && { isPinned: false }),
        });
      } catch (error) {
        console.error('[sessions] Failed to set parent on original session, rolling back:', error);
        await rollbackParent();
        return null;
      }

      // Create a new sibling session (unless skipSiblingCreation is set, e.g. for drag-drop)
      let siblingResult: { success: boolean; sessionId?: string; error?: string } = { success: false };
      if (!skipSiblingCreation) {
        try {
          // Derive provider from model ID to prevent provider/model mismatches
          let siblingProvider = sessionData.provider || 'claude-code';
          if (model) {
            const modelId = ModelIdentifier.tryParse(model);
            if (modelId) {
              siblingProvider = modelId.provider;
            }
          }
          siblingResult = await window.electronAPI.invoke('sessions:create-child', {
            parentSessionId,
            workspacePath,
            worktreeId: sessionData.worktreeId,
            provider: siblingProvider,
            model,
          });
        } catch (error) {
          // Sibling creation failed - rollback: remove parentSessionId from original, delete parent
          console.error('[sessions] Failed to create sibling session (exception), rolling back:', error);
          try {
            await window.electronAPI.invoke('sessions:update-metadata', sessionId, {
              parentSessionId: null,
            });
          } catch (revertError) {
            console.error('[sessions] Failed to revert parentSessionId on original session:', revertError);
          }
          await rollbackParent();
          return null;
        }

        // Check if IPC returned an error (didn't throw but returned { success: false })
        if (!siblingResult.success) {
          console.error('[sessions] Failed to create sibling session (IPC error), rolling back:', siblingResult.error);
          try {
            await window.electronAPI.invoke('sessions:update-metadata', sessionId, {
              parentSessionId: null,
            });
          } catch (revertError) {
            console.error('[sessions] Failed to revert parentSessionId on original session:', revertError);
          }
          await rollbackParent();
          return null;
        }
      }

      // All database operations succeeded - now update atoms
      // Set parent ID for the original session
      set(sessionParentIdAtom(sessionId), parentSessionId);

      // Initialize children list with both sessions
      const children = [sessionId];
      if (siblingResult.success && siblingResult.sessionId) {
        children.push(siblingResult.sessionId);
        set(sessionParentIdAtom(siblingResult.sessionId), parentSessionId);
        // Initialize sessionStoreAtom for the sibling so derived atoms (mode, model) work
        // This prevents showing default values before loadSessionDataAtom runs
        set(sessionStoreAtom(siblingResult.sessionId), {
          id: siblingResult.sessionId,
          title: 'New Session',
          provider: sessionData.provider || 'claude-code',
          model: model || sessionData.model || 'claude-code:sonnet',
          mode: 'agent',
          messages: [],
          parentSessionId,
          worktreeId: sessionData.worktreeId || undefined,
          createdAt: Date.now(),
          updatedAt: Date.now(),
        } as SessionData);
      }
      set(sessionChildrenAtom(parentSessionId), children);

      // Set the active child and mark as read
      if (siblingResult.success && siblingResult.sessionId) {
        // Normal conversion: set the new sibling as active (user wants to work in the new session)
        set(sessionActiveChildAtom(parentSessionId), siblingResult.sessionId);
        set(setWorkstreamActiveChildAtom, { workstreamId: parentSessionId, childId: siblingResult.sessionId });
        set(markSessionReadAtom, siblingResult.sessionId);
      } else {
        // Drag-drop (no sibling): set the original session as active child
        set(sessionActiveChildAtom(parentSessionId), sessionId);
        set(setWorkstreamActiveChildAtom, { workstreamId: parentSessionId, childId: sessionId });
      }

      // Update unified workstream state. Always runs so drag-drop conversions
      // (skipSiblingCreation=true) initialize childSessionIds; otherwise subsequent
      // reparentSession calls operate on uninitialized state and the workstream's
      // child list never reflects further drops.
      const { convertToWorkstreamAtom: convertToWorkstreamStateAtom } = await import('./workstreamState');
      set(convertToWorkstreamStateAtom, {
        sessionId,
        parentId: parentSessionId,
        ...(siblingResult.success && siblingResult.sessionId
          ? { siblingId: siblingResult.sessionId }
          : {}),
      });

      // Add the new parent session to the session list so it appears in the sidebar
      // If original was pinned, transfer pin to the parent workstream
      const now = Date.now();
      set(addSessionFullAtom, {
        id: parentSessionId,
        title: sessionData.title || 'Workstream',
        provider: sessionData.provider || 'claude-code',
        model: sessionData.model,
        sessionType: 'workstream',
        createdAt: now,
        updatedAt: now,
        workspaceId: workspacePath,
        messageCount: 0,
        isArchived: false,
        isPinned: originalWasPinned,
        // Workstreams never carry a worktreeId — the worktree IS the workstream,
        // and the early-return above already blocks this path for worktree sessions.
        worktreeId: null,
        parentSessionId: null, // This is the root
        childCount: children.length,
        uncommittedCount: 0,
      });

      // Update the original session in the list to show it now has a parent
      // Also update isPinned to false if it was pinned (pin transferred to parent)
      set(updateSessionFullAtom, {
        id: sessionId,
        parentSessionId: parentSessionId,
        ...(originalWasPinned && { isPinned: false }),
      });

      // Update the selected workstream to point to the new parent
      // This is critical - without it, the sidebar still shows the old session
      // IMPORTANT: Use setSelectedWorkstreamAtom (not selectedWorkstreamAtom directly)
      // to ensure the selection is persisted to workspace state
      set(setSelectedWorkstreamAtom, {
        workspacePath,
        selection: {
          type: 'workstream' as WorkstreamType,
          id: parentSessionId,
        },
      });

      return { parentId: parentSessionId, siblingId: siblingResult.sessionId ?? null };
    } catch (error) {
      console.error(`[sessions] Failed to convert session ${sessionId} to workstream:`, error);
      return null;
    }
  }
);

/**
 * Open sessions list - just IDs and names for tab display.
 * AgenticPanel manages this list (open/close tabs).
 * AISessionView instances manage their own full session data.
 */
export const openSessionsAtom = atom<OpenSession[]>([]);

/**
 * Track in-flight load promises to deduplicate concurrent loads for the same session.
 * Multiple components (SessionTranscript, AgentWorkstreamPanel) may call loadSessionDataAtom
 * simultaneously for the same session. Without deduplication, each triggers a separate
 * IPC round-trip + DB query (2+ seconds each for large sessions).
 */
const loadSessionPromises = new Map<string, Promise<SessionData | null>>();

/**
 * Load session data into the atom.
 * Called by AISessionView on mount.
 */
export const loadSessionDataAtom = atom(
  null,
  async (get, set, { sessionId, workspacePath }: { sessionId: string; workspacePath: string }) => {
    if (!sessionId || !workspacePath || !window.electronAPI) {
      return null;
    }

    // Deduplicate: if a load is already in-flight for this session, reuse its promise
    const existing = loadSessionPromises.get(sessionId);
    if (existing) {
      const result = await existing;
      return result;
    }

    set(sessionLoadingAtom(sessionId), true);

    const loadPromise = (async () => {
    try {
      const sessionData = await window.electronAPI.aiLoadSession(sessionId, workspacePath);
      if (sessionData) {
        // Validate model field (for debugging)
        const model = sessionData.model;
        if (!model || !model.includes(':')) {
          console.warn(`[sessions] Session ${sessionId} has invalid model "${model}" - this indicates a bug in session creation`);
        }

        // Set sessionStoreAtom - derived atoms (mode, model, archived) will automatically sync
        set(sessionStoreAtom(sessionId), sessionData);

        // Initialize draft input if session has saved draft
        if (sessionData.draftInput) {
          set(sessionDraftInputAtom(sessionId), sessionData.draftInput);
        }

        // Initialize workstream state if this is a worktree session
        // This ensures type='worktree' is set even when loading from DB
        if (sessionData.worktreeId) {
          const currentState = store.get(workstreamStateAtom(sessionId));
          if (currentState.type !== 'worktree') {
            set(workstreamStateAtom(sessionId), {
              type: 'worktree',
              worktreeId: sessionData.worktreeId,
            });
          }
        }

        return sessionData;
      }
    } catch (error) {
      console.error(`[sessions] Failed to load session ${sessionId}:`, error);
    } finally {
      set(sessionLoadingAtom(sessionId), false);
    }

    return null;
    })();

    loadSessionPromises.set(sessionId, loadPromise);
    try {
      return await loadPromise;
    } finally {
      loadSessionPromises.delete(sessionId);
    }
  }
);

/**
 * Update session data in the atom (after streaming updates, etc.).
 * @deprecated Use updateSessionStoreAtom instead - it syncs both stores
 */
export const updateSessionDataAtom = atom(
  null,
  (get, set, { sessionId, updates }: { sessionId: string; updates: Partial<SessionData> }) => {
    if (process.env.NODE_ENV === 'development') {
      console.warn('[DEPRECATED] updateSessionDataAtom is deprecated. Use updateSessionStoreAtom instead.');
    }
    const current = get(sessionStoreAtom(sessionId));
    if (current) {
      set(sessionStoreAtom(sessionId), { ...current, ...updates });
    }
  }
);

/**
 * Track pending reloads per session to prevent concurrent race conditions.
 * When multiple reload requests come in rapidly (e.g., multiple message-logged events),
 * only the latest fetch should update the state to avoid stale data overwrites.
 */
const pendingReloads = new Map<string, { version: number; aborted: boolean }>();

/**
 * Reload session data from database.
 * Called after message-logged events, etc.
 *
 * Uses version tracking to prevent race conditions when multiple reloads
 * are triggered in rapid succession (e.g., from multiple message-logged events).
 * Only the most recent reload will update the atom state.
 */
export const reloadSessionDataAtom = atom(
  null,
  async (get, set, { sessionId, workspacePath }: { sessionId: string; workspacePath: string }) => {
    if (!sessionId || !workspacePath || !window.electronAPI) {
      return;
    }

    // Create a new version for this reload request
    const existingPending = pendingReloads.get(sessionId);
    if (existingPending) {
      // Mark the existing reload as aborted - it should not update state
      existingPending.aborted = true;
    }

    const currentVersion = (existingPending?.version || 0) + 1;
    const thisReload = { version: currentVersion, aborted: false };
    pendingReloads.set(sessionId, thisReload);

    try {
      const sessionData = await window.electronAPI.aiLoadSession(sessionId, workspacePath);

      // Check if this reload was superseded by a newer one
      if (thisReload.aborted) {
        return;
      }

      if (sessionData) {
        const current = get(sessionStoreAtom(sessionId));

        // Merge messages: preserve local-only optimistic messages not yet in database.
        // Optimistic messages (added in-memory by the renderer before the provider
        // persists them) have negative IDs (id < 0). They must be preserved across
        // DB reloads so chat bubbles don't flicker away while waiting for the
        // provider to persist the canonical version.
        if (current) {
          const dbMessages = sessionData.messages || [];
          const localMessages = current.messages || [];

          // Collect optimistic messages (negative IDs) that aren't yet in the DB.
          // These were added locally before the provider persisted them.
          // Drop any optimistic message whose type+text matches a DB message
          // with a similar timestamp (within 5s tolerance). The timestamp check
          // avoids premature eviction when a user sends two identical messages
          // (e.g. "yes" twice). Use safe getTime() in case createdAt is a string
          // after IPC serialization rather than a Date object.
          const safeGetTime = (d: Date | string | unknown): number => {
            if (d instanceof Date) return d.getTime();
            if (typeof d === 'string') return new Date(d).getTime();
            return 0;
          };
          const optimisticMessages = localMessages.filter(
            (m: TranscriptViewMessage) =>
              m.id < 0 &&
              !dbMessages.some(
                (db: TranscriptViewMessage) =>
                  db.type === m.type &&
                  db.text === m.text &&
                  Math.abs(safeGetTime(db.createdAt) - safeGetTime(m.createdAt)) < 5000
              )
          );

          if (optimisticMessages.length > 0) {
            // Append optimistic messages after DB messages so they appear at
            // the correct position (end of transcript). They'll be naturally
            // replaced on the next reload once the provider has persisted
            // canonical versions with real positive IDs.
            sessionData.messages = [...dbMessages, ...optimisticMessages];
          } else {
            sessionData.messages = dbMessages;
          }

          // Preserve read state
          const preservedTimestamp = current.lastReadMessageTimestamp || 0;
          const dbTimestamp = sessionData.lastReadMessageTimestamp || 0;
          sessionData.lastReadMessageTimestamp = Math.max(preservedTimestamp, dbTimestamp);

          // For claude-code, preserve tokenUsage (comes from /context IPC, not database)
          if (sessionData.provider === 'claude-code' && current.tokenUsage) {
            sessionData.tokenUsage = current.tokenUsage;
          }
        }

        // Final check before updating state - ensure we weren't superseded
        if (!thisReload.aborted) {
          // console.log(`[TRANSCRIPT-DEBUG] reloadSessionDataAtom: setting ${sessionData.messages?.length ?? 0} messages from DB for session ${sessionId}`);
          set(sessionStoreAtom(sessionId), sessionData);
          // Note: sessionModeAtom, sessionModelAtom, and sessionArchivedAtom are derived from sessionStoreAtom,
          // so they automatically stay in sync when sessionStoreAtom is updated
        }
      }
    } catch (error) {
      console.error(`[sessions] Failed to reload session ${sessionId}:`, error);
    } finally {
      // Clean up if this was the latest reload
      const currentPending = pendingReloads.get(sessionId);
      if (currentPending?.version === currentVersion) {
        pendingReloads.delete(sessionId);
      }
    }
  }
);

/**
 * Clean up session atoms when closing a session tab.
 */
export const cleanupSessionAtom = atom(null, (get, set, sessionId: string) => {
  // Remove all per-session atoms
  sessionStoreAtom.remove(sessionId);
  sessionLoadingAtom.remove(sessionId);
  sessionModeAtom.remove(sessionId);
  sessionModelAtom.remove(sessionId);
  sessionArchivedAtom.remove(sessionId);
  sessionProcessingAtom.remove(sessionId);
  sessionUnreadAtom.remove(sessionId);
  sessionPendingPromptAtom.remove(sessionId);
  sessionHasPendingInteractivePromptAtom.remove(sessionId);
  sessionLastReadAtom.remove(sessionId);
  sessionDraftInputAtom.remove(sessionId);
  sessionDraftAttachmentsAtom.remove(sessionId);
  sessionLastSubmitAtAtom.remove(sessionId);
  aiInputHistoryAtom.remove(sessionId);
  // Hierarchical session atoms
  sessionChildrenAtom.remove(sessionId);
  sessionActiveChildAtom.remove(sessionId);
  sessionParentIdAtom.remove(sessionId);
});

/**
 * Derived: total unread session count.
 * Badge component subscribes to show count in sidebar.
 */
export const totalUnreadCountAtom = atom((get) => {
  const sessions = get(sessionListAtom);
  return sessions.filter((s) => get(sessionUnreadAtom(s.id))).length;
});

/**
 * Derived: any session processing.
 * Useful for global processing indicator.
 */
export const anySessionProcessingAtom = atom((get) => {
  const sessions = get(sessionListAtom);
  return sessions.some((s) => get(sessionProcessingAtom(s.id)));
});

/**
 * Derived: any session with pending interactive prompt.
 * Useful for global attention indicator.
 */
export const anyPendingInteractivePromptAtom = atom((get) => {
  const sessions = get(sessionListAtom);
  return sessions.some((s) => get(sessionHasPendingInteractivePromptAtom(s.id)));
});

/**
 * Actions for managing sessions.
 */

/**
 * Mark a session as read (clear unread).
 * Called when user views the session.
 * Persists to database metadata for cross-device sync.
 */
export const markSessionReadAtom = atom(null, (get, set, sessionId: string) => {
  const wasUnread = get(sessionUnreadAtom(sessionId));

  const now = Date.now();
  set(sessionUnreadAtom(sessionId), false);
  set(sessionLastReadAtom(sessionId), now);

  // Always push lastReadAt through sync for cross-device read state.
  // Even if this device didn't consider the session "unread", another device
  // (e.g. iOS) may show it as unread because it tracks read state independently
  // via lastReadAt vs lastMessageAt. We must always sync the read timestamp
  // so other devices can clear their unread indicators.
  window.electronAPI?.invoke('ai:updateSessionMetadata', sessionId, {
    metadata: { hasUnread: false, lastReadAt: now },
  }).catch((err: Error) => {
    console.error('[sessions] Failed to persist read state:', err);
  });
});

/**
 * Set session as active.
 * Also marks it as read.
 */
export const setActiveSessionAtom = atom(
  null,
  (get, set, sessionId: string | null) => {
    set(activeSessionIdAtom, sessionId);
    if (sessionId) {
      set(markSessionReadAtom, sessionId);
    }
  }
);

/**
 * Remove a session and clean up its atoms.
 */
// ============================================================
// Session list loading and refresh
// ============================================================

// SessionListItem interface and sessionMetaToListItem conversion deleted.
// SessionMeta IS the list item type now. See SessionListItem type alias above.

/**
 * Derived: Root sessions only (no parent).
 * These are the sessions that should show in the main session history list.
 * Child sessions are displayed as tabs within their parent.
 * Filters by showArchivedSessionsAtom to hide/show archived sessions.
 * Now derives from sessionRegistryAtom instead of sessionListFullAtom.
 */
export const sessionListRootAtom = atom<SessionListItem[]>((get) => {
  const registry = get(sessionRegistryAtom);
  const workspacePath = get(sessionListWorkspaceAtom) || '';
  const showArchived = get(showArchivedSessionsAtom);

  return Array.from(registry.values())
    .filter(s => {
      if (!showArchived && s.isArchived) return false;
      // Meta-agent sessions are included - they're rendered via MetaAgentGroup in SessionHistory
      if (s.agentRole === 'meta-agent') return true;
      // Root sessions (no parent) are always included
      if (!s.parentSessionId) return true;
      // Blitz child sessions must also be included so they appear in worktreeGroupsData
      // and can be grouped into BlitzGroup via their parentSessionId
      const parent = registry.get(s.parentSessionId);
      return parent?.sessionType === 'blitz';
    })
    .sort((a, b) => b.updatedAt - a.updatedAt);
});

/**
 * Derived: Sessions for chat mode dropdown.
 * Includes standalone sessions and workstream children, but excludes:
 * - Workstream parent sessions (they're just containers)
 * - Worktree sessions (they're against different directories)
 * Now derives from sessionRegistryAtom instead of sessionListFullAtom.
 */
export const sessionListChatAtom = atom<SessionMeta[]>((get) => {
  const registry = get(sessionRegistryAtom);

  return Array.from(registry.values())
    .filter(s => {
      if (s.agentRole === 'meta-agent') return false;
      // Exclude worktree sessions
      if (s.worktreeId) return false;
      // Exclude workstream parents (childCount > 0 means it's a parent)
      if (s.childCount && s.childCount > 0) return false;
      return true;
    })
    .sort((a, b) => b.updatedAt - a.updatedAt);
});

/**
 * Whether the session list is currently loading.
 */
export const sessionListLoadingAtom = atom<boolean>(false);

/**
 * Current workspace path for session list.
 * Used to know when to refresh.
 */
export const sessionListWorkspaceAtom = atom<string | null>(null);

/**
 * Show archived sessions toggle.
 */
export const showArchivedSessionsAtom = atom<boolean>(false);

/**
 * Refresh the session list from the database.
 * This is an action atom that fetches from IPC and updates the list.
 * @param includeArchivedOverride - Optional explicit value for includeArchived.
 *   If provided, uses this value instead of reading from showArchivedSessionsAtom.
 *   This avoids race conditions when the atom is updated but not yet committed.
 */
export const refreshSessionListAtom = atom(
  null,
  async (get, set, includeArchivedOverride?: boolean) => {
    const workspacePath = get(sessionListWorkspaceAtom);
    if (!workspacePath || !window.electronAPI) {
      return;
    }

    const showArchived = includeArchivedOverride ?? get(showArchivedSessionsAtom);

    try {
      set(sessionListLoadingAtom, true);
      const result = await window.electronAPI.invoke('sessions:list', workspacePath, {
        includeArchived: showArchived,
      });

      if (result.success && Array.isArray(result.sessions)) {
        // Map IPC results directly into registry (single pass, no intermediate type)
        const registry = new Map<string, SessionMeta>();
        for (const s of result.sessions) {
          registry.set(s.id, {
            id: s.id,
            title: s.title || 'Untitled Session',
            createdAt: s.createdAt,
            updatedAt: s.updatedAt,
            provider: s.provider || 'claude',
            model: s.model,
            sessionType: s.sessionType || 'session',
            agentRole: s.agentRole || 'standard',
            createdBySessionId: s.createdBySessionId || null,
            messageCount: s.messageCount || 0,
            workspaceId: workspacePath,
            isArchived: s.isArchived || false,
            isPinned: s.isPinned || false,
            parentSessionId: s.parentSessionId || null,
            worktreeId: s.worktreeId || null,
            childCount: s.childCount || 0,
            uncommittedCount: s.uncommittedCount || 0,
            // Kanban board phase and tags from metadata JSONB
            ...(s.phase && { phase: s.phase }),
            ...(s.tags && { tags: s.tags }),
            // Linked tracker item IDs from metadata JSONB
            ...(s.linkedTrackerItemIds && { linkedTrackerItemIds: s.linkedTrackerItemIds }),
            ...(s.agentRole && { agentRole: s.agentRole }),
            ...(s.createdBySessionId !== undefined && { createdBySessionId: s.createdBySessionId }),
          });

          // Initialize unread state from database metadata (for cross-device sync)
          if (s.hasUnread) {
            set(sessionUnreadAtom(s.id), true);
          }
          // Initialize pending interactive prompt state from database metadata (for sidebar indicator persistence)
          if (s.hasPendingQuestion || s.hasPendingInteractivePrompt) {
            set(sessionHasPendingInteractivePromptAtom(s.id), true);
          }
        }

        set(sessionRegistryAtom, registry);
      }
    } catch (error) {
      console.error('[sessions] Failed to refresh session list:', error);
    } finally {
      set(sessionListLoadingAtom, false);
    }
  }
);

/**
 * Initialize the session list for a workspace.
 * Call this when the workspace is opened.
 *
 * This function is deduplicated - if called multiple times for the same workspace,
 * subsequent calls will return immediately (if already initialized) or return the
 * existing promise (if initialization is in progress).
 * This prevents redundant database queries when multiple components mount simultaneously.
 */
let initInProgress: Promise<void> | null = null;
let lastInitWorkspacePath: string | null = null;
let initializedWorkspacePath: string | null = null;

export async function initSessionList(workspacePath: string): Promise<void> {
  // If already initialized for this workspace, return immediately
  if (initializedWorkspacePath === workspacePath) {
    return;
  }

  // If same workspace init is already in progress, return existing promise
  if (initInProgress && lastInitWorkspacePath === workspacePath) {
    return initInProgress;
  }

  lastInitWorkspacePath = workspacePath;
  store.set(sessionListWorkspaceAtom, workspacePath);

  // Trigger initial load and track the promise
  initInProgress = store.set(refreshSessionListAtom);
  try {
    await initInProgress;
    // Mark as initialized only after successful completion
    initializedWorkspacePath = workspacePath;
  } finally {
    initInProgress = null;
  }
}

/**
 * Reset session list initialization state.
 * Call this when changing workspaces or when a full refresh is needed.
 */
export function resetSessionListInit(): void {
  initializedWorkspacePath = null;
  initInProgress = null;
  lastInitWorkspacePath = null;
}

/**
 * Add a new session to the full list (optimistic update).
 */
export const addSessionFullAtom = atom(
  null,
  (get, set, session: SessionListItem) => {
    // Update registry (single source of truth)
    const registry = new Map(get(sessionRegistryAtom));
    // Avoid duplicates
    if (registry.has(session.id)) {
      return;
    }
    registry.set(session.id, session);
    set(sessionRegistryAtom, registry);

    // Initialize sessionStoreAtom with minimal data so derived atoms (mode, model) work
    // This prevents showing default values before loadSessionDataAtom runs
    const existingStore = get(sessionStoreAtom(session.id));
    if (!existingStore) {
      set(sessionStoreAtom(session.id), {
        id: session.id,
        title: session.title || 'Untitled Session',
        provider: session.provider || 'claude-code',
        model: session.model || 'claude-code:sonnet',
        mode: 'agent',
        messages: [],
        createdAt: session.createdAt,
        updatedAt: session.updatedAt,
        worktreeId: session.worktreeId || null,
        parentSessionId: session.parentSessionId || null,
      } as SessionData);
    }

    // File state is loaded lazily when FilesEditedSidebar mounts
  }
);

/**
 * Update a session in the registry.
 * @deprecated Use updateSessionStoreAtom instead for full sync
 */
export const updateSessionFullAtom = atom(
  null,
  (get, set, update: Partial<SessionListItem> & { id: string }) => {
    if (process.env.NODE_ENV === 'development') {
      console.warn('[DEPRECATED] updateSessionFullAtom is deprecated. Use updateSessionStoreAtom instead.');
    }

    // Update registry (single source of truth)
    const registry = new Map(get(sessionRegistryAtom));
    const meta = registry.get(update.id);
    if (meta) {
      registry.set(update.id, {
        ...meta,
        ...(update.title !== undefined && { title: update.title }),
        ...(update.updatedAt !== undefined && { updatedAt: update.updatedAt }),
        ...(update.isArchived !== undefined && { isArchived: update.isArchived }),
        ...(update.isPinned !== undefined && { isPinned: update.isPinned }),
        ...(update.parentSessionId !== undefined && { parentSessionId: update.parentSessionId }),
        ...(update.worktreeId !== undefined && { worktreeId: update.worktreeId }),
        ...(update.childCount !== undefined && { childCount: update.childCount }),
        ...(update.uncommittedCount !== undefined && { uncommittedCount: update.uncommittedCount }),
        ...(update.messageCount !== undefined && { messageCount: update.messageCount }),
        ...(update.provider !== undefined && { provider: update.provider }),
        ...(update.sessionType !== undefined && { sessionType: update.sessionType }),
        ...(update.phase !== undefined && { phase: update.phase }),
        ...(update.tags !== undefined && { tags: update.tags }),
      });
      set(sessionRegistryAtom, registry);
    }
  }
);

/**
 * Remove a session from the registry.
 */
export const removeSessionFullAtom = atom(null, (get, set, sessionId: string) => {
  // Remove from registry (single source of truth)
  const registry = new Map(get(sessionRegistryAtom));
  registry.delete(sessionId);
  set(sessionRegistryAtom, registry);
});

// ============================================================
// Workstream atoms for AgentMode rewrite
// A "workstream" represents whatever is selected in the left sidebar:
// - A single session (no children)
// - A workstream set (parent + child sessions)
// - A worktree set (worktree + associated sessions)
// ============================================================

/**
 * Type of workstream currently selected.
 */
export type WorkstreamType = 'session' | 'workstream' | 'worktree';

/**
 * Selection state for the workstream list.
 * Keyed by workspace path - each workspace has its own selection.
 */
export const selectedWorkstreamAtom = atomFamily((_workspacePath: string) =>
  atom<{ type: WorkstreamType; id: string } | null>(null)
);

// Persist helper for selected workstream - called inline (no debounce needed,
// selection only changes on user click, not on rapid programmatic events).
// Using a standalone function avoids stale-closure issues after Vite HMR
// where a debounce timer callback would capture a stale module scope.
function persistSelectedWorkstream(workspacePath: string, selection: { type: WorkstreamType; id: string } | null): void {
  // console.log('[sessions] persistSelectedWorkstream:', selection?.type, selection?.id);
  window.electronAPI.invoke('workspace:update-state', workspacePath, {
    agenticCodingWindowState: {
      selectedWorkstream: selection,
    },
  }).catch((err: unknown) => {
    console.error('[sessions] Failed to persist selected workstream:', err);
  });
}

/**
 * Plain module-level callback invoked whenever a workstream is selected.
 * NOT a Jotai atom -- avoids Provider/store mismatch issues where the
 * atom getter inside setSelectedWorkstreamAtom reads from a different
 * store than the one used to register the callback.
 *
 * Used to trigger side effects (like exiting kanban view) without
 * creating circular dependencies between atom modules.
 * agentMode.ts imports from sessions.ts, so sessions.ts cannot import
 * agentMode atoms directly -- this callback breaks the cycle.
 */
let _workstreamSelectedHook: (() => void) | null = null;

export function registerWorkstreamSelectedHook(hook: (() => void) | null): void {
  _workstreamSelectedHook = hook;
}

/**
 * Set the selected workstream.
 * Handles marking the session as active/read.
 * Persists to workspace state for restore on reload.
 */
export const setSelectedWorkstreamAtom = atom(
  null,
  (get, set, { workspacePath, selection }: {
    workspacePath: string;
    selection: { type: WorkstreamType; id: string } | null;
  }) => {
    const prev = get(selectedWorkstreamAtom(workspacePath));
    set(selectedWorkstreamAtom(workspacePath), selection);

    // Fire the selection hook (e.g., exit kanban view).
    // This fires on EVERY selection, including re-selecting the same session,
    // which is intentional -- the user explicitly navigated to a session.
    if (selection) {
      _workstreamSelectedHook?.();
    }

    // If selecting a single session OR a worktree session, set it as active immediately.
    // Worktree selections use a session ID as the selection ID, and may not go through
    // loadSessionChildrenAtom (e.g. blitz children), so we must initialize active child here.
    if (selection?.type === 'session' || selection?.type === 'worktree') {
      set(setActiveSessionAtom, selection.id);
      // For session/worktree selections, the selected session is both the workstream root
      // and the active session tab.
      set(setWorkstreamActiveChildAtom, { workstreamId: selection.id, childId: selection.id });
    }
    // For workstream parents, do NOT set activeChildId here.
    // Let loadSessionChildren or persisted state handle it.

    // Persist to workspace state immediately (fire-and-forget).
    // No debounce needed: selection only changes on explicit user navigation.
    persistSelectedWorkstream(workspacePath, selection);
  }
);

/**
 * Session IDs belonging to a workstream.
 * For single sessions: [sessionId]
 * For workstreams: [childIds] (parent is just a container, not displayed)
 * For worktrees: [sessionId1, sessionId2, ...]
 *
 * This is a derived atom that reads from existing session state.
 */
export const workstreamSessionsAtom = atomFamily((workstreamId: string) =>
  atom((get) => {
    // Helper to filter out archived sessions
    const filterArchived = (sessionIds: string[]) =>
      sessionIds.filter(id => !get(sessionArchivedAtom(id)));

    // Check if this is a parent with children already loaded
    const children = get(sessionChildrenAtom(workstreamId));
    if (children.length > 0) {
      // This is a workstream parent - only return non-archived children
      // The parent is a structural container, not a displayable session
      return filterArchived(children);
    }

    // Get session data and registry for further checks
    const sessionData = get(sessionStoreAtom(workstreamId));
    const registry = get(sessionRegistryAtom);

    // Check if this session has a worktree_id
    if (sessionData?.worktreeId) {
      // This is a worktree session - find all non-archived sessions with the same worktreeId
      const worktreeSessions = Array.from(registry.values())
        .filter(s => s.worktreeId === sessionData.worktreeId)
        .sort((a, b) => a.createdAt - b.createdAt)
        .map(s => s.id);
      // If no sessions found in registry (might not be populated yet), at least include self
      if (worktreeSessions.length === 0) {
        // console.log('[workstreamSessionsAtom]', workstreamId, 'worktree session - returning self');
        return filterArchived([workstreamId]);
      }
      // console.log('[workstreamSessionsAtom]', workstreamId, 'returning worktree sessions:', worktreeSessions);
      return filterArchived(worktreeSessions);
    }

    // Check if this is a workstream root that hasn't had children loaded yet
    // Look up childCount from the registry (more reliable than metadata)
    const sessionMeta = registry.get(workstreamId);
    // console.log('[workstreamSessionsAtom]', workstreamId, 'sessionMeta:', sessionMeta?.id, 'childCount:', sessionMeta?.childCount);
    if (sessionMeta?.childCount && sessionMeta.childCount > 0) {
      // This is a workstream parent - find non-archived children from registry by parentSessionId
      // This works even before the workstream is opened
      const childrenFromRegistry = Array.from(registry.values())
        .filter(s => s.parentSessionId === workstreamId)
        .sort((a, b) => a.createdAt - b.createdAt)
        .map(s => s.id);
      // console.log('[workstreamSessionsAtom]', workstreamId, 'returning children from registry:', childrenFromRegistry);
      return filterArchived(childrenFromRegistry);
    }

    // Single session with no children and no worktree
    // console.log('[workstreamSessionsAtom]', workstreamId, 'returning self as single session');
    return filterArchived([workstreamId]);
  })
);

/**
 * Set the active session within a workstream.
 * Handles marking the session as read.
 * Note: This wraps setWorkstreamActiveChildAtom from workstreamState.ts
 */
export const setActiveSessionInWorkstreamAtom = atom(
  null,
  (get, set, { workstreamId, sessionId }: { workstreamId: string; sessionId: string }) => {
    set(setWorkstreamActiveChildAtom, { workstreamId, childId: sessionId });
    set(markSessionReadAtom, sessionId);
    // Also set the global active session so components like VoiceModeButton
    // (which live outside of the workstream context) can read it.
    set(activeSessionIdAtom, sessionId);
  }
);

/**
 * Derived: Is any session in this workstream processing?
 */
export const workstreamProcessingAtom = atomFamily((workstreamId: string) =>
  atom((get) => {
    const sessions = get(workstreamSessionsAtom(workstreamId));
    return sessions.some(id => get(sessionProcessingAtom(id)));
  })
);

/**
 * Derived: Unique tags across all sessions in this workstream (parent + children).
 * Returns a deduplicated, sorted array of tag strings.
 */
export const workstreamTagsAtom = atomFamily((workstreamId: string) =>
  atom((get) => {
    const sessions = get(workstreamSessionsAtom(workstreamId));
    const registry = get(sessionRegistryAtom);
    const tagSet = new Set<string>();

    // Collect tags from the workstream root itself
    const rootMeta = registry.get(workstreamId);
    if (rootMeta?.tags) {
      for (const tag of rootMeta.tags) tagSet.add(tag);
    }

    // Collect tags from all child sessions
    for (const sessionId of sessions) {
      const meta = registry.get(sessionId);
      if (meta?.tags) {
        for (const tag of meta.tags) tagSet.add(tag);
      }
    }

    return Array.from(tagSet).sort();
  })
);

/**
 * Derived: Does any session in this workstream have unread messages?
 */
export const workstreamUnreadAtom = atomFamily((workstreamId: string) =>
  atom((get) => {
    const sessions = get(workstreamSessionsAtom(workstreamId));
    return sessions.some(id => get(sessionUnreadAtom(id)));
  })
);

/**
 * Derived: Does any session in this workstream have a pending prompt?
 */
export const workstreamPendingPromptAtom = atomFamily((workstreamId: string) =>
  atom((get) => {
    const sessions = get(workstreamSessionsAtom(workstreamId));
    return sessions.some(id => get(sessionPendingPromptAtom(id)));
  })
);

/**
 * Derived: Does any session in this workstream have a pending interactive prompt?
 */
export const workstreamPendingInteractivePromptAtom = atomFamily((workstreamId: string) =>
  atom((get) => {
    const sessions = get(workstreamSessionsAtom(workstreamId));
    return sessions.some(id => get(sessionHasPendingInteractivePromptAtom(id)));
  })
);

/**
 * Workstream title - derived from the root session or worktree name.
 * Falls back to registry if session data hasn't been loaded yet.
 */
export const workstreamTitleAtom = atomFamily((workstreamId: string) =>
  atom((get) => {
    const sessionData = get(sessionStoreAtom(workstreamId));
    if (sessionData?.title) {
      return sessionData.title;
    }
    // Fallback to registry if session data not loaded yet
    const registry = get(sessionRegistryAtom);
    const meta = registry.get(workstreamId);
    return meta?.title || 'Untitled';
  })
);
