import { describe, expect, it } from 'vitest';
import { buildClaudeCodeSystemPrompt } from '../prompt';

describe('buildClaudeCodeSystemPrompt', () => {
  it('includes interactive input guidance for codex-style tool references', () => {
    const prompt = buildClaudeCodeSystemPrompt({
      toolReferenceStyle: 'codex',
    });

    expect(prompt).toContain('## Interactive User Input');
    expect(prompt).toContain('`AskUserQuestion` (server: `nimbalyst-mcp`)');
    expect(prompt).toContain('`PromptForUserInput` (server: `nimbalyst-mcp`)');
    expect(prompt).toContain('do not guess');
    expect(prompt).toContain('Wait for the tool result before continuing');
  });

  it('formats interactive input tool references for claude-style prompts', () => {
    const prompt = buildClaudeCodeSystemPrompt({
      toolReferenceStyle: 'claude',
    });

    expect(prompt).toContain('`mcp__nimbalyst-mcp__AskUserQuestion`');
    expect(prompt).toContain('`mcp__nimbalyst-mcp__PromptForUserInput`');
  });
});
