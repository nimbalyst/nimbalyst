import { describe, expect, it } from 'vitest';
import type { Message } from '@nimbalyst/runtime/ai/server/types';
import { toBackendHistory } from '../extensionAgentHistory';

function msg(role: Message['role'], content: string, extra: Partial<Message> = {}): Message {
  return { role, content, timestamp: 0, ...extra } as Message;
}

describe('toBackendHistory', () => {
  it('returns empty for null/undefined/empty input', () => {
    expect(toBackendHistory(undefined)).toEqual([]);
    expect(toBackendHistory(null)).toEqual([]);
    expect(toBackendHistory([])).toEqual([]);
  });

  it('maps user/assistant/tool roles and content through', () => {
    const out = toBackendHistory([
      msg('user', 'do the task'),
      msg('assistant', 'on it'),
      msg('tool', 'tool result text'),
    ]);
    expect(out).toEqual([
      { role: 'user', content: 'do the task' },
      { role: 'assistant', content: 'on it' },
      { role: 'tool', content: 'tool result text' },
    ]);
  });

  it('drops system-role turns (persona is delivered via systemPrompt)', () => {
    const out = toBackendHistory([
      msg('system', 'you are a meta agent'),
      msg('user', 'go'),
    ]);
    expect(out).toEqual([{ role: 'user', content: 'go' }]);
  });

  it('preserves a tool call name and result', () => {
    const out = toBackendHistory([
      msg('assistant', '', { toolCall: { name: 'get_session_result', result: 'big report' } as never }),
    ]);
    expect(out).toEqual([
      { role: 'assistant', content: '', toolCall: { name: 'get_session_result', result: 'big report' } },
    ]);
  });

  it('coerces non-string content to an empty string', () => {
    const out = toBackendHistory([msg('assistant', undefined as never)]);
    expect(out).toEqual([{ role: 'assistant', content: '' }]);
  });
});
