import { describe, it, expect } from 'vitest';
import { buildClaudeCliResponseEvent } from '../claudeCliResponseAnalytics';

describe('buildClaudeCliResponseEvent', () => {
  it('classifies a text-only turn', () => {
    const e = buildClaudeCliResponseEvent({ toolNames: [], finalText: 'all done' });
    expect(e.responseType).toBe('text');
    expect(e.toolsUsed).toEqual([]);
    expect(e.usedChartTool).toBe(false);
    expect(e.provider).toBe('claude-code-cli');
  });

  it('classifies a tool-using turn and dedupes tool names', () => {
    const e = buildClaudeCliResponseEvent({
      toolNames: ['Read', 'Edit', 'Read', 'Bash'],
      finalText: 'done',
    });
    expect(e.responseType).toBe('tool_use');
    expect(e.toolsUsed).toEqual(['Read', 'Edit', 'Bash']);
  });

  it('flags chart/display tools', () => {
    const e = buildClaudeCliResponseEvent({
      toolNames: ['mcp__nimbalyst__display_to_user'],
      finalText: '',
    });
    expect(e.usedChartTool).toBe(true);
  });

  it('buckets the final text length', () => {
    const e = buildClaudeCliResponseEvent({ toolNames: [], finalText: 'x'.repeat(5000) });
    expect(typeof e.totalLength).toBe('string');
  });
});
