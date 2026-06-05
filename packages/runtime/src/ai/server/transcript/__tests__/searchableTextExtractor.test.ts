/**
 * Tests for searchableTextExtractor -- verifies that the per-row classifier
 * produces the same searchable text and kind the canonical parsers would
 * have for the equivalent row, so FTS on the raw table preserves search
 * behavior.
 */

import { describe, it, expect } from 'vitest';
import { extractSearchable } from '../searchableTextExtractor';

describe('searchableTextExtractor', () => {
  describe('hidden rows', () => {
    it('always returns meta + null for hidden rows', () => {
      const r = extractSearchable({
        source: 'claude-code',
        direction: 'input',
        content: JSON.stringify({ prompt: 'hi' }),
        hidden: true,
      });
      expect(r).toEqual({ searchableText: null, messageKind: 'meta' });
    });
  });

  describe('claude-code input', () => {
    it('extracts user prompt from { prompt }', () => {
      const r = extractSearchable({
        source: 'claude-code',
        direction: 'input',
        content: JSON.stringify({ prompt: 'Hello world' }),
      });
      expect(r).toEqual({ searchableText: 'Hello world', messageKind: 'user' });
    });

    it('classifies [System: prompts as system with no searchable text', () => {
      const r = extractSearchable({
        source: 'claude-code',
        direction: 'input',
        content: JSON.stringify({ prompt: '[System: status update]' }),
      });
      expect(r).toEqual({ searchableText: null, messageKind: 'system' });
    });

    it('classifies SYSTEM_REMINDER content as system', () => {
      const r = extractSearchable({
        source: 'claude-code',
        direction: 'input',
        content: JSON.stringify({ prompt: '<SYSTEM_REMINDER>do X</SYSTEM_REMINDER>' }),
      });
      expect(r).toEqual({ searchableText: null, messageKind: 'system' });
    });

    it('classifies wakeup_resume prompts as system', () => {
      const r = extractSearchable({
        source: 'claude-code',
        direction: 'input',
        content: JSON.stringify({ prompt: 'continue' }),
        metadata: { promptOrigin: 'wakeup_resume' },
      });
      expect(r).toEqual({ searchableText: null, messageKind: 'system' });
    });

    it('classifies tool_result blocks as tool', () => {
      const r = extractSearchable({
        source: 'claude-code',
        direction: 'input',
        content: JSON.stringify({
          type: 'user',
          message: { content: [{ type: 'tool_result', tool_use_id: 'tu_1', content: 'ok' }] },
        }),
      });
      expect(r).toEqual({ searchableText: null, messageKind: 'tool' });
    });

    it('falls back to user for plain-text input', () => {
      const r = extractSearchable({
        source: 'claude-code',
        direction: 'input',
        content: 'not json',
      });
      expect(r).toEqual({ searchableText: 'not json', messageKind: 'user' });
    });
  });

  describe('claude-code output', () => {
    it('extracts assistant text from { type: "text", content }', () => {
      const r = extractSearchable({
        source: 'claude-code',
        direction: 'output',
        content: JSON.stringify({ type: 'text', content: 'assistant says hi' }),
      });
      expect(r).toEqual({ searchableText: 'assistant says hi', messageKind: 'assistant' });
    });

    it('extracts assistant text from { type: "assistant", message.content[].text }', () => {
      const r = extractSearchable({
        source: 'claude-code',
        direction: 'output',
        content: JSON.stringify({
          type: 'assistant',
          message: { content: [{ type: 'text', text: 'here you go' }] },
        }),
      });
      expect(r).toEqual({ searchableText: 'here you go', messageKind: 'assistant' });
    });

    it('classifies assistant turn with only tool_use as tool', () => {
      const r = extractSearchable({
        source: 'claude-code',
        direction: 'output',
        content: JSON.stringify({
          type: 'assistant',
          message: { content: [{ type: 'tool_use', name: 'Bash', id: 'tu_1', input: {} }] },
        }),
      });
      expect(r).toEqual({ searchableText: null, messageKind: 'tool' });
    });

    it('classifies tool_use_summary as meta', () => {
      const r = extractSearchable({
        source: 'claude-code',
        direction: 'output',
        content: JSON.stringify({ type: 'tool_use_summary', total: 5 }),
      });
      expect(r).toEqual({ searchableText: null, messageKind: 'meta' });
    });

    it('classifies system/init as system', () => {
      const r = extractSearchable({
        source: 'claude-code',
        direction: 'output',
        content: JSON.stringify({ type: 'system', subtype: 'init', session_id: 'x' }),
      });
      expect(r).toEqual({ searchableText: null, messageKind: 'system' });
    });

    it('classifies error chunks as system', () => {
      const r = extractSearchable({
        source: 'claude-code',
        direction: 'output',
        content: JSON.stringify({ type: 'error', error: 'rate limit' }),
      });
      expect(r).toEqual({ searchableText: 'rate limit', messageKind: 'system' });
    });

    it('classifies nimbalyst_tool_use as tool', () => {
      const r = extractSearchable({
        source: 'claude-code',
        direction: 'output',
        content: JSON.stringify({ type: 'nimbalyst_tool_use', name: 'Test', id: 't' }),
      });
      expect(r).toEqual({ searchableText: null, messageKind: 'tool' });
    });
  });

  describe('openai-codex output', () => {
    it('renders todo_list items as searchable assistant text', () => {
      const r = extractSearchable({
        source: 'openai-codex',
        direction: 'output',
        content: JSON.stringify({
          item: { type: 'todo_list', items: [{ text: 'a', completed: false }, { text: 'b', completed: true }] },
        }),
      });
      expect(r.messageKind).toBe('assistant');
      expect(r.searchableText).toContain('- [ ] a');
      expect(r.searchableText).toContain('- [x] b');
    });

    it('extracts agent_message text via msg envelope', () => {
      const r = extractSearchable({
        source: 'openai-codex',
        direction: 'output',
        content: JSON.stringify({ msg: { type: 'agent_message', message: 'final answer' } }),
      });
      expect(r).toEqual({ searchableText: 'final answer', messageKind: 'assistant' });
    });

    it('classifies unrecognized payloads as meta', () => {
      const r = extractSearchable({
        source: 'openai-codex',
        direction: 'output',
        content: JSON.stringify({ msg: { type: 'tool_call_started' } }),
      });
      expect(r).toEqual({ searchableText: null, messageKind: 'meta' });
    });
  });

  describe('generic providers (claude/openai/lmstudio)', () => {
    it('treats output content as assistant text by default', () => {
      const r = extractSearchable({ source: 'claude', direction: 'output', content: 'plain text reply' });
      expect(r).toEqual({ searchableText: 'plain text reply', messageKind: 'assistant' });
    });

    it('treats input content as user prompt by default', () => {
      const r = extractSearchable({ source: 'openai', direction: 'input', content: 'ask me anything' });
      expect(r).toEqual({ searchableText: 'ask me anything', messageKind: 'user' });
    });
  });

  describe('size cap', () => {
    it('truncates extremely long searchable text', () => {
      const big = 'a'.repeat(600_000);
      const r = extractSearchable({
        source: 'claude-code',
        direction: 'output',
        content: JSON.stringify({ type: 'text', content: big }),
      });
      expect(r.messageKind).toBe('assistant');
      expect(r.searchableText?.length).toBe(500_000);
    });
  });
});
