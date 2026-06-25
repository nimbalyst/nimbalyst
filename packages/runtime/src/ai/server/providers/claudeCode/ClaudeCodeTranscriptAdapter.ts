/**
 * ClaudeCodeTranscriptAdapter -- chunk parser for Claude Code SDK chunks.
 *
 * Parses raw SDK chunks and returns typed ParsedItems for the provider's
 * streaming loop. The provider yields these items for UI rendering.
 *
 * NOTE: Bus emission is deprecated. Canonical transcript events are now
 * written by the TranscriptTransformer from raw ai_agent_messages.
 * The bus parameter is kept as optional for backwards compatibility
 * during migration and will be removed entirely.
 */

/** Bus interface -- kept for the optional emit parameter */
interface TranscriptEventBus {
  emit(event: any): void;
}
import { parseMcpToolName } from '../../transcript/utils';
import { isAuthenticationSummary } from './resultChunkUtils';

const SUBAGENT_TOOLS = new Set(['Task', 'Agent']);

// ---------------------------------------------------------------------------
// Parsed item types (what the provider consumes)
// ---------------------------------------------------------------------------

export type ParsedItem =
  // Transcript-relevant items (written to canonical events)
  | { kind: 'text'; text: string }
  | { kind: 'tool_use'; toolId: string; toolName: string; args: Record<string, unknown>; isMcp: boolean; isSubagent: boolean }
  | { kind: 'tool_result'; toolUseId: string; content: unknown; isError: boolean }
  | { kind: 'usage'; usage: any; modelUsage?: any; isPerStep: boolean }
  | { kind: 'error'; message: string; chunk: any }
  | { kind: 'session_id'; id: string }
  // Lifecycle items (provider handles side effects, not transcript-relevant)
  | { kind: 'system_init'; chunk: any }
  | { kind: 'system_task'; subtype: 'task_started' | 'task_progress' | 'task_notification'; chunk: any }
  | { kind: 'system_compact'; preTokens: string | number }
  | { kind: 'system_message'; text: string }
  | { kind: 'summary'; text: string; isAuthError: boolean; chunk: any }
  | { kind: 'auth_status'; chunk: any }
  | { kind: 'rate_limit'; chunk: any }
  | { kind: 'tool_progress' }
  | { kind: 'tool_use_summary' }
  | { kind: 'unknown'; chunk: any; extractedText?: string };

// ---------------------------------------------------------------------------
// Adapter
// ---------------------------------------------------------------------------

export class ClaudeCodeTranscriptAdapter {
  private processedTextMessageIds = new Set<string>();
  private emittedToolCalls = new Set<string>();
  private emittedSubagents = new Set<string>();

  constructor(
    private bus: TranscriptEventBus | null,
    private sessionId: string,
  ) {}

  resetTurn(): void {
    this.processedTextMessageIds.clear();
  }

  resetAll(): void {
    this.processedTextMessageIds.clear();
    this.emittedToolCalls.clear();
    this.emittedSubagents.clear();
  }

  userMessage(text: string, mode?: 'agent' | 'planning', attachments?: any[]): void {
    this.bus?.emit({
      type: 'user_message',
      sessionId: this.sessionId,
      text,
      mode: mode ?? 'agent',
      attachments,
    });
  }

  /**
   * Process a raw SDK chunk. Returns parsed items for the provider, or null
   * if this chunk type isn't transcript-relevant (system, summary, etc.).
   * Emits canonical events to the bus as a side effect.
   */
  processChunk(chunk: any): ParsedItem[] {
    if (typeof chunk === 'string') {
      return this.parseTextString(chunk);
    }
    if (!chunk || typeof chunk !== 'object') return [];

    switch (chunk.type) {
      case 'assistant': return this.parseAssistantChunk(chunk);
      case 'tool_call':
      case 'tool_use': return this.parseStandaloneToolUse(chunk);
      case 'text': return this.parseTextObject(chunk);
      case 'result': return this.parseResultChunk(chunk);
      case 'user': return this.parseUserChunk(chunk);
      case 'error': return this.parseErrorChunk(chunk);
      case 'system': return this.parseSystemChunk(chunk);
      case 'summary': return this.parseSummaryChunk(chunk);
      case 'auth_status': return [{ kind: 'auth_status', chunk }];
      case 'rate_limit_event': return [{ kind: 'rate_limit', chunk }];
      case 'tool_progress': return [{ kind: 'tool_progress' }];
      case 'tool_use_summary': return [{ kind: 'tool_use_summary' }];
      default: return [this.parseUnknownChunk(chunk)];
    }
  }

  /**
   * Emit a system message to the canonical transcript (errors, etc).
   * Called by the provider after it classifies errors.
   */
  systemMessage(text: string, systemType?: 'status' | 'slash_command' | 'error' | 'init'): void {
    this.bus?.emit({
      type: 'system_message',
      sessionId: this.sessionId,
      text,
      systemType: systemType ?? 'status',
      searchable: false,
    });
  }

  /**
   * Record turn ended with usage data. Called by the provider at completion.
   */
  turnEnded(usage: any | undefined, modelUsage?: Record<string, any>): void {
    if (!usage && !modelUsage) return;

    const u = usage ?? {};
    let totalInput = u.input_tokens || 0;
    let totalOutput = u.output_tokens || 0;
    let totalCost = 0;

    if (modelUsage) {
      totalInput = 0;
      totalOutput = 0;
      for (const stats of Object.values(modelUsage)) {
        const s = stats as any;
        totalInput += s.inputTokens || 0;
        totalOutput += s.outputTokens || 0;
        totalCost += s.costUSD || 0;
      }
    }

    this.bus?.emit({
      type: 'turn_ended',
      sessionId: this.sessionId,
      contextFill: {
        inputTokens: u.input_tokens || totalInput,
        cacheReadInputTokens: u.cache_read_input_tokens || 0,
        cacheCreationInputTokens: u.cache_creation_input_tokens || 0,
        outputTokens: u.output_tokens || totalOutput,
        totalContextTokens: (u.input_tokens || totalInput)
          + (u.cache_read_input_tokens || 0)
          + (u.cache_creation_input_tokens || 0),
      },
      contextWindow: 0,
      cumulativeUsage: {
        inputTokens: totalInput,
        outputTokens: totalOutput,
        cacheReadInputTokens: u.cache_read_input_tokens || 0,
        cacheCreationInputTokens: u.cache_creation_input_tokens || 0,
        costUSD: totalCost,
        webSearchRequests: 0,
      },
      contextCompacted: false,
    });
  }

  // ---------------------------------------------------------------------------
  // Parsers
  // ---------------------------------------------------------------------------

  private parseTextString(text: string): ParsedItem[] {
    if (!text) return [];
    this.bus?.emit({ type: 'assistant_text', sessionId: this.sessionId, text });
    return [{ kind: 'text', text }];
  }

  private parseTextObject(chunk: any): ParsedItem[] {
    const text = chunk.text || chunk.content || '';
    if (!text) return [];
    this.bus?.emit({ type: 'assistant_text', sessionId: this.sessionId, text });
    return [{ kind: 'text', text }];
  }

  private parseAssistantChunk(chunk: any): ParsedItem[] {
    const items: ParsedItem[] = [];

    // Session ID capture. Skip when this assistant chunk is from a sub-agent
    // (parent_tool_use_id set): the SDK relays the sub-agent's chunks back
    // through the same iterator carrying the sub-agent's own session_id,
    // which is NOT the lead's. Capturing it overwrites the lead's session id
    // and corrupts resume on the next turn (NIM-671 / #457).
    if (chunk.session_id && !chunk.parent_tool_use_id) {
      items.push({ kind: 'session_id', id: chunk.session_id });
    }

    // Auth error (first-class SDK detection)
    if (chunk.error === 'authentication_failed') {
      items.push({ kind: 'error', message: 'Authentication failed. Please log in to continue.', chunk });
      return items;
    }

    if (!chunk.message) return items;

    // Per-step usage from assistant message (not cumulative -- used for context fill).
    // Skip sub-agent chunks (parent_tool_use_id set): a sub-agent runs as its own
    // SDK conversation with a much smaller context, and its chunks are relayed back
    // through this same iterator. Without this guard the lead's context-fill bounces
    // between the lead's large context and a sub-agent's small one as the live
    // indicator updates per step (NIM-868). Same guard the session_id capture uses.
    if (chunk.message.usage && !chunk.parent_tool_use_id) {
      items.push({ kind: 'usage', usage: chunk.message.usage, isPerStep: true });
    }

    const content = chunk.message.content;
    const messageId: string | undefined = chunk.message.id;
    const parentToolUseId: string | undefined = chunk.parent_tool_use_id;

    if (Array.isArray(content)) {
      for (const block of content) {
        if (block.type === 'text' && block.text) {
          // Dedup streaming chunks vs accumulated echoes
          if (messageId && this.processedTextMessageIds.has(messageId)) continue;
          if (!messageId && this.processedTextMessageIds.size > 0) continue;
          if (messageId) this.processedTextMessageIds.add(messageId);

          this.bus?.emit({ type: 'assistant_text', sessionId: this.sessionId, text: block.text });
          items.push({ kind: 'text', text: block.text });
        } else if (block.type === 'tool_use') {
          const item = this.parseToolUseBlock(block, parentToolUseId);
          if (item) items.push(item);
        } else if (block.type === 'tool_result') {
          const item = this.parseToolResultBlock(block);
          if (item) items.push(item);
        }
      }
    } else if (typeof content === 'string' && content) {
      this.bus?.emit({ type: 'assistant_text', sessionId: this.sessionId, text: content });
      items.push({ kind: 'text', text: content });
    }

    return items;
  }

  private parseStandaloneToolUse(chunk: any): ParsedItem[] {
    const item = this.parseToolUseBlock({
      name: chunk.name || 'unknown',
      id: chunk.id || chunk.tool_id,
      input: chunk.input,
    });
    return item ? [item] : [];
  }

  private parseToolUseBlock(block: any, parentToolUseId?: string): ParsedItem | null {
    const toolName: string = block.name ?? 'unknown';
    const toolId: string | undefined = block.id;
    const args = block.input ?? block.arguments ?? {};

    // Subagent detection
    if (SUBAGENT_TOOLS.has(toolName) && toolId) {
      if (this.emittedSubagents.has(toolId)) return null;
      this.emittedSubagents.add(toolId);
      this.emittedToolCalls.add(toolId);

      this.bus?.emit({
        type: 'subagent_started',
        sessionId: this.sessionId,
        subagentId: toolId,
        agentType: toolName,
        teammateName: typeof args.name === 'string' ? args.name : null,
        teamName: typeof args.team_name === 'string' ? args.team_name : null,
        teammateMode: typeof args.mode === 'string' ? args.mode : null,
        isBackground: args.run_in_background === true,
        prompt: typeof args.prompt === 'string' ? args.prompt : JSON.stringify(args),
      });
      return { kind: 'tool_use', toolId: toolId, toolName, args, isMcp: false, isSubagent: true };
    }

    // Dedup
    if (toolId && this.emittedToolCalls.has(toolId)) return null;
    if (toolId) this.emittedToolCalls.add(toolId);

    // MCP parsing
    const isMcp = toolName.startsWith('mcp__');
    let mcpServer: string | null = null;
    let mcpTool: string | null = null;
    if (isMcp) {
      const parsed = parseMcpToolName(toolName);
      if (parsed) { mcpServer = parsed.server; mcpTool = parsed.tool; }
    }

    const subagentId = parentToolUseId && this.emittedSubagents.has(parentToolUseId)
      ? parentToolUseId : undefined;

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
      providerToolCallId: toolId ?? null,
      subagentId: subagentId ?? null,
    });

    return { kind: 'tool_use', toolId: toolId ?? `tool-anon`, toolName, args, isMcp, isSubagent: false };
  }

  private parseToolResultBlock(block: any): ParsedItem | null {
    const toolUseId = block.tool_use_id || block.id;
    if (!toolUseId) return null;

    const content = block.content;
    const isError = block.is_error || false;

    // Subagent completion
    if (this.emittedSubagents.has(toolUseId)) {
      const resultText = typeof content === 'string' ? content : JSON.stringify(content);
      this.bus?.emit({
        type: 'subagent_completed',
        sessionId: this.sessionId,
        subagentId: toolUseId,
        status: 'completed',
        resultSummary: resultText?.substring(0, 500),
      });
    } else {
      // Regular tool result
      let resultText = '';
      if (typeof content === 'string') {
        resultText = content;
      } else if (Array.isArray(content)) {
        const hasNonText = content.some((inner: any) => inner.type !== 'text');
        if (hasNonText) {
          resultText = JSON.stringify(content);
        } else {
          for (const inner of content) {
            if (inner.type === 'text' && inner.text) resultText += inner.text;
          }
        }
      } else if (content != null) {
        resultText = JSON.stringify(content);
      }

      this.bus?.emit({
        type: 'tool_call_completed',
        sessionId: this.sessionId,
        providerToolCallId: toolUseId,
        status: isError ? 'error' : 'completed',
        result: resultText,
        isError,
      });
    }

    return { kind: 'tool_result', toolUseId, content, isError };
  }

  private parseResultChunk(chunk: any): ParsedItem[] {
    const items: ParsedItem[] = [];

    // Do not capture session_id from result chunks. The system init frame is
    // authoritative for the lead session id (see parseSystemChunk:'init').
    // Result chunks can arrive from sub-agent completions and would otherwise
    // overwrite the lead's session id (NIM-671 / #457).

    if (chunk.is_error) {
      const msg = chunk.error?.message || chunk.error || 'Unknown error';
      const errorText = typeof msg === 'string' ? msg : JSON.stringify(msg);
      items.push({ kind: 'error', message: errorText, chunk });
      return items;
    }

    if (chunk.usage || chunk.modelUsage) {
      items.push({ kind: 'usage', usage: chunk.usage, modelUsage: chunk.modelUsage, isPerStep: false });
    }

    // Slash command result text (non-error result with string content).
    // Skip if assistant text was already emitted this turn -- the result chunk
    // duplicates the final assistant text for regular turns, so only emit when
    // there were no streaming assistant chunks (slash command path).
    if (
      chunk.result
      && typeof chunk.result === 'string'
      && chunk.result.trim().length > 0
      && this.processedTextMessageIds.size === 0
    ) {
      this.bus?.emit({ type: 'assistant_text', sessionId: this.sessionId, text: chunk.result });
      items.push({ kind: 'text', text: chunk.result });
    }

    return items;
  }

  private parseUserChunk(chunk: any): ParsedItem[] {
    const items: ParsedItem[] = [];
    const content = chunk.message?.content;

    if (Array.isArray(content)) {
      for (const block of content) {
        if (block.type === 'tool_result') {
          const item = this.parseToolResultBlock(block);
          if (item) items.push(item);
        }
      }
    }

    // Slash command output: extract from <local-command-stdout> tags
    if (typeof content === 'string') {
      const stdoutMatch = content.match(/<local-command-stdout>([\s\S]*?)<\/local-command-stdout>/);
      if (stdoutMatch?.[1]) {
        items.push({ kind: 'text', text: stdoutMatch[1].trim() });
      }

      const stderrMatch = content.match(/<local-command-stderr>([\s\S]*?)<\/local-command-stderr>/);
      if (stderrMatch?.[1]) {
        items.push({ kind: 'error', message: stderrMatch[1].trim(), chunk });
      }
    }

    return items;
  }

  private parseErrorChunk(chunk: any): ParsedItem[] {
    const errorContent = typeof chunk.error === 'string'
      ? chunk.error : JSON.stringify(chunk.error);
    this.bus?.emit({
      type: 'system_message',
      sessionId: this.sessionId,
      text: errorContent,
      systemType: 'error',
      searchable: false,
    });
    return [{ kind: 'error', message: errorContent, chunk }];
  }

  private parseSystemChunk(chunk: any): ParsedItem[] {
    const items: ParsedItem[] = [];

    switch (chunk.subtype) {
      case 'init':
        // Only trust session_id from the init frame. Hook frames
        // (hook_started, hook_response) carry a transient pre-resume UUID
        // that differs from the actual resumed session ID. Capturing it
        // triggers a false resume-mismatch abort (NIM-838).
        if (chunk.session_id) {
          items.push({ kind: 'session_id', id: chunk.session_id });
        }
        items.push({ kind: 'system_init', chunk });
        break;
      case 'task_started':
      case 'task_progress':
      case 'task_notification':
        items.push({ kind: 'system_task', subtype: chunk.subtype, chunk });
        break;
      case 'compact_boundary':
        items.push({ kind: 'system_compact', preTokens: chunk.compact_metadata?.pre_tokens || 'unknown' });
        break;
      default: {
        // Other system subtypes may carry displayable text
        const text = chunk.message || chunk.text || chunk.content;
        if (text) {
          const str = typeof text === 'string' ? text : JSON.stringify(text);
          items.push({ kind: 'system_message', text: str });
        }
        break;
      }
    }
    return items;
  }

  private parseSummaryChunk(chunk: any): ParsedItem[] {
    const summary = chunk.summary || '';
    const isAuthError = isAuthenticationSummary(summary);
    return [{ kind: 'summary', text: summary, isAuthError, chunk }];
  }

  private parseUnknownChunk(chunk: any): ParsedItem {
    // Try to extract displayable text from various possible fields
    const raw = chunk.text || chunk.content || chunk.message || chunk.data ||
      chunk.output || chunk.response || chunk.value || '';
    const extractedText = raw
      ? (typeof raw === 'string' ? raw : JSON.stringify(raw, null, 2))
      : undefined;
    return { kind: 'unknown', chunk, extractedText };
  }
}

