import { describe, it, expect } from 'vitest';
import { slimClaudeCodeChunkForStorage } from '../toolChunkUtils';

describe('slimClaudeCodeChunkForStorage', () => {
  it('drops heavy tool_use_result fields but keeps small scalars and the message', () => {
    const chunk = {
      type: 'user',
      message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't', content: 'The file was updated' }] },
      uuid: 'u1',
      tool_use_result: {
        filePath: '/a/b/File.tsx',
        userModified: false,
        replaceAll: false,
        oldString: 'x'.repeat(5000),
        newString: 'y'.repeat(5000),
        originalFile: 'z'.repeat(20000),
        structuredPatch: Array.from({ length: 100 }, (_, i) => ({ line: i })),
      },
    };

    const slim = slimClaudeCodeChunkForStorage(chunk) as any;

    // Heavy fields gone, small scalars kept.
    expect(slim.tool_use_result).toEqual({
      filePath: '/a/b/File.tsx',
      userModified: false,
      replaceAll: false,
    });
    // Message (the rendered part) untouched.
    expect(slim.message.content[0].content).toBe('The file was updated');
    expect(slim.uuid).toBe('u1');
    // Original input is not mutated.
    expect((chunk.tool_use_result as any).originalFile).toHaveLength(20000);
  });

  it('strips thinking-block signatures but keeps thinking text', () => {
    const chunk = {
      type: 'assistant',
      message: {
        id: 'msg_1',
        content: [
          { type: 'thinking', thinking: 'reasoning', signature: 'A'.repeat(12000) },
          { type: 'text', text: 'answer' },
        ],
      },
    };

    const slim = slimClaudeCodeChunkForStorage(chunk) as any;

    expect(slim.message.content[0]).toEqual({ type: 'thinking', thinking: 'reasoning' });
    expect(slim.message.content[1]).toEqual({ type: 'text', text: 'answer' });
    // Original untouched.
    expect((chunk.message.content[0] as any).signature).toHaveLength(12000);
  });

  it('returns the chunk unchanged when there is nothing to trim', () => {
    const chunk = { type: 'assistant', message: { content: [{ type: 'text', text: 'hi' }] }, uuid: 'u' };
    expect(slimClaudeCodeChunkForStorage(chunk)).toBe(chunk);
  });

  it('passes through string chunks and non-objects', () => {
    expect(slimClaudeCodeChunkForStorage('plain')).toBe('plain');
    expect(slimClaudeCodeChunkForStorage(null)).toBe(null);
  });
});
