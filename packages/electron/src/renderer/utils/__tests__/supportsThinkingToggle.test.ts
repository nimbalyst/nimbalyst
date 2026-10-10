// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { canDisableClaudeThinking } from '@nimbalyst/runtime/ai/modelConstants';
import { supportsThinkingToggle, supportsEffortLevel } from '../modelUtils';

describe('supportsThinkingToggle', () => {
  it('keeps thinking mandatory for current Opus and Sonnet', () => {
    expect(supportsThinkingToggle('claude-code:opus')).toBe(false);
    expect(supportsThinkingToggle('claude-code:sonnet')).toBe(false);
  });

  it.each(['claude-code', 'claude-code-cli'])('matches the CLI rejects_disabled_thinking list for Sonnet on %s', (provider) => {
    // CLI 2.1.284 marks Sonnet 5.5 rejects_disabled_thinking and silently
    // ignores a disabled request, so the toggle would be a no-op.
    expect(supportsThinkingToggle(`${provider}:sonnet-5-5`)).toBe(false);
    expect(supportsThinkingToggle(`${provider}:sonnet-1m`)).toBe(false);
    expect(supportsThinkingToggle(`${provider}:sonnet-5`)).toBe(true);
    expect(supportsThinkingToggle(`${provider}:sonnet-4-6`)).toBe(true);
    expect(canDisableClaudeThinking('claude-sonnet-5-5')).toBe(false);
    expect(canDisableClaudeThinking('claude-sonnet-5')).toBe(true);
    expect(supportsEffortLevel(`${provider}:sonnet-5`)).toBe(true);
  });

  it('offers effort on every retained pinned Opus and Fable row', () => {
    expect(supportsEffortLevel('claude-code:fable-5')).toBe(true);
    expect(supportsEffortLevel('claude-code:opus-4-8')).toBe(true);
  });

  it.each(['claude-code', 'claude-code-cli'])('handles explicit Opus versions and 1M selections for %s', (provider) => {
    expect(supportsThinkingToggle(`${provider}:opus-5-5-1m`)).toBe(false);
    expect(supportsThinkingToggle(`${provider}:opus-5`)).toBe(true);
    expect(supportsThinkingToggle(`${provider}:opus-5-1m`)).toBe(true);
    expect(supportsEffortLevel(`${provider}:opus-5`)).toBe(true);
    expect(supportsEffortLevel(`${provider}:opus-5-5`)).toBe(true);
  });

  it('enables the toggle for pinned opus variants', () => {
    // Older Opus versions still support the existing Off preference.
    expect(supportsThinkingToggle('claude-code:opus-4-7')).toBe(true);
    expect(supportsThinkingToggle('claude-code:opus-4-6')).toBe(true);
  });

  it('disables the toggle for fable and haiku variants', () => {
    expect(supportsThinkingToggle('claude-code:fable')).toBe(false);
    expect(supportsThinkingToggle('claude-code:haiku')).toBe(false);
  });

  it('disables the toggle for non-claude-code and missing models', () => {
    expect(supportsThinkingToggle(undefined)).toBe(false);
    expect(supportsThinkingToggle('gpt-5.5')).toBe(false);
  });
});
