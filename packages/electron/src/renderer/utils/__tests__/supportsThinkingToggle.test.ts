import { describe, expect, it } from 'vitest';
import { supportsThinkingToggle } from '../modelUtils';

describe('supportsThinkingToggle', () => {
  it('enables the toggle for the default opus and sonnet variants', () => {
    expect(supportsThinkingToggle('claude-code:opus')).toBe(true);
    expect(supportsThinkingToggle('claude-code:sonnet')).toBe(true);
  });

  it('enables the toggle for pinned opus variants', () => {
    // These must stay in lock-step with the server-side canDisableThinkingForModel
    // gate: it disables thinking for any opus/sonnet model, so the UI toggle must
    // be present for those pinned variants or users cannot re-enable thinking.
    // opus-4-7 was the variant stranded by the original gate.
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
    expect(supportsThinkingToggle('claude-code-cli:opus')).toBe(false);
    expect(supportsThinkingToggle('claude-code-cli:sonnet')).toBe(false);
  });
});
