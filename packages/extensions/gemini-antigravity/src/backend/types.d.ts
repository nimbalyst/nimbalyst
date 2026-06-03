/**
 * Ambient backend module types for the gemini-antigravity extension.
 *
 * These mirror what the Nimbalyst extension SDK will eventually publish once
 * the backend-module surface is fully baked. They are declared locally here so
 * this extension can compile independently of SDK release cadence; when the SDK
 * ships the canonical interfaces, this file can be deleted or narrowed to a
 * re-export shim without changing any agent.ts logic.
 *
 * Design notes (from phase-4 proposal, Q1-Q7 resolutions):
 *   - Q1: backend module exports a default `activate(ctx)` factory.
 *   - Q2: raw-message audit goes through ctx.services.logRaw (host-owned DB).
 *   - Q4: provider session lifecycle uses createSession/resumeSession/abort/cleanup.
 *   - Q6: streaming surface is AsyncIterable<ProtocolEvent> from sendMessage.
 *   - Q7: tool-call dispatch is PROVIDER-PRIVATE via injected callbacks --
 *         NOT host.requestPermission. The host provides the executor via
 *         BackendActivateContext.services.toolExecutor during session setup.
 */

declare global {
  // -------------------------------------------------------------------------
  // Event / message shapes
  // -------------------------------------------------------------------------

  /**
   * Provider-agnostic event yielded by sendMessage(). Mirrors the canonical
   * event taxonomy the host uses to render transcripts.
   */
  type ProtocolEvent =
    | { type: 'text'; content: string }
    | {
        type: 'tool_call';
        toolCall: {
          id: string;
          name: string;
          arguments: Record<string, unknown>;
          result?: unknown;
        };
      }
    | { type: 'complete'; content?: string; isComplete: true }
    | { type: 'error'; error: string };

  /**
   * A message in the session history, in the shape this provider's tool loop
   * understands. The host normalizes its own canonical events down to this
   * shape when seeding history on session resume.
   */
  interface BackendHistoryMessage {
    role?: 'user' | 'assistant' | 'tool';
    content?: string;
    toolCall?: { name?: string; result?: unknown };
  }

  // -------------------------------------------------------------------------
  // OpenAI-shaped tool definition (compatible with both the chat-completions
  // function-calling format and our own renderer-side tool registry).
  // -------------------------------------------------------------------------

  interface BackendOpenAITool {
    type: 'function';
    function: {
      name: string;
      description?: string;
      parameters?: Record<string, unknown>;
    };
  }

  // -------------------------------------------------------------------------
  // Session lifecycle inputs/outputs
  // -------------------------------------------------------------------------

  interface CreateSessionInput {
    sessionId: string;
    workspacePath?: string;
    model?: string;
    /** OpenAI-shaped tool definitions the host wants this session to have. */
    tools?: BackendOpenAITool[];
    /** Initial system prompt. Host can also stream more via per-turn input. */
    systemPrompt?: string;
    /** Optional document context the host wants attached to user turns. */
    documentContext?: unknown;
  }

  interface ResumeSessionInput {
    sessionId: string;
    workspacePath?: string;
    model?: string;
    tools?: BackendOpenAITool[];
    systemPrompt?: string;
    documentContext?: unknown;
    /** Prior conversation history to seed the tool loop. */
    history?: BackendHistoryMessage[];
  }

  interface SendMessageInput {
    sessionId: string;
    message: string;
    /** Optional override of session-level tools for this turn. */
    tools?: BackendOpenAITool[];
    /** Optional override of session-level system prompt for this turn. */
    systemPrompt?: string;
    /** Optional document context for this turn only. */
    documentContext?: unknown;
    /** Optional override of session-level history for this turn. */
    history?: BackendHistoryMessage[];
  }

  // -------------------------------------------------------------------------
  // Host-provided services (Q2, Q7)
  // -------------------------------------------------------------------------

  interface BackendServices {
    /**
     * Raw-message audit log. The host owns the database; the backend module
     * just hands raw provider payloads to be persisted. (Q2 resolution.)
     */
    logRaw(
      sessionId: string,
      direction: 'inbound' | 'outbound',
      content: string,
      metadata?: Record<string, unknown>
    ): Promise<void> | void;

    /**
     * Provider-private tool dispatcher (Q7). The host injects this so the
     * backend can execute tool calls without going through the public
     * requestPermission/askUserQuestion API. Returns the raw tool result
     * which the backend then folds back into the model's next turn.
     */
    toolExecutor(payload: {
      sessionId: string;
      workspacePath?: string;
      name: string;
      args: Record<string, unknown>;
    }): Promise<unknown>;

    /**
     * Optional emit-event channel for non-streaming side signals (prompt
     * additions, telemetry, debugging). The host decides what to do with these.
     */
    emitEvent?(payload: {
      sessionId: string;
      event: string;
      data: unknown;
    }): Promise<void> | void;
  }

  // -------------------------------------------------------------------------
  // activate(ctx) shape
  // -------------------------------------------------------------------------

  /**
   * Per-extension configuration the host hands to activate(). Read once at
   * activation and cached on the module instance. Allows the host to override
   * environment-derived defaults (port candidates, IDE version string) without
   * the backend reading process.env directly.
   */
  interface BackendExtensionConfig {
    overrideIdeVersion?: string;
    spawnPortCandidates?: readonly number[];
    [key: string]: unknown;
  }

  interface BackendActivateContext {
    /** Stable extension identifier (e.g. "gemini-antigravity"). */
    extensionId: string;
    /** Absolute path to the extension's installation directory. */
    extensionPath: string;
    /** Host-provided services (raw audit log + private tool executor). */
    services: BackendServices;
    /** Configuration handed in by the host (manifest + user settings merged). */
    config?: BackendExtensionConfig;
    /** Optional shared logger from the host. Falls back to console if absent. */
    logger?: {
      debug?(...args: unknown[]): void;
      info?(...args: unknown[]): void;
      warn?(...args: unknown[]): void;
      error?(...args: unknown[]): void;
    };
  }

  // -------------------------------------------------------------------------
  // The API the backend module returns from activate()
  // -------------------------------------------------------------------------

  interface BackendModuleApi {
    /** Create a fresh provider session. */
    createSession(input: CreateSessionInput): Promise<void>;

    /** Resume an existing session (rehydrate history + config). */
    resumeSession(input: ResumeSessionInput): Promise<void>;

    /**
     * Run a single turn of the tool loop. Yields ProtocolEvent as the model
     * produces text, requests tools, or completes. Caller is the host's
     * provider-side streaming bridge; the host normalizes these into canonical
     * transcript events.
     */
    sendMessage(input: SendMessageInput): AsyncIterable<ProtocolEvent>;

    /** Abort the in-flight turn for a session, if any. */
    abortSession(sessionId: string): Promise<void> | void;

    /** Drop all state for a session (memory only; the host owns persisted DB). */
    cleanupSession(sessionId: string): Promise<void> | void;
  }
}

// Required so this file is treated as a module-augmenting declaration file.
export {};
