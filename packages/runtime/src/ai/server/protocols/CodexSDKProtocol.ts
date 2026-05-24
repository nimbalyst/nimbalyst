/**
 * OpenAI Codex SDK Protocol Adapter (LEGACY -- retained as escape hatch)
 *
 * Wraps the @openai/codex-sdk to provide a normalized protocol interface
 * for the OpenAICodexProvider via `codex exec --experimental-json`.
 *
 * **Status**: this is no longer the default codex transport. The default is
 * now `CodexAppServerProtocol`, which drives `codex app-server --listen stdio://`
 * directly via JSON-RPC v2. The app-server transport's notifications include
 * the full unified-diff text per fileChange item, eliminating the apply_patch
 * race the SDK transport has when capturing pre-edit baselines.
 *
 * This file remains in the tree because:
 *   1. legacy sessions persist their raw events in the SDK shape and need
 *      this parser path (via the dispatcher) to render correctly
 *   2. it is the documented escape hatch via the
 *      `aiProviders.openai-codex.transport = 'sdk'` setting
 *
 * Do not remove without first migrating both points above. See
 * `nimbalyst-local/plans/codex-app-server-protocol-migration.md` for context.
 *
 * This adapter isolates all SDK-specific details:
 * - Client initialization
 * - Thread creation/resumption
 * - Message sending via runStreamed
 * - Event parsing and conversion
 */

import { buildDocumentAttachmentPromptText } from '../providers/codex/documentAttachmentPrompt';
import { describeCodexConfigError } from './codexConfigError';
import {
  AgentProtocol,
  ProtocolSession,
  SessionOptions,
  ProtocolMessage,
  ProtocolEvent,
  ToolResult,
} from './ProtocolInterface';
import {
  CodexClientLike,
  CodexInput,
  CodexSdkModuleLike,
  CodexThreadLike,
  getEventsIterable,
  loadCodexSdkModule,
} from '../providers/codex/codexSdkLoader';
import { parseCodexEvent } from '../providers/codex/codexEventParser';

/**
 * OpenAI Codex SDK Protocol Adapter
 *
 * Provides a normalized interface to the OpenAI Codex SDK, handling:
 * - Client initialization and API key management
 * - Thread lifecycle (create, resume)
 * - Message sending and event streaming
 * - Event parsing from Codex format to protocol format
 *
 * Note: The Codex SDK does not support session forking. Calling forkSession
 * will create a new thread instead.
 */
export class CodexSDKProtocol implements AgentProtocol {
  readonly platform = 'codex-sdk';

  private apiKey: string;
  private codexClient: CodexClientLike | null = null;
  private codexClientOptionsKey: string | null = null;
  private readonly loadSdkModule: () => Promise<CodexSdkModuleLike>;
  private readonly resolveCodexPathOverride: () => string | undefined;

  /**
   * @param apiKey - OpenAI API key
   * @param loadSdkModule - Optional SDK loader for testing
   * @param resolveCodexPathOverride - Optional function to resolve packaged Codex binary path
   */
  constructor(
    apiKey: string,
    loadSdkModule?: () => Promise<CodexSdkModuleLike>,
    resolveCodexPathOverride?: () => string | undefined
  ) {
    this.apiKey = apiKey;
    this.loadSdkModule = loadSdkModule || loadCodexSdkModule;
    this.resolveCodexPathOverride = resolveCodexPathOverride || (() => undefined);
  }

  setApiKey(apiKey: string): void {
    if (this.apiKey === apiKey) {
      return;
    }

    this.apiKey = apiKey;
    this.codexClient = null;
    this.codexClientOptionsKey = null;
  }

  /**
   * Create a new session (thread)
   *
   * @param options - Session configuration
   * @returns Protocol session with thread ID
   */
  async createSession(options: SessionOptions): Promise<ProtocolSession> {
    const client = await this.getCodexClient(options);
    const threadOptions = this.buildThreadOptions(options);
    const thread = client.startThread(threadOptions);

    // Thread ID is typically empty initially and populated from thread.started event
    const threadId = thread.id || '';
    console.log('[CODEX-PROTOCOL] Thread created, initial ID:', threadId || '(empty - will be set from thread.started event)');

    return {
      id: threadId,
      platform: this.platform,
      raw: {
        thread,
        options: threadOptions,
      },
    };
  }

  /**
   * Resume an existing session (thread)
   *
   * @param sessionId - Codex thread ID to resume
   * @param options - Session configuration
   * @returns Protocol session
   */
  async resumeSession(sessionId: string, options: SessionOptions): Promise<ProtocolSession> {
    console.log('[CODEX-PROTOCOL] Resuming thread:', sessionId);
    const client = await this.getCodexClient(options);
    const threadOptions = this.buildThreadOptions(options);
    const thread = client.resumeThread(sessionId, threadOptions);

    console.log('[CODEX-PROTOCOL] Thread resumed:', {
      threadId: sessionId,
      threadObjectId: thread.id
    });

    return {
      id: sessionId,
      platform: this.platform,
      raw: {
        thread,
        options: threadOptions,
      },
    };
  }

  /**
   * Fork an existing session
   *
   * Note: The Codex SDK does not support session forking.
   * This method creates a new thread instead.
   *
   * @param sessionId - Source session ID (ignored)
   * @param options - Session configuration for the new thread
   * @returns New protocol session
   */
  async forkSession(sessionId: string, options: SessionOptions): Promise<ProtocolSession> {
    // Codex SDK doesn't support forking, create a new thread instead
    console.warn('[CODEX-PROTOCOL] Codex SDK does not support session forking. Creating new thread instead.');
    return this.createSession(options);
  }

  /**
   * Send a message and receive streaming events
   *
   * This method:
   * 1. Builds the prompt from message content
   * 2. Calls thread.runStreamed() with the prompt
   * 3. Captures and updates the thread ID
   * 4. Streams and parses events from the SDK
   * 5. Converts Codex events to protocol events
   */
  async *sendMessage(
    session: ProtocolSession,
    message: ProtocolMessage
  ): AsyncIterable<ProtocolEvent> {
    const thread = session.raw?.thread as CodexThreadLike | undefined;
    if (!thread) {
      throw new Error('Invalid session: missing thread');
    }

    // Extract typed options from raw session data
    const rawOptions = session.raw?.options as { abortSignal?: AbortSignal } | undefined;

    // Build the prompt (system prompt is now in thread options as developer_instructions)
    const input = await this.buildInput(message);

    // Track cumulative text for delta extraction
    let lastCumulativeText = '';
    let fullText = '';
    let usage: { input_tokens: number; output_tokens: number; total_tokens: number } | undefined;
    let contextFillTokens: number | undefined;
    let contextWindow: number | undefined;

    try {
      // Run the thread with streaming
      const runResult = await thread.runStreamed(input, {
        signal: (session.raw?.options as { abortSignal?: AbortSignal })?.abortSignal,
      });

      // Thread ID is captured from thread.started event during streaming (see event loop below)

      // Stream events
      const events = getEventsIterable(runResult);
      for await (const event of events) {
        // Check for abort
        if ((session.raw?.options as { abortSignal?: AbortSignal })?.abortSignal?.aborted) {
          throw new Error('Operation cancelled');
        }

        // Emit raw SDK event so callers can persist every Codex output,
        // even when it doesn't map to a known parsed event shape yet.
        yield {
          type: 'raw_event',
          metadata: { rawEvent: event },
        };

        // Parse Codex event into protocol events
        const parsedEvents = parseCodexEvent(event);
        for (const parsedEvent of parsedEvents) {
          // Capture thread ID from thread.started event
          if (parsedEvent.threadId && parsedEvent.threadId !== session.id) {
            session.id = parsedEvent.threadId;
            console.log('[CODEX-PROTOCOL] Thread ID captured from thread.started event:', session.id);
          }

          // Error event
          if (parsedEvent.error) {
            yield {
              type: 'error',
              error: parsedEvent.error,
              metadata: { rawEvent: parsedEvent.rawEvent },
            };
            continue;
          }

          // Usage tracking
          if (parsedEvent.usage) {
            usage = parsedEvent.usage;
          }
          if (parsedEvent.contextSnapshot) {
            contextFillTokens = parsedEvent.contextSnapshot.contextFillTokens;
            contextWindow = parsedEvent.contextSnapshot.contextWindow;
          }

          // Tool call event
          if (parsedEvent.toolCall) {
            yield {
              type: 'tool_call',
              toolCall: {
                ...(parsedEvent.toolCall.id ? { id: parsedEvent.toolCall.id } : {}),
                name: parsedEvent.toolCall.name,
                arguments: parsedEvent.toolCall.arguments as Record<string, unknown> | undefined,
                ...(parsedEvent.toolCall.result !== undefined && parsedEvent.toolCall.result !== null
                  ? { result: parsedEvent.toolCall.result as string | ToolResult }
                  : {}),
              },
              metadata: { rawEvent: parsedEvent.rawEvent },
            };
            continue;
          }

          // Reasoning event (thinking blocks - not part of final output)
          if (parsedEvent.reasoning) {
            yield {
              type: 'reasoning',
              content: parsedEvent.reasoning,
              metadata: { rawEvent: parsedEvent.rawEvent },
            };
            continue;
          }

          // Text event (handle cumulative vs incremental)
          if (parsedEvent.text) {
            let delta: string;
            if (parsedEvent.text.startsWith(lastCumulativeText) && lastCumulativeText.length > 0) {
              // Cumulative mode - extract only the new portion
              delta = parsedEvent.text.slice(lastCumulativeText.length);
              lastCumulativeText = parsedEvent.text;
            } else {
              // Incremental mode
              delta = parsedEvent.text;
              lastCumulativeText = parsedEvent.text;
            }

            if (delta) {
              fullText += delta;
              yield {
                type: 'text',
                content: delta,
                metadata: { rawEvent: parsedEvent.rawEvent },
              };
            }
          }
        }
      }

      // Emit completion event
      yield {
        type: 'complete',
        content: fullText,
        usage: usage ?? {
          input_tokens: 0,
          output_tokens: 0,
          total_tokens: 0,
        },
        ...(contextFillTokens !== undefined ? { contextFillTokens } : {}),
        ...(contextWindow !== undefined ? { contextWindow } : {}),
      };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      const isAbort =
        (session.raw?.options as { abortSignal?: AbortSignal })?.abortSignal?.aborted || /abort|cancel/i.test(errorMessage);

      if (!isAbort) {
        const configHint = describeCodexConfigError(errorMessage);
        yield {
          type: 'error',
          error: configHint ? `${errorMessage}\n\n${configHint}` : errorMessage,
        };
      }
    }
  }

  /**
   * Abort an active session
   *
   * Note: Codex SDK abort is handled via AbortSignal passed in options.
   * This method is for cleanup purposes.
   */
  abortSession(session: ProtocolSession): void {
    // Codex SDK abort is handled via AbortSignal in options
    // No additional cleanup needed
  }

  /**
   * Clean up session resources
   */
  cleanupSession(session: ProtocolSession): void {
    // Clear thread reference
    if (session.raw) {
      session.raw.thread = null;
    }
  }

  /**
   * Get or initialize the Codex client
   */
  private async getCodexClient(options: SessionOptions): Promise<CodexClientLike> {
    const sdkModule = await this.loadSdkModule();
    const codexPathOverride = this.resolveCodexPathOverride();
    const codexConfigOverrides = this.getCodexConfigOverrides(options);
    const codexEnv = this.getCodexEnv(options);
    const codexClientOptions: Record<string, unknown> = {
      ...(this.apiKey ? { apiKey: this.apiKey } : {}),
      ...(codexPathOverride ? { codexPathOverride } : {}),
      ...(codexConfigOverrides ? { config: codexConfigOverrides } : {}),
      ...(codexEnv ? { env: codexEnv } : {}),
    };
    const optionsKey = JSON.stringify(codexClientOptions);

    if (this.codexClient && this.codexClientOptionsKey === optionsKey) {
      return this.codexClient;
    }

    this.codexClient = new sdkModule.Codex(codexClientOptions);
    this.codexClientOptionsKey = optionsKey;
    return this.codexClient;
  }

  /**
   * Extract environment variables from session options.
   * When provided, the SDK passes these to the Codex CLI binary instead of
   * inheriting process.env, ensuring tools like docker, homebrew, nvm, etc.
   * are visible even when Electron is launched from Dock/Finder.
   */
  private getCodexEnv(options: SessionOptions): Record<string, string> | undefined {
    const rawEnv = options.raw?.codexEnv;
    if (!rawEnv || typeof rawEnv !== 'object' || Array.isArray(rawEnv)) {
      return undefined;
    }
    return rawEnv as Record<string, string>;
  }

  /**
   * Build thread options from session options
   */
  private buildThreadOptions(options: SessionOptions): Record<string, unknown> {
    // Determine sandboxMode based on permission mode
    // - 'bypass-all' (Allow All) -> 'danger-full-access' (unrestricted file system access)
    // - 'allow-all' (Allow Edits) or default -> 'workspace-write' (scoped to workspace)
    const sandboxMode = options.permissionMode === 'bypass-all'
      ? 'danger-full-access'
      : 'workspace-write';

    // Map effort level to Codex SDK ModelReasoningEffort.
    // Codex SDK supports: 'minimal' | 'low' | 'medium' | 'high' | 'xhigh'
    // Our EffortLevel uses: 'low' | 'medium' | 'high' | 'max'
    // Map 'max' → 'xhigh', rest map directly.
    const effortLevel = options.raw?.effortLevel as string | undefined;
    const reasoningEffort = effortLevel === 'max' ? 'xhigh' : (effortLevel || 'high');

    const baseOptions = {
      model: options.model || 'gpt-5',
      workingDirectory: options.workspacePath,
      skipGitRepoCheck: true,
      approvalPolicy: 'never', // Nimbalyst handles approvals
      sandboxMode,
      modelReasoningEffort: reasoningEffort,
    };

    // Extract systemPrompt from raw options and pass it as developer_instructions
    // This is the proper Codex SDK way to add custom instructions
    const {
      systemPrompt,
      codexConfigOverrides: _codexConfigOverrides,
      effortLevel: _effortLevel,
      additionalDirectories: rawAdditionalDirectories,
      ...otherRawOptions
    } = options.raw || {};

    // Sibling worktrees and the parent project root the agent is allowed to
    // write to, in addition to workingDirectory. The Codex SDK forwards this
    // to the CLI as repeated --add-dir flags. Sandboxed in workspace-write
    // mode the CLI rejects all writes outside these roots. Issue #37 problem
    // 1: orchestrator sessions could not edit sibling worktrees.
    const additionalDirectories = Array.isArray(rawAdditionalDirectories)
      ? (rawAdditionalDirectories as unknown[]).filter(
          (entry): entry is string => typeof entry === 'string' && entry.length > 0,
        )
      : [];

    return {
      ...baseOptions,
      ...(systemPrompt ? { developer_instructions: systemPrompt } : {}),
      ...(options.allowedTools ? { allowedTools: options.allowedTools } : {}),
      ...(options.disallowedTools ? { disallowedTools: options.disallowedTools } : {}),
      ...(additionalDirectories.length > 0 ? { additionalDirectories } : {}),
      ...otherRawOptions,
    };
  }

  private getCodexConfigOverrides(options: SessionOptions): Record<string, unknown> | undefined {
    const rawOverrides = options.raw?.codexConfigOverrides;
    if (!rawOverrides || typeof rawOverrides !== 'object' || Array.isArray(rawOverrides)) {
      return undefined;
    }
    return rawOverrides as Record<string, unknown>;
  }

  /**
   * Build thread input from message content and supported attachments.
   *
   * NOTE: System prompts are now passed via developer_instructions in thread options,
   * not injected into the user message. This is the proper Codex SDK approach.
   */
  private async buildInput(message: ProtocolMessage): Promise<CodexInput> {
    const attachments = message.attachments || [];
    const hasStructuredAttachments = attachments.some(
      (attachment) => (attachment.type === 'image' || attachment.type === 'document') && attachment.filepath
    );

    if (!hasStructuredAttachments) {
      return message.content;
    }

    const input: Array<{ type: 'text'; text: string } | { type: 'local_image'; path: string }> = [
      { type: 'text', text: message.content },
    ];

    for (const attachment of attachments) {
      if (!attachment.filepath) {
        continue;
      }

      if (attachment.type === 'document') {
        input.push({
          type: 'text',
          text: await buildDocumentAttachmentPromptText(attachment),
        });
        continue;
      }

      if (attachment.type === 'image') {
        input.push({
          type: 'local_image',
          path: attachment.filepath,
        });
      }
    }

    return input;
  }
}
