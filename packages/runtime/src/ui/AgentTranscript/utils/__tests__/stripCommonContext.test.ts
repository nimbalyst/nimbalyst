import { describe, it, expect } from 'vitest';
import { stripCommonContext } from '../stripCommonContext';

describe('stripCommonContext', () => {
  it('should handle empty strings', () => {
    const result = stripCommonContext('', '');
    expect(result).toEqual({
      oldText: '',
      newText: '',
      commonPrefix: '',
      commonSuffix: '',
    });
  });

  it('should handle one empty string', () => {
    const result = stripCommonContext('hello', '');
    expect(result).toEqual({
      oldText: 'hello',
      newText: '',
      commonPrefix: '',
      commonSuffix: '',
    });
  });

  it('should preserve full words when they differ - Chat vs Agent', () => {
    const result = stripCommonContext('Chat', 'Agent');
    expect(result.oldText).toBe('Chat');
    expect(result.newText).toBe('Agent');
    expect(result.commonPrefix).toBe('');
    expect(result.commonSuffix).toBe('');
  });

  it('should preserve full words in context - "AI Chat" vs "AI Agent"', () => {
    const result = stripCommonContext('AI Chat', 'AI Agent');
    expect(result.oldText).toBe('Chat');
    expect(result.newText).toBe('Agent');
    expect(result.commonPrefix).toBe('AI ');
    expect(result.commonSuffix).toBe('');
  });

  it('should preserve full words in context - "Chat Panel" vs "Agent Panel"', () => {
    const result = stripCommonContext('Chat Panel', 'Agent Panel');
    expect(result.oldText).toBe('Chat');
    expect(result.newText).toBe('Agent');
    expect(result.commonPrefix).toBe('');
    expect(result.commonSuffix).toBe(' Panel');
  });

  it('should preserve full words with both prefix and suffix', () => {
    const result = stripCommonContext(
      'The AI Chat is here',
      'The AI Agent is here'
    );
    expect(result.oldText).toBe('Chat');
    expect(result.newText).toBe('Agent');
    expect(result.commonPrefix).toBe('The AI ');
    expect(result.commonSuffix).toBe(' is here');
  });

  it('should handle multi-word changes', () => {
    const result = stripCommonContext(
      'Click the button now',
      'Click the new toggle now'
    );
    expect(result.oldText).toBe('button');
    expect(result.newText).toBe('new toggle');
    expect(result.commonPrefix).toBe('Click the ');
    expect(result.commonSuffix).toBe(' now');
  });

  it('should handle identical strings', () => {
    const result = stripCommonContext('Hello World', 'Hello World');
    expect(result.oldText).toBe('');
    expect(result.newText).toBe('');
    expect(result.commonPrefix).toBe('Hello World');
    expect(result.commonSuffix).toBe('');
  });

  it('should handle changes with punctuation', () => {
    const result = stripCommonContext(
      'Hello, world!',
      'Hello, universe!'
    );
    expect(result.oldText).toBe('world');
    expect(result.newText).toBe('universe');
    expect(result.commonPrefix).toBe('Hello, ');
    expect(result.commonSuffix).toBe('!');
  });

  it('should handle changes in the middle of a sentence', () => {
    const result = stripCommonContext(
      'The quick brown fox jumps',
      'The quick red fox jumps'
    );
    expect(result.oldText).toBe('brown');
    expect(result.newText).toBe('red');
    expect(result.commonPrefix).toBe('The quick ');
    expect(result.commonSuffix).toBe(' fox jumps');
  });

  it('should handle hyphenated words', () => {
    const result = stripCommonContext(
      'user-friendly interface',
      'user-hostile interface'
    );
    expect(result.oldText).toBe('friendly');
    expect(result.newText).toBe('hostile');
    expect(result.commonPrefix).toBe('user-');
    expect(result.commonSuffix).toBe(' interface');
  });

  it('should handle changes at the start', () => {
    const result = stripCommonContext(
      'Old value here',
      'New value here'
    );
    expect(result.oldText).toBe('Old');
    expect(result.newText).toBe('New');
    expect(result.commonPrefix).toBe('');
    expect(result.commonSuffix).toBe(' value here');
  });

  it('should handle changes at the end', () => {
    const result = stripCommonContext(
      'Same prefix old',
      'Same prefix new'
    );
    expect(result.oldText).toBe('old');
    expect(result.newText).toBe('new');
    expect(result.commonPrefix).toBe('Same prefix ');
    expect(result.commonSuffix).toBe('');
  });

  it('should handle code-like strings with underscores', () => {
    // Since underscores are NOT word boundaries, the entire identifier is treated as one word
    // This is actually better for showing the full context in code
    const result = stripCommonContext(
      'user_session_token',
      'user_auth_token'
    );
    // The function shows the whole identifier since it's all one "word"
    expect(result.oldText).toBe('user_session_token');
    expect(result.newText).toBe('user_auth_token');
    expect(result.commonPrefix).toBe('');
    expect(result.commonSuffix).toBe('');
  });

  it('should handle strings with newlines', () => {
    const result = stripCommonContext(
      'Line 1\nOld content\nLine 3',
      'Line 1\nNew content\nLine 3'
    );
    expect(result.oldText).toBe('Old');
    expect(result.newText).toBe('New');
    expect(result.commonPrefix).toBe('Line 1\n');
    expect(result.commonSuffix).toBe(' content\nLine 3');
  });
});
