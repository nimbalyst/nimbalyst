import { describe, expect, it } from 'vitest';
import { toBackendHistory } from '../extensionAgentHistory';

// The converter must handle BOTH shapes the host may pass: the canonical
// Message ({ role, content }) and - the one session state actually holds at
// runtime - the TranscriptViewMessage ({ type, text, toolCall.toolName }).
// AIProvider.sendMessage types messages as any[], so only these tests guard the
// shape; the original converter silently read role/content off TranscriptView
// messages (undefined) and produced empty history - a runtime no-op.
describe('toBackendHistory', () => {
  it('returns empty for null/undefined/empty input', () => {
    expect(toBackendHistory(undefined)).toEqual([]);
    expect(toBackendHistory(null)).toEqual([]);
    expect(toBackendHistory([])).toEqual([]);
  });

  it('maps the canonical Message shape (role/content)', () => {
    const out = toBackendHistory([
      { role: 'user', content: 'do the task', timestamp: 0 },
      { role: 'assistant', content: 'on it', timestamp: 0 },
      { role: 'tool', content: 'tool result text', timestamp: 0 },
    ]);
    expect(out).toEqual([
      { role: 'user', content: 'do the task' },
      { role: 'assistant', content: 'on it' },
      { role: 'tool', content: 'tool result text' },
    ]);
  });

  it('maps the real TranscriptViewMessage shape (type/text/toolName) - the regression guard', () => {
    const out = toBackendHistory([
      { id: 1, sequence: 0, type: 'user_message', text: 'do the task', subagentId: null },
      { id: 2, sequence: 1, type: 'assistant_message', text: 'on it', subagentId: null },
      {
        id: 3,
        sequence: 2,
        type: 'tool_call',
        text: '',
        toolCall: { toolName: 'get_session_result', result: 'BIG CHILD REPORT', status: 'completed' },
        subagentId: null,
      },
    ]);
    expect(out).toEqual([
      { role: 'user', content: 'do the task' },
      { role: 'assistant', content: 'on it' },
      { role: 'tool', content: '', toolCall: { name: 'get_session_result', result: 'BIG CHILD REPORT' } },
    ]);
  });

  it('drops system turns from both shapes (persona comes from systemPrompt)', () => {
    expect(
      toBackendHistory([
        { role: 'system', content: 'you are a meta agent', timestamp: 0 },
        { type: 'system_message', text: 'system note' },
        { role: 'user', content: 'go', timestamp: 0 },
      ]),
    ).toEqual([{ role: 'user', content: 'go' }]);
  });

  it('drops a content-less, tool-less message (nothing for the backend to replay)', () => {
    expect(toBackendHistory([{ role: 'assistant', timestamp: 0 }])).toEqual([]);
    expect(toBackendHistory([{ type: 'assistant_message' }])).toEqual([]);
  });

  it('caps long history but preserves the first entry (the original task)', () => {
    const many = Array.from({ length: 200 }, (_unused, i) => ({
      type: i === 0 ? 'user_message' : 'assistant_message',
      text: i === 0 ? 'ORIGINAL_TASK' : `msg ${i}`,
    }));
    const out = toBackendHistory(many);
    expect(out.length).toBe(80);
    expect(out[0]).toEqual({ role: 'user', content: 'ORIGINAL_TASK' });
    // The tail is the most recent entries.
    expect(out[out.length - 1]).toEqual({ role: 'assistant', content: 'msg 199' });
  });
});
