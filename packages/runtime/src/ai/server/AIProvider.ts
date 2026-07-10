/**
 * Abstract interface for AI providers
 */

import { EventEmitter } from 'events';
import {
  DocumentContext,
  ProviderConfig,
  ProviderCapabilities,
  StreamChunk,
  ToolHandler,
  ToolDefinition,
  AgentToolDefinition,
} from './types';
import { toolRegistry, toAnthropicTools, toOpenAITools } from '../tools';
import { buildSystemPrompt } from '../prompt';
import {
  AgentMessageWriteQueue,
  type MessagesLoggedBatchEvent,
} from '../../storage/repositories/AgentMessageWriteQueue';
import { extractSearchable } from './transcript/searchableTextExtractor';

/**
 * Interface for providers that support the AskUserQuestion tool
 * Implemented by agent providers that can pause for user input.
 */
export interface AskUserQuestionProvider {
  /**
   * Resolve a pending AskUserQuestion request with user's answers
   * @returns true if the question was found and resolved, false if not found
   */
  resolveAskUserQuestion(
    questionId: string,
    answers: Record<string, string>,
    sessionId?: string,
    respondedBy?: 'desktop' | 'mobile'
  ): boolean;

  /**
   * Reject a pending AskUserQuestion request (e.g., on cancel/abort)
   */
  rejectAskUserQuestion(
    questionId: string,
    error: Error,
    respondedBy?: 'desktop' | 'mobile'
  ): void;
}

/**
 * Type guard to check if a provider supports AskUserQuestion
 */
export function isAskUserQuestionProvider(provider: AIProvider): provider is AIProvider & AskUserQuestionProvider {
  return !!provider && typeof (provider as any).resolveAskUserQuestion === 'function';
}

export interface SlashCommandCatalogProvider {
  getSlashCommands?(): string[];
  getSkills?(): string[];
}

export function isSlashCommandCatalogProvider(
  provider: AIProvider | null | undefined
): provider is AIProvider & SlashCommandCatalogProvider {
  return !!provider && (
    typeof (provider as any).getSlashCommands === 'function' ||
    typeof (provider as any).getSkills === 'function'
  );
}

export interface AIProvider extends EventEmitter {
  /**
   * Initialize the provider with configuration
   */
  initialize(config: ProviderConfig): Promise<void>;

  /**
   * Send a message to the AI provider
   * Returns an async iterator for streaming responses
   */
  sendMessage(
    message: string,
    documentContext?: DocumentContext,
    sessionId?: string,
    messages?: any[],
    workspacePath?: string,
    attachments?: any[],
    /**
     * Optional, additive. Tool definitions the host wants this turn to expose.
     * Only extension-agent providers read it (their tool loop renders tools as
     * JSON in the prompt); built-in providers ignore the extra arg entirely.
     */
    tools?: AgentToolDefinition[],
    /**
     * Optional, additive. System-prompt override for this turn. Only
     * extension-agent providers read it (they prepend it as the
     * baseSystemPrompt ahead of the tool-envelope block). Built-in providers
     * build their own system prompt internally and ignore the extra arg. Used
     * to deliver the meta-agent persona to extension agents.
     */
    systemPrompt?: string
  ): AsyncIterableIterator<StreamChunk>;

  /**
   * Abort any ongoing request
   */
  abort(): void;

  /**
   * Gracefully interrupt the current turn so the next queued prompt can fire
   * immediately. Providers that support true mid-stream interrupt (Claude Code)
   * override this to wrap up cleanly without killing the subprocess; others
   * fall back to the default `abort()` and rely on the caller to trigger the
   * next queued prompt. The return value lets the caller distinguish the two.
   */
  interruptCurrentTurn(): Promise<{ method: 'interrupt' | 'abort' }>;

  /**
   * Get the capabilities of this provider
   */
  getCapabilities(): ProviderCapabilities;

  /**
   * Register a tool handler for executing tools
   */
  registerToolHandler(handler: ToolHandler): void;

  /**
   * Set provider-specific session data (e.g., Claude Code session ID)
   */
  setProviderSessionData?(sessionId: string, data: any): void;

  /**
   * Get provider-specific session data
   */
  getProviderSessionData?(sessionId: string): any;

  /**
   * Set hidden mode for next message logging (Claude Code only)
   * When true, the next sendMessage call will mark logged messages as hidden
   */
  setHiddenMode?(enabled: boolean): void;

  /**
   * Clean up resources
   */
  destroy(): void;
}

/**
 * Process-wide write queue shared across providers. The queue coalesces
 * non-blocking chunk writes into multi-row INSERTs so synchronous
 * `logAgentMessage` awaits (user prompts, final outputs, `can_use_tool`
 * permission audits) don't get starved behind the firehose. Provider
 * instances forward their flush calls into this single queue.
 *
 * See `AgentMessageWriteQueue` for design details and the plan at
 * `nimbalyst-local/plans/agent-message-write-coalescing.md`.
 */
const sharedAgentMessageQueue = new AgentMessageWriteQueue();

/**
 * Subscribe to per-flush batch events from the shared queue. Used by the
 * Electron streaming handler to forward `messages:logged-batch` events to
 * renderer processes alongside the existing `message:logged` per-row event.
 */
export function onAgentMessageBatch(
  listener: (event: MessagesLoggedBatchEvent) => void
): () => void {
  return sharedAgentMessageQueue.onBatch(listener);
}

function getSharedAgentMessageQueue(): AgentMessageWriteQueue {
  return sharedAgentMessageQueue;
}

/**
 * Base class with common functionality for AI providers
 */
export abstract class BaseAIProvider extends EventEmitter implements AIProvider {
  protected toolHandler: ToolHandler | null = null;
  protected config: ProviderConfig = {};
  protected correlationId: string | null = null;

  /**
   * Set of in-flight non-blocking write promises owned by this provider
   * instance. Each enqueue from `logAgentMessageNonBlocking` adds its promise
   * here and self-removes on settle. `flushPendingWrites()` first drains the
   * shared queue (so all coalesced rows hit the DB), then awaits these
   * promises so callers (e.g. the completion path) can ensure DB consistency
   * before the UI reloads.
   */
  private pendingWritePromises = new Set<Promise<void>>();

  abstract initialize(config: ProviderConfig): Promise<void>;
  abstract sendMessage(
    message: string,
    documentContext?: DocumentContext,
    sessionId?: string,
    messages?: any[],
    workspacePath?: string,
    attachments?: any[],
    tools?: AgentToolDefinition[],
    systemPrompt?: string
  ): AsyncIterableIterator<StreamChunk>;
  abstract abort(): void;
  abstract getCapabilities(): ProviderCapabilities;

  /**
   * Default graceful-interrupt: hard abort. Providers with a real graceful
   * interrupt (e.g. ClaudeCodeProvider) override this to wrap up the current
   * turn without killing the subprocess. Callers use the returned `method` to
   * decide whether they should also explicitly trigger queue processing
   * (always do, since both paths land in the same completion event in the
   * end).
   */
  async interruptCurrentTurn(): Promise<{ method: 'interrupt' | 'abort' }> {
    this.abort();
    return { method: 'abort' };
  }

  registerToolHandler(handler: ToolHandler): void {
    this.toolHandler = handler;
  }

  /**
   * Get all registered tools from the centralized registry
   */
  protected getRegisteredTools(): ToolDefinition[] {
    return toolRegistry.getAll();
  }

  /**
   * Convert tools to Anthropic format
   */
  protected getToolsInAnthropicFormat(): any[] {
    return toAnthropicTools(this.getRegisteredTools());
  }

  /**
   * Convert tools to OpenAI format
   */
  protected getToolsInOpenAIFormat(): any[] {
    return toOpenAITools(this.getRegisteredTools());
  }

  /**
   * Generate a correlation ID for request tracking
   */
  protected generateCorrelationId(): string {
    this.correlationId = `req-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
    return this.correlationId;
  }

  destroy(): void {
    this.removeAllListeners();
  }

  protected async executeToolCall(name: string, args: any): Promise<any> {
    // Generate correlation ID for tracking
    const correlationId = `tool-${name}-${Date.now()}`;
    this.emit('tool:start', { correlationId, name, args });

    try {
      if (!this.toolHandler) {
        throw new Error('No tool handler registered');
      }

      let result;

      // Check if tool exists in registry
      if (toolRegistry.has(name)) {
        // Use the centralized tool executor
        if (this.toolHandler.executeTool) {
          result = await this.toolHandler.executeTool(name, args);
        } else {
          // Fallback to built-in handlers
          switch (name) {
            case 'applyDiff':
              if (this.toolHandler.applyDiff) {
                result = await this.toolHandler.applyDiff(args);
              } else {
                throw new Error('applyDiff not implemented in handler');
              }
              break;
            default:
              throw new Error(`Tool ${name} not implemented in handler`);
          }
        }
      } else {
        throw new Error(`Unknown tool: ${name}`);
      }

      this.emit('tool:complete', { correlationId, name, result });
      return result;
    } catch (error) {
      this.emit('tool:error', { correlationId, name, error });
      throw error;
    }
  }

  /**
   * Build the base system prompt with shared context
   * Providers should call this and append their specific instructions
   */
  protected buildSystemPrompt(documentContext?: DocumentContext): string {
    // Extract transition info from document context if present
    const documentTransition = (documentContext as any)?.documentTransition;
    const documentDiff = (documentContext as any)?.documentDiff;

    // Use the new options format to pass transition/diff info
    return buildSystemPrompt({
      documentContext,
      documentTransition,
      documentDiff,
    });
  }

  /**
   * Log an agent message to the audit table.
   *
   * Both this awaited path and the non-blocking variant route through the
   * shared `AgentMessageWriteQueue`. The queue holds a single FIFO buffer
   * that flushes on a 200ms idle window, a 200-row threshold, or an explicit
   * `flushAll()`. Per-session order is preserved by enqueue order.
   *
   * 200ms of worst-case persistence latency is well inside the SDK's 5s
   * grace timer for `can_use_tool`, so awaited writes (user prompts, final
   * outputs, permission audits in `AgentToolHooks`) don't need a separate
   * priority lane.
   *
   * Emits 'message:logged' after the row is persisted to keep the existing
   * per-row UI refresh signal alive.
   *
   * @throws Error if the database write fails - callers must handle this appropriately
   */
  protected async logAgentMessage(
    sessionId: string,
    source: string, // Provider name (e.g., 'claude', 'claude-code', 'openai')
    direction: 'input' | 'output',
    content: string,
    metadata?: Record<string, unknown>,
    hidden?: boolean,
    providerMessageId?: string,  // Provider-assigned message ID (e.g., SDK uuid) for deduplication
    searchable?: boolean  // Whether to include in FTS index (user prompts and assistant text only)
  ): Promise<void> {
    // Skip logging for stateless extension completions (no session row in DB)
    if (this.config.skipLogging) return;

    // Create timestamp HERE - this is the authoritative source
    // This same timestamp must be used for message.created_at, session.updated_at, and sync index
    const createdAt = new Date();

    // Only allow searchable for content under 500KB to avoid tsvector 1MB limit
    const isSearchable = searchable && content.length < 500000;

    const { searchableText, messageKind } = extractSearchable({
      source,
      direction,
      content,
      metadata: metadata ?? null,
      hidden,
    });

    try {
      await getSharedAgentMessageQueue().enqueue({
        sessionId,
        source,
        direction,
        content,
        metadata,
        hidden,
        createdAt,
        providerMessageId,
        searchable: isSearchable,
        searchableText,
        messageKind,
      });
      // Emit event to notify listeners that new message was written to database
      // Include hidden flag so sync handlers can skip hidden messages
      this.emit('message:logged', { sessionId, direction, hidden: hidden ?? false });
    } catch (error) {
      // Log error details for debugging but re-throw to let callers handle appropriately
      console.error('[BaseAIProvider] Failed to log agent message:', error);
      console.error('[BaseAIProvider] Failed message details:', { sessionId, source, direction, contentLength: content.length });
      throw error;
    }
  }

  /**
   * Log an agent message without blocking execution.
   * Use this ONLY for streaming chunks where some loss is acceptable.
   * NEVER use this for user input messages or final output messages.
   *
   * Routes the row to the shared queue. Coalesced into a multi-row INSERT
   * with up to 200ms of persistence latency (or sooner if the row threshold
   * trips).
   *
   * The enqueue promise is tracked so flushPendingWrites() can await all
   * outstanding writes before session completion.
   *
   * Errors are logged but not propagated.
   */
  protected logAgentMessageNonBlocking(
    sessionId: string,
    source: string,
    direction: 'input' | 'output',
    content: string,
    metadata?: Record<string, unknown>,
    hidden?: boolean,
    providerMessageId?: string,
    searchable?: boolean
  ): void {
    if (this.config.skipLogging) return;

    const createdAt = new Date();
    const isSearchable = searchable && content.length < 500000;

    const { searchableText, messageKind } = extractSearchable({
      source,
      direction,
      content,
      metadata: metadata ?? null,
      hidden,
    });

    const writePromise = getSharedAgentMessageQueue().enqueue({
      sessionId,
      source,
      direction,
      content,
      metadata,
      hidden,
      createdAt,
      providerMessageId,
      searchable: isSearchable,
      searchableText,
      messageKind,
    })
      .catch((error) => {
        // Don't log per-row failures here — the queue's per-row fallback path
        // already surfaces the original batched-INSERT failure once. Suppress
        // the unhandled rejection.
        void error;
      })
      .finally(() => {
        this.pendingWritePromises.delete(writePromise);
      });
    this.pendingWritePromises.add(writePromise);
  }

  /**
   * Await this provider's in-flight message writes.
   *
   * Per-provider promises are tracked in `pendingWritePromises` and resolve
   * when their row's flush completes. Awaiting them here gives turn-end
   * "this provider's rows are persisted" semantics WITHOUT also waiting for
   * unrelated traffic from other concurrent providers/sessions to drain
   * through the shared queue.
   *
   * The natural flush triggers (200ms idle / 200-row threshold) bound how
   * long this can take; under steady firehose the row threshold trips well
   * before idle, and under a quiet trailing burst the idle timer fires
   * within 200ms.
   */
  protected async flushPendingWrites(): Promise<void> {
    if (this.pendingWritePromises.size > 0) {
      await Promise.all(this.pendingWritePromises);
    }
  }

  /**
   * Log an error to the database (non-blocking)
   * Helper method to reduce duplication across provider implementations
   * @param hidden - If true, marks the error message as hidden (won't appear in UI)
   */
  protected logError(
    sessionId: string | undefined,
    providerName: string,
    error: Error,
    source: string,
    errorType: string = 'api_error',
    hidden: boolean = false
  ): void {
    if (!sessionId) return;

    const isAuthError = errorType === 'authentication_error';

    // Use non-blocking for error logging - errors are secondary to the main message flow
    this.logAgentMessageNonBlocking(sessionId, providerName, 'output', JSON.stringify({
      type: 'error',
      error: error.message,
      source,
      is_error: true,
      is_auth_error: isAuthError,
      error_name: error.name,
      error_stack: error.stack
    }), {
      isError: true,
      isAuthError,
      errorType,
      errorName: error.name
    }, hidden);
  }
}
