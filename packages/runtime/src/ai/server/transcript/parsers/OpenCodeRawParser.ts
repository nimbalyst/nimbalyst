/**
 * OpenCodeRawParser -- parses OpenCode SSE events into canonical event
 * descriptors.
 *
 * OpenCode stores raw events as `{ rawEvent: { type, properties } }` envelopes
 * via OpenCodeProvider.sendMessage(). The shape is fundamentally different from
 * Codex SDK events: OpenCode uses `message.part.updated` with a discriminated
 * `part.type` (text/reasoning/tool), `state.status` transitions for tool calls,
 * and explicit `session.idle` / `session.error` lifecycle events.
 *
 * Authoritative event field reference: see OpenCodeSDKProtocol.parseSSEEvent()
 * for how each event type's `properties` payload is structured.
 */
import type { RawMessage } from '../TranscriptTransformer';
import { parseMcpToolName } from '../utils';
import type {
  IRawMessageParser,
  ParseContext,
  CanonicalEventDescriptor,
} from './IRawMessageParser';

interface OpenCodeSseEvent {
  type?: string;
  properties?: Record<string, unknown>;
}

interface OpenCodeTodoItem {
  text?: unknown;
  completed?: unknown;
}

interface AssistantTokenSnapshot {
  inputTokens: number;
  outputTokens: number;
  cacheReadInputTokens: number;
  cacheCreationInputTokens: number;
  reasoningTokens: number;
  finished: boolean;
}

export class OpenCodeRawParser implements IRawMessageParser {
  private toolIdCounter = 0;
  // Set of message IDs confirmed as assistant via message.updated events.
  // Used to short-circuit the user-message check when we have positive proof.
  private assistantMessageIds = new Set<string>();
  // Set of message IDs confirmed as user-role. Deltas referencing these are
  // suppressed so user-message parts don't leak through as assistant text.
  // Tracked separately so we default to emitting when role is unknown -- the
  // transformer creates a fresh parser per batch, so a message.updated arriving
  // before its deltas in one batch won't be remembered in the next batch's
  // parser instance. Defaulting to emit + explicit user-suppression matches
  // real OpenCode traffic, where only assistant messages ever stream deltas.
  private userMessageIds = new Set<string>();
  // Latest token snapshot per assistant message ID, captured from
  // message.updated. Used to populate turn_ended on session.idle.
  private assistantTokens = new Map<string, AssistantTokenSnapshot>();
  private partTextSnapshots = new Map<string, string>();
  private partTypes = new Map<string, string>();

  async parseMessage(
    msg: RawMessage,
    context: ParseContext,
  ): Promise<CanonicalEventDescriptor[]> {
    if (msg.hidden && msg.direction !== 'output') return [];

    if (msg.direction === 'input') {
      return this.parseInputMessage(msg);
    }

    return this.parseOutputMessage(msg, context);
  }

  // ---------------------------------------------------------------------------
  // Input message parsing (user prompts and system reminders)
  //
  // OpenCode stores user prompts in the same shape as Codex/Claude Code:
  // either plain text or `{ prompt: "..." }` JSON. Logic intentionally
  // duplicated from CodexRawParser to keep each parser self-contained.
  // ---------------------------------------------------------------------------

  private parseInputMessage(msg: RawMessage): CanonicalEventDescriptor[] {
    const descriptors: CanonicalEventDescriptor[] = [];

    try {
      const parsed = JSON.parse(msg.content);
      if (parsed.prompt) {
        if (this.isSystemReminderContent(parsed.prompt, msg.metadata)) {
          descriptors.push({
            type: 'system_message',
            text: parsed.prompt,
            systemType: 'status',
            reminderKind: this.extractReminderKind(msg.metadata),
            createdAt: msg.createdAt,
          });
        } else {
          descriptors.push({
            type: 'user_message',
            text: parsed.prompt,
            mode: (msg.metadata?.mode as 'agent' | 'planning') ?? 'agent',
            attachments: msg.metadata?.attachments as any,
            createdAt: msg.createdAt,
          });
        }
      }
    } catch {
      const content = String(msg.content ?? '');
      if (content.trim()) {
        if (this.isSystemReminderContent(content, msg.metadata)) {
          descriptors.push({
            type: 'system_message',
            text: content,
            systemType: 'status',
            reminderKind: this.extractReminderKind(msg.metadata),
            createdAt: msg.createdAt,
          });
        } else {
          descriptors.push({
            type: 'user_message',
            text: content,
            createdAt: msg.createdAt,
          });
        }
      }
    }

    return descriptors;
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
  // Output message parsing (OpenCode SSE events)
  // ---------------------------------------------------------------------------

  private parseOutputMessage(
    msg: RawMessage,
    context: ParseContext,
  ): CanonicalEventDescriptor[] {
    let sseEvent: OpenCodeSseEvent;
    try {
      sseEvent = JSON.parse(msg.content) as OpenCodeSseEvent;
    } catch {
      return [];
    }

    if (!sseEvent || typeof sseEvent !== 'object') return [];

    if (sseEvent.type === 'nimbalyst_tool_result') {
      return this.parseNimbalystToolResult(sseEvent as Record<string, unknown>);
    }

    const eventType = typeof sseEvent.type === 'string'
      ? normalizeOpenCodeEventType(sseEvent.type)
      : '';
    const props = (sseEvent.properties ?? {}) as Record<string, unknown>;

    switch (eventType) {
      case 'message.updated':
        return this.parseMessageUpdated(props);
      case 'message.part.updated':
        return this.parsePartUpdated(msg, props, context);
      case 'message.part.delta':
        return this.parsePartDelta(msg, props);
      case 'file.edited':
        return this.parseFileEdited(msg, props, context);
      case 'session.idle':
        return this.parseSessionIdle(msg, props);
      case 'session.error':
        return this.parseSessionError(msg, props);
      case 'todo.updated':
        return this.parseTodoUpdated(msg, props);
      case 'permission.updated':
      case 'permission.asked':
        return this.parsePermissionUpdated(msg, props);
      case 'permission.replied':
        return this.parsePermissionReplied(props);
      default:
        return [];
    }
  }

  // ---- message.updated ------------------------------------------------------
  //
  // Tracks per-message role (user vs assistant) so part updates can be
  // filtered, and snapshots assistant token usage for turn_ended.

  private parseMessageUpdated(props: Record<string, unknown>): CanonicalEventDescriptor[] {
    const info = props.info as Record<string, unknown> | undefined;
    if (!info) return [];

    const id = typeof info.id === 'string' ? info.id : '';
    const role = info.role;
    if (!id) return [];

    if (role === 'user') {
      this.userMessageIds.add(id);
      return [];
    }
    if (role !== 'assistant') return [];

    this.assistantMessageIds.add(id);

    const tokens = info.tokens as Record<string, unknown> | undefined;
    const cache = (tokens?.cache ?? {}) as Record<string, unknown>;
    this.assistantTokens.set(id, {
      inputTokens: numericField(tokens, 'input'),
      outputTokens: numericField(tokens, 'output'),
      cacheReadInputTokens: numericField(cache, 'read'),
      cacheCreationInputTokens: numericField(cache, 'write'),
      reasoningTokens: numericField(tokens, 'reasoning'),
      finished: typeof info.finish === 'string' && info.finish.length > 0,
    });

    return [];
  }

  // ---- message.part.updated -------------------------------------------------

  private parsePartUpdated(
    msg: RawMessage,
    props: Record<string, unknown>,
    context: ParseContext,
  ): CanonicalEventDescriptor[] {
    const part = props.part as Record<string, unknown> | undefined;
    if (!part) return [];

    const partType = typeof part.type === 'string' ? part.type : '';
    this.rememberPartType(part, props, partType);

    const messageID = this.stringField(part.messageID) ?? this.stringField(props.messageID);
    if (messageID && this.userMessageIds.has(messageID)) return [];

    if (partType === 'text' || partType === 'reasoning') {
      const content = this.derivePartTextChunk(part, props, partType);
      if (!content) return [];
      if (partType === 'reasoning') {
        return [{
          type: 'assistant_message',
          text: '',
          thinking: content,
          createdAt: msg.createdAt,
        }];
      }
      return [{
        type: 'assistant_message',
        text: content,
        createdAt: msg.createdAt,
      }];
    }

    if (partType !== 'tool') return [];

    return this.parseToolPart(msg, part, context);
  }

  // Emits text/reasoning content from message.part.delta events (the SDK's
  // incremental delta channel). Filters by parent message role -- the SDK
  // also streams deltas for user-message parts, which must not show up as
  // assistant text.
  private parsePartDelta(
    msg: RawMessage,
    props: Record<string, unknown>,
  ): CanonicalEventDescriptor[] {
    const field = typeof props.field === 'string' ? props.field : '';
    if (field !== 'text') return [];

    const delta = typeof props.delta === 'string' ? props.delta : '';
    if (!delta) return [];

    const messageID = typeof props.messageID === 'string' ? props.messageID : '';
    if (!messageID) return [];
    // Suppress only when we have positive proof this is a user-message part.
    // Otherwise emit -- real-time streaming routinely splits message.updated
    // and its deltas across separate transformer batches, and a fresh parser
    // instance won't remember the assistant-role assertion from a prior batch.
    if (this.userMessageIds.has(messageID)) return [];

    const identityKey = this.openCodePartIdentityKeyFromProps(props);
    const partType = this.partTypes.get(identityKey) ?? 'text';
    this.rememberPartDelta(props, partType, delta);

    if (partType === 'reasoning') {
      return [{
        type: 'assistant_message',
        text: '',
        thinking: delta,
        createdAt: msg.createdAt,
      }];
    }

    return [{
      type: 'assistant_message',
      text: delta,
      createdAt: msg.createdAt,
    }];
  }

  private rememberPartType(
    part: Record<string, unknown>,
    props: Record<string, unknown>,
    partType: string,
  ): void {
    this.partTypes.set(this.openCodePartIdentityKey(part, props), partType);
  }

  private derivePartTextChunk(
    part: Record<string, unknown>,
    props: Record<string, unknown>,
    partType: string,
  ): string | undefined {
    const delta = this.stringField(props.delta);
    const key = this.openCodePartTextKey(part, props, partType);

    if (delta !== undefined) {
      const fullSnapshot = this.stringField(part.text);
      if (fullSnapshot !== undefined) {
        this.partTextSnapshots.set(key, fullSnapshot);
      } else {
        this.partTextSnapshots.set(key, `${this.partTextSnapshots.get(key) ?? ''}${delta}`);
      }
      return delta || undefined;
    }

    const fullText = this.stringField(part.text);
    if (fullText === undefined) return undefined;

    const previous = this.partTextSnapshots.get(key);
    this.partTextSnapshots.set(key, fullText);

    if (!fullText) return undefined;
    if (previous === undefined) return fullText;

    if (fullText.startsWith(previous)) {
      const suffix = fullText.slice(previous.length);
      return suffix || undefined;
    }

    // OpenCode normally appends assistant text. If a snapshot rewrites the
    // part, the canonical transcript has no replacement event type, so do not
    // emit the full snapshot and duplicate already-visible output.
    return undefined;
  }

  private rememberPartDelta(
    props: Record<string, unknown>,
    partType: string,
    delta: string,
  ): void {
    const key = this.openCodePartTextKeyFromProps(props, partType);
    this.partTextSnapshots.set(key, `${this.partTextSnapshots.get(key) ?? ''}${delta}`);
  }

  private openCodePartIdentityKey(
    part: Record<string, unknown>,
    props: Record<string, unknown>,
  ): string {
    const sessionID = this.stringField(part.sessionID) ?? this.stringField(props.sessionID) ?? 'unknown-session';
    const messageID = this.stringField(part.messageID) ?? this.stringField(props.messageID) ?? 'unknown-message';
    const partID = this.stringField(part.id) ?? this.stringField(props.partID) ?? 'unknown-part';
    return `${sessionID}:${messageID}:${partID}`;
  }

  private openCodePartIdentityKeyFromProps(props: Record<string, unknown>): string {
    const sessionID = this.stringField(props.sessionID) ?? 'unknown-session';
    const messageID = this.stringField(props.messageID) ?? 'unknown-message';
    const partID = this.stringField(props.partID) ?? 'unknown-part';
    return `${sessionID}:${messageID}:${partID}`;
  }

  private openCodePartTextKey(
    part: Record<string, unknown>,
    props: Record<string, unknown>,
    partType: string,
  ): string {
    return `${this.openCodePartIdentityKey(part, props)}:${partType}`;
  }

  private openCodePartTextKeyFromProps(
    props: Record<string, unknown>,
    partType: string,
  ): string {
    return `${this.openCodePartIdentityKeyFromProps(props)}:${partType}`;
  }

  private stringField(value: unknown): string | undefined {
    return typeof value === 'string' ? value : undefined;
  }

  private parseToolPart(
    msg: RawMessage,
    part: Record<string, unknown>,
    context: ParseContext,
  ): CanonicalEventDescriptor[] {
    const rawToolName = typeof part.tool === 'string' ? part.tool : 'unknown';
    // OpenCode names MCP tools as `<server>_<tool>` (single underscore),
    // but every other provider in Nimbalyst -- and our widget registry --
    // uses Claude/Codex's canonical `mcp__<server>__<tool>` format.
    // Normalize here so a single canonical name flows through the rest of
    // the system: tool widgets match, persistence is consistent, and the
    // canonical event store doesn't have to know about provider quirks.
    const toolName = normalizeOpenCodeToolName(rawToolName);
    const callId = (typeof part.callID === 'string' && part.callID)
      || (typeof part.id === 'string' && part.id)
      || `opencode-tool-${++this.toolIdCounter}`;
    const state = (part.state ?? {}) as Record<string, unknown>;
    const status = (typeof state.status === 'string' && state.status)
      || (typeof state.type === 'string' && state.type)
      || '';

    const descriptors: CanonicalEventDescriptor[] = [];

    const isMcp = toolName.startsWith('mcp__');
    let mcpServer: string | null = null;
    let mcpTool: string | null = null;
    if (isMcp) {
      const parsed = parseMcpToolName(toolName);
      if (parsed) {
        mcpServer = parsed.server;
        mcpTool = parsed.tool;
      }
    }

    const args = (state.input ?? {}) as Record<string, unknown>;
    let targetFilePath: string | null = null;
    if (typeof args.file_path === 'string') targetFilePath = args.file_path;
    else if (typeof args.path === 'string') targetFilePath = args.path;

    // Skip pending events: OpenCode emits a tool part transition through
    // pending -> running -> completed/error, and only by `running` is the
    // tool's input populated. If we emit on pending we capture the empty
    // input snapshot, and downstream `hasToolCall` dedup means the real
    // arguments from the running event are never attached. Wait for running
    // (or for a terminal state, handled below).
    if (status === 'running') {
      if (!context.hasToolCall(callId)) {
        descriptors.push({
          type: 'tool_call_started',
          toolName,
          toolDisplayName: this.openCodeToolDisplayName(toolName),
          arguments: args,
          targetFilePath,
          mcpServer,
          mcpTool,
          providerToolCallId: callId,
          createdAt: msg.createdAt,
        });
      }
      return descriptors;
    }

    if (status === 'pending') {
      // Nothing to emit yet -- wait for `running`.
      return descriptors;
    }

    if (status === 'completed' || status === 'error') {
      if (!context.hasToolCall(callId)) {
        descriptors.push({
          type: 'tool_call_started',
          toolName,
          toolDisplayName: this.openCodeToolDisplayName(toolName),
          arguments: args,
          targetFilePath,
          mcpServer,
          mcpTool,
          providerToolCallId: callId,
          createdAt: msg.createdAt,
        });
      }

      const isError = status === 'error';
      const { resultText } = this.extractToolResult(state, isError);

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

  private extractToolResult(
    state: Record<string, unknown>,
    isError: boolean,
  ): { resultText: string; isError: boolean } {
    if (isError) {
      const err = state.error;
      if (typeof err === 'string') return { resultText: err, isError: true };
      if (err && typeof err === 'object') return { resultText: JSON.stringify(err), isError: true };
      return { resultText: 'Tool execution failed', isError: true };
    }

    let output = state.output;

    // MCP tools wrap output as { content: [{ type: 'text', text: '...' }] }
    if (output && typeof output === 'object' && !Array.isArray(output)) {
      const obj = output as Record<string, unknown>;
      if (Array.isArray(obj.content)) {
        let extracted = '';
        for (const block of obj.content) {
          if (block && typeof block === 'object' && (block as any).type === 'text' && (block as any).text) {
            extracted += (block as any).text;
          }
        }
        if (extracted) {
          output = extracted;
        }
      }
    }

    const resultText = typeof output === 'string'
      ? output
      : output != null ? JSON.stringify(output) : '';

    return { resultText, isError: false };
  }

  private openCodeToolDisplayName(toolName: string): string {
    const mcp = parseMcpToolName(toolName);
    if (mcp) return mcp.tool;
    if (toolName === 'file_edit') return 'File Edit';
    if (toolName === 'bash' || toolName === 'shell') return 'Bash';
    return toolName;
  }

  // ---- file.edited ----------------------------------------------------------

  private parseFileEdited(
    msg: RawMessage,
    props: Record<string, unknown>,
    context: ParseContext,
  ): CanonicalEventDescriptor[] {
    const filePath = typeof props.file === 'string' ? props.file : '';
    if (!filePath) return [];

    const callId = `opencode-file-edit-${++this.toolIdCounter}`;
    if (context.hasToolCall(callId)) return [];

    return [
      {
        type: 'tool_call_started',
        toolName: 'file_edit',
        toolDisplayName: 'File Edit',
        arguments: { file_path: filePath },
        targetFilePath: filePath,
        mcpServer: null,
        mcpTool: null,
        providerToolCallId: callId,
        createdAt: msg.createdAt,
      },
      {
        type: 'tool_call_completed',
        providerToolCallId: callId,
        status: 'completed',
        result: '',
        isError: false,
      },
    ];
  }

  // ---- session.idle ---------------------------------------------------------
  //
  // Token usage is captured from the latest assistant message.updated event
  // (AssistantMessage.tokens). session.idle marks the turn boundary; we
  // emit turn_ended with the most recent assistant token snapshot.

  private parseSessionIdle(
    msg: RawMessage,
    _props: Record<string, unknown>,
  ): CanonicalEventDescriptor[] {
    const snapshot = this.latestAssistantTokenSnapshot();
    const inputTokens = snapshot?.inputTokens ?? 0;
    const outputTokens = snapshot?.outputTokens ?? 0;
    const cacheReadInputTokens = snapshot?.cacheReadInputTokens ?? 0;
    const cacheCreationInputTokens = snapshot?.cacheCreationInputTokens ?? 0;

    return [{
      type: 'turn_ended',
      contextFill: {
        inputTokens,
        cacheReadInputTokens,
        cacheCreationInputTokens,
        outputTokens,
        totalContextTokens: inputTokens + cacheReadInputTokens + cacheCreationInputTokens,
      },
      contextWindow: 0,
      cumulativeUsage: {
        inputTokens,
        outputTokens,
        cacheReadInputTokens,
        cacheCreationInputTokens,
        costUSD: 0,
        webSearchRequests: 0,
      },
      contextCompacted: false,
      createdAt: msg.createdAt,
    }];
  }

  // Returns the most recently observed assistant token snapshot, preferring
  // a finished message if any are present.
  private latestAssistantTokenSnapshot(): AssistantTokenSnapshot | undefined {
    let finished: AssistantTokenSnapshot | undefined;
    let latest: AssistantTokenSnapshot | undefined;
    for (const snap of this.assistantTokens.values()) {
      latest = snap;
      if (snap.finished) finished = snap;
    }
    return finished ?? latest;
  }

  // ---- session.error --------------------------------------------------------

  private parseSessionError(
    msg: RawMessage,
    props: Record<string, unknown>,
  ): CanonicalEventDescriptor[] {
    const errorObj = props.error;
    let errorMsg: string;
    if (typeof errorObj === 'string') {
      errorMsg = errorObj;
    } else if (errorObj && typeof errorObj === 'object') {
      const obj = errorObj as Record<string, unknown>;
      errorMsg = (typeof obj.message === 'string' && obj.message)
        || (typeof obj.type === 'string' && obj.type)
        || 'Unknown error';
    } else {
      errorMsg = 'Unknown error';
    }

    return [{
      type: 'system_message',
      text: errorMsg,
      systemType: 'error',
      createdAt: msg.createdAt,
    }];
  }

  // ---- todo.updated ---------------------------------------------------------

  private parseTodoUpdated(
    msg: RawMessage,
    props: Record<string, unknown>,
  ): CanonicalEventDescriptor[] {
    const todos = props.todos;
    if (!Array.isArray(todos)) return [];

    const items = todos
      .filter((t): t is OpenCodeTodoItem => t != null && typeof t === 'object')
      .map((t) => ({
        text: typeof t.text === 'string' ? t.text : String(t.text ?? ''),
        completed: !!t.completed,
      }));

    if (items.length === 0) return [];

    const text = items
      .map((t) => `- [${t.completed ? 'x' : ' '}] ${t.text}`)
      .join('\n');

    return [{
      type: 'assistant_message',
      text,
      createdAt: msg.createdAt,
    }];
  }

  // ---- permission.updated / permission.replied ----------------------------
  //
  // OpenCode asks for external-directory and other permission approvals via a
  // server-side permission stream instead of an MCP tool call. Project it into
  // Nimbalyst's existing ToolPermission card so desktop and mobile can approve
  // the run and replay the decision from raw transcript history.

  private parsePermissionUpdated(
    msg: RawMessage,
    props: Record<string, unknown>,
  ): CanonicalEventDescriptor[] {
    const permissionId = this.stringField(props.id) ?? this.stringField(props.requestID);
    if (!permissionId) return [];

    return [{
      type: 'tool_call_started',
      toolName: 'ToolPermission',
      toolDisplayName: 'Permission',
      arguments: buildOpenCodePermissionToolArgs(props),
      targetFilePath: null,
      mcpServer: null,
      mcpTool: null,
      providerToolCallId: permissionId,
      createdAt: msg.createdAt,
    }];
  }

  private parsePermissionReplied(
    props: Record<string, unknown>,
  ): CanonicalEventDescriptor[] {
    const permissionId = this.stringField(props.permissionID)
      ?? this.stringField(props.requestID)
      ?? this.stringField(props.id);
    if (!permissionId) return [];

    const response = this.stringField(props.response) ?? this.stringField(props.reply) ?? '';
    return [{
      type: 'tool_call_completed',
      providerToolCallId: permissionId,
      status: 'completed',
      result: JSON.stringify(openCodePermissionResponseToNimbalyst(response)),
      isError: false,
    }];
  }

  private parseNimbalystToolResult(parsed: Record<string, unknown>): CanonicalEventDescriptor[] {
    const toolUseId = this.stringField(parsed.tool_use_id) ?? this.stringField(parsed.id);
    if (!toolUseId) return [];

    const content = parsed.result;
    const result = typeof content === 'string'
      ? content
      : content != null ? JSON.stringify(content) : '';
    const isError = parsed.is_error === true;

    return [{
      type: 'tool_call_completed',
      providerToolCallId: toolUseId,
      status: isError ? 'error' : 'completed',
      result,
      isError,
    }];
  }
}

function numericField(record: Record<string, unknown> | undefined, key: string): number {
  if (!record) return 0;
  const value = record[key];
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

function normalizeOpenCodeEventType(type: string): string {
  return type.replace(/\.\d+$/, '');
}

// MCP server names registered in OpenCode by McpConfigService. We match a
// known-prefix list (rather than splitting on underscore) because both
// server names and tool names can contain underscores, so a generic split
// would mis-segment ambiguous cases.
const KNOWN_MCP_SERVER_PREFIXES = [
  'nimbalyst-mcp',
  'nimbalyst-session-naming',
  'nimbalyst-extension-dev',
  'nimbalyst-session-context',
  'nimbalyst-meta-agent',
  'nimbalyst-extension-dev-kit',
];

// Converts OpenCode's `<server>_<tool>` MCP tool name format to the
// canonical `mcp__<server>__<tool>` used everywhere else. Returns the
// input unchanged if it doesn't look like an MCP tool from a known server.
function normalizeOpenCodeToolName(toolName: string): string {
  if (toolName.startsWith('mcp__')) return toolName;

  for (const server of KNOWN_MCP_SERVER_PREFIXES) {
    const prefix = `${server}_`;
    if (toolName.startsWith(prefix)) {
      const tool = toolName.slice(prefix.length);
      if (tool) return `mcp__${server}__${tool}`;
    }
  }

  return toolName;
}

function buildOpenCodePermissionToolArgs(props: Record<string, unknown>): Record<string, unknown> {
  const permissionId = typeof props.id === 'string'
    ? props.id
    : typeof props.requestID === 'string' ? props.requestID : '';
  const permissionType = typeof props.type === 'string'
    ? props.type
    : typeof props.permission === 'string' ? props.permission : 'permission';
  const title = typeof props.title === 'string' && props.title
    ? props.title
    : `OpenCode ${permissionType} permission`;
  const patterns = normalizeOpenCodePermissionPattern(props.pattern ?? props.patterns);
  const patternText = patterns.join(', ') || permissionType;
  const rawCommand = `${title}${patternText ? `\n${patternText}` : ''}`;

  return {
    requestId: permissionId,
    toolName: 'OpenCode',
    rawCommand,
    pattern: `OpenCodePermission(${permissionType}:${patternText})`,
    patternDisplayName: title,
    isDestructive: permissionType !== 'read',
    warnings: [
      `OpenCode is requesting ${permissionType} permission.`,
      ...(patterns.length > 0 ? [`Requested path/pattern: ${patternText}`] : []),
    ],
    workspacePath: '',
    openCodePermissionType: permissionType,
    openCodePermissionPattern: patterns,
    openCodePermissionTitle: title,
  };
}

function normalizeOpenCodePermissionPattern(pattern: unknown): string[] {
  if (typeof pattern === 'string' && pattern) return [pattern];
  if (Array.isArray(pattern)) {
    return pattern.filter((value): value is string => typeof value === 'string' && value.length > 0);
  }
  return [];
}

function openCodePermissionResponseToNimbalyst(response: string): {
  decision: 'allow' | 'deny';
  scope: 'once' | 'session' | 'always';
} {
  if (response === 'reject') {
    return { decision: 'deny', scope: 'once' };
  }
  if (response === 'always') {
    return { decision: 'allow', scope: 'always' };
  }
  return { decision: 'allow', scope: 'once' };
}
