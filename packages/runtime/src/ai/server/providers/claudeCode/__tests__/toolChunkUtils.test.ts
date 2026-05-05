import { describe, it, expect } from 'vitest';
import {
  annotateStreamClosedToolResult,
  applyToolResultToToolCall,
} from '../toolChunkUtils';

describe('annotateStreamClosedToolResult', () => {
  it('rewrites string tool_result containing "Stream closed" when isError=true', () => {
    const annotated = annotateStreamClosedToolResult(
      'Tool permission request failed: Error: Stream closed',
      true,
    );
    expect(typeof annotated).toBe('string');
    expect(annotated).toContain('PGLite write-lock contention');
    expect(annotated).toContain('nimbalyst/nimbalyst#163');
    // Original text is preserved verbatim at the end
    expect(annotated).toContain('Tool permission request failed: Error: Stream closed');
  });

  it('returns input unchanged when isError=false', () => {
    const passthrough = annotateStreamClosedToolResult(
      'echo Stream closed (this is just normal output)',
      false,
    );
    expect(passthrough).toBe('echo Stream closed (this is just normal output)');
  });

  it('returns input unchanged when string does not include "Stream closed"', () => {
    const passthrough = annotateStreamClosedToolResult(
      'Tool call failed: ECONNREFUSED',
      true,
    );
    expect(passthrough).toBe('Tool call failed: ECONNREFUSED');
  });

  it('returns input unchanged when toolResult is not a string', () => {
    const arr = [{ type: 'text', text: 'Stream closed' }];
    expect(annotateStreamClosedToolResult(arr, true)).toBe(arr);
    expect(annotateStreamClosedToolResult(undefined, true)).toBe(undefined);
    expect(annotateStreamClosedToolResult(null, true)).toBe(null);
  });
});

describe('applyToolResultToToolCall integration with annotated content', () => {
  it('writes the annotated string to toolCall.result without duplicating', () => {
    const toolCall: any = { name: 'Bash', arguments: { command: 'sleep 60 && echo done' } };
    const annotated = annotateStreamClosedToolResult('Stream closed', true);

    const { isDuplicate } = applyToolResultToToolCall(toolCall, annotated, true);
    expect(isDuplicate).toBe(false);
    expect(typeof toolCall.result).toBe('string');
    expect(toolCall.result).toContain('audit-log tables');
    expect(toolCall.isError).toBe(true);
  });

  it('does not corrupt Edit-tool result-shape preservation', () => {
    // For Edit tools without an error, the existing logic builds a structured
    // result. annotateStreamClosedToolResult must not interfere on the success
    // path because isError=false short-circuits the helper.
    const toolCall: any = {
      name: 'Edit',
      arguments: { file_path: '/x.txt', old_string: 'a', new_string: 'b' },
    };
    const successText = 'File edited.';
    const passthrough = annotateStreamClosedToolResult(successText, false);
    expect(passthrough).toBe(successText);

    applyToolResultToToolCall(toolCall, passthrough, false);
    expect(toolCall.result).toEqual({
      message: successText,
      file_path: '/x.txt',
      old_string: 'a',
      new_string: 'b',
    });
  });
});
