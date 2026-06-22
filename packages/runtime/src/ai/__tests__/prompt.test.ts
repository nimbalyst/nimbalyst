import { describe, expect, it } from 'vitest';
import { buildClaudeCodeSystemPrompt, buildMetaAgentSystemPrompt, buildDevAgentSystemPrompt } from '../prompt';

describe('buildClaudeCodeSystemPrompt', () => {
  it('includes interactive input guidance for codex-style tool references', () => {
    const prompt = buildClaudeCodeSystemPrompt({
      toolReferenceStyle: 'codex',
    });

    expect(prompt).toContain('## Interactive User Input');
    expect(prompt).toContain('`AskUserQuestion` (server: `nimbalyst`)');
    expect(prompt).toContain('`PromptForUserInput` (server: `nimbalyst`)');
    expect(prompt).toContain('call an interactive tool instead');
    expect(prompt).toContain('Combine multiple questions into one multi-field prompt');
  });

  it('formats interactive input tool references for claude-style prompts', () => {
    const prompt = buildClaudeCodeSystemPrompt({
      toolReferenceStyle: 'claude',
    });

    // Core interactive tools now live on the eager `nimbalyst` server (Phase 2).
    expect(prompt).toContain('`mcp__nimbalyst__AskUserQuestion`');
    expect(prompt).toContain('`mcp__nimbalyst__PromptForUserInput`');
  });

  it('keeps plan-only sessions in planning', () => {
    const prompt = buildClaudeCodeSystemPrompt({
      toolReferenceStyle: 'codex',
      hasSessionNaming: true,
    });

    expect(prompt).toContain('Update phase for plan-only work: `{ "phase": "planning" }`');
    expect(prompt).toContain('If the session only produced a plan/design/research artifact, it stays "planning"');
    expect(prompt).toContain('Use "validating" only after implementation exists and is being tested or reviewed.');
  });
});

describe('extension agent self-identification (gemini)', () => {
  it('buildDevAgentSystemPrompt identifies by display name, not the internal id', () => {
    const prompt = buildDevAgentSystemPrompt({
      provider: 'antigravity-gemini-agent',
      model: 'gemini-3-flash-agent',
      modelDisplayName: 'Gemini 3.5 Flash (High)',
    });
    expect(prompt).toContain('You are Gemini 3.5 Flash (High),');
    expect(prompt).toContain('answer truthfully with that name');
    expect(prompt).not.toContain('You are running as provider');
    expect(prompt).not.toContain('gemini-3-flash-agent');
  });

  it('buildDevAgentSystemPrompt falls back to a generic identity without a display name', () => {
    const prompt = buildDevAgentSystemPrompt({ provider: 'antigravity-gemini-agent', model: 'gemini-3-flash-agent' });
    expect(prompt).toContain('You are an AI model served through the Antigravity language server.');
    expect(prompt).not.toContain('gemini-3-flash-agent');
  });

  it('buildMetaAgentSystemPrompt keeps the original identity for built-ins (no display name)', () => {
    const prompt = buildMetaAgentSystemPrompt('claude', 'default', { provider: 'claude-code', model: 'opus' });
    expect(prompt).toContain('You are running as provider `claude-code` with model `opus`.');
    expect(prompt).not.toContain('You are an AI model');
  });

  it('buildMetaAgentSystemPrompt identifies by display name but keeps ids for child spawning', () => {
    const prompt = buildMetaAgentSystemPrompt('codex', 'default', {
      provider: 'antigravity-gemini-agent',
      model: 'gemini-3-flash-agent',
      modelDisplayName: 'Gemini 3.5 Flash (High)',
    });
    expect(prompt).toContain('You are Gemini 3.5 Flash (High).');
    expect(prompt).toContain('answer truthfully with that name');
    expect(prompt).not.toContain('You are running as provider');
    // The raw ids remain in the spawn instruction so children inherit the same model.
    expect(prompt).toContain('gemini-3-flash-agent');
  });
});
