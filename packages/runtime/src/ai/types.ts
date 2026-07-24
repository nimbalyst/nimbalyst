// Import and re-export types from server types to avoid duplication
import type {
  Message,
  TranscriptViewMessage,
  DocumentContext,
  SessionData,
  AgentMessage,
  CreateAgentMessageInput,
  AgentMessageDirection,
  ChatAttachment,
  // Interactive prompt types
  InteractivePromptStatus,
  PermissionRequestContent,
  PermissionResponseContent,
  AskUserQuestionRequestContent,
  AskUserQuestionResponseContent,
  InteractivePromptContent,
} from './server/types';
export type {
  Message,
  TranscriptViewMessage,
  DocumentContext,
  SessionData,
  AgentMessage,
  CreateAgentMessageInput,
  AgentMessageDirection,
  ChatAttachment,
  // Interactive prompt types
  InteractivePromptStatus,
  PermissionRequestContent,
  PermissionResponseContent,
  AskUserQuestionRequestContent,
  AskUserQuestionResponseContent,
  InteractivePromptContent,
};

// Core AI types
export interface AIToolCall {
  id?: string;
  name: string;
  arguments?: any;
  result?: any;
}

export interface AIToolResult {
  success: boolean;
  result?: any;
  error?: string;
}

// AI Stream Response types - MUST match what UI expects!
export type AIStreamChunk =
  | { type: 'text'; content: string }  // Text content - MUST use 'content' not 'text'!
  | { type: 'complete'; content: string; isComplete: true; usage?: any }  // Completion
  | { type: 'error'; error: string }  // Error
  | { type: 'tool_call'; toolCall: any }  // Tool call
  | { type: 'tool_error'; toolError: any }  // Tool error
  | { type: 'stream_edit_start'; config: any }  // Stream edit start
  | { type: 'stream_edit_content'; content: string }  // Stream edit content
  | { type: 'stream_edit_end'; error?: string };  // Stream edit end

export type AIStreamResponse = AsyncIterableIterator<AIStreamChunk>;


export type StreamingMode = 'extend' | 'after' | 'append' | 'replace' | 'insert';

export interface StreamingConfig {
  position?: 'cursor' | 'selection' | 'end' | 'after-selection';
  mode?: StreamingMode;  // Optional - plugin will decide based on context if not provided
  insertAfter?: string;
  insertAtEnd?: boolean;
}

export interface ProviderRequest {
  prompt: string;
  document?: DocumentContext;
  model?: string;
  apiKey?: string;
  baseUrl?: string;
  headers?: Record<string, string>;
}

// ChatMessage removed - use Message directly from server/types

// ChatToolCall is the same structure as the toolCall field in Message
export type ChatToolCall = {
  id?: string;
  name: string;
  arguments?: any;
  result?: any;
};

// ChatSession removed - use SessionData directly from server/types

export type StreamEvent =
  | { type: 'start'; config: StreamingConfig }
  | { type: 'content'; chunk: string }
  | { type: 'end' }
  | { type: 'error'; error: string };

export interface StreamCallbacks {
  onStart?: (config: StreamingConfig) => void;
  onContent?: (chunk: string) => void;
  onEnd?: () => void;
  onError?: (err: unknown) => void;
}
