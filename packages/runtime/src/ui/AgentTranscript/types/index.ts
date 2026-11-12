/**
 * Agent Transcript types for UI display
 * Extends core runtime types for rich transcript rendering
 */

import type { SessionData } from '../../../ai/server/types';

// Re-export core runtime types
export type { SessionData, DocumentContext, TranscriptViewMessage } from '../../../ai/server/types';
export type { AIProviderType } from '../../../ai/server/types';

/**
 * UI-specific settings for transcript display
 */
export interface TranscriptSettings {
  showToolCalls: boolean;
  showThinking: boolean;
  compactMode: boolean;
  collapseTools: boolean;
  showSessionInit: boolean;
}

/**
 * Prompt marker for navigation sidebar
 */
export interface PromptMarker {
  /** Unique within the session's marker list; also the React key. */
  id: number;
  sessionId: string;
  /**
   * `prompt` is a message the user typed. `agentPrompt` was sent by another
   * session (send_prompt, child-session reports). `answer` is the user's
   * response to a question tool (AskUserQuestion, PromptForUserInput).
   * Absent means `prompt`.
   */
  kind?: 'prompt' | 'agentPrompt' | 'answer';
  /** 1-based count among the user's own prompts; only set for `prompt`. */
  promptNumber?: number;
  /** For `prompt`/`agentPrompt` the message text; for `answer` the question. */
  promptText: string;
  /** For `answer`: a one-line summary of what the user chose. */
  answerText?: string;
  /** For `answer`: the question tool call's id, to reveal its card. */
  toolCallId?: string;
  outputIndex: number;
  outputLine?: number;
  timestamp: string;
  completionTimestamp?: string;
}

/**
 * Extended session data for agentic coding sessions
 * Includes plan references, file edits, and todo tracking
 */
export interface AgenticSessionData extends SessionData {
  metadata?: SessionData['metadata'] & {
    planDocumentPath?: string;
    fileEdits?: FileEditSummary[];
    todos?: TodoItem[];
    sessionType?: 'agentic-coding' | 'chat';
  };
}

/**
 * File edit summary for displaying in transcript
 */
export interface FileEditSummary {
  filePath: string;
  linkType?: 'edited' | 'referenced' | 'read';
  operation?: 'create' | 'edit' | 'delete' | 'rename';
  linesAdded?: number;
  linesRemoved?: number;
  timestamp: string;
  metadata?: Record<string, unknown>;
}

/**
 * TODO item for task tracking in agentic sessions
 */
export interface TodoItem {
  id: string;
  content: string;
  activeForm: string;
  status: 'pending' | 'in_progress' | 'completed';
  timestamp?: string;
}
