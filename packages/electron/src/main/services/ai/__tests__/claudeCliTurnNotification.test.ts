import { describe, it, expect } from 'vitest';
import {
  isClaudeCliTurnEnd,
  extractAssistantText,
  buildTurnNotificationBody,
} from '../claudeCliTurnNotification';
import type { AssembledAssistantMessage } from '../claudeCliObservation/claudeApiMessageAssembler';

function msg(
  content: AssembledAssistantMessage['content'],
  stopReason: string | null,
): AssembledAssistantMessage {
  return {
    id: 'm',
    role: 'assistant',
    model: 'claude-opus-4-x',
    content,
    stopReason,
    usage: { inputTokens: 0, outputTokens: 0, cacheReadInputTokens: 0, cacheCreationInputTokens: 0 },
  };
}

describe('isClaudeCliTurnEnd', () => {
  it('treats tool_use as mid-turn and null as unknown', () => {
    expect(isClaudeCliTurnEnd('tool_use')).toBe(false);
    expect(isClaudeCliTurnEnd(null)).toBe(false);
  });
  it('treats end_turn / stop_sequence / max_tokens as turn-end', () => {
    expect(isClaudeCliTurnEnd('end_turn')).toBe(true);
    expect(isClaudeCliTurnEnd('stop_sequence')).toBe(true);
    expect(isClaudeCliTurnEnd('max_tokens')).toBe(true);
  });
});

describe('extractAssistantText', () => {
  it('joins text blocks, ignoring thinking and tool_use', () => {
    const m = msg(
      [
        { type: 'thinking', thinking: 'secret' },
        { type: 'text', text: 'Done.' },
        { type: 'tool_use', id: 't', name: 'Read', input: {} },
        { type: 'text', text: 'All set.' },
      ],
      'end_turn',
    );
    expect(extractAssistantText(m)).toBe('Done.\nAll set.');
  });
});

describe('buildTurnNotificationBody', () => {
  it('falls back to a default when empty', () => {
    expect(buildTurnNotificationBody('   ')).toBe('Response complete');
  });
  it('truncates long text to 100 chars + ellipsis', () => {
    const long = 'x'.repeat(150);
    const body = buildTurnNotificationBody(long);
    expect(body.endsWith('...')).toBe(true);
    expect(body.length).toBe(103);
  });
  it('passes short text through', () => {
    expect(buildTurnNotificationBody('hi there')).toBe('hi there');
  });
});
