/**
 * Session State Types
 *
 * Defines the types for tracking AI session state across the application.
 */

/**
 * Possible states for an AI session
 */
export type SessionStatus =
  | 'idle'                  // Session exists but not currently active
  | 'running'               // Session is actively processing
  | 'waiting_for_input'     // Session is waiting for user input (survives restart)
  | 'error';                // Session ended with an error

/**
 * In-memory state for a running session
 */
export interface SessionState {
  sessionId: string;
  workspacePath?: string;
  status: SessionStatus;
  lastActivity: Date;
  isStreaming: boolean;
}

/**
 * Events emitted by the SessionStateManager
 */
export type SessionStateEvent =
  | { type: 'session:started'; sessionId: string; workspacePath?: string; timestamp: Date }
  | { type: 'session:streaming'; sessionId: string; workspacePath?: string; timestamp: Date }
  | { type: 'session:waiting'; sessionId: string; workspacePath?: string; timestamp: Date }
  | { type: 'session:completed'; sessionId: string; workspacePath?: string; timestamp: Date }
  | { type: 'session:error'; sessionId: string; workspacePath?: string; error: string; timestamp: Date }
  | { type: 'session:interrupted'; sessionId: string; workspacePath?: string; timestamp: Date }
  | { type: 'session:activity'; sessionId: string; workspacePath?: string; timestamp: Date };

/**
 * Event listener function type
 */
export type SessionStateListener = (event: SessionStateEvent) => void;

/**
 * Database row structure for ai_sessions table with state fields
 */
export interface AISessionRow {
  id: string;
  workspace_id: string;
  file_path: string | null;
  provider: string;
  model: string | null;
  title: string;
  session_type: string;
  document_context: any;
  provider_config: any;
  provider_session_id: string | null;
  draft_input: string | null;
  metadata: any;
  last_read_message_id: string | null;
  last_read_timestamp: Date | null;
  status: SessionStatus;
  last_activity: Date;
  created_at: Date;
  updated_at: Date;
}

/**
 * Options for starting a session
 */
export interface StartSessionOptions {
  sessionId: string;
  workspacePath?: string;
  initialStatus?: SessionStatus;
}

/**
 * Options for updating session activity
 */
export interface UpdateActivityOptions {
  sessionId: string;
  status?: SessionStatus;
  isStreaming?: boolean;
}
