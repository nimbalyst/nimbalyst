/**
 * Canonical-event parser for `antigravity-gemini-agent`.
 *
 * Handles both raw shapes that coexist under `antigravity-gemini-agent`:
 *
 * 1. **ACP rows** (current transport via `agy acp` + shared `CodexACPProtocol`):
 *    JSON envelopes `{ type: 'session/update' | 'session/request_permission' | 'session/request_permission_preview', ... }`
 *    and Nimbalyst interactive permission rows (`nimbalyst_tool_use` / `nimbalyst_tool_result`).
 *    Delegated to `CodexACPRawParser({ thoughtAsThinking: true })` so
 *    `agent_thought_chunk` renders as collapsed-by-default thinking.
 *
 * 2. **Legacy Connect-RPC / extension rows** (preserved for historical sessions):
 *    - direction 'input',  metadata.role 'user'      -> plain prompt text
 *    - direction 'output', metadata.role 'assistant' -> plain answer text
 *    - direction 'output', metadata.role 'tool'      -> {"name","args","result"}
 */

import type { RawMessage } from '../TranscriptTransformer';
import type {
  IRawMessageParser,
  ParseContext,
  CanonicalEventDescriptor,
} from './IRawMessageParser';
import { CodexACPRawParser } from './CodexACPRawParser';

/** Tool argument keys that name a file, in the legacy Gemini toolset's spelling. */
const FILE_PATH_KEYS = ['path', 'file_path'] as const;

const ACP_ENVELOPE_TYPES = new Set([
  'session/update',
  'session/request_permission',
  'session/request_permission_preview',
]);

export class GeminiAntigravityRawParser implements IRawMessageParser {
  private readonly acpParser = new CodexACPRawParser({ thoughtAsThinking: true });

  async parseMessage(
    msg: RawMessage,
    context: ParseContext,
  ): Promise<CanonicalEventDescriptor[]> {
    if (msg.hidden) return [];
    return msg.direction === 'input'
      ? this.parseInput(msg)
      : this.parseOutput(msg, context);
  }

  private parseInput(msg: RawMessage): CanonicalEventDescriptor[] {
    const text = String(msg.content ?? '').trim();
    if (!text) return [];

    if (
      msg.metadata?.promptType === 'system_reminder'
      || /<SYSTEM_REMINDER>[\s\S]*<\/SYSTEM_REMINDER>/.test(text)
    ) {
      const reminderKind = typeof msg.metadata?.reminderKind === 'string'
        ? msg.metadata.reminderKind
        : undefined;
      return [{
        type: 'system_message',
        text,
        systemType: 'status',
        reminderKind,
        createdAt: msg.createdAt,
      }];
    }

    return [{
      type: 'user_message',
      text,
      mode: (msg.metadata?.mode as 'agent' | 'planning' | undefined) ?? 'agent',
      ...(msg.metadata?.attachments ? { attachments: msg.metadata.attachments as any } : {}),
      createdAt: msg.createdAt,
    }];
  }

  private async parseOutput(
    msg: RawMessage,
    context: ParseContext,
  ): Promise<CanonicalEventDescriptor[]> {
    if (msg.metadata?.role === 'tool') {
      return this.parseLegacyToolRow(msg);
    }

    // Legacy assistant rows explicitly carry `metadata.role === 'assistant'`
    // and must be kept verbatim even if the prose happens to be valid JSON.
    if (msg.metadata?.role !== 'assistant') {
      const parsed = tryParseObject(msg.content);
      if (parsed && typeof parsed.type === 'string') {
        if (ACP_ENVELOPE_TYPES.has(parsed.type)) {
          return this.acpParser.parseMessage(msg, context);
        }
        if (parsed.type === 'nimbalyst_tool_use') {
          return parseNimbalystToolUse(parsed, msg, context);
        }
        if (parsed.type === 'nimbalyst_tool_result') {
          return parseNimbalystToolResult(parsed);
        }
      }
    }

    const text = String(msg.content ?? '').trim();
    return text ? [{ type: 'assistant_message', text, createdAt: msg.createdAt }] : [];
  }

  private parseLegacyToolRow(msg: RawMessage): CanonicalEventDescriptor[] {
    let row: { name?: unknown; args?: unknown; result?: unknown };
    try {
      row = JSON.parse(msg.content) as typeof row;
    } catch {
      return [];
    }
    const toolName = typeof row.name === 'string' && row.name ? row.name : 'unknown';
    const args = (row.args && typeof row.args === 'object' ? row.args : {}) as Record<string, unknown>;
    const providerToolCallId = typeof msg.metadata?.toolUseId === 'string'
      ? msg.metadata.toolUseId
      : `gemini-tool-${msg.id}`;

    const resultText = typeof row.result === 'string' ? row.result : safeStringify(row.result);
    const isError = looksLikeErrorResult(row.result);

    return [
      {
        type: 'tool_call_started',
        toolName,
        toolDisplayName: toolName,
        arguments: args,
        targetFilePath: readTargetFilePath(args),
        providerToolCallId,
        createdAt: msg.createdAt,
      },
      {
        type: 'tool_call_completed',
        providerToolCallId,
        status: isError ? 'error' : 'completed',
        isError,
        result: resultText,
      },
    ];
  }
}

async function parseNimbalystToolUse(
  record: Record<string, unknown>,
  msg: RawMessage,
  context: ParseContext,
): Promise<CanonicalEventDescriptor[]> {
  const id = typeof record.id === 'string' ? record.id : null;
  if (id) {
    if (context.hasToolCall?.(id)) return [];
    if (context.findByProviderToolCallId && await context.findByProviderToolCallId(id)) return [];
  }

  const args = record.input;
  return [{
    type: 'tool_call_started',
    toolName: typeof record.name === 'string' ? record.name : 'unknown',
    toolDisplayName: typeof record.name === 'string' ? record.name : 'unknown',
    arguments: (args && typeof args === 'object' ? args : {}) as Record<string, unknown>,
    providerToolCallId: id,
    createdAt: msg.createdAt,
  }];
}

function parseNimbalystToolResult(
  record: Record<string, unknown>,
): CanonicalEventDescriptor[] {
  const id = typeof record.tool_use_id === 'string'
    ? record.tool_use_id
    : typeof record.id === 'string' ? record.id : null;
  if (!id) return [];

  const isError = record.is_error === true;
  return [{
    type: 'tool_call_completed',
    providerToolCallId: id,
    status: isError ? 'error' : 'completed',
    isError,
    result: typeof record.result === 'string' ? record.result : safeStringify(record.result),
  }];
}

function tryParseObject(content: string): Record<string, unknown> | null {
  if (!content || content[0] !== '{') return null;
  try {
    const parsed = JSON.parse(content);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

function looksLikeErrorResult(result: unknown): boolean {
  if (typeof result === 'string') return false;
  if (!result || typeof result !== 'object') return false;
  return (result as { isError?: unknown }).isError === true;
}

function readTargetFilePath(args: Record<string, unknown>): string | null {
  for (const key of FILE_PATH_KEYS) {
    const value = args[key];
    if (typeof value === 'string' && value) return value;
  }
  return null;
}

function safeStringify(value: unknown): string {
  if (value === undefined || value === null) return '';
  try {
    return JSON.stringify(value) ?? '';
  } catch {
    return String(value);
  }
}
