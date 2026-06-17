import { describe, it, expect, vi } from 'vitest';
import {
  deriveSessionTitleFromPrompt,
  maybeAutoNameClaudeCliSession,
} from '../claudeCliSessionAutoName';

/**
 * NIM-822: claude-code-cli sessions stayed "New Session" — the PTY-spawned CLI
 * never enters the SDK provider loop, and the --append-system-prompt naming
 * nudge is opportunistic and usually ignored. The host now derives a title
 * from the first user prompt on the first completed turn if the agent hasn't
 * named the session itself. No API call — CLI users may be subscription-only
 * with no API key configured (and env-var keys are forbidden).
 */

describe('deriveSessionTitleFromPrompt', () => {
  it('uses a short prompt verbatim', () => {
    expect(deriveSessionTitleFromPrompt('Fix the login bug')).toBe('Fix the login bug');
  });

  it('flattens whitespace and truncates long prompts at a word boundary with an ellipsis', () => {
    const title = deriveSessionTitleFromPrompt(
      'Please investigate why the terminal panel\n  sometimes fails to initialize on cold start and write a fix',
    );
    expect(title).toBeTruthy();
    expect(title!.length).toBeLessThanOrEqual(49); // 48 + ellipsis char
    expect(title).toContain('…');
    expect(title).not.toContain('\n');
  });

  it('returns null for empty, slash-command, and memory prompts', () => {
    expect(deriveSessionTitleFromPrompt('')).toBeNull();
    expect(deriveSessionTitleFromPrompt('   ')).toBeNull();
    expect(deriveSessionTitleFromPrompt('/clear')).toBeNull();
    expect(deriveSessionTitleFromPrompt('# remember this')).toBeNull();
    expect(deriveSessionTitleFromPrompt(undefined)).toBeNull();
  });

  it('strips trailing punctuation', () => {
    expect(deriveSessionTitleFromPrompt('What does this do?')).toBe('What does this do');
  });
});

describe('maybeAutoNameClaudeCliSession', () => {
  const deps = (overrides: Partial<Parameters<typeof maybeAutoNameClaudeCliSession>[1]> = {}) => ({
    isAlreadyNamed: vi.fn(async () => false),
    getFirstUserPrompt: vi.fn(async () => 'Fix the login bug please'),
    applyTitle: vi.fn(async () => undefined),
    ...overrides,
  });

  it('derives and applies a title for an unnamed session', async () => {
    const d = deps();
    const result = await maybeAutoNameClaudeCliSession('s1', d);
    expect(result).toBe('named');
    expect(d.applyTitle).toHaveBeenCalledWith('s1', 'Fix the login bug please');
  });

  it('skips a session the agent already named', async () => {
    const d = deps({ isAlreadyNamed: vi.fn(async () => true) });
    const result = await maybeAutoNameClaudeCliSession('s1', d);
    expect(result).toBe('already-named');
    expect(d.applyTitle).not.toHaveBeenCalled();
  });

  it('skips when there is no usable first prompt', async () => {
    const d = deps({ getFirstUserPrompt: vi.fn(async () => '/clear') });
    const result = await maybeAutoNameClaudeCliSession('s1', d);
    expect(result).toBe('no-usable-prompt');
    expect(d.applyTitle).not.toHaveBeenCalled();
  });
});
