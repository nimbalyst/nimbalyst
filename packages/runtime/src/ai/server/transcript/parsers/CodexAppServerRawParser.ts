/**
 * CodexAppServerRawParser -- parses raw messages logged by the OpenAI Codex
 * **app-server** transport into canonical event descriptors.
 *
 * The SDK-transport `CodexRawParser` reads SDK JSONL events from
 * `ai_agent_messages.content` (shape: `{ type: 'item.completed', item: {...} }`).
 * The app-server transport persists notifications in a different shape:
 *
 *   content = JSON.stringify({ method, params })
 *
 * with `metadata.transport = 'app-server'` and `metadata.eventType = method`
 * stamped at write time by `OpenAICodexProvider.storeRawEventIfPresent`.
 *
 * The transformer dispatches to either parser per-message via
 * `CodexRawParserDispatcher`. We do NOT bump `TranscriptTransformer.CURRENT_VERSION` --
 * old sessions stay on the SDK parser, new sessions use this one.
 */

import type { RawMessage } from '../TranscriptTransformer';
import { parseMcpToolName } from '../utils';
import { buildCodexToolLookupId } from '../../toolLookupIds';
import type {
  IRawMessageParser,
  ParseContext,
  CanonicalEventDescriptor,
} from './IRawMessageParser';

interface AppServerEnvelope {
  method?: string;
  params?: {
    threadId?: string;
    turnId?: string;
    item?: AppServerItem;
    usage?: AppServerUsage;
    turn?: { id?: string; status?: string; error?: { message?: string } };
    error?: { message?: string };
    message?: string;
  };
}

const WHOLE_MESSAGE_ELISION_MARKER = /^\[Full .+ message elided from mobile sync:.*\]$/;

interface AppServerUsage {
  input_tokens?: number;
  output_tokens?: number;
  total_tokens?: number;
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
}

interface AppServerItem {
  id?: string;
  type?: string;
  status?: string;
  text?: string;
  changes?: Array<{ path: string; kind: { type: string; move_path?: string | null }; diff: string }>;
  server?: string;
  tool?: string;
  arguments?: unknown;
  result?: unknown;
  error?: { message: string };
  command?: string;
  aggregated_output?: string;
  aggregatedOutput?: string;
  exit_code?: number;
  exitCode?: number;
  content?: Array<{ type: string; text?: string }>;
  prompt?: string | null;
  senderThreadId?: string;
  receiverThreadIds?: string[];
  model?: string | null;
  reasoningEffort?: string | null;
  agentsStates?: Record<string, { status?: string; message?: string | null }>;
  items?: Array<Record<string, unknown>>;
}

export class CodexAppServerRawParser implements IRawMessageParser {
  private toolIdCounter = 0;
  private readonly seenNotificationKeysByTurnId = new Map<string, Set<string>>();
  /**
   * Per-batch in-flight raw-itemId -> synthetic edit-group ID mapping. Mirrors
   * the SDK parser's behavior: started+completed events from the same batch
   * share their synthetic ID via this map; cross-batch resolution goes through
   * ParseContext.findActiveToolCallByRawProviderId.
   *
   * For the app-server transport, item/completed for fileChange items is the
   * only place we emit canonical events today (a single started+completed pair
   * descriptor sequence) -- there's no separate started message. So this map
   * is mostly used for cross-message dedup within a single batch (defensive).
   */
  private readonly inFlightSyntheticIds = new Map<string, string>();

  async parseMessage(msg: RawMessage, context: ParseContext): Promise<CanonicalEventDescriptor[]> {
    if (msg.hidden) return [];
    if (msg.direction === 'input') {
      // Input messages are formatted identically to the SDK transport. Reuse
      // the same path as `CodexRawParser.parseInputMessage` by parsing here.
      return this.parseInputMessage(msg);
    }
    return this.parseOutputMessage(msg, context);
  }

  private parseInputMessage(msg: RawMessage): CanonicalEventDescriptor[] {
    try {
      const parsed = JSON.parse(msg.content);
      if (parsed && typeof parsed === 'object' && typeof parsed.prompt === 'string') {
        return [{
          type: 'user_message',
          text: parsed.prompt,
          mode: (msg.metadata?.mode as 'agent' | 'planning') ?? 'agent',
          attachments: msg.metadata?.attachments as never,
          createdAt: msg.createdAt,
        }];
      }
    } catch { /* fall through */ }
    const content = String(msg.content ?? '').trim();
    if (!content) return [];
    return [{
      type: 'user_message',
      text: content,
      mode: (msg.metadata?.mode as 'agent' | 'planning') ?? 'agent',
      createdAt: msg.createdAt,
    }];
  }

  private async parseOutputMessage(msg: RawMessage, context: ParseContext): Promise<CanonicalEventDescriptor[]> {
    const descriptors: CanonicalEventDescriptor[] = [];
    let envelope: AppServerEnvelope;
    try { envelope = JSON.parse(msg.content); }
    catch {
      const content = String(msg.content ?? '');
      if (content.trim() && !WHOLE_MESSAGE_ELISION_MARKER.test(content.trim())) {
        descriptors.push({ type: 'assistant_message', text: content, createdAt: msg.createdAt });
      }
      return descriptors;
    }

    const method = envelope.method;
    const params = envelope.params;
    if (!method || !params) return descriptors;
    if (this.isDuplicateNotification(method, params)) {
      return descriptors;
    }

    switch (method) {
      case 'item/started': {
        const item = params.item;
        if (!item || typeof item !== 'object') break;
        descriptors.push(...await this.parseItemStarted(msg, item, context));
        break;
      }
      case 'item/completed': {
        const item = params.item;
        if (!item || typeof item !== 'object') break;
        descriptors.push(...await this.parseItemCompleted(msg, item, context));
        break;
      }
      case 'turn/completed': {
        descriptors.push(...this.parseTurnCompleted(msg, params));
        break;
      }
      case 'turn/failed':
      case 'error': {
        const message = params.error?.message ?? params.message;
        if (message) {
          descriptors.push({
            type: 'system_message',
            text: message,
            systemType: 'error',
            createdAt: msg.createdAt,
          });
        }
        break;
      }
      default: {
        // Other notifications (deltas, mcpServer status, etc.) do not produce
        // canonical events; they're preserved as raw rows for re-parse but
        // not surfaced in the transcript.
        break;
      }
    }

    return descriptors;
  }

  /**
   * Emit a `tool_call_started` descriptor when we see `item/started` for
   * tool-like items. Required for MCP tools that block on the user (commit
   * proposal, AskUserQuestion): their widgets render off the canonical
   * tool_call_started event, and `item/completed` won't fire until *after*
   * the user clicks through the widget -- so without this path the user
   * sees only "Thinking..." and can never respond.
   *
   * We track the rawItemId in `inFlightSyntheticIds` so the subsequent
   * `item/completed` reuses the same editGroupId and skips re-emitting the
   * started descriptor.
   */
  private async parseItemStarted(
    msg: RawMessage,
    item: AppServerItem,
    context: ParseContext,
  ): Promise<CanonicalEventDescriptor[]> {
    if (item.type === 'mcpToolCall') {
      if (!item.id || !item.server || !item.tool) return [];
      const rawItemId = item.id;
      const editGroupId = await this.resolveEditGroupId(msg, rawItemId, context);
      const toolName = `mcp__${item.server}__${item.tool}`;
      const parsed = parseMcpToolName(toolName);
      return [{
        type: 'tool_call_started',
        toolName,
        toolDisplayName: toolName,
        arguments: (item.arguments as Record<string, unknown> | undefined) ?? {},
        targetFilePath: null,
        mcpServer: parsed?.server ?? item.server,
        mcpTool: parsed?.tool ?? item.tool,
        providerToolCallId: editGroupId,
        createdAt: msg.createdAt,
      }];
    }

    if (item.type === 'collabAgentToolCall') {
      return this.parseCollabAgentToolCallStarted(msg, item, context);
    }

    if (this.isGenericToolLikeItem(item)) {
      return this.parseGenericToolLikeItem(msg, item, context);
    }

    return [];
  }

  private async parseItemCompleted(
    msg: RawMessage,
    item: AppServerItem,
    context: ParseContext,
  ): Promise<CanonicalEventDescriptor[]> {
    const descriptors: CanonicalEventDescriptor[] = [];
    switch (item.type) {
      case 'agentMessage': {
        const text = item.text ?? '';
        if (text) descriptors.push({ type: 'assistant_message', text, createdAt: msg.createdAt });
        break;
      }
      case 'reasoning': {
        const text = item.text ?? '';
        if (text) descriptors.push({ type: 'assistant_message', text: '', thinking: text, createdAt: msg.createdAt });
        break;
      }
      case 'fileChange': {
        descriptors.push(...await this.parseFileChangeItem(msg, item, context));
        break;
      }
      case 'mcpToolCall': {
        descriptors.push(...await this.parseMcpToolCall(msg, item, context));
        break;
      }
      case 'commandExecution': {
        descriptors.push(...await this.parseCommandExecution(msg, item, context));
        break;
      }
      case 'collabAgentToolCall': {
        descriptors.push(...await this.parseCollabAgentToolCallCompleted(msg, item, context));
        break;
      }
      case 'todoList':
      case 'todo_list': {
        descriptors.push(...this.parseTodoListItem(msg, item));
        break;
      }
      default: {
        if (this.isGenericToolLikeItem(item)) {
          descriptors.push(...await this.parseGenericToolLikeItem(msg, item, context));
        }
        break;
      }
    }
    return descriptors;
  }

  private isDuplicateNotification(method: string, params: AppServerEnvelope['params']): boolean {
    const notificationKey = this.buildNotificationKey(method, params);
    if (!notificationKey) {
      return false;
    }

    const turnId = this.extractTurnId(params) ?? 'no-turn';
    const seenKeys = this.seenNotificationKeysByTurnId.get(turnId) ?? new Set<string>();
    if (!this.seenNotificationKeysByTurnId.has(turnId)) {
      this.seenNotificationKeysByTurnId.set(turnId, seenKeys);
    }

    if (seenKeys.has(notificationKey)) {
      return true;
    }

    seenKeys.add(notificationKey);
    return false;
  }

  private buildNotificationKey(method: string, params: AppServerEnvelope['params']): string | null {
    switch (method) {
      case 'item/started':
      case 'item/completed': {
        const itemId = params?.item?.id;
        const turnId = this.extractTurnId(params) ?? 'no-turn';
        if (typeof itemId !== 'string' || !itemId) {
          return null;
        }
        return `${method}:${turnId}:${itemId}`;
      }
      case 'turn/completed':
      case 'turn/failed': {
        const turnId = params?.turn?.id;
        if (typeof turnId !== 'string' || !turnId) {
          return null;
        }
        return `${method}:${turnId}`;
      }
      default:
        return null;
    }
  }

  private extractTurnId(params: AppServerEnvelope['params']): string | null {
    if (!params) {
      return null;
    }
    if (typeof params.turnId === 'string' && params.turnId) {
      return params.turnId;
    }
    if (typeof params.turn?.id === 'string' && params.turn.id) {
      return params.turn.id;
    }
    return null;
  }

  private async parseCollabAgentToolCallStarted(
    msg: RawMessage,
    item: AppServerItem,
    context: ParseContext,
  ): Promise<CanonicalEventDescriptor[]> {
    if (!item.id || !item.tool) return [];

    if (item.tool === 'spawnAgent') {
      return [{
        type: 'subagent_started',
        subagentId: item.id,
        agentType: 'Session',
        prompt: item.prompt ?? '',
        createdAt: msg.createdAt,
      }];
    }

    return this.parseGenericCollabAgentToolCall(msg, item, context);
  }

  private async parseCollabAgentToolCallCompleted(
    msg: RawMessage,
    item: AppServerItem,
    context: ParseContext,
  ): Promise<CanonicalEventDescriptor[]> {
    if (!item.id || !item.tool) return [];

    if (item.tool === 'spawnAgent') {
      return [{
        type: 'subagent_completed',
        subagentId: item.id,
        status: 'completed',
        resultSummary: this.buildSpawnAgentResultSummary(item),
      }];
    }

    return this.parseGenericCollabAgentToolCall(msg, item, context);
  }

  private async parseGenericCollabAgentToolCall(
    msg: RawMessage,
    item: AppServerItem,
    context: ParseContext,
  ): Promise<CanonicalEventDescriptor[]> {
    if (!item.id || !item.tool) return [];

    const rawItemId = item.id;
    const editGroupId = await this.resolveEditGroupId(msg, rawItemId, context);
    const toolName = item.tool;
    const descriptors: CanonicalEventDescriptor[] = [{
      type: 'tool_call_started',
      toolName,
      toolDisplayName: toolName,
      arguments: this.buildCollabAgentToolArguments(item),
      targetFilePath: null,
      mcpServer: null,
      mcpTool: null,
      providerToolCallId: editGroupId,
      createdAt: msg.createdAt,
    }];

    if (item.status === 'completed' || item.status === 'failed') {
      const isError = item.status !== 'completed';
      descriptors.push({
        type: 'tool_call_completed',
        providerToolCallId: editGroupId,
        status: isError ? 'error' : 'completed',
        result: this.buildCollabAgentToolResult(item),
        isError,
      });
      this.inFlightSyntheticIds.delete(rawItemId);
    }

    return descriptors;
  }

  private async parseGenericToolLikeItem(
    msg: RawMessage,
    item: AppServerItem,
    context: ParseContext,
  ): Promise<CanonicalEventDescriptor[]> {
    if (!item.id || !item.type) return [];

    const rawItemId = item.id;
    const startedAlreadyEmitted = this.inFlightSyntheticIds.has(rawItemId);
    const editGroupId = await this.resolveEditGroupId(msg, rawItemId, context);
    const toolName = item.type;
    const descriptors: CanonicalEventDescriptor[] = [];

    if (!startedAlreadyEmitted) {
      descriptors.push({
        type: 'tool_call_started',
        toolName,
        toolDisplayName: toolName,
        arguments: this.buildGenericToolLikeArguments(item),
        targetFilePath: null,
        mcpServer: null,
        mcpTool: null,
        providerToolCallId: editGroupId,
        createdAt: msg.createdAt,
      });
    }

    if (item.status === 'completed' || item.status === 'failed') {
      const isError = item.status !== 'completed';
      descriptors.push({
        type: 'tool_call_completed',
        providerToolCallId: editGroupId,
        status: isError ? 'error' : 'completed',
        result: this.buildGenericToolLikeResult(item),
        isError,
      });
      this.inFlightSyntheticIds.delete(rawItemId);
    }

    return descriptors;
  }

  private async parseFileChangeItem(
    msg: RawMessage,
    item: AppServerItem,
    context: ParseContext,
  ): Promise<CanonicalEventDescriptor[]> {
    if (!item.id || !Array.isArray(item.changes) || item.changes.length === 0) return [];
    const rawItemId = item.id;
    const editGroupId = await this.resolveEditGroupId(msg, rawItemId, context);

    const args = {
      changes: item.changes.map((c) => ({
        path: c.path,
        kind: c.kind.type,
        move_path: c.kind.move_path ?? null,
        diff: c.diff,
      })),
    };
    const targetFilePath = item.changes[0]?.path ?? null;

    const descriptors: CanonicalEventDescriptor[] = [{
      type: 'tool_call_started',
      // Use the SDK-transport tool name so the renderer's special-case
      // routing in RichTranscriptView picks the main-enriched file_change
      // renderer. See CodexAppServerProtocol.handleItemCompleted for the
      // parallel decision in the live stream path.
      toolName: 'file_change',
      toolDisplayName: 'apply_patch',
      arguments: args,
      targetFilePath,
      mcpServer: null,
      mcpTool: null,
      providerToolCallId: editGroupId,
      createdAt: msg.createdAt,
    }];

    descriptors.push({
      type: 'tool_call_completed',
      providerToolCallId: editGroupId,
      status: item.status === 'completed' ? 'completed' : 'error',
      result: item.status === 'completed' ? `Applied ${item.changes.length} file change(s)` : 'apply_patch failed',
      isError: item.status !== 'completed',
    });

    this.inFlightSyntheticIds.delete(rawItemId);
    return descriptors;
  }

  private async parseMcpToolCall(
    msg: RawMessage,
    item: AppServerItem,
    context: ParseContext,
  ): Promise<CanonicalEventDescriptor[]> {
    if (!item.id || !item.server || !item.tool) return [];
    const rawItemId = item.id;
    // If `parseItemStarted` already emitted a tool_call_started for this
    // rawItemId in the same batch, skip re-emitting it -- otherwise we'd
    // produce two started descriptors for the same providerToolCallId. The
    // writer dedupes by id, but emitting cleanly here keeps reparse output
    // identical to live-stream output.
    const startedAlreadyEmitted = this.inFlightSyntheticIds.has(rawItemId);
    const editGroupId = await this.resolveEditGroupId(msg, rawItemId, context);
    const toolName = `mcp__${item.server}__${item.tool}`;
    const parsed = parseMcpToolName(toolName);

    const descriptors: CanonicalEventDescriptor[] = [];
    if (!startedAlreadyEmitted) {
      descriptors.push({
        type: 'tool_call_started',
        toolName,
        toolDisplayName: toolName,
        arguments: (item.arguments as Record<string, unknown> | undefined) ?? {},
        targetFilePath: null,
        mcpServer: parsed?.server ?? item.server,
        mcpTool: parsed?.tool ?? item.tool,
        providerToolCallId: editGroupId,
        createdAt: msg.createdAt,
      });
    }

    if (item.status === 'completed' || item.status === 'failed') {
      const { resultText, isError } = this.extractToolResult(item);
      descriptors.push({
        type: 'tool_call_completed',
        providerToolCallId: editGroupId,
        status: isError ? 'error' : 'completed',
        result: resultText,
        isError,
      });
      this.inFlightSyntheticIds.delete(rawItemId);
    }
    return descriptors;
  }

  private async parseCommandExecution(
    msg: RawMessage,
    item: AppServerItem,
    context: ParseContext,
  ): Promise<CanonicalEventDescriptor[]> {
    if (!item.id || !item.command) return [];
    const rawItemId = item.id;
    const editGroupId = await this.resolveEditGroupId(msg, rawItemId, context);
    const descriptors: CanonicalEventDescriptor[] = [{
      type: 'tool_call_started',
      toolName: 'command_execution',
      toolDisplayName: 'command_execution',
      arguments: { command: item.command },
      targetFilePath: null,
      mcpServer: null,
      mcpTool: null,
      providerToolCallId: editGroupId,
      createdAt: msg.createdAt,
    }];
    if (item.status === 'completed' || item.status === 'failed') {
      const isError = item.status !== 'completed';
      descriptors.push({
        type: 'tool_call_completed',
        providerToolCallId: editGroupId,
        status: isError ? 'error' : 'completed',
        result: item.aggregated_output ?? item.aggregatedOutput ?? '',
        isError,
        exitCode: item.exit_code ?? item.exitCode,
      });
      this.inFlightSyntheticIds.delete(rawItemId);
    }
    return descriptors;
  }

  private parseTodoListItem(
    msg: RawMessage,
    item: AppServerItem,
  ): CanonicalEventDescriptor[] {
    if (!Array.isArray(item.items) || item.items.length === 0) return [];

    const todoText = item.items
      .filter((entry): entry is Record<string, unknown> => !!entry && typeof entry === 'object')
      .map((entry) => {
        const text = typeof entry.text === 'string' ? entry.text : String(entry.text ?? '');
        return `- [${entry.completed ? 'x' : ' '}] ${text}`;
      })
      .join('\n');

    if (!todoText) return [];

    return [{
      type: 'assistant_message',
      text: todoText,
      createdAt: msg.createdAt,
    }];
  }

  private parseTurnCompleted(msg: RawMessage, params: NonNullable<AppServerEnvelope['params']>): CanonicalEventDescriptor[] {
    // The `turn/completed` notification CAN carry usage but in practice usage
    // arrives via `thread/tokenUsage/updated` and the SDK parser pulls it from
    // that path. Emit a minimal turn_ended descriptor only when usage is
    // present; otherwise let other producers handle it.
    const usage = params.usage;
    if (!usage) return [];
    const input = usage.input_tokens ?? usage.inputTokens ?? 0;
    const output = usage.output_tokens ?? usage.outputTokens ?? 0;
    return [{
      type: 'turn_ended',
      contextFill: {
        inputTokens: input,
        cacheReadInputTokens: 0,
        cacheCreationInputTokens: 0,
        outputTokens: output,
        totalContextTokens: input,
      },
      contextWindow: 0,
      cumulativeUsage: {
        inputTokens: input,
        outputTokens: output,
        cacheReadInputTokens: 0,
        cacheCreationInputTokens: 0,
        costUSD: 0,
        webSearchRequests: 0,
      },
      contextCompacted: false,
      createdAt: msg.createdAt,
    }];
  }

  private async resolveEditGroupId(msg: RawMessage, rawItemId: string, context: ParseContext): Promise<string> {
    const fromMetadata = msg.metadata?.editGroupId;
    if (typeof fromMetadata === 'string' && fromMetadata.startsWith('nimtc|')) {
      this.inFlightSyntheticIds.set(rawItemId, fromMetadata);
      return fromMetadata;
    }
    const inBatch = this.inFlightSyntheticIds.get(rawItemId);
    if (inBatch) return inBatch;
    try {
      const existing = await context.findActiveToolCallByRawProviderId(rawItemId);
      if (existing && typeof existing.providerToolCallId === 'string' && existing.providerToolCallId) {
        this.inFlightSyntheticIds.set(rawItemId, existing.providerToolCallId);
        return existing.providerToolCallId;
      }
    } catch { /* fall through */ }
    const minted = buildCodexToolLookupId(rawItemId, msg.createdAt.getTime(), msg.id);
    this.inFlightSyntheticIds.set(rawItemId, minted);
    return minted;
  }

  private extractToolResult(item: AppServerItem): { resultText: string; isError: boolean } {
    if (item.error) return { resultText: item.error.message, isError: true };
    const result = item.result;
    if (typeof result === 'string') return { resultText: result, isError: false };
    if (Array.isArray((result as { content?: unknown[] })?.content)) {
      const blocks = (result as { content: unknown[] }).content;
      let text = '';
      for (const b of blocks) {
        if (b && typeof b === 'object' && (b as { type?: string }).type === 'text') {
          text += (b as { text?: string }).text ?? '';
        }
      }
      if (text) return { resultText: text, isError: false };
    }
    return { resultText: result == null ? '' : JSON.stringify(result), isError: false };
  }

  private isGenericToolLikeItem(item: AppServerItem): boolean {
    if (!item.id || !item.type) return false;
    return !new Set([
      'userMessage',
      'agentMessage',
      'reasoning',
      'todoList',
      'todo_list',
      'error',
      'fileChange',
      'mcpToolCall',
      'commandExecution',
      'collabAgentToolCall',
    ]).has(item.type);
  }

  private buildGenericToolLikeArguments(item: AppServerItem): Record<string, unknown> {
    const record = item as Record<string, unknown>;
    const args: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(record)) {
      if (value === undefined) continue;
      if (['id', 'type', 'status', 'result', 'error', 'aggregated_output', 'aggregatedOutput', 'exit_code', 'exitCode', 'text', 'content', 'items'].includes(key)) {
        continue;
      }
      args[key] = value;
    }
    return args;
  }

  private buildGenericToolLikeResult(item: AppServerItem): string {
    if (item.error?.message) return item.error.message;
    const aggregatedOutput = item.aggregated_output ?? item.aggregatedOutput;
    if (typeof aggregatedOutput === 'string' && aggregatedOutput) return aggregatedOutput;

    const directResult = this.extractToolResult(item).resultText;
    if (directResult) return directResult;

    const record = item as Record<string, unknown>;
    const summary: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(record)) {
      if (value === undefined) continue;
      if (['id', 'type', 'status', 'text', 'content', 'items'].includes(key)) continue;
      summary[key] = value;
    }
    return Object.keys(summary).length === 0 ? '' : JSON.stringify(summary);
  }

  private buildCollabAgentToolArguments(item: AppServerItem): Record<string, unknown> {
    const args: Record<string, unknown> = {};
    if (item.senderThreadId) args.senderThreadId = item.senderThreadId;
    if (Array.isArray(item.receiverThreadIds) && item.receiverThreadIds.length > 0) {
      args.receiverThreadIds = item.receiverThreadIds;
    }
    if (item.prompt) args.prompt = item.prompt;
    if (item.model) args.model = item.model;
    if (item.reasoningEffort) args.reasoningEffort = item.reasoningEffort;
    if (item.agentsStates && Object.keys(item.agentsStates).length > 0) {
      args.agentsStates = item.agentsStates;
    }
    return args;
  }

  private buildCollabAgentToolResult(item: AppServerItem): string {
    const parts: string[] = [];

    if (Array.isArray(item.receiverThreadIds) && item.receiverThreadIds.length > 0) {
      parts.push(`receiver_thread_ids: ${item.receiverThreadIds.join(', ')}`);
    }
    if (item.model) {
      parts.push(`model: ${item.model}`);
    }
    if (item.reasoningEffort) {
      parts.push(`reasoning_effort: ${item.reasoningEffort}`);
    }
    if (item.agentsStates && Object.keys(item.agentsStates).length > 0) {
      parts.push(`agents: ${JSON.stringify(item.agentsStates)}`);
    }

    return parts.join('\n');
  }

  private buildSpawnAgentResultSummary(item: AppServerItem): string {
    const parts: string[] = [];
    if (Array.isArray(item.receiverThreadIds) && item.receiverThreadIds.length > 0) {
      parts.push(`receiver_thread_ids: ${item.receiverThreadIds.join(', ')}`);
    } else {
      parts.push('receiver_thread_ids: none');
    }
    if (item.model) {
      parts.push(`model: ${item.model}`);
    }
    if (item.reasoningEffort) {
      parts.push(`reasoning_effort: ${item.reasoningEffort}`);
    }
    return parts.join('\n');
  }
}
