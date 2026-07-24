import { describe, expect, it } from 'vitest';
import {
  DEFAULT_ACTION_PROMPTS_TEMPLATE,
  parseActionPromptsFile,
} from '../ActionPromptParser';

describe('parseActionPromptsFile', () => {
  it('parses two simple actions with verbatim multi-line bodies', () => {
    const content = `# AI Action Prompts

## Review Changed Files
/review changed files in this session and call out regression risk.

## Plan Implementation
Look at the active issue.

Produce a structured plan that:
- breaks the work into phases
- identifies the files
`;
    const { actions, diagnostics } = parseActionPromptsFile(content);

    expect(diagnostics).toEqual([]);
    expect(actions).toHaveLength(2);

    expect(actions[0]).toEqual({
      id: 'review-changed-files',
      label: 'Review Changed Files',
      body: '/review changed files in this session and call out regression risk.',
    });

    expect(actions[1].id).toBe('plan-implementation');
    expect(actions[1].label).toBe('Plan Implementation');
    expect(actions[1].body).toBe(
      'Look at the active issue.\n\nProduce a structured plan that:\n- breaks the work into phases\n- identifies the files'
    );
  });

  it('returns empty result for empty or whitespace-only content', () => {
    expect(parseActionPromptsFile('')).toEqual({ actions: [], diagnostics: [] });
    expect(parseActionPromptsFile('   \n\n\t\n')).toEqual({ actions: [], diagnostics: [] });
  });

  it('ignores content above the first ## heading', () => {
    const content = `# Title

Some preamble text that should be ignored.

## First Action
The body of the first action.
`;
    const { actions, diagnostics } = parseActionPromptsFile(content);
    expect(diagnostics).toEqual([]);
    expect(actions).toHaveLength(1);
    expect(actions[0].label).toBe('First Action');
    expect(actions[0].body).toBe('The body of the first action.');
  });

  it('treats ### as part of the body, not a new action', () => {
    const content = `## Outer Action
Intro text.
### A subheading inside the body
More body text.
`;
    const { actions } = parseActionPromptsFile(content);
    expect(actions).toHaveLength(1);
    expect(actions[0].body).toContain('### A subheading inside the body');
    expect(actions[0].body).toContain('More body text.');
  });

  it('emits a duplicate-heading diagnostic and keeps only the first occurrence', () => {
    const content = `## Same Action
First body.

## Same Action
Second body that should be dropped.
`;
    const { actions, diagnostics } = parseActionPromptsFile(content);
    expect(actions).toHaveLength(1);
    expect(actions[0].body).toBe('First body.');
    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0].code).toBe('duplicate-heading');
    expect(diagnostics[0].label).toBe('Same Action');
  });

  it('emits an empty-body diagnostic for headings with no content', () => {
    const content = `## Empty Action

## Real Action
A real body.
`;
    const { actions, diagnostics } = parseActionPromptsFile(content);
    expect(actions).toHaveLength(1);
    expect(actions[0].label).toBe('Real Action');
    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0].code).toBe('empty-body');
    expect(diagnostics[0].label).toBe('Empty Action');
  });

  it('does not split on a ## inside a fenced code block', () => {
    const content = `## Code Example
Here is a fenced block:
\`\`\`md
## Not a heading
text
\`\`\`
After the block.
`;
    const { actions } = parseActionPromptsFile(content);
    expect(actions).toHaveLength(1);
    expect(actions[0].body).toContain('## Not a heading');
    expect(actions[0].body).toContain('After the block.');
  });

  it('handles CRLF line endings', () => {
    const content = '## CRLF Action\r\nBody line 1\r\nBody line 2\r\n';
    const { actions } = parseActionPromptsFile(content);
    expect(actions).toHaveLength(1);
    expect(actions[0].body).toBe('Body line 1\nBody line 2');
  });

  it('slugifies headings into stable kebab-case ids', () => {
    const content = `## Hello, World!
body
## É — Café & Crème
body
`;
    const { actions } = parseActionPromptsFile(content);
    expect(actions).toHaveLength(2);
    expect(actions[0].id).toBe('hello-world');
    expect(actions[1].id).toBe('e-cafe-creme');
  });

  describe('action launch config', () => {
    it('leaves config undefined when no known key starts the body', () => {
      const content = `## No Config Action
Look at the file and tell me what you think.
`;
      const { actions, diagnostics } = parseActionPromptsFile(content);
      expect(diagnostics).toEqual([]);
      expect(actions).toHaveLength(1);
      expect(actions[0].config).toBeUndefined();
      expect(actions[0].body).toBe('Look at the file and tell me what you think.');
    });

    it('parses a full launcher config and strips it from the body', () => {
      const content = `## Plan in a fresh Opus session
launch: new-session
model: claude-code:opus
foreground: true
autoSubmit: false
worktree: true

Look at the originating session and propose a new plan.
`;
      const { actions, diagnostics } = parseActionPromptsFile(content);
      expect(diagnostics).toEqual([]);
      expect(actions).toHaveLength(1);
      expect(actions[0].config).toEqual({
        launch: 'new-session',
        model: 'claude-code:opus',
        foreground: true,
        autoSubmit: false,
        worktree: true,
      });
      expect(actions[0].body).toBe('Look at the originating session and propose a new plan.');
    });

    it('fills missing keys with defaults when a partial config is given', () => {
      const content = `## Just launch
launch: new-session

Body here.
`;
      const { actions, diagnostics } = parseActionPromptsFile(content);
      expect(diagnostics).toEqual([]);
      expect(actions).toHaveLength(1);
      expect(actions[0].config).toEqual({
        launch: 'new-session',
        model: undefined,
        foreground: true,
        autoSubmit: true,
        worktree: false,
      });
      expect(actions[0].body).toBe('Body here.');
    });

    it('emits a diagnostic and ignores unknown keys', () => {
      const content = `## Has Unknown Key
launch: new-session
bogus: yes

Body here.
`;
      const { actions, diagnostics } = parseActionPromptsFile(content);
      expect(actions).toHaveLength(1);
      expect(actions[0].config?.launch).toBe('new-session');
      expect(diagnostics).toHaveLength(1);
      expect(diagnostics[0].code).toBe('unknown-action-key');
      expect(actions[0].body).toBe('Body here.');
    });

    it('rejects an invalid model identifier and falls through to inherit', () => {
      const content = `## Bad Model
launch: new-session
model: not a valid id

Body here.
`;
      const { actions, diagnostics } = parseActionPromptsFile(content);
      expect(actions).toHaveLength(1);
      expect(actions[0].config?.launch).toBe('new-session');
      expect(actions[0].config?.model).toBeUndefined();
      expect(diagnostics.some((d) => d.code === 'invalid-model')).toBe(true);
    });

    it('rejects an unknown provider via ModelIdentifier validation', () => {
      const content = `## Unknown Provider
launch: new-session
model: bogus-provider:some-model

Body here.
`;
      const { actions, diagnostics } = parseActionPromptsFile(content);
      expect(actions).toHaveLength(1);
      expect(actions[0].config?.model).toBeUndefined();
      expect(diagnostics.some((d) => d.code === 'invalid-model')).toBe(true);
    });

    it('accepts provider-prefixed model ids that contain slashes (e.g. opencode)', () => {
      const content = `## OpenCode model
launch: new-session
model: opencode:anthropic/claude-sonnet-4-5-20250929

Body.
`;
      const { actions, diagnostics } = parseActionPromptsFile(content);
      // The parser used to hardcode a regex without slashes, which rejected
      // legitimate opencode-style model ids. Now we defer to
      // ModelIdentifier.tryParse, which accepts arbitrary model strings for
      // generic providers.
      expect(diagnostics.filter((d) => d.code === 'invalid-model')).toEqual([]);
      expect(actions[0].config?.model).toBe('opencode:anthropic/claude-sonnet-4-5-20250929');
    });

    it('rejects an invalid launch value but keeps other keys', () => {
      const content = `## Bad Launch
launch: forever
foreground: false

Body here.
`;
      const { actions, diagnostics } = parseActionPromptsFile(content);
      expect(actions).toHaveLength(1);
      expect(actions[0].config?.launch).toBe('same-session');
      expect(actions[0].config?.foreground).toBe(false);
      expect(diagnostics.some((d) => d.code === 'invalid-launch')).toBe(true);
    });

    it('rejects invalid bool values and keeps the default', () => {
      const content = `## Bad Bool
launch: new-session
autoSubmit: maybe

Body here.
`;
      const { actions, diagnostics } = parseActionPromptsFile(content);
      expect(actions).toHaveLength(1);
      expect(actions[0].config?.autoSubmit).toBe(true);
      expect(diagnostics.some((d) => d.code === 'invalid-bool')).toBe(true);
    });

    it('does not treat a key-shaped first line with an unknown key as config', () => {
      const content = `## Body Starts With Colon
Hello: this is the body, not a config line.
More body.
`;
      const { actions, diagnostics } = parseActionPromptsFile(content);
      expect(diagnostics).toEqual([]);
      expect(actions).toHaveLength(1);
      expect(actions[0].config).toBeUndefined();
      expect(actions[0].body).toBe(
        'Hello: this is the body, not a config line.\nMore body.'
      );
    });

    it('accepts capitalized models like claude-code:Opus-4.6', () => {
      const content = `## Variant model
launch: new-session
model: claude-code:opus-4-6

Body.
`;
      const { actions, diagnostics } = parseActionPromptsFile(content);
      expect(diagnostics).toEqual([]);
      expect(actions[0].config?.model).toBe('claude-code:opus-4-6');
    });
  });

  it('ships a default template with sibling-session launcher examples', () => {
    const { actions, diagnostics } = parseActionPromptsFile(DEFAULT_ACTION_PROMPTS_TEMPLATE);

    expect(diagnostics).toEqual([]);

    const planningLauncher = actions.find((action) => action.id === 'plan-in-fresh-opus-session');
    expect(planningLauncher?.config).toEqual({
      launch: 'new-session',
      model: 'claude-code:opus',
      foreground: true,
      autoSubmit: true,
      worktree: false,
    });
    expect(planningLauncher?.body).toContain('Open a fresh sibling planning session.');

    const worktreeLauncher = actions.find((action) => action.id === 'worktree-implementation-draft');
    expect(worktreeLauncher?.config).toEqual({
      launch: 'new-session',
      model: undefined,
      foreground: true,
      autoSubmit: false,
      worktree: true,
    });
    expect(worktreeLauncher?.body).toContain('Open a sibling coding session in a git worktree.');
  });
});
