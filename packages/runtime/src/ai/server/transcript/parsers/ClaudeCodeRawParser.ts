/**
 * ClaudeCodeRawParser -- parses Claude Code SDK raw messages into
 * canonical event descriptors.
 *
 * Extracted from TranscriptTransformer.transformInputMessage() and
 * transformOutputMessage(). Handles text, assistant, tool_use, tool_result,
 * subagent, nimbalyst_tool_use/result message types.
 *
 * Internal state (processedTextMessageIds) is scoped to the parser instance
 * and resets per batch. Cross-batch state (tool ID maps) is managed by
 * the transformer via ParseContext.
 */

import type { RawMessage } from '../TranscriptTransformer';
import { parseMcpToolName } from '../utils';
import type {
  IRawMessageParser,
  ParseContext,
  CanonicalEventDescriptor,
} from './IRawMessageParser';

// Tool names that represent sub-agent spawns
const SUBAGENT_TOOLS = new Set(['Task', 'Agent']);

export class ClaudeCodeRawParser implements IRawMessageParser {
  /**
   * Track API message IDs that have had text content processed.
   * Prevents duplicate text from streaming + accumulated echo chunks.
   * Scoped to this parser instance (one per batch).
   */
  private processedTextMessageIds = new Set<string>();

  /**
   * When true, result chunk text is always suppressed.
   * Set by the transformer when this parser handles a resume batch
   * (afterId > 0), because prior batches may have already produced
   * assistant_message events from assistant chunks. The result chunk
   * echoes the same text and would create duplicates.
   */
  private suppressResultChunkText = false;

  setSuppressResultChunkText(suppress: boolean): void {
    this.suppressResultChunkText = suppress;
  }

  async parseMessage(
    msg: RawMessage,
    context: ParseContext,
  ): Promise<CanonicalEventDescriptor[]> {
    if (msg.hidden) return [];

    if (msg.direction === 'input') {
      return this.parseInputMessage(msg, context);
    } else if (msg.direction === 'output') {
      return this.parseOutputMessage(msg, context);
    }

    return [];
  }

  // ---------------------------------------------------------------------------
  // Input message parsing
  // ---------------------------------------------------------------------------

  private async parseInputMessage(
    msg: RawMessage,
    context: ParseContext,
  ): Promise<CanonicalEventDescriptor[]> {
    const descriptors: CanonicalEventDescriptor[] = [];

    try {
      const parsed = JSON.parse(msg.content);

      if (parsed.prompt) {
        if (parsed.prompt.startsWith('[System:')) {
          descriptors.push({
            type: 'system_message',
            text: parsed.prompt,
            systemType: 'status',
            searchable: false,
            createdAt: msg.createdAt,
          });
        } else if (this.isSystemReminderContent(parsed.prompt, msg.metadata)) {
          descriptors.push({
            type: 'system_message',
            text: parsed.prompt,
            systemType: 'status',
            reminderKind: this.extractReminderKind(msg.metadata),
            createdAt: msg.createdAt,
          });
        } else if (msg.metadata?.promptOrigin === 'wakeup_resume') {
          descriptors.push({
            type: 'system_message',
            text: parsed.prompt,
            systemType: 'status',
            reminderKind: 'wakeup_resume',
            searchable: false,
            createdAt: msg.createdAt,
          });
        } else {
          const mode = (msg.metadata?.mode as 'agent' | 'planning' | 'auto') ?? 'agent';
          descriptors.push({
            type: 'user_message',
            text: parsed.prompt,
            mode,
            attachments: msg.metadata?.attachments as any,
            createdAt: msg.createdAt,
          });
        }
      } else if (parsed.type === 'user' && parsed.message) {
        const content = parsed.message.content;

        if (Array.isArray(content)) {
          for (const block of content) {
            if (block.type === 'tool_result') {
              const result = this.parseToolResult(block, context);
              if (result) descriptors.push(result);
            }
          }
        } else if (typeof content === 'string') {
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
    } catch {
      // Not JSON -- treat as plain text user message
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

      if (parsed.type === 'text' && parsed.content !== undefined) {
        descriptors.push({
          type: 'assistant_message',
          text: String(parsed.content),
          createdAt: msg.createdAt,
        });
      } else if (parsed.type === 'assistant' && parsed.message) {
        // Skip synthetic assistant messages that echo an error (model: "<synthetic>",
        // top-level error field). The real error arrives as a separate type: "error"
        // message, so processing both creates duplicate widgets.
        if (parsed.error) {
          return descriptors;
        }
        const parentToolUseId: string | undefined = parsed.parent_tool_use_id;
        const messageId: string | undefined = parsed.message.id;
        // Per-turn model id (Claude Code 2.1.x). Threaded into every
        // descriptor we emit for this turn so the renderer can label each
        // assistant chunk with the model that produced it.
        const turnModel: string | undefined =
          typeof parsed.message.model === 'string' ? parsed.message.model : undefined;

        if (Array.isArray(parsed.message.content)) {
          for (const block of parsed.message.content) {
            if (block.type === 'text' && block.text) {
              // Deduplicate text:
              // 1. If we've seen this message ID before, skip (repeated streaming chunk)
              // 2. If no message ID AND we've already processed text, skip (accumulated echo)
              if (messageId && this.processedTextMessageIds.has(messageId)) {
                continue;
              }
              if (!messageId && this.processedTextMessageIds.size > 0) {
                continue;
              }
              if (messageId) this.processedTextMessageIds.add(messageId);
              descriptors.push({
                type: 'assistant_message',
                text: block.text,
                createdAt: msg.createdAt,
                ...(turnModel ? { model: turnModel } : {}),
              });
            } else if (block.type === 'thinking' && (block.thinking || block.text)) {
              // Extended-thinking output. Persist as an assistant_message
              // with empty text and the thinking content on the side-channel
              // so we don't have to migrate the event_type CHECK constraint.
              const thinkingText: string =
                typeof block.thinking === 'string'
                  ? block.thinking
                  : typeof block.text === 'string'
                    ? block.text
                    : '';
              if (!thinkingText) continue;
              const thinkingSignature: string | undefined =
                typeof block.signature === 'string' ? block.signature : undefined;
              descriptors.push({
                type: 'assistant_message',
                text: '',
                thinking: thinkingText,
                ...(thinkingSignature ? { thinkingSignature } : {}),
                ...(turnModel ? { model: turnModel } : {}),
                createdAt: msg.createdAt,
              });
            } else if (block.type === 'tool_use') {
              const toolDescriptors = await this.parseToolUse(
                msg,
                block,
                context,
                parentToolUseId,
              );
              descriptors.push(...toolDescriptors);
            } else if (block.type === 'tool_result') {
              const result = this.parseToolResult(block, context);
              if (result) descriptors.push(result);
            }
          }
        }
      } else if (parsed.type === 'attachment' && parsed.attachment) {
        // Mid-session context delta (deferred_tools_delta, mcp_instructions_delta,
        // skill_listing). Render as a status system_message with a deterministic
        // summary so the transcript faithfully shows when context changed.
        const summary = summariseAttachment(parsed.attachment);
        if (summary) {
          descriptors.push({
            type: 'system_message',
            text: summary,
            systemType: 'status',
            searchable: false,
            createdAt: msg.createdAt,
          });
        }
      } else if (parsed.type === 'system' && parsed.subtype === 'permission_denied') {
        // SDK auto-denied a tool call WITHOUT showing an interactive prompt.
        // Sources: SDK deny rule, `dontAsk` mode, headless-agent auto-deny,
        // or (rarely) the auto-mode classifier on something it is confident
        // should be blocked. Note: the common auto-mode path for destructive
        // tools is escalation to the normal permission prompt via
        // can_use_tool, NOT this deny short-circuit -- those still surface as
        // an interactive_prompt event, not here. We render this so the user
        // sees why a tool was blocked instead of only an is_error tool_result.
        // See @anthropic-ai/claude-agent-sdk
        // SDKPermissionDeniedMessage.
        const deniedToolName: string =
          typeof parsed.tool_name === 'string' ? parsed.tool_name : 'unknown';
        const deniedReason: string | undefined =
          typeof parsed.decision_reason === 'string' ? parsed.decision_reason : undefined;
        const deniedReasonType: string | undefined =
          typeof parsed.decision_reason_type === 'string' ? parsed.decision_reason_type : undefined;
        const deniedInput: Record<string, unknown> | undefined =
          parsed.tool_input && typeof parsed.tool_input === 'object'
            ? (parsed.tool_input as Record<string, unknown>)
            : undefined;
        const messageText: string =
          typeof parsed.message === 'string'
            ? parsed.message
            : deniedReason
              ? `${deniedToolName} was denied: ${deniedReason}`
              : `${deniedToolName} was denied`;
        descriptors.push({
          type: 'system_message',
          text: messageText,
          systemType: 'permission_denied',
          deniedToolName,
          ...(deniedReason ? { deniedReason } : {}),
          ...(deniedReasonType ? { deniedReasonType } : {}),
          ...(deniedInput ? { deniedInput } : {}),
          createdAt: msg.createdAt,
        });
      } else if (parsed.type === 'error' && parsed.error) {
        const errorContent =
          typeof parsed.error === 'string' ? parsed.error : JSON.stringify(parsed.error);
        const isAuthError =
          parsed.is_auth_error === true || msg.metadata?.isAuthError === true;
        descriptors.push({
          type: 'system_message',
          text: errorContent,
          systemType: 'error',
          createdAt: msg.createdAt,
          ...(isAuthError ? { isAuthError: true } : {}),
        });
      } else if (
        parsed.type === 'result'
        && typeof parsed.result === 'string'
        && parsed.result.trim().length > 0
        && (
          parsed.num_turns === 0
          || (this.processedTextMessageIds.size === 0 && !this.suppressResultChunkText)
        )
      ) {
        // Slash command turns (e.g. unknown /foo) can produce ONLY a result chunk
        // with the final text. For regular assistant turns the result chunk
        // duplicates text already emitted via `type: 'assistant'` messages, so
        // only backfill when no assistant text was seen IN THIS BATCH and no
        // prior batch produced assistant text (suppressResultChunkText).
        //
        // Why num_turns===0 short-circuits both gates: a turn with num_turns===0
        // means the SDK ran ZERO assistant turns this invocation -- the result
        // chunk is the entire output of the turn (e.g. "Unknown command: /foo")
        // and cannot duplicate text from anywhere. The processedTextMessageIds
        // check is too coarse here: in a full-session reparse it accumulates
        // across earlier turns, so by the time we reach a later turn's result
        // chunk it's already non-empty. Likewise, suppressResultChunkText is
        // set globally for resume batches. Without the num_turns===0 carve-out,
        // unknown-slash-command turns render as a completely blank turn,
        // hiding the failure.
        descriptors.push({
          type: 'assistant_message',
          text: parsed.result,
          createdAt: msg.createdAt,
        });
      } else if (parsed.type === 'nimbalyst_tool_use') {
        const nimbalystDescriptors = await this.parseNimbalystToolUse(msg, parsed, context);
        descriptors.push(...nimbalystDescriptors);
      } else if (parsed.type === 'nimbalyst_tool_result') {
        const result = this.parseToolResult({
          tool_use_id: parsed.tool_use_id || parsed.id,
          content: parsed.result,
          is_error: parsed.is_error,
        }, context);
        if (result) descriptors.push(result);
      } else if (parsed.type === 'user' && parsed.message) {
        if (Array.isArray(parsed.message.content)) {
          for (const block of parsed.message.content) {
            if (block.type === 'tool_result') {
              const result = this.parseToolResult(block, context);
              if (result) descriptors.push(result);
            }
          }
        } else if (typeof parsed.message.content === 'string' && parsed.message.content.trim()) {
          descriptors.push({
            type: 'system_message',
            text: parsed.message.content,
            systemType: 'status',
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
  // Tool handling helpers
  // ---------------------------------------------------------------------------

  private async parseToolUse(
    msg: RawMessage,
    block: any,
    context: ParseContext,
    parentToolUseId?: string,
  ): Promise<CanonicalEventDescriptor[]> {
    const descriptors: CanonicalEventDescriptor[] = [];
    const toolName = block.name ?? 'unknown';
    const toolId: string | undefined = block.id;
    const args = block.input ?? block.arguments ?? {};

    // Detect subagent spawn (Agent/Task tools)
    if (SUBAGENT_TOOLS.has(toolName) && toolId) {
      // Deduplicate
      if (context.hasSubagent(toolId)) return [];

      const prompt = typeof args.prompt === 'string' ? args.prompt : JSON.stringify(args);
      const teammateName = typeof args.name === 'string' ? args.name : null;
      const teamName = typeof args.team_name === 'string' ? args.team_name : null;
      const teammateMode = typeof args.mode === 'string' ? args.mode : null;
      const isBackground = args.run_in_background === true;
      // Claude Code 2.1.x carries the actual agent type on the `subagent_type`
      // arg (e.g. "Explore", "general-purpose"). Fall back to the tool name
      // ("Agent"/"Task") when it's missing for older runs.
      const agentType =
        typeof args.subagent_type === 'string' && args.subagent_type
          ? args.subagent_type
          : toolName;

      descriptors.push({
        type: 'subagent_started',
        subagentId: toolId,
        agentType,
        teammateName,
        teamName,
        teammateMode,
        isBackground,
        prompt,
        createdAt: msg.createdAt,
      });
      return descriptors;
    }

    const isMcpTool = toolName.startsWith('mcp__');
    let mcpServer: string | null = null;
    let mcpTool: string | null = null;

    if (isMcpTool) {
      const parts = toolName.split('__');
      if (parts.length >= 3) {
        mcpServer = parts[1];
        mcpTool = parts.slice(2).join('__');
      }
    }

    // Deduplicate: SDK sends streaming + accumulated chunks with the same tool_use
    if (toolId && context.hasToolCall(toolId)) return [];

    // Cross-batch dedup: a prior batch (or a synthetic nimbalyst_tool_use row
    // written by an MCP handler such as developer_git_commit_proposal) may
    // already have produced a canonical event for this provider tool-call id.
    // Without this check the SDK's later assistant chunk for the same tool_use
    // would create a duplicate. Parity with `parseNimbalystToolUse`.
    if (toolId) {
      const existing = await context.findByProviderToolCallId(toolId);
      if (existing) return [];
    }

    // Resolve parent subagent for nested tool calls
    const resolvedParent = parentToolUseId ?? block.parent_tool_use_id;
    const subagentId = resolvedParent && context.hasSubagent(resolvedParent) ? resolvedParent : undefined;

    descriptors.push({
      type: 'tool_call_started',
      toolName,
      toolDisplayName: toolName,
      arguments: args,
      mcpServer,
      mcpTool,
      providerToolCallId: toolId ?? null,
      subagentId: subagentId ?? null,
      createdAt: msg.createdAt,
    });

    return descriptors;
  }

  private parseToolResult(
    block: any,
    context: ParseContext,
  ): CanonicalEventDescriptor | null {
    const toolUseId = block.tool_use_id || block.id;
    if (!toolUseId) return null;

    // Check if this completes a subagent
    if (context.hasSubagent(toolUseId)) {
      const resultText = typeof block.content === 'string'
        ? block.content
        : JSON.stringify(block.content);
      return {
        type: 'subagent_completed',
        subagentId: toolUseId,
        status: 'completed',
        resultSummary: resultText?.substring(0, 500),
      };
    }

    let resultText = '';
    if (typeof block.content === 'string') {
      resultText = block.content;
    } else if (Array.isArray(block.content)) {
      const hasNonText = block.content.some((inner: any) => inner.type !== 'text');
      if (hasNonText) {
        resultText = JSON.stringify(block.content);
      } else {
        for (const inner of block.content) {
          if (inner.type === 'text' && inner.text) {
            resultText += inner.text;
          }
        }
      }
    } else if (block.content != null) {
      resultText = JSON.stringify(block.content);
    }

    return {
      type: 'tool_call_completed',
      providerToolCallId: toolUseId,
      status: block.is_error ? 'error' : 'completed',
      result: resultText,
      isError: block.is_error ?? false,
    };
  }

  private async parseNimbalystToolUse(
    msg: RawMessage,
    parsed: any,
    context: ParseContext,
  ): Promise<CanonicalEventDescriptor[]> {
    // Deduplicate: the assistant message may already contain a tool_use block
    // with the same ID that was processed before this nimbalyst_tool_use message.
    // Check in-memory map first, then fall back to DB lookup (covers the case
    // where the assistant tool_use was processed in a prior incremental batch).
    if (parsed.id) {
      if (context.hasToolCall(parsed.id)) return [];
      const existing = await context.findByProviderToolCallId(parsed.id);
      if (existing) return [];
    }

    const toolName = parsed.name ?? 'unknown';
    const args = parsed.input ?? {};

    return [{
      type: 'tool_call_started',
      toolName,
      toolDisplayName: toolName,
      arguments: args,
      providerToolCallId: parsed.id ?? null,
      createdAt: msg.createdAt,
    }];
  }

  // ---------------------------------------------------------------------------
  // Helpers
  // ---------------------------------------------------------------------------

  private isSystemReminderContent(
    content: string,
    metadata?: Record<string, unknown>,
  ): boolean {
    return (
      metadata?.promptType === 'system_reminder' ||
      /<SYSTEM_REMINDER>[\s\S]*<\/SYSTEM_REMINDER>/.test(content)
    );
  }

  private extractReminderKind(metadata?: Record<string, unknown>): string | undefined {
    const kind = metadata?.reminderKind;
    return typeof kind === 'string' ? kind : undefined;
  }
}

/**
 * Render a Claude Code 2.1.x `attachment` payload as a one-line status
 * message. Each attachment subtype has a deterministic summary so the
 * transcript can be diffed reliably across imports.
 */
function summariseAttachment(attachment: any): string | null {
  if (!attachment || typeof attachment !== 'object') return null;
  switch (attachment.type) {
    case 'deferred_tools_delta': {
      const added = Array.isArray(attachment.addedNames) ? attachment.addedNames : [];
      const removed = Array.isArray(attachment.removedNames) ? attachment.removedNames : [];
      const parts: string[] = [];
      if (added.length) parts.push(`Tools added: ${added.join(', ')}`);
      if (removed.length) parts.push(`Tools removed: ${removed.join(', ')}`);
      return parts.length ? parts.join(' · ') : null;
    }
    case 'mcp_instructions_delta': {
      const added = Array.isArray(attachment.addedNames) ? attachment.addedNames : [];
      return added.length ? `MCP instructions added: ${added.join(', ')}` : null;
    }
    case 'skill_listing':
      return 'Skills list refreshed';
    default:
      return null;
  }
}
