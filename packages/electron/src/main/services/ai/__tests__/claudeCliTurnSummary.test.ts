import { describe, it, expect } from 'vitest';
import {
  recordClaudeCliTurnMessage,
  takeClaudeCliTurnSummary,
  clearClaudeCliTurnSummary,
} from '../claudeCliTurnSummary';

describe('claudeCliTurnSummary', () => {
  it('accumulates tool names and keeps the latest non-empty text across a turn', () => {
    const sid = 'sum-1';
    recordClaudeCliTurnMessage(sid, { text: 'thinking...', toolNames: ['Read'] });
    recordClaudeCliTurnMessage(sid, { text: '', toolNames: ['Edit'] }); // empty text ignored
    recordClaudeCliTurnMessage(sid, { text: 'all done', toolNames: [] });

    const summary = takeClaudeCliTurnSummary(sid);
    expect(summary).toEqual({ lastAssistantText: 'all done', toolNames: ['Read', 'Edit'] });
  });

  it('take clears the summary (second take is null)', () => {
    const sid = 'sum-2';
    recordClaudeCliTurnMessage(sid, { text: 'x' });
    expect(takeClaudeCliTurnSummary(sid)).not.toBeNull();
    expect(takeClaudeCliTurnSummary(sid)).toBeNull();
  });

  it('clear drops an in-flight summary', () => {
    const sid = 'sum-3';
    recordClaudeCliTurnMessage(sid, { text: 'x', toolNames: ['Bash'] });
    clearClaudeCliTurnSummary(sid);
    expect(takeClaudeCliTurnSummary(sid)).toBeNull();
  });

  it('keeps sessions isolated', () => {
    recordClaudeCliTurnMessage('a', { text: 'A', toolNames: ['Read'] });
    recordClaudeCliTurnMessage('b', { text: 'B', toolNames: ['Edit'] });
    expect(takeClaudeCliTurnSummary('a')).toEqual({ lastAssistantText: 'A', toolNames: ['Read'] });
    expect(takeClaudeCliTurnSummary('b')).toEqual({ lastAssistantText: 'B', toolNames: ['Edit'] });
  });
});
