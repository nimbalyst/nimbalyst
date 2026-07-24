import { describe, it, expect, beforeEach } from 'vitest';
import { ClaudeCodeTranscriptAdapter, type ParsedItem } from '../../providers/claudeCode/ClaudeCodeTranscriptAdapter';

/**
 * Tests for ClaudeCodeTranscriptAdapter as a pure chunk parser (no bus).
 * Canonical event persistence is now handled by TranscriptTransformer.
 * See ClaudeCodeRawParser.test.ts for canonical event descriptor tests.
 */
describe('ClaudeCodeTranscriptAdapter', () => {
  let adapter: ClaudeCodeTranscriptAdapter;
  const sessionId = 'test-session-1';

  beforeEach(() => {
    adapter = new ClaudeCodeTranscriptAdapter(null, sessionId);
  });

  describe('processChunk: text', () => {
    it('handles string chunks', () => {
      const items = adapter.processChunk('Hello');
      expect(items).toEqual([{ kind: 'text', text: 'Hello' }]);
    });

    it('handles text object chunks', () => {
      const items = adapter.processChunk({ type: 'text', content: 'some text' });
      expect(items).toEqual([{ kind: 'text', text: 'some text' }]);
    });

    it('handles assistant text blocks', () => {
      const items = adapter.processChunk({
        type: 'assistant',
        message: { id: 'msg-1', content: [{ type: 'text', text: 'Hello' }] },
      });
      expect(items!.find(i => i.kind === 'text')).toEqual({ kind: 'text', text: 'Hello' });
    });

    it('deduplicates by messageId', () => {
      adapter.processChunk({
        type: 'assistant',
        message: { id: 'msg-1', content: [{ type: 'text', text: 'Hello' }] },
      });
      const items2 = adapter.processChunk({
        type: 'assistant',
        message: { id: 'msg-1', content: [{ type: 'text', text: 'Hello' }] },
      });
      expect(items2!.filter(i => i.kind === 'text')).toHaveLength(0);
    });

    it('skips accumulated echo (no messageId after one was seen)', () => {
      adapter.processChunk({
        type: 'assistant',
        message: { id: 'msg-1', content: [{ type: 'text', text: 'Hello' }] },
      });
      const items2 = adapter.processChunk({
        type: 'assistant',
        message: { content: [{ type: 'text', text: 'Hello world' }] },
      });
      expect(items2!.filter(i => i.kind === 'text')).toHaveLength(0);
    });
  });

  describe('processChunk: tool_use', () => {
    it('returns tool_use item', () => {
      const items = adapter.processChunk({
        type: 'assistant',
        message: { content: [{ type: 'tool_use', id: 'tool-1', name: 'Read', input: { file_path: '/foo.ts' } }] },
      });
      const toolItem = items!.find(i => i.kind === 'tool_use') as any;
      expect(toolItem.toolName).toBe('Read');
      expect(toolItem.toolId).toBe('tool-1');
    });

    it('parses MCP tools', () => {
      const items = adapter.processChunk({
        type: 'assistant',
        message: { content: [{ type: 'tool_use', id: 'mcp-1', name: 'mcp__server__tool', input: {} }] },
      });
      const toolItem = items!.find(i => i.kind === 'tool_use') as any;
      expect(toolItem.isMcp).toBe(true);
    });

    it('deduplicates by toolId', () => {
      adapter.processChunk({
        type: 'assistant',
        message: { content: [{ type: 'tool_use', id: 'dup', name: 'Read', input: {} }] },
      });
      const items2 = adapter.processChunk({
        type: 'assistant',
        message: { content: [{ type: 'tool_use', id: 'dup', name: 'Read', input: {} }] },
      });
      expect(items2!.filter(i => i.kind === 'tool_use')).toHaveLength(0);
    });

    it('handles standalone tool_use chunks', () => {
      const items = adapter.processChunk({ type: 'tool_use', id: 's1', name: 'Bash', input: { command: 'ls' } });
      expect(items!.find(i => i.kind === 'tool_use')).toBeDefined();
    });
  });

  describe('processChunk: tool_result', () => {
    it('returns tool_result item', () => {
      adapter.processChunk({
        type: 'assistant',
        message: { content: [{ type: 'tool_use', id: 't1', name: 'Read', input: {} }] },
      });

      const items = adapter.processChunk({
        type: 'assistant',
        message: { content: [{ type: 'tool_result', tool_use_id: 't1', content: 'result data', is_error: false }] },
      });
      expect(items!.find(i => i.kind === 'tool_result')).toBeDefined();
    });

    it('handles user chunk tool results', () => {
      adapter.processChunk({ type: 'tool_use', id: 'u1', name: 'Read', input: {} });

      const items = adapter.processChunk({
        type: 'user',
        message: { content: [{ type: 'tool_result', tool_use_id: 'u1', content: 'data' }] },
      });
      expect(items!.find(i => i.kind === 'tool_result')).toBeDefined();
    });
  });

  describe('processChunk: subagents', () => {
    it('detects Agent as subagent', () => {
      const items = adapter.processChunk({
        type: 'assistant',
        message: { content: [{ type: 'tool_use', id: 'a1', name: 'Agent', input: { prompt: 'search', name: 'searcher', run_in_background: true } }] },
      });
      const toolItem = items!.find(i => i.kind === 'tool_use') as any;
      expect(toolItem.isSubagent).toBe(true);
    });

    it('returns tool_result for subagent completion', () => {
      adapter.processChunk({
        type: 'assistant',
        message: { content: [{ type: 'tool_use', id: 'a2', name: 'Agent', input: { prompt: 'find' } }] },
      });

      const items = adapter.processChunk({
        type: 'user',
        message: { content: [{ type: 'tool_result', tool_use_id: 'a2', content: 'Found 3 files' }] },
      });
      expect(items!.find(i => i.kind === 'tool_result')).toBeDefined();
    });
  });

  describe('processChunk: result', () => {
    it('returns usage from result chunk', () => {
      const items = adapter.processChunk({
        type: 'result',
        usage: { input_tokens: 1000, output_tokens: 500 },
      });
      const usageItem = items!.find(i => i.kind === 'usage') as any;
      expect(usageItem.usage.input_tokens).toBe(1000);
    });

    it('returns error from error result chunk', () => {
      const items = adapter.processChunk({
        type: 'result',
        is_error: true,
        error: { message: 'API error' },
      });
      const errorItem = items!.find(i => i.kind === 'error') as any;
      expect(errorItem.message).toContain('API error');
    });

    it('returns text from slash command result', () => {
      const items = adapter.processChunk({
        type: 'result',
        result: 'command output here',
      });
      expect(items!.find(i => i.kind === 'text')).toEqual({ kind: 'text', text: 'command output here' });
    });
  });

  describe('processChunk: error', () => {
    it('returns error item', () => {
      const items = adapter.processChunk({ type: 'error', error: 'Something broke' });
      expect(items![0]).toEqual({ kind: 'error', message: 'Something broke', chunk: { type: 'error', error: 'Something broke' } });
    });
  });

  describe('processChunk: lifecycle chunks', () => {
    it('returns system_init for system init chunks', () => {
      const items = adapter.processChunk({ type: 'system', subtype: 'init', tools: [] });
      expect(items.some(i => i.kind === 'system_init')).toBe(true);
    });

    it('returns summary for summary chunks', () => {
      const items = adapter.processChunk({ type: 'summary', summary: 'done' });
      expect(items.some(i => i.kind === 'summary')).toBe(true);
    });

    it('returns rate_limit for rate_limit_event', () => {
      const items = adapter.processChunk({ type: 'rate_limit_event' });
      expect(items.some(i => i.kind === 'rate_limit')).toBe(true);
    });
  });

  describe('processChunk: session_id capture', () => {
    it('returns session_id from system init chunk (authoritative source)', () => {
      const items = adapter.processChunk({
        type: 'system',
        subtype: 'init',
        session_id: 'lead-session-abc',
      });
      expect(items!.find(i => i.kind === 'session_id')).toEqual({ kind: 'session_id', id: 'lead-session-abc' });
    });

    it('returns session_id from assistant chunk when not from a sub-agent', () => {
      const items = adapter.processChunk({
        type: 'assistant',
        session_id: 'sdk-session-123',
        message: { content: [] },
      });
      expect(items!.find(i => i.kind === 'session_id')).toEqual({ kind: 'session_id', id: 'sdk-session-123' });
    });

    it('does NOT emit session_id from a sub-agent assistant chunk (parent_tool_use_id set)', () => {
      // NIM-671: When the agent uses Task/Agent to spawn a sub-agent, the SDK
      // relays the sub-agent's assistant chunks with parent_tool_use_id set
      // and the sub-agent's own session_id. Capturing that as the lead's
      // session_id corrupts resume on the next turn.
      const items = adapter.processChunk({
        type: 'assistant',
        session_id: 'subagent-session-xyz',
        parent_tool_use_id: 'tool-task-1',
        message: { content: [{ type: 'text', text: 'sub-agent output' }] },
      });
      expect(items!.find(i => i.kind === 'session_id')).toBeUndefined();
    });

    it('does NOT emit session_id from a result chunk', () => {
      // Result chunks may carry the sub-agent's session_id when a sub-agent
      // finishes. Only the system init frame is authoritative for the lead.
      const items = adapter.processChunk({
        type: 'result',
        session_id: 'maybe-subagent-session',
        subtype: 'success',
      });
      expect(items!.find(i => i.kind === 'session_id')).toBeUndefined();
    });
  });

  describe('slash command output in user chunks', () => {
    it('extracts stdout from local-command-stdout tags', () => {
      const items = adapter.processChunk({
        type: 'user',
        message: { content: '<local-command-stdout>command output</local-command-stdout>' },
      });
      expect(items!.find(i => i.kind === 'text')).toEqual({ kind: 'text', text: 'command output' });
    });

    it('extracts stderr as error', () => {
      const items = adapter.processChunk({
        type: 'user',
        message: { content: '<local-command-stderr>error output</local-command-stderr>' },
      });
      const err = items!.find(i => i.kind === 'error') as any;
      expect(err.message).toBe('error output');
    });
  });
});
