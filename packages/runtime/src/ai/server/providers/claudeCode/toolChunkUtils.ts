// Claude Agent SDK emits several chunk types that are pure runtime side-channels:
// the live in-memory dispatch loop reacts to them (status text, auth detection,
// rate-limit metadata, tool progress), but the persistent reparse path
// (ClaudeCodeRawParser used by TranscriptTransformer) ignores them entirely.
// Persisting them just inflates ai_agent_messages and SessionRoom storage with
// rows that never produce a canonical transcript event.
//
// Kept persisted on purpose:
//   - system/init           -- carries session_id + tool/MCP context useful for forensics
//   - system/compact_boundary -- marks where the SDK compacted the conversation
//   - summary               -- carries auth-error text the parser may surface later
const CLAUDE_CODE_TRANSIENT_SYSTEM_SUBTYPES = new Set([
  'hook_started',
  'hook_response',
  'task_started',
  'task_progress',
  'task_notification',
]);

const CLAUDE_CODE_TRANSIENT_CHUNK_TYPES = new Set([
  'tool_progress',
  'tool_use_summary',
  'auth_status',
  'rate_limit_event',
]);

export function isTransientClaudeCodeChunk(chunk: unknown): boolean {
  if (!chunk || typeof chunk !== 'object') return false;
  const c = chunk as { type?: string; subtype?: string };
  if (c.type === 'system' && typeof c.subtype === 'string') {
    return CLAUDE_CODE_TRANSIENT_SYSTEM_SUBTYPES.has(c.subtype);
  }
  return typeof c.type === 'string' && CLAUDE_CODE_TRANSIENT_CHUNK_TYPES.has(c.type);
}

export function isSearchableAssistantChunk(chunk: any): boolean {
  if (typeof chunk !== 'object' || chunk.type !== 'assistant' || !chunk.message?.content) {
    return false;
  }

  const content = chunk.message.content;
  if (!Array.isArray(content)) {
    return false;
  }

  const hasText = content.some((block: any) => block.type === 'text');
  const hasTool = content.some((block: any) => block.type === 'tool_use' || block.type === 'tool_result');
  return hasText && !hasTool;
}

export function buildToolUseMessage(toolId: string, toolName: string, toolArgs: unknown): string {
  return JSON.stringify({
    type: 'assistant',
    message: {
      content: [{
        type: 'tool_use',
        id: toolId,
        name: toolName,
        input: toolArgs,
      }],
    },
  });
}

export function buildToolResultMessage(
  toolUseId: string,
  content: unknown,
  isError: boolean
): string {
  return JSON.stringify({
    type: 'assistant',
    message: {
      content: [{
        type: 'tool_result',
        tool_use_id: toolUseId,
        content,
        is_error: isError,
      }],
    },
  });
}

/**
 * Mutates toolCall in place to keep existing call-site behavior.
 */
export function applyToolResultToToolCall(
  toolCall: any,
  toolResult: unknown,
  isError: boolean
): { isDuplicate: boolean } {
  if (toolCall.result !== undefined) {
    return { isDuplicate: true };
  }

  toolCall.result = toolResult;

  const hasErrorFlag = isError === true;
  const hasErrorContent = typeof toolResult === 'string'
    && (toolResult.includes('<tool_use_error>') || toolResult.startsWith('Error:'));
  if (hasErrorFlag || hasErrorContent) {
    toolCall.isError = true;
  }

  // Preserve Edit diffs for UI red/green rendering.
  if (toolCall.name === 'Edit' && toolCall.arguments && !toolCall.isError) {
    const args = toolCall.arguments as any;
    if (args.old_string !== undefined || args.new_string !== undefined) {
      const resultMessage = typeof toolResult === 'string'
        ? toolResult
        : JSON.stringify(toolResult);
      toolCall.result = {
        message: resultMessage,
        file_path: args.file_path,
        old_string: args.old_string,
        new_string: args.new_string,
      };
    }
  }

  return { isDuplicate: false };
}
