/**
 * Protocol Interface for Agent SDK Adapters
 *
 * This interface normalizes the differences between various agent SDKs
 * (Claude Agent SDK, OpenAI Codex SDK) to provide a unified abstraction
 * layer for agent providers.
 *
 * The protocol adapters isolate platform-specific SDK details from the
 * provider implementations, making it easier to:
 * - Add new agent SDKs
 * - Update SDK versions without touching provider logic
 * - Test providers with mock protocols
 * - Share common infrastructure across providers
 *
 * Ownership note: this module is the canonical home of the protocol
 * contract. The runtime re-exports these types via
 * `@nimbalyst/runtime/ai/server/protocols/ProtocolInterface` so that
 * existing runtime imports keep working without source churn, but the
 * SDK now owns the type bodies. Adding a new field, changing a tag, or
 * tightening a discriminator happens here first; the runtime picks it
 * up via the re-export.
 */

/**
 * MCP server configuration
 */
export interface MCPServerConfig {
  command: string;
  args?: string[];
  env?: Record<string, string>;
  [key: string]: unknown;
}

/**
 * Platform-specific session data for internal use
 */
export interface RawProtocolSession {
  [key: string]: unknown;
}

/**
 * Structured result from tool execution
 */
export interface ToolResult {
  success: boolean;
  result?: unknown;
  output?: unknown;
  error?: string | unknown;
  status?: string;
  // command_execution specific
  command?: string;
  exit_code?: number;
  // file_change specific
  changes?: unknown;
  // web_search specific
  query?: string;
  action?: unknown;
  fileSnapshots?: Record<string, { content: string | null; error?: string; isBinary?: boolean; truncated?: boolean }>;
}

/**
 * Options for creating or resuming a session
 */
export interface SessionOptions {
  /** Working directory path for the session */
  workspacePath: string;

  /** Model identifier (e.g., 'sonnet', 'gpt-5') */
  model?: string;

  /** System prompt to initialize the agent */
  systemPrompt?: string;

  /** Abort signal for cancelling the session */
  abortSignal?: AbortSignal;

  /** Permission mode for tool approvals ('ask', 'auto', 'plan') */
  permissionMode?: string;

  /** MCP server configurations */
  mcpServers?: Record<string, MCPServerConfig>;

  /** Environment variables for the session */
  env?: Record<string, string>;

  /** Tools to allow (whitelist) */
  allowedTools?: string[];

  /** Tools to disallow (blacklist) */
  disallowedTools?: string[];

  /** Platform-specific options that don't fit the common schema */
  raw?: Record<string, unknown>;
}

/**
 * Attachment shape used by ProtocolMessage.
 *
 * Inlined into the SDK (rather than re-imported from the runtime's
 * `ChatAttachment`) so the protocol contract has no dependency on
 * runtime types. The runtime's `ChatAttachment` is structurally
 * assignable to this shape, so existing runtime call sites that pass
 * `ChatAttachment[]` continue to type-check at the SDK boundary.
 */
export interface ProtocolAttachment {
  id: string;
  filename: string;
  filepath: string;
  mimeType: string;
  size: number;
  type: 'image' | 'pdf' | 'document';
  thumbnail?: string;
  addedAt: number;
}

/**
 * Message sent to the agent
 */
export interface ProtocolMessage {
  /** Text content of the message */
  content: string;

  /** Optional attachments (images, PDFs, documents) */
  attachments?: ProtocolAttachment[];

  /** Session ID for logging and tracking */
  sessionId?: string;

  /** AI mode when message was sent ('planning' or 'agent' or 'auto') */
  mode?: 'planning' | 'agent' | 'auto';

  /**
   * Abort signal for THIS turn. Protocol sessions are cached across turns, so
   * a signal passed at session creation goes stale after the first turn --
   * per-message is the only correct place to carry it.
   */
  abortSignal?: AbortSignal;
}

/**
 * Session created or resumed by the protocol
 */
export interface ProtocolSession {
  /** Platform-specific session identifier */
  id: string;

  /** Platform identifier (e.g., 'claude-sdk', 'codex-sdk') */
  platform: string;

  /** Platform-specific session data (for internal use) */
  raw?: RawProtocolSession;
}

/**
 * Event types emitted during message streaming
 */
export type ProtocolEventType =
  | 'raw_event'               // Raw SDK event (for persistence/audit)
  | 'text'                    // Text content chunk
  | 'reasoning'               // Thinking/reasoning content (not part of final output)
  | 'tool_call'               // Tool invocation
  | 'tool_result'             // Tool execution result
  | 'error'                   // Error occurred
  | 'complete'                // Stream complete
  | 'usage'                   // Token usage stats
  | 'planning_mode_entered'   // Agent entered planning mode
  | 'planning_mode_exited';   // Agent exited planning mode

/**
 * Event emitted during message streaming
 */
export interface ProtocolEvent {
  /** Event type */
  type: ProtocolEventType;

  /** Text content (for 'text' events) */
  content?: string;

  /** Tool call data (for 'tool_call' events) */
  toolCall?: {
    id?: string;
    name: string;
    arguments?: Record<string, any>;
    result?: ToolResult | string;
  };

  /** Tool result data (for 'tool_result' events) */
  toolResult?: {
    id?: string;
    name: string;
    result?: ToolResult | string;
  };

  /** Error message (for 'error' events) */
  error?: string;

  /** Token usage (for 'usage' or 'complete' events) */
  usage?: {
    input_tokens: number;
    output_tokens: number;
    total_tokens: number;
  };

  /** Current context fill tokens for this turn (provider-reported snapshot) */
  contextFillTokens?: number;

  /** Maximum context window for the active model */
  contextWindow?: number;

  /** Additional metadata */
  metadata?: Record<string, unknown>;
}

/**
 * Agent Protocol Interface
 *
 * All agent SDK adapters must implement this interface to provide
 * a consistent abstraction layer for agent providers.
 */
export interface AgentProtocol {
  /**
   * Platform identifier (e.g., 'claude-sdk', 'codex-sdk')
   */
  readonly platform: string;

  /**
   * Create a new session
   *
   * @param options - Session configuration
   * @returns Protocol session with platform-specific ID
   */
  createSession(options: SessionOptions): Promise<ProtocolSession>;

  /**
   * Resume an existing session
   *
   * @param sessionId - Platform-specific session ID to resume
   * @param options - Session configuration
   * @returns Protocol session
   */
  resumeSession(sessionId: string, options: SessionOptions): Promise<ProtocolSession>;

  /**
   * Fork an existing session (create a branch)
   *
   * Not all platforms support forking. If unsupported, implementations
   * should either throw an error or create a new session.
   *
   * @param sessionId - Platform-specific session ID to fork from
   * @param options - Session configuration for the fork
   * @returns New protocol session branched from the source
   */
  forkSession(sessionId: string, options: SessionOptions): Promise<ProtocolSession>;

  /**
   * Send a message and receive streaming events
   *
   * @param session - Active protocol session
   * @param message - Message to send
   * @returns Async iterable of protocol events
   */
  sendMessage(
    session: ProtocolSession,
    message: ProtocolMessage
  ): AsyncIterable<ProtocolEvent>;

  /**
   * Abort an active session
   *
   * @param session - Session to abort
   */
  abortSession(session: ProtocolSession): void;

  /**
   * Clean up session resources
   *
   * Called when a session is deleted or no longer needed.
   *
   * @param session - Session to clean up
   */
  cleanupSession(session: ProtocolSession): void;
}
