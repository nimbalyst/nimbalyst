/**
 * CodexACPRawParser -- parses raw ACP session-update events into canonical
 * event descriptors.
 *
 * Each output message stored by OpenAICodexACPProvider has the shape:
 *   { type: 'session/update', sessionId, update }
 * where `update` is an ACP `SessionUpdate` discriminator (agent_message_chunk,
 * agent_thought_chunk, tool_call, tool_call_update, plan, usage_update).
 *
 * Permission requests are stored as:
 *   { type: 'session/request_permission', sessionId, request }
 *
 * Authoritative shape reference: CodexACPProtocol.handleSessionUpdate() and
 * CodexACPProtocol.mapSessionUpdate() in
 * packages/runtime/src/ai/server/protocols/CodexACPProtocol.ts.
 *
 * Input messages (user prompts) are plain text written by
 * OpenAICodexACPProvider.sendMessage; we mirror the OpenCode/Codex parser
 * convention so reload behaves the same as live streaming.
 */
import type { RawMessage } from '../TranscriptTransformer';
import { parseMcpToolName } from '../utils';
import type {
  IRawMessageParser,
  ParseContext,
  CanonicalEventDescriptor,
} from './IRawMessageParser';

interface ACPRawEvent {
  type?: string;
  sessionId?: string;
  update?: ACPSessionUpdate;
  request?: ACPRequestPermission;
}

interface ACPSessionUpdate {
  sessionUpdate?: string;
  content?: ACPContentBlock;
  toolCallId?: string;
  title?: string;
  kind?: string;
  status?: string;
  rawInput?: unknown;
  rawOutput?: unknown;
  // tool_call_update fields
  // diff/patch payloads come through `content` array
  // see ACP schema for the complete list
  [key: string]: unknown;
}

interface ACPContentBlock {
  type?: string;
  text?: string;
  uri?: string;
  mimeType?: string;
}

interface ACPRequestPermission {
  toolCall?: {
    toolCallId?: string;
    title?: string;
    kind?: string;
    rawInput?: unknown;
    locations?: ACPToolCallLocation[] | null;
  };
  options?: Array<{ optionId: string; name?: string; kind?: string }>;
}

interface ACPToolCallLocation {
  path?: unknown;
  line?: unknown;
}

export class CodexACPRawParser implements IRawMessageParser {
  // Tracks tool calls we've already emitted a started descriptor for in this
  // batch so a tool_call_update doesn't double-create.
  private readonly emittedStartedToolCallIds = new Set<string>();
  // Captures tool name as observed on the first tool_call event so subsequent
  // tool_call_update events reuse the canonical name (the update event's
  // title/kind may be missing).
  private readonly toolNamesById = new Map<string, string>();
  // Latest usage snapshot from usage_update events; flushed into turn_ended
  // when we synthesize one.
  private latestContext: { used: number; size: number } | null = null;

  async parseMessage(
    msg: RawMessage,
    context: ParseContext,
  ): Promise<CanonicalEventDescriptor[]> {
    if (msg.hidden) return [];

    if (msg.direction === 'input') {
      return this.parseInputMessage(msg);
    }

    return this.parseOutputMessage(msg, context);
  }

  // ---------------------------------------------------------------------------
  // Input messages (user prompts and system reminders)
  // ---------------------------------------------------------------------------

  private parseInputMessage(msg: RawMessage): CanonicalEventDescriptor[] {
    const content = String(msg.content ?? '').trim();
    if (!content) return [];

    if (this.isSystemReminderContent(content, msg.metadata)) {
      return [{
        type: 'system_message',
        text: content,
        systemType: 'status',
        reminderKind: this.extractReminderKind(msg.metadata),
        createdAt: msg.createdAt,
      }];
    }

    return [{
      type: 'user_message',
      text: content,
      mode: (msg.metadata?.mode as 'agent' | 'planning') ?? 'agent',
      attachments: msg.metadata?.attachments as any,
      createdAt: msg.createdAt,
    }];
  }

  private extractReminderKind(metadata?: Record<string, unknown>): string | undefined {
    const kind = metadata?.reminderKind;
    return typeof kind === 'string' ? kind : undefined;
  }

  private isSystemReminderContent(
    content: string,
    metadata?: Record<string, unknown>,
  ): boolean {
    return (
      metadata?.promptType === 'system_reminder' ||
      /<SYSTEM_REMINDER>[\s\S]*<\/SYSTEM_REMINDER>/.test(content)
    );
  }

  // ---------------------------------------------------------------------------
  // Output messages (ACP session/update + session/request_permission)
  // ---------------------------------------------------------------------------

  private parseOutputMessage(
    msg: RawMessage,
    context: ParseContext,
  ): CanonicalEventDescriptor[] {
    let event: ACPRawEvent;
    try {
      event = JSON.parse(msg.content) as ACPRawEvent;
    } catch {
      return [];
    }

    if (!event || typeof event !== 'object') return [];

    if (event.type === 'session/request_permission') {
      return this.parseRequestPermission(msg, event, context);
    }

    // session/request_permission_preview is informational only (the protocol
    // also emits a tool_call ProtocolEvent for it which carries the canonical
    // arguments). Skip it here to avoid double-counting.
    if (event.type === 'session/request_permission_preview') {
      return [];
    }

    if (event.type !== 'session/update' || !event.update) {
      return [];
    }

    return this.parseSessionUpdate(msg, event.update, context);
  }

  private parseSessionUpdate(
    msg: RawMessage,
    update: ACPSessionUpdate,
    context: ParseContext,
  ): CanonicalEventDescriptor[] {
    const kind = update.sessionUpdate;

    switch (kind) {
      case 'agent_message_chunk':
        return this.parseChunkAsAssistant(msg, update.content);
      case 'agent_thought_chunk':
        // Reasoning is rendered as assistant content so it shows in the
        // transcript -- there's no separate "reasoning" canonical type.
        return this.parseChunkAsAssistant(msg, update.content);
      case 'tool_call':
        return this.parseToolCall(msg, update, context);
      case 'tool_call_update':
        return this.parseToolCallUpdate(msg, update, context);
      case 'usage_update':
        this.captureUsageUpdate(update);
        return [];
      case 'plan':
        return this.parsePlan(msg, update);
      default:
        return [];
    }
  }

  private parseChunkAsAssistant(
    msg: RawMessage,
    block: ACPContentBlock | undefined,
  ): CanonicalEventDescriptor[] {
    if (!block) return [];

    if (block.type === 'text' && typeof block.text === 'string' && block.text.length > 0) {
      return [{
        type: 'assistant_message',
        text: block.text,
        createdAt: msg.createdAt,
      }];
    }

    if (block.type === 'resource_link' && typeof block.uri === 'string' && block.uri.length > 0) {
      return [{
        type: 'assistant_message',
        text: block.uri,
        createdAt: msg.createdAt,
      }];
    }

    return [];
  }

  private parseToolCall(
    msg: RawMessage,
    update: ACPSessionUpdate,
    context: ParseContext,
  ): CanonicalEventDescriptor[] {
    const callId = typeof update.toolCallId === 'string' ? update.toolCallId : '';
    if (!callId) return [];

    const toolName = this.deriveToolName(update.title ?? 'Tool call', update.kind);
    this.toolNamesById.set(callId, toolName);

    if (this.emittedStartedToolCallIds.has(callId) || context.hasToolCall(callId)) {
      return [];
    }
    this.emittedStartedToolCallIds.add(callId);

    const locationPath = this.firstLocationPath(update);
    const args = this.mergeLocationPath(this.normalizeArguments(update.rawInput), locationPath);
    const targetFilePath = this.extractTargetFilePath(args) ?? locationPath;
    const { mcpServer, mcpTool } = this.extractMcpMetadata(toolName);

    return [{
      type: 'tool_call_started',
      toolName,
      toolDisplayName: this.toolDisplayName(toolName),
      arguments: args,
      targetFilePath,
      mcpServer,
      mcpTool,
      providerToolCallId: callId,
      createdAt: msg.createdAt,
    }];
  }

  private parseToolCallUpdate(
    msg: RawMessage,
    update: ACPSessionUpdate,
    context: ParseContext,
  ): CanonicalEventDescriptor[] {
    const callId = typeof update.toolCallId === 'string' ? update.toolCallId : '';
    if (!callId) return [];

    const descriptors: CanonicalEventDescriptor[] = [];

    // Don't synthesize tool_call_started from update events. ACP always emits
    // a `tool_call` first; if the parser missed it (e.g. its in-memory
    // toolNamesById map is empty because the parser was constructed fresh
    // mid-stream), emitting a started here with title="Tool call" would
    // either dupe the existing canonical event (different toolName -> dedup
    // miss) or display a generic name. Better to skip the started side and
    // let tool_call_completed land on the existing event.

    const status = typeof update.status === 'string' ? update.status : '';
    if (status === 'completed' || status === 'failed') {
      const isError = status === 'failed';
      const { resultText } = this.extractResult(update);
      descriptors.push({
        type: 'tool_call_completed',
        providerToolCallId: callId,
        status: isError ? 'error' : 'completed',
        result: resultText,
        isError,
      });
    }

    return descriptors;
  }

  private parsePlan(
    msg: RawMessage,
    update: ACPSessionUpdate,
  ): CanonicalEventDescriptor[] {
    // ACP `plan` updates carry an entries array of {content, status}. Render
    // them as an assistant message so they survive reload.
    const entries = (update as { entries?: Array<{ content?: unknown; status?: unknown }> }).entries;
    if (!Array.isArray(entries) || entries.length === 0) return [];

    const lines = entries
      .map((entry) => {
        const text = typeof entry.content === 'string' ? entry.content : String(entry.content ?? '');
        const done = entry.status === 'completed';
        return `- [${done ? 'x' : ' '}] ${text}`;
      })
      .join('\n');

    return [{
      type: 'assistant_message',
      text: lines,
      createdAt: msg.createdAt,
    }];
  }

  private parseRequestPermission(
    msg: RawMessage,
    event: ACPRawEvent,
    context: ParseContext,
  ): CanonicalEventDescriptor[] {
    const toolCall = event.request?.toolCall;
    if (!toolCall) return [];

    const callId = typeof toolCall.toolCallId === 'string' ? toolCall.toolCallId : '';
    if (!callId) return [];

    if (this.emittedStartedToolCallIds.has(callId) || context.hasToolCall(callId)) {
      return [];
    }

    const toolName = this.deriveToolName(toolCall.title ?? 'Tool call', toolCall.kind);
    this.toolNamesById.set(callId, toolName);
    this.emittedStartedToolCallIds.add(callId);

    const locationPath = this.firstLocationPath(toolCall);
    const args = this.mergeLocationPath(this.normalizeArguments(toolCall.rawInput), locationPath);
    const targetFilePath = this.extractTargetFilePath(args) ?? locationPath;
    const { mcpServer, mcpTool } = this.extractMcpMetadata(toolName);

    return [{
      type: 'tool_call_started',
      toolName,
      toolDisplayName: this.toolDisplayName(toolName),
      arguments: args,
      targetFilePath,
      mcpServer,
      mcpTool,
      providerToolCallId: callId,
      createdAt: msg.createdAt,
    }];
  }

  private captureUsageUpdate(update: ACPSessionUpdate): void {
    const used = (update as { used?: unknown }).used;
    const size = (update as { size?: unknown }).size;
    if (typeof used === 'number' && typeof size === 'number') {
      this.latestContext = { used, size };
    }
  }

  // ---------------------------------------------------------------------------
  // Helpers
  // ---------------------------------------------------------------------------

  /**
   * Mirrors CodexACPProtocol.deriveToolName so canonical events have the
   * same tool identifiers as live-streamed events.
   */
  private deriveToolName(title: string, kind?: string | null): string {
    const cleaned = title.trim().replace(/^Tool:\s*/i, '');

    const match = /^([A-Za-z0-9_-]+)[./]([A-Za-z0-9_-]+)/.exec(cleaned);
    if (match) {
      const [, serverName, toolName] = match;
      if (serverName === 'acp_fs') {
        switch (toolName) {
          case 'read_text_file':
            return 'Read';
          case 'write_text_file':
            return 'Write';
          case 'edit_text_file':
          case 'multi_edit_text_file':
            return 'Edit';
          default:
            return toolName;
        }
      }
      return `mcp__${serverName}__${toolName}`;
    }

    switch (kind) {
      case 'read':
        return 'Read';
      case 'search':
        return 'Grep';
      case 'execute':
        return 'Bash';
      case 'fetch':
        return 'WebFetch';
      case 'edit':
      case 'delete':
      case 'move':
        return 'ApplyPatch';
      default:
        return title || 'Tool call';
    }
  }

  private toolDisplayName(toolName: string): string {
    const mcp = parseMcpToolName(toolName);
    if (mcp) return mcp.tool;
    return toolName;
  }

  private extractMcpMetadata(toolName: string): { mcpServer: string | null; mcpTool: string | null } {
    if (!toolName.startsWith('mcp__')) {
      return { mcpServer: null, mcpTool: null };
    }
    const parsed = parseMcpToolName(toolName);
    if (!parsed) {
      return { mcpServer: null, mcpTool: null };
    }
    return { mcpServer: parsed.server, mcpTool: parsed.tool };
  }

  private extractTargetFilePath(args: Record<string, unknown>): string | null {
    if (typeof args.file_path === 'string') return args.file_path;
    if (typeof args.path === 'string') return args.path;
    if (typeof args.filePath === 'string') return args.filePath;
    return null;
  }

  /**
   * Codex's `apply_patch` rawInput doesn't carry a path -- the path lives in
   * ACP's `locations[]`. Pull the first non-empty path so the tracking
   * pipeline (which only reads args) can attribute the edit.
   */
  private firstLocationPath(
    source: { locations?: ACPToolCallLocation[] | null } | ACPSessionUpdate,
  ): string | null {
    const locations = (source as { locations?: unknown }).locations;
    if (!Array.isArray(locations)) return null;
    for (const loc of locations) {
      if (loc && typeof (loc as ACPToolCallLocation).path === 'string') {
        const path = (loc as ACPToolCallLocation).path as string;
        if (path.length > 0) return path;
      }
    }
    return null;
  }

  private mergeLocationPath(
    args: Record<string, unknown>,
    locationPath: string | null,
  ): Record<string, unknown> {
    if (!locationPath) return args;
    if (
      typeof args.file_path === 'string' ||
      typeof args.path === 'string' ||
      typeof args.filePath === 'string'
    ) {
      return args;
    }
    return { ...args, path: locationPath };
  }

  private normalizeArguments(rawInput: unknown): Record<string, unknown> {
    if (!rawInput) return {};
    if (typeof rawInput === 'object' && !Array.isArray(rawInput)) {
      const obj = rawInput as Record<string, unknown>;
      // ACP wraps MCP tool calls as `{ server, tool, arguments }`. Unwrap so
      // canonical events match what custom widgets expect (e.g.
      // AskUserQuestionWidget reads `args.questions` directly).
      if (
        typeof obj.server === 'string' &&
        typeof obj.tool === 'string' &&
        obj.arguments &&
        typeof obj.arguments === 'object' &&
        !Array.isArray(obj.arguments)
      ) {
        return obj.arguments as Record<string, unknown>;
      }
      return obj;
    }
    return { value: rawInput };
  }

  private extractResult(update: ACPSessionUpdate): { resultText: string; isError: boolean } {
    const isError = update.status === 'failed';

    // Prefer rawOutput; fall back to extracting text from the content array.
    if (update.rawOutput !== undefined) {
      const text = typeof update.rawOutput === 'string'
        ? update.rawOutput
        : JSON.stringify(update.rawOutput);
      return { resultText: text, isError };
    }

    const content = (update as { content?: Array<Record<string, unknown>> }).content;
    if (Array.isArray(content) && content.length > 0) {
      const parts: string[] = [];
      for (const entry of content) {
        if (!entry || typeof entry !== 'object') continue;
        const t = (entry as { type?: unknown }).type;
        if (t === 'content') {
          const inner = (entry as { content?: { type?: string; text?: string; uri?: string } }).content;
          if (inner?.type === 'text' && typeof inner.text === 'string') {
            parts.push(inner.text);
          } else if (inner?.type === 'resource_link' && typeof inner.uri === 'string') {
            parts.push(inner.uri);
          }
        } else if (t === 'diff') {
          const diff = entry as { path?: unknown; oldText?: unknown; newText?: unknown };
          parts.push(JSON.stringify({
            type: 'diff',
            path: diff.path,
            oldText: diff.oldText,
            newText: diff.newText,
          }));
        }
      }
      if (parts.length > 0) {
        return { resultText: parts.join('\n'), isError };
      }
    }

    return { resultText: '', isError };
  }
}
