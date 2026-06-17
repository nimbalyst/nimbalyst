import { describe, it, expect, vi } from 'vitest';
import { trackClaudeCliFileEdits } from '../claudeCliFileTracking';
import type { AssembledAssistantMessage } from '../claudeCliObservation/claudeApiMessageAssembler';

function msg(content: AssembledAssistantMessage['content']): AssembledAssistantMessage {
  return {
    id: 'msg_1',
    role: 'assistant',
    model: 'claude-opus-4-x',
    content,
    stopReason: 'tool_use',
    usage: { inputTokens: 0, outputTokens: 0, cacheReadInputTokens: 0, cacheCreationInputTokens: 0 },
  };
}

describe('trackClaudeCliFileEdits', () => {
  it('feeds each tool_use block to the tracker with name/input/id', async () => {
    const track = vi.fn().mockResolvedValue(undefined);
    await trackClaudeCliFileEdits({
      message: msg([
        { type: 'text', text: 'working on it' },
        { type: 'tool_use', id: 'tu_1', name: 'Write', input: { file_path: '/a.ts', content: 'x' } },
        { type: 'tool_use', id: 'tu_2', name: 'Read', input: { file_path: '/b.ts' } },
      ]),
      track,
    });

    expect(track).toHaveBeenCalledTimes(2);
    expect(track).toHaveBeenNthCalledWith(1, 'Write', { file_path: '/a.ts', content: 'x' }, 'tu_1');
    expect(track).toHaveBeenNthCalledWith(2, 'Read', { file_path: '/b.ts' }, 'tu_2');
  });

  it('skips text/thinking blocks and tolerates a turn with no tools', async () => {
    const track = vi.fn().mockResolvedValue(undefined);
    await trackClaudeCliFileEdits({
      message: msg([
        { type: 'thinking', thinking: 'hmm' },
        { type: 'text', text: 'done' },
      ]),
      track,
    });
    expect(track).not.toHaveBeenCalled();
  });

  it('does not let one tracker failure block the rest', async () => {
    const track = vi
      .fn()
      .mockRejectedValueOnce(new Error('boom'))
      .mockResolvedValue(undefined);
    await trackClaudeCliFileEdits({
      message: msg([
        { type: 'tool_use', id: 'tu_1', name: 'Edit', input: { file_path: '/a.ts' } },
        { type: 'tool_use', id: 'tu_2', name: 'Edit', input: { file_path: '/b.ts' } },
      ]),
      track,
    });
    expect(track).toHaveBeenCalledTimes(2);
  });
});
