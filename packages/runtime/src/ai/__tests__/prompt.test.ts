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
    expect(prompt).toContain('Combine questions into one multi-field prompt');
  });

  it('formats interactive input tool references for claude-style prompts', () => {
    const prompt = buildClaudeCodeSystemPrompt({
      toolReferenceStyle: 'claude',
    });

    // Core interactive tools now live on the eager `nimbalyst` server (Phase 2).
    expect(prompt).toContain('`mcp__nimbalyst__AskUserQuestion`');
    expect(prompt).toContain('`mcp__nimbalyst__PromptForUserInput`');
  });

  it('includes tracker-references guidance by default', () => {
    const prompt = buildClaudeCodeSystemPrompt({});

    expect(prompt).toContain('## Tracker References');
    expect(prompt).toContain('nimbalyst://NIM-123');
  });

  it('omits tracker-references guidance when trackers are disabled', () => {
    const prompt = buildClaudeCodeSystemPrompt({ trackersEnabled: false });

    expect(prompt).not.toContain('## Tracker References');
    expect(prompt).not.toContain('nimbalyst://');
    // Unrelated sections stay intact
    expect(prompt).toContain('## File References');
    expect(prompt).toContain('## Git Commits');
  });

  it('keeps plan-only sessions in planning', () => {
    const prompt = buildClaudeCodeSystemPrompt({
      toolReferenceStyle: 'codex',
      hasSessionNaming: true,
    });

    expect(prompt).toContain('stays "planning" even when that deliverable is complete');
    expect(prompt).toContain('"validating" once implementation is being tested or reviewed');
  });

  it('includes name guidelines only when naming is in-band', () => {
    const inBand = buildClaudeCodeSystemPrompt({
      hasSessionNaming: true,
      hasOutOfBandNaming: false,
    });
    expect(inBand).toContain('### Name guidelines');
    expect(inBand).toContain('CRITICAL: You MUST call this tool');

    const outOfBand = buildClaudeCodeSystemPrompt({
      hasSessionNaming: true,
      hasOutOfBandNaming: true,
    });
    expect(outOfBand).not.toContain('### Name guidelines');
    expect(outOfBand).toContain('do NOT set `name`');
    expect(outOfBand).toContain('Tags and phase are NOT auto-assigned');
    expect(outOfBand).toContain('call this tool early in your first turn');
    expect(outOfBand).toContain('### Commit tracking');
  });

  it('includes the worktree section only when a worktree path is set', () => {
    const prompt = buildClaudeCodeSystemPrompt({
      worktreePath: '/tmp/wt/session-1',
    });
    expect(prompt).toContain('## Git Worktree Environment');
    expect(prompt).toContain('/tmp/wt/session-1');
    expect(prompt).toContain('do not modify files in the main checkout unless explicitly asked');
    expect(buildClaudeCodeSystemPrompt({})).not.toContain('## Git Worktree Environment');
  });

  it('retains the key behavioral rules after prose tightening', () => {
    const prompt = buildClaudeCodeSystemPrompt({ hasSessionNaming: true });
    expect(prompt).toContain('Prefer charts over text tables');
    expect(prompt).toContain('never manually');
    expect(prompt).toContain('pre-fill defaults');
    expect(prompt).toContain('[relativeName](/absolute/path/to/file.ext)');
    expect(prompt).toContain('%20');
    expect(prompt).toContain('`mcp__nimbalyst__developer_git_commit_proposal`');
    expect(prompt).toContain('Fixes #123');
    expect(prompt).toContain('never invent an issue key');
  });

  it('documents only the current custom-editor embed contract', () => {
    const prompt = buildClaudeCodeSystemPrompt({});

    expect(prompt).toContain('[Label](relative/path/file.ext "width=1000 height=650")');
    expect(prompt).toContain('Never use the legacy `{mockup:...}` image-attribute syntax');
    expect(prompt).not.toContain('](screenshot.png){mockup:');
  });

  // Context-size regression gate (NIM-1988): the addendum is injected into every
  // claude-code session, so its size is a per-session token cost. If this fails,
  // trim prose rather than raising the budget.
  it('keeps the static feature-rich addendum under the size budget', () => {
    const prompt = buildClaudeCodeSystemPrompt({
      hasSessionNaming: true,
      hasOutOfBandNaming: true,
      trackersEnabled: true,
      planTrackingEnabled: true,
      worktreePath: '/tmp/wt/session-1',
      isVoiceMode: true,
    });
    expect(prompt.length).toBeLessThan(9500);

    const typical = buildClaudeCodeSystemPrompt({
      hasSessionNaming: true,
      hasOutOfBandNaming: true,
    });
    expect(typical.length).toBeLessThan(6500);
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
