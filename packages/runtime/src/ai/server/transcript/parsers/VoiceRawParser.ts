/**
 * VoiceRawParser -- parses voice-session (`openai-realtime`) raw messages into
 * canonical event descriptors.
 *
 * Voice sessions store three kinds of `ai_agent_messages` rows (all written via
 * the `voice-mode:appendMessage` IPC):
 * - direction 'input', plain text  -> the user's transcribed speech.
 * - direction 'output', plain text -> the voice agent's spoken reply.
 * - direction 'output', `[system] ...` -> diagnostic entries (state changes).
 * - direction 'output', JSON `{ kind: 'voiceToolCall', ... }` -> a function/tool
 *   call the voice agent made (memory lookups, ask_coding_agent, etc.). These
 *   were previously invisible in the transcript; this parser turns them into
 *   real tool_call events so they render with the standard tool widget.
 *
 * Before this parser existed, voice sessions fell through to the default
 * ClaudeCodeRawParser, which only knew how to render plain text -- so tool
 * calls never appeared. Keeping a dedicated parser isolates voice concerns and
 * means no CURRENT_VERSION bump (the change only affects `openai-realtime`).
 */

import type { RawMessage } from '../TranscriptTransformer';
import type {
  IRawMessageParser,
  ParseContext,
  CanonicalEventDescriptor,
} from './IRawMessageParser';

/** Shape persisted for a voice tool call (see voiceModeListeners.writeToolCallEntry). */
interface VoiceToolCallPayload {
  kind: 'voiceToolCall';
  phase: 'started' | 'completed';
  callId: string;
  name: string;
  displayName?: string;
  args?: Record<string, unknown>;
  success?: boolean;
  summary?: string;
}

const SYSTEM_PREFIX = '[system] ';

export class VoiceRawParser implements IRawMessageParser {
  async parseMessage(
    msg: RawMessage,
    _context: ParseContext,
  ): Promise<CanonicalEventDescriptor[]> {
    if (msg.hidden) return [];

    if (msg.direction === 'input') {
      const text = String(msg.content ?? '').trim();
      if (!text) return [];
      return [{ type: 'user_message', text, createdAt: msg.createdAt }];
    }

    return this.parseOutputMessage(msg);
  }

  private parseOutputMessage(msg: RawMessage): CanonicalEventDescriptor[] {
    const raw = String(msg.content ?? '');

    // Diagnostic/system entries are written as "[system] <message>".
    if (raw.startsWith(SYSTEM_PREFIX)) {
      return [{
        type: 'system_message',
        text: raw.slice(SYSTEM_PREFIX.length),
        systemType: 'status',
        createdAt: msg.createdAt,
      }];
    }

    // Tool calls are persisted as JSON. Anything else is spoken assistant text.
    const toolCall = this.tryParseToolCall(raw);
    if (toolCall) {
      return this.toolCallDescriptors(toolCall, msg);
    }

    const text = raw.trim();
    if (!text) return [];
    return [{ type: 'assistant_message', text, createdAt: msg.createdAt }];
  }

  private tryParseToolCall(raw: string): VoiceToolCallPayload | null {
    if (!raw.startsWith('{')) return null;
    try {
      const parsed = JSON.parse(raw) as Record<string, unknown>;
      if (parsed && parsed.kind === 'voiceToolCall' && typeof parsed.callId === 'string') {
        return parsed as unknown as VoiceToolCallPayload;
      }
    } catch {
      // Not JSON -- fall through to assistant text.
    }
    return null;
  }

  private toolCallDescriptors(
    call: VoiceToolCallPayload,
    msg: RawMessage,
  ): CanonicalEventDescriptor[] {
    const displayName = call.displayName || call.name;
    if (call.phase === 'started') {
      return [{
        type: 'tool_call_started',
        toolName: call.name,
        toolDisplayName: displayName,
        arguments: call.args ?? {},
        providerToolCallId: call.callId,
        createdAt: msg.createdAt,
      }];
    }
    // completed
    return [{
      type: 'tool_call_completed',
      providerToolCallId: call.callId,
      status: call.success === false ? 'error' : 'completed',
      result: call.summary,
      isError: call.success === false,
    }];
  }
}
