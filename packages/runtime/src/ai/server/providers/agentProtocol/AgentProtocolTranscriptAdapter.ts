/**
 * AgentProtocolTranscriptAdapter -- parses ProtocolEvent objects from agent
 * providers (OpenAICodexProvider, OpenCodeProvider) into canonical transcript
 * events and typed ParsedItems.
 *
 * Both providers use the AgentProtocol interface and emit ProtocolEvent objects
 * from their SDK protocol layers (CodexSDKProtocol, OpenCodeSDKProtocol).
 * This adapter is the single parser for that shared event format.
 *
 * The provider's streaming loop becomes:
 *   for (const item of adapter.processEvent(protocolEvent)) {
 *     switch (item.kind) { /* side effects only * / }
 *   }
 */

/** Bus interface -- kept for the optional emit parameter */
interface TranscriptEventBus {
  emit(event: any): void;
}
import type { ProtocolEvent } from '../../protocols/ProtocolInterface';
import { parseMcpToolName } from '../../transcript/utils';

// ---------------------------------------------------------------------------
// Parsed item types (what the provider consumes for side effects)
// ---------------------------------------------------------------------------

export type ParsedItem =
  // Transcript-relevant
  | { kind: 'text'; text: string }
  | { kind: 'tool_call'; toolCall: NonNullable<ProtocolEvent['toolCall']> }
  | { kind: 'tool_result'; toolResult: NonNullable<ProtocolEvent['toolResult']> }
  | { kind: 'complete'; event: ProtocolEvent }
  | { kind: 'error'; message: string }
  // Lifecycle (not transcript-relevant)
  | { kind: 'raw_event'; event: ProtocolEvent }
  | { kind: 'reasoning' }
  | { kind: 'planning_mode'; entering: boolean }
  | { kind: 'unknown'; event: ProtocolEvent };

// ---------------------------------------------------------------------------
// Adapter
// ---------------------------------------------------------------------------

export class AgentProtocolTranscriptAdapter {
  private emittedToolCalls = new Set<string>();
  private anonToolCounter = 0;

  constructor(
    private bus: TranscriptEventBus | null,
    private sessionId: string,
  ) {}

  /** Emit user message. Called before the streaming loop. */
  userMessage(text: string, mode?: 'agent' | 'planning', attachments?: any[]): void {
    this.bus?.emit({
      type: 'user_message',
      sessionId: this.sessionId,
      text,
      mode: mode ?? 'agent',
      attachments,
    });
  }

  /** Parse a ProtocolEvent into typed items + emit canonical transcript events. */
  processEvent(event: ProtocolEvent): ParsedItem[] {
    switch (event.type) {
      case 'text':
        return this.handleText(event);
      case 'tool_call':
        return this.handleToolCall(event);
      case 'tool_result':
        return this.handleToolResult(event);
      case 'complete':
        return this.handleComplete(event);
      case 'error':
        return this.handleError(event);
      case 'raw_event':
        return [{ kind: 'raw_event', event }];
      case 'reasoning':
        return [{ kind: 'reasoning' }];
      case 'planning_mode_entered':
        return [{ kind: 'planning_mode', entering: true }];
      case 'planning_mode_exited':
        return [{ kind: 'planning_mode', entering: false }];
      default:
        return [{ kind: 'unknown', event }];
    }
  }

  // ---------------------------------------------------------------------------
  // Handlers
  // ---------------------------------------------------------------------------

  private handleText(event: ProtocolEvent): ParsedItem[] {
    const text = event.content;
    if (!text) return [];
    this.bus?.emit({
      type: 'assistant_text',
      sessionId: this.sessionId,
      text,
    });
    return [{ kind: 'text', text }];
  }

  private handleToolCall(event: ProtocolEvent): ParsedItem[] {
    const tc = event.toolCall;
    if (!tc) return [];

    const toolId = tc.id ?? `anon-tool-${++this.anonToolCounter}`;
    const toolName = tc.name;
    const args = tc.arguments ?? {};

    // Emit tool_call_started (with dedup)
    if (!this.emittedToolCalls.has(toolId)) {
      this.emittedToolCalls.add(toolId);

      const isMcp = toolName.startsWith('mcp__');
      let mcpServer: string | null = null;
      let mcpTool: string | null = null;
      if (isMcp) {
        const parsed = parseMcpToolName(toolName);
        if (parsed) { mcpServer = parsed.server; mcpTool = parsed.tool; }
      }

      let targetFilePath: string | null = null;
      if (typeof args.file_path === 'string') targetFilePath = args.file_path;
      else if (typeof args.path === 'string') targetFilePath = args.path;

      this.bus?.emit({
        type: 'tool_call_started',
        sessionId: this.sessionId,
        toolName,
        toolDisplayName: toolName,
        arguments: args,
        targetFilePath,
        mcpServer,
        mcpTool,
        providerToolCallId: toolId,
        subagentId: null,
      });
    }

    // If the protocol event already has a result, emit completed too
    if (tc.result !== undefined) {
      const resultText = typeof tc.result === 'string'
        ? tc.result
        : JSON.stringify(tc.result);
      this.bus?.emit({
        type: 'tool_call_completed',
        sessionId: this.sessionId,
        providerToolCallId: toolId,
        status: 'completed',
        result: resultText,
        isError: false,
      });
    }

    return [{ kind: 'tool_call', toolCall: tc }];
  }

  private handleToolResult(event: ProtocolEvent): ParsedItem[] {
    const tr = event.toolResult;
    if (!tr) return [];

    // OpenCode emits tool_result as a separate event from tool_call.
    // Emit tool_call_completed for the matching tool_call_started.
    const toolId = tr.id;
    if (toolId) {
      const resultText = tr.result !== undefined
        ? (typeof tr.result === 'string' ? tr.result : JSON.stringify(tr.result))
        : '';
      this.bus?.emit({
        type: 'tool_call_completed',
        sessionId: this.sessionId,
        providerToolCallId: toolId,
        status: 'completed',
        result: resultText,
        isError: false,
      });
    }

    return [{ kind: 'tool_result', toolResult: tr }];
  }

  private handleComplete(event: ProtocolEvent): ParsedItem[] {
    const u = event.usage;
    this.bus?.emit({
      type: 'turn_ended',
      sessionId: this.sessionId,
      contextFill: {
        inputTokens: event.contextFillTokens ?? u?.input_tokens ?? 0,
        cacheReadInputTokens: 0,
        cacheCreationInputTokens: 0,
        outputTokens: u?.output_tokens ?? 0,
        totalContextTokens: (event.contextFillTokens ?? u?.input_tokens ?? 0),
      },
      contextWindow: event.contextWindow ?? 0,
      cumulativeUsage: {
        inputTokens: u?.input_tokens ?? 0,
        outputTokens: u?.output_tokens ?? 0,
        cacheReadInputTokens: 0,
        cacheCreationInputTokens: 0,
        costUSD: 0,
        webSearchRequests: 0,
      },
      contextCompacted: false,
    });
    return [{ kind: 'complete', event }];
  }

  private handleError(event: ProtocolEvent): ParsedItem[] {
    const msg = event.error || 'Unknown error';
    this.bus?.emit({
      type: 'system_message',
      sessionId: this.sessionId,
      text: msg,
      systemType: 'error',
      searchable: false,
    });
    return [{ kind: 'error', message: msg }];
  }
}
