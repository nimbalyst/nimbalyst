/**
 * CopilotRawParser -- parses GitHub Copilot ACP raw messages into
 * canonical event descriptors.
 *
 * ACP session/update notifications are stored as raw JSON-RPC messages:
 *   {"jsonrpc":"2.0","method":"session/update","params":{
 *     "update":{"sessionUpdate":"agent_message_chunk",
 *       "content":{"type":"text","text":"Hello"}}}}
 *
 * This parser handles:
 * - Input messages (user prompts, same format as other providers)
 * - agent_message_chunk updates (text, thinking)
 * - tool_call / tool_result updates
 * - error updates
 * - Copilot assistant response messages (stored as item.completed)
 */

import type { RawMessage } from '../TranscriptTransformer';
import type {
  IRawMessageParser,
  ParseContext,
  CanonicalEventDescriptor,
} from './IRawMessageParser';

export class CopilotRawParser implements IRawMessageParser {
  private accumulatedText = '';

  async parseMessage(
    msg: RawMessage,
    _context: ParseContext,
  ): Promise<CanonicalEventDescriptor[]> {
    if (msg.hidden) return [];

    if (msg.direction === 'input') {
      return this.parseInputMessage(msg);
    }

    return this.parseOutputMessage(msg);
  }

  private parseInputMessage(msg: RawMessage): CanonicalEventDescriptor[] {
    const content = String(msg.content ?? '').trim();
    if (!content) return [];

    if (this.isSystemReminder(content, msg.metadata)) {
      return [{
        type: 'system_message',
        text: content,
        systemType: 'status',
        createdAt: msg.createdAt,
      }];
    }

    return [{
      type: 'user_message',
      text: content,
      mode: (msg.metadata?.mode as 'agent' | 'planning') ?? 'agent',
      createdAt: msg.createdAt,
    }];
  }

  private parseOutputMessage(msg: RawMessage): CanonicalEventDescriptor[] {
    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(msg.content);
    } catch {
      // Plain text output = assistant response
      const text = String(msg.content ?? '').trim();
      if (text) {
        return [{ type: 'assistant_message', text, createdAt: msg.createdAt }];
      }
      return [];
    }

    // Handle Codex-compatible item.completed format (stored by the provider
    // after a turn completes for reliable transcript rendering)
    if (parsed.type === 'item.completed' && parsed.item) {
      return this.parseItemCompleted(parsed.item as Record<string, unknown>, msg);
    }

    // Handle ACP session/update notifications
    if (parsed.method === 'session/update' && parsed.params) {
      const params = parsed.params as Record<string, unknown>;
      const update = params.update as Record<string, unknown> | undefined;
      if (update) {
        return this.parseSessionUpdate(update, msg);
      }
    }

    return [];
  }

  private parseItemCompleted(
    item: Record<string, unknown>,
    msg: RawMessage,
  ): CanonicalEventDescriptor[] {
    if (item.type !== 'message' || item.role !== 'assistant') return [];

    const content = item.content;
    if (!Array.isArray(content)) return [];

    const textParts: string[] = [];
    for (const part of content) {
      if (part && typeof part === 'object' && !Array.isArray(part)) {
        const p = part as Record<string, unknown>;
        if (p.type === 'output_text' && typeof p.text === 'string') {
          textParts.push(p.text);
        }
      }
    }

    const text = textParts.join('');
    if (!text) return [];

    return [{ type: 'assistant_message', text, createdAt: msg.createdAt }];
  }

  private parseSessionUpdate(
    update: Record<string, unknown>,
    msg: RawMessage,
  ): CanonicalEventDescriptor[] {
    const updateType = update.sessionUpdate as string | undefined;
    const content = update.content as Record<string, unknown> | undefined;

    switch (updateType) {
      case 'agent_message_chunk': {
        if (!content) return [];
        const contentType = content.type as string | undefined;

        if (contentType === 'text' && typeof content.text === 'string') {
          this.accumulatedText += content.text;
          // Don't emit per-chunk -- the item.completed message has the full text
          return [];
        }

        if (contentType === 'thinking' || contentType === 'reasoning') {
          // Reasoning is not rendered in transcript
          return [];
        }

        return [];
      }

      case 'tool_call':
      case 'tool_use': {
        const name = (typeof update.name === 'string' ? update.name :
                      typeof content?.name === 'string' ? content.name : 'unknown');
        const id = (typeof update.id === 'string' ? update.id :
                    typeof content?.id === 'string' ? content.id : undefined);
        const args = (update.arguments ?? update.input ?? content?.arguments ?? content?.input) as Record<string, unknown> | undefined;

        return [{
          type: 'tool_call_started',
          toolName: name,
          toolDisplayName: name,
          arguments: args ?? {},
          providerToolCallId: id ?? null,
          createdAt: msg.createdAt,
        }];
      }

      case 'tool_result': {
        const id = (typeof update.id === 'string' ? update.id :
                    typeof content?.id === 'string' ? content.id : undefined);
        const output = update.output ?? content?.output;
        const resultStr = typeof output === 'string' ? output : JSON.stringify(output ?? '');

        if (id) {
          return [{
            type: 'tool_call_completed',
            providerToolCallId: id,
            status: 'completed',
            result: resultStr,
          }];
        }
        return [];
      }

      case 'error': {
        const errorMsg = typeof update.message === 'string' ? update.message :
                         typeof content?.message === 'string' ? content.message : 'Unknown error';
        return [{
          type: 'system_message',
          text: errorMsg,
          systemType: 'error',
          createdAt: msg.createdAt,
        }];
      }

      default:
        return [];
    }
  }

  private isSystemReminder(content: string, metadata?: Record<string, unknown>): boolean {
    return (
      metadata?.promptType === 'system_reminder' ||
      /<SYSTEM_REMINDER>[\s\S]*<\/SYSTEM_REMINDER>/.test(content)
    );
  }
}
