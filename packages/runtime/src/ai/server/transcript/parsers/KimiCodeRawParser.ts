/**
 * KimiCodeRawParser -- parses Kimi Code ACP raw messages into canonical
 * event descriptors.
 *
 * Kimi Code implements the standard ACP schema (@agentclientprotocol/sdk),
 * so session/update notifications carry the spec field names:
 *   {"jsonrpc":"2.0","method":"session/update","params":{
 *     "sessionId":"...","update":{"sessionUpdate":"agent_message_chunk",
 *       "content":{"type":"text","text":"Hello"}}}}
 *   tool calls: {"sessionUpdate":"tool_call","toolCallId":"...","title":"...",
 *     "kind":"read","status":"pending","rawInput":{...}}
 *   updates:    {"sessionUpdate":"tool_call_update","toolCallId":"...",
 *     "status":"completed","rawOutput":...}
 *
 * This parser handles:
 * - Input messages (user prompts, same format as other providers)
 * - agent_message_chunk / agent_thought_chunk updates
 * - tool_call / tool_call_update updates
 * - Kimi assistant response messages (stored as item.completed, same
 *   Codex-compatible envelope the Copilot provider uses)
 */

import type { RawMessage } from '../TranscriptTransformer';
import type {
  IRawMessageParser,
  ParseContext,
  CanonicalEventDescriptor,
} from './IRawMessageParser';

export class KimiCodeRawParser implements IRawMessageParser {
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

    // Codex-compatible item.completed envelope stored by the provider after a
    // turn completes (reliable transcript rendering without chunk reassembly)
    if (parsed.type === 'item.completed' && parsed.item) {
      return this.parseItemCompleted(parsed.item as Record<string, unknown>, msg);
    }

    // ACP session/update notifications
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
      case 'agent_message_chunk':
        // Don't emit per-chunk -- the item.completed message has the full text
        return [];

      case 'agent_thought_chunk':
        // Reasoning is not rendered in transcript
        return [];

      case 'tool_call': {
        const name = typeof update.title === 'string' ? update.title : 'unknown';
        const id = typeof update.toolCallId === 'string' ? update.toolCallId : undefined;
        const args = (update.rawInput ?? undefined) as Record<string, unknown> | undefined;

        return [{
          type: 'tool_call_started',
          toolName: name,
          toolDisplayName: name,
          arguments: args ?? {},
          providerToolCallId: id ?? null,
          createdAt: msg.createdAt,
        }];
      }

      case 'tool_call_update': {
        const id = typeof update.toolCallId === 'string' ? update.toolCallId : undefined;
        const status = update.status as string | undefined;
        if (!id || (status !== 'completed' && status !== 'failed')) return [];

        const output = update.rawOutput ?? this.extractToolContentText(update.content);
        const resultStr = typeof output === 'string' ? output : JSON.stringify(output ?? '');

        return [{
          type: 'tool_call_completed',
          providerToolCallId: id,
          status: status === 'failed' ? 'error' : 'completed',
          result: resultStr,
        }];
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

  private extractToolContentText(content: unknown): string | undefined {
    if (!Array.isArray(content)) return undefined;
    const parts: string[] = [];
    for (const item of content) {
      if (item && typeof item === 'object') {
        const c = (item as Record<string, unknown>).content as Record<string, unknown> | undefined;
        if (c && c.type === 'text' && typeof c.text === 'string') {
          parts.push(c.text);
        }
      }
    }
    return parts.length > 0 ? parts.join('\n') : undefined;
  }

  private isSystemReminder(content: string, metadata?: Record<string, unknown>): boolean {
    return (
      metadata?.promptType === 'system_reminder' ||
      /<SYSTEM_REMINDER>[\s\S]*<\/SYSTEM_REMINDER>/.test(content)
    );
  }
}
