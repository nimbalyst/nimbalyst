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
 * The Claude Code native binary surfaces "Stream closed" as the tool_result
 * content when the SDK's stdin closes mid-tool-call. ClaudeCodeProvider already
 * mitigates one trigger of this (premature stdin close on `type: 'result'`)
 * with the AsyncIterable prompt + grace-period timer. A second trigger remains
 * in `permissionMode: bypass-all`: sustained tool-call traffic queues
 * audit-log writes (ai_agent_messages, ai_tool_call_file_edits) behind PGLite's
 * single-writer lock, the IPC-side timeout fires before the audit write
 * completes, and the same "Stream closed" string surfaces. The bare error
 * leaves operators chasing permission-mode or token issues that aren't there.
 *
 * When the pattern matches, replace the bare text with a diagnostic message
 * pointing at audit-log contention and the tracking issue. The original error
 * is preserved verbatim at the end so nothing is lost. Any non-string, non-
 * matching, or non-error input passes through unchanged.
 *
 * Tracking: see #163 for the full hypothesis + ranked deeper fixes.
 */
export function annotateStreamClosedToolResult(
  toolResult: unknown,
  isError: boolean,
): unknown {
  if (!isError) return toolResult;
  if (typeof toolResult !== 'string') return toolResult;
  if (!toolResult.includes('Stream closed')) return toolResult;
  return (
    'Tool call failed in Nimbalyst.\n' +
    '\n' +
    'The native binary returned "Stream closed". The most common cause in ' +
    'permissionMode: bypass-all is PGLite write-lock contention on the ' +
    'audit-log tables (ai_agent_messages, ai_tool_call_file_edits) under ' +
    'sustained tool-call traffic. Restarting Nimbalyst typically resets ' +
    'the wall for ~2 more calls.\n' +
    '\n' +
    'See nimbalyst/nimbalyst#163 for the full hypothesis and ranked workarounds.\n' +
    '\n' +
    'Original tool_result content:\n' +
    toolResult
  );
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
