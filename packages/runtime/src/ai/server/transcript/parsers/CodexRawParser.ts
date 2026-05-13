/**
 * CodexRawParser -- parses OpenAI Codex / OpenCode raw messages into
 * canonical event descriptors.
 *
 * Extracted from TranscriptTransformer.transformCodexOutputMessage().
 * Handles Codex SDK event formats including todo_list, tool calls,
 * text, errors, usage, and reasoning.
 *
 * Also used for OpenCode since both providers share the same
 * AgentProtocol event format for raw messages.
 */

import type { RawMessage } from '../TranscriptTransformer';
import { parseCodexEvent, type ParsedCodexToolCall } from '../../providers/codex/codexEventParser';
import { parseMcpToolName } from '../utils';
import { buildCodexToolLookupId } from '../../toolLookupIds';
import type {
  IRawMessageParser,
  ParseContext,
  CanonicalEventDescriptor,
} from './IRawMessageParser';

export class CodexRawParser implements IRawMessageParser {
  private toolIdCounter = 0;
  /**
   * Maps the raw Codex item id (e.g. `item_0`) to the synthetic edit-group ID
   * minted for the currently in-flight tool call. Cleared on completion so a
   * later turn that reuses the same item id mints a fresh synthetic ID.
   *
   * In-batch only -- cross-batch correlation goes through
   * ParseContext.findActiveToolCallByRawProviderId.
   */
  private inFlightSyntheticIds: Map<string, string> = new Map();

  async parseMessage(
    msg: RawMessage,
    context: ParseContext,
  ): Promise<CanonicalEventDescriptor[]> {
    if (msg.hidden) return [];

    // Codex parser only handles output messages.
    // Input messages (user prompts) use the same format as Claude Code
    // and are handled by the ClaudeCodeRawParser for input direction.
    if (msg.direction === 'input') {
      return this.parseInputMessage(msg);
    }

    return this.parseOutputMessage(msg, context);
  }

  // ---------------------------------------------------------------------------
  // Input message parsing (simple user prompts)
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
  // Output message parsing
  // ---------------------------------------------------------------------------

  private async parseOutputMessage(
    msg: RawMessage,
    context: ParseContext,
  ): Promise<CanonicalEventDescriptor[]> {
    const descriptors: CanonicalEventDescriptor[] = [];

    try {
      const parsed = JSON.parse(msg.content);

      // Handle todo_list items directly from raw JSON (not in ParsedCodexEvent)
      const item = parsed.item;
      if (item && typeof item === 'object' && !Array.isArray(item)) {
        const itemRecord = item as Record<string, unknown>;
        if (itemRecord.type === 'todo_list' && Array.isArray(itemRecord.items)) {
          const todoItems = (itemRecord.items as Array<Record<string, unknown>>)
            .filter((t): t is Record<string, unknown> => t != null && typeof t === 'object')
            .map(t => ({
              text: typeof t.text === 'string' ? t.text : String(t.text ?? ''),
              completed: !!t.completed,
            }));
          if (todoItems.length > 0) {
            const todoText = todoItems
              .map(t => `- [${t.completed ? 'x' : ' '}] ${t.text}`)
              .join('\n');
            descriptors.push({
              type: 'assistant_message',
              text: todoText,
              createdAt: msg.createdAt,
            });
          }
          return descriptors;
        }
      }

      const codexEvents = parseCodexEvent(parsed);

      if (codexEvents.length === 0) {
        return [];
      }

      for (const ce of codexEvents) {
        if (ce.error) {
          descriptors.push({
            type: 'system_message',
            text: ce.error,
            systemType: 'error',
            createdAt: msg.createdAt,
          });
        }

        if (ce.text) {
          descriptors.push({
            type: 'assistant_message',
            text: ce.text,
            createdAt: msg.createdAt,
          });
        }

        if (ce.toolCall) {
          const toolDescriptors = await this.parseCodexToolCall(msg, ce.toolCall, context);
          descriptors.push(...toolDescriptors);
        }

        if (ce.usage) {
          descriptors.push({
            type: 'turn_ended',
            contextFill: {
              inputTokens: ce.usage.input_tokens,
              cacheReadInputTokens: 0,
              cacheCreationInputTokens: 0,
              outputTokens: ce.usage.output_tokens,
              totalContextTokens: ce.usage.input_tokens,
            },
            contextWindow: ce.contextSnapshot?.contextWindow ?? 0,
            cumulativeUsage: {
              inputTokens: ce.usage.input_tokens,
              outputTokens: ce.usage.output_tokens,
              cacheReadInputTokens: 0,
              cacheCreationInputTokens: 0,
              costUSD: 0,
              webSearchRequests: 0,
            },
            contextCompacted: false,
          });
        }

        if (ce.reasoning) {
          descriptors.push({
            type: 'assistant_message',
            text: '',
            thinking: ce.reasoning,
            createdAt: msg.createdAt,
          });
        }
      }
    } catch {
      // Not JSON -- treat as plain text assistant message
      const content = String(msg.content ?? '');
      if (content.trim()) {
        descriptors.push({
          type: 'assistant_message',
          text: content,
          createdAt: msg.createdAt,
        });
      }
    }

    return descriptors;
  }

  // ---------------------------------------------------------------------------
  // Tool call handling
  // ---------------------------------------------------------------------------

  private async parseCodexToolCall(
    msg: RawMessage,
    tc: ParsedCodexToolCall,
    context: ParseContext,
  ): Promise<CanonicalEventDescriptor[]> {
    const descriptors: CanonicalEventDescriptor[] = [];
    const toolName = tc.name;
    const rawItemId = tc.id ?? `codex-tool-${++this.toolIdCounter}`;
    const editGroupId = await this.resolveEditGroupId(msg, rawItemId, context);
    const args = (tc.arguments ?? {}) as Record<string, unknown>;
    const hasResult = tc.result !== undefined && tc.result !== null;

    const isMcpTool = toolName.startsWith('mcp__');
    let mcpServer: string | null = null;
    let mcpTool: string | null = null;
    if (isMcpTool) {
      const parsed = parseMcpToolName(toolName);
      if (parsed) {
        mcpServer = parsed.server;
        mcpTool = parsed.tool;
      }
    }

    // Determine target file path
    let targetFilePath: string | null = null;
    if (typeof args.file_path === 'string') targetFilePath = args.file_path;
    else if (typeof args.path === 'string') targetFilePath = args.path;

    // Always emit tool_call_started. processDescriptor is responsible for
    // deduping against an existing tool call with the same id AND the same
    // toolName -- not on id alone. Codex resets per-turn item ids, so the
    // same id ('item_1') routinely refers to a different tool in a later
    // turn. Short-circuiting on hasToolCall(id) here would silently drop
    // those later-turn tool calls when reprocessing the full session
    // (the path mobile clients use).
    descriptors.push({
      type: 'tool_call_started',
      toolName,
      toolDisplayName: this.codexToolDisplayName(toolName),
      arguments: args,
      targetFilePath,
      mcpServer,
      mcpTool,
      providerToolCallId: editGroupId,
      createdAt: msg.createdAt,
    });

    // If tool call already has a result, complete immediately
    if (hasResult) {
      const { resultText, isError } = this.extractCodexToolResult(tc.result);
      descriptors.push({
        type: 'tool_call_completed',
        providerToolCallId: editGroupId,
        status: isError ? 'error' : 'completed',
        result: resultText,
        isError,
      });
      // The tool call is now terminal; allow a future reuse of the same raw
      // item id (e.g. `item_0` in a later turn) to mint a fresh edit-group ID.
      this.inFlightSyntheticIds.delete(rawItemId);
    }

    return descriptors;
  }

  /**
   * Resolve (or mint) the synthetic edit-group ID for a Codex raw item id.
   *
   * Order of preference:
   *   1. `editGroupId` already stamped onto the raw message metadata by the
   *      provider streaming layer. This is the durable canonical source --
   *      both started and completed raw messages carry it, so the parser and
   *      the streaming-time SessionFileTracker call see the same ID.
   *   2. In-batch in-flight map (started+completed in same transformer run).
   *   3. Active canonical event already on disk (cross-batch correlation
   *      where started was written in an earlier batch).
   *   4. Mint a fresh `nimtc|<encoded>|<msg.createdAt>|<msg.id>` ID.
   */
  private async resolveEditGroupId(
    msg: RawMessage,
    rawItemId: string,
    context: ParseContext,
  ): Promise<string> {
    const fromMetadata = msg.metadata?.editGroupId;
    if (typeof fromMetadata === 'string' && fromMetadata.startsWith('nimtc|')) {
      this.inFlightSyntheticIds.set(rawItemId, fromMetadata);
      return fromMetadata;
    }

    const inBatch = this.inFlightSyntheticIds.get(rawItemId);
    if (inBatch) {
      return inBatch;
    }

    try {
      const existing = await context.findActiveToolCallByRawProviderId(rawItemId);
      if (existing && typeof existing.providerToolCallId === 'string' && existing.providerToolCallId) {
        this.inFlightSyntheticIds.set(rawItemId, existing.providerToolCallId);
        return existing.providerToolCallId;
      }
    } catch {
      // Lookup failures fall through to minting a new ID. The worst case is
      // an orphaned in-flight tool call event, which the existing dedup logic
      // already tolerates.
    }

    const minted = buildCodexToolLookupId(
      rawItemId,
      msg.createdAt.getTime(),
      msg.id,
    );
    this.inFlightSyntheticIds.set(rawItemId, minted);
    return minted;
  }

  private extractCodexToolResult(result: unknown): { resultText: string; isError: boolean } {
    let actualResult = result;
    let isError = false;

    if (typeof result === 'object' && result !== null && !Array.isArray(result)) {
      const r = result as Record<string, unknown>;
      if ('success' in r && 'result' in r) {
        actualResult = r.result;
        isError = r.success === false || !!r.error;
      } else {
        isError = 'error' in r;
      }
    }

    // MCP content envelope: { content: [{ type: "text", text: "..." }] }
    if (typeof actualResult === 'object' && actualResult !== null && !Array.isArray(actualResult)) {
      const obj = actualResult as Record<string, unknown>;
      if (Array.isArray(obj.content)) {
        let extracted = '';
        for (const block of obj.content) {
          if (block && typeof block === 'object' && (block as any).type === 'text' && (block as any).text) {
            extracted += (block as any).text;
          }
        }
        if (extracted) {
          actualResult = extracted;
        }
      }
    }

    const resultText = typeof actualResult === 'string'
      ? actualResult
      : actualResult != null ? JSON.stringify(actualResult) : '';

    return { resultText, isError };
  }

  private codexToolDisplayName(toolName: string): string {
    const mcp = parseMcpToolName(toolName);
    if (mcp) return mcp.tool;
    if (toolName === 'file_change') return 'File Change';
    if (toolName.includes('command') || toolName === 'shell') return 'Bash';
    return toolName;
  }
}
