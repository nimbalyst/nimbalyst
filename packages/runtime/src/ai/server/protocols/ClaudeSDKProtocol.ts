/**
 * Claude Agent SDK Protocol Adapter
 *
 * Wraps the @anthropic-ai/claude-agent-sdk to provide a normalized
 * protocol interface for the ClaudeCodeProvider.
 *
 * This adapter isolates all SDK-specific details:
 * - Session creation/resumption/forking
 * - Event parsing and streaming
 * - Attachment handling
 * - Query construction
 */

import { query, type Query } from '@anthropic-ai/claude-agent-sdk';
import type {
  MessageParam,
  ImageBlockParam,
  TextBlockParam,
  ContentBlockParam,
  DocumentBlockParam,
} from '@anthropic-ai/sdk/resources';
import {
  AgentProtocol,
  ProtocolSession,
  SessionOptions,
  ProtocolMessage,
  ProtocolEvent,
} from './ProtocolInterface';

/**
 * SDK-specific user message format for streaming input mode
 */
type SDKUserMessage = {
  type: 'user';
  message: MessageParam;
  parent_tool_use_id: string | null;
};

/**
 * Claude Agent SDK Protocol Adapter
 *
 * Provides a normalized interface to the Claude Agent SDK, handling:
 * - Session lifecycle (create, resume, fork)
 * - Message sending with attachments
 * - Event streaming and parsing
 * - SDK-specific quirks and formats
 */
export class ClaudeSDKProtocol implements AgentProtocol {
  readonly platform = 'claude-sdk';

  private activeQueries = new Map<string, Query>();

  /**
   * Create a new session
   *
   * Since the Claude SDK is query-based (not session-based), we don't
   * actually create a session here. The session is created implicitly
   * when the first message is sent via sendMessage.
   */
  async createSession(options: SessionOptions): Promise<ProtocolSession> {
    // Claude SDK sessions are created implicitly via query() calls
    // We return a placeholder session that will be populated on first message
    return {
      id: '', // Will be captured from SDK on first message
      platform: this.platform,
      raw: { options },
    };
  }

  /**
   * Resume an existing session
   *
   * @param sessionId - Claude SDK session ID to resume
   * @param options - Session configuration
   */
  async resumeSession(sessionId: string, options: SessionOptions): Promise<ProtocolSession> {
    return {
      id: sessionId,
      platform: this.platform,
      raw: {
        options,
        resume: true,
      },
    };
  }

  /**
   * Fork an existing session (create a branch)
   *
   * @param sessionId - Claude SDK session ID to fork from
   * @param options - Session configuration for the fork
   */
  async forkSession(sessionId: string, options: SessionOptions): Promise<ProtocolSession> {
    return {
      id: sessionId,
      platform: this.platform,
      raw: {
        options,
        resume: true,
        fork: true,
      },
    };
  }

  /**
   * Send a message and receive streaming events
   *
   * This method:
   * 1. Builds the SDK query options
   * 2. Converts attachments to SDK content blocks
   * 3. Calls the SDK query() function
   * 4. Streams and parses events from the SDK
   * 5. Updates the session ID when received from SDK
   */
  async *sendMessage(
    session: ProtocolSession,
    message: ProtocolMessage
  ): AsyncIterable<ProtocolEvent> {
    const rawSession = session.raw as { options?: any; resume?: boolean; fork?: string } | undefined;
    const { options, resume, fork } = rawSession || {};

    // Build SDK query options
    const queryOptions: any = {
      model: options?.model,
      systemPrompt: options?.systemPrompt,
      cwd: options?.workspacePath,
      permissionMode: options?.permissionMode,
      mcpServers: options?.mcpServers,
      env: options?.env,
      allowedTools: options?.allowedTools,
      disallowedTools: options?.disallowedTools,
      abortController: options?.abortSignal ? { signal: options.abortSignal } : undefined,
      ...options?.raw,
    };

    // Handle session resumption and forking
    if (session.id && resume) {
      queryOptions.resume = session.id;
      if (fork) {
        queryOptions.forkSession = true;
      }
    }

    // Build the prompt - use streaming input mode when we have attachments
    let promptInput: string | AsyncIterable<SDKUserMessage>;

    const imageBlocks = this.buildImageBlocks(message.attachments);
    const documentBlocks = this.buildDocumentBlocks(message.attachments);
    const hasAttachments = imageBlocks.length > 0 || documentBlocks.length > 0;

    if (hasAttachments) {
      // Use streaming input mode with content blocks
      const contentBlocks: ContentBlockParam[] = [
        ...imageBlocks,
        ...documentBlocks,
        { type: 'text', text: message.content } as TextBlockParam,
      ];

      /**
       * Creates an async generator wrapping the user message for SDK streaming input.
       * The Claude SDK accepts either a string or AsyncGenerator<SDKUserMessage> as prompt.
       * When using attachments, we must use the generator form to pass structured content blocks.
       */
      async function* createStreamingInput(): AsyncGenerator<SDKUserMessage> {
        const msg: SDKUserMessage = {
          type: 'user',
          message: {
            role: 'user',
            content: contentBlocks,
          },
          parent_tool_use_id: null,
        };
        yield msg;
      }

      promptInput = createStreamingInput();
    } else {
      // Simple string prompt when no attachments
      promptInput = message.content;
    }

    // Call SDK query function
    const leadQuery = query({
      prompt: promptInput as any,
      options: queryOptions,
    });

    // Track active query for abort support
    const queryId = `${session.id || 'new'}-${Date.now()}`;
    this.activeQueries.set(queryId, leadQuery);

    try {
      // Stream events from SDK
      for await (const rawChunk of leadQuery as AsyncIterable<any>) {
        const chunk = rawChunk as any;

        // Capture session ID from SDK
        if (chunk.session_id) {
          session.id = chunk.session_id;
        }

        // Parse and yield protocol events
        const events = this.parseSDKChunk(chunk);
        for (const event of events) {
          yield event;
        }
      }
    } finally {
      this.activeQueries.delete(queryId);
    }
  }

  /**
   * Abort an active session
   *
   * Note: The Claude SDK handles abort via AbortController passed in options.
   * This method is for cleanup purposes.
   */
  abortSession(session: ProtocolSession): void {
    // SDK abort is handled via AbortController in options
    // Clean up any tracked queries
    for (const [queryId, query] of this.activeQueries.entries()) {
      if (queryId.startsWith(session.id)) {
        this.activeQueries.delete(queryId);
      }
    }
  }

  /**
   * Clean up session resources
   */
  cleanupSession(session: ProtocolSession): void {
    this.abortSession(session);
  }

  /**
   * Parse an SDK chunk into protocol events
   */
  private parseSDKChunk(chunk: any): ProtocolEvent[] {
    const events: ProtocolEvent[] = [];

    // String chunks are text content
    if (typeof chunk === 'string') {
      events.push({
        type: 'text',
        content: chunk,
      });
      return events;
    }

    // Object chunks have different types
    if (chunk && typeof chunk === 'object') {
      // Authentication error
      if (chunk.error === 'authentication_failed') {
        events.push({
          type: 'error',
          error: 'Authentication failed. Please log in to continue.',
          metadata: { isAuthError: true },
        });
        events.push({ type: 'complete' });
        return events;
      }

      // Assistant message with content
      if (chunk.type === 'assistant' && chunk.message) {
        const content = chunk.message.content;

        // Extract usage data
        if (chunk.message.usage) {
          events.push({
            type: 'usage',
            usage: {
              input_tokens: chunk.message.usage.input_tokens || 0,
              output_tokens: chunk.message.usage.output_tokens || 0,
              total_tokens: (chunk.message.usage.input_tokens || 0) + (chunk.message.usage.output_tokens || 0),
            },
          });
        }

        // Parse content blocks
        if (Array.isArray(content)) {
          for (const block of content) {
            if (block.type === 'text') {
              events.push({
                type: 'text',
                content: block.text,
              });
            } else if (block.type === 'tool_use') {
              events.push({
                type: 'tool_call',
                toolCall: {
                  id: block.id,
                  name: block.name,
                  arguments: block.input,
                },
              });
            } else if (block.type === 'tool_result') {
              events.push({
                type: 'tool_result',
                toolResult: {
                  id: block.tool_use_id,
                  name: '', // Tool name not in result block
                  result: block.content,
                },
              });
            }
          }
        }
      }

      // System messages (planning mode transitions)
      if (chunk.type === 'system') {
        const content = chunk.message?.content;
        if (typeof content === 'string') {
          if (content.includes('entering planning mode') || content.includes('plan mode')) {
            events.push({ type: 'planning_mode_entered' });
          } else if (content.includes('exiting planning mode') || content.includes('left plan mode')) {
            events.push({ type: 'planning_mode_exited' });
          }
        }
      }

      // Result message (final summary from SDK)
      if (chunk.type === 'result') {
        // Result contains final data, usage, etc.
        if (chunk.data?.usage) {
          events.push({
            type: 'usage',
            usage: {
              input_tokens: chunk.data.usage.input_tokens || 0,
              output_tokens: chunk.data.usage.output_tokens || 0,
              total_tokens: (chunk.data.usage.input_tokens || 0) + (chunk.data.usage.output_tokens || 0),
            },
          });
        }
      }
    }

    return events;
  }

  /**
   * Build image content blocks from attachments
   */
  private buildImageBlocks(attachments?: any[]): ImageBlockParam[] {
    if (!attachments || attachments.length === 0) {
      return [];
    }

    const imageBlocks: ImageBlockParam[] = [];

    for (const attachment of attachments) {
      if (attachment.type === 'image' && attachment.base64Data) {
        imageBlocks.push({
          type: 'image',
          source: {
            type: 'base64',
            media_type: attachment.mimeType || 'image/png',
            data: attachment.base64Data,
          },
        });
      }
    }

    return imageBlocks;
  }

  /**
   * Build document content blocks from attachments.
   *
   * Two attachment shapes produce document blocks:
   *
   * 1. PDFs (`attachment.type === 'pdf'`): base64 source with
   *    `media_type: 'application/pdf'`.
   * 2. Text documents (`attachment.type === 'document'`): handled by the
   *    `AttachmentProcessor` text path which base64-encodes the file
   *    contents; we decode and emit a text-source document so Claude treats
   *    the file contents as in-line context. Before this fix the text
   *    branch was missing, so document attachments were silently dropped
   *    and only the `@filename` text token reached the agent. The agent
   *    then tried to resolve the filename as a path and reported "file does
   *    not exist." See #239.
   */
  private buildDocumentBlocks(attachments?: any[]): DocumentBlockParam[] {
    if (!attachments || attachments.length === 0) {
      return [];
    }

    const documentBlocks: DocumentBlockParam[] = [];

    for (const attachment of attachments) {
      if (attachment.type === 'pdf' && attachment.base64Data) {
        documentBlocks.push({
          type: 'document',
          source: {
            type: 'base64',
            media_type: 'application/pdf',
            data: attachment.base64Data,
          },
          title: attachment.filename || 'document.pdf',
        });
        continue;
      }
      if (attachment.type === 'document' && attachment.base64Data) {
        // AttachmentProcessor base64-encodes text content; decode for the
        // text-source document block so the agent sees the actual content.
        let textContent: string;
        try {
          textContent = Buffer.from(attachment.base64Data, 'base64').toString('utf-8');
        } catch (err) {
          console.error('[ClaudeSDKProtocol] Failed to decode document attachment:', err);
          continue;
        }
        documentBlocks.push({
          type: 'document',
          source: {
            type: 'text',
            media_type: 'text/plain',
            data: textContent,
          } as DocumentBlockParam['source'],
          title: attachment.filename || 'document.txt',
        });
      }
    }

    return documentBlocks;
  }
}
