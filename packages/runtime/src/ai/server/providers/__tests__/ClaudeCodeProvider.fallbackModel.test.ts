import { describe, it, expect } from 'vitest';
import { ProviderFactory } from '../../ProviderFactory';
import { CLAUDE_CODE_SAFE_FALLBACK_MODEL } from '../../../modelConstants';

/**
 * GitHub #631 / NIM-848 — billing safety: the Claude Agent SDK provider must
 * never silently send the paid 1M-context beta when a session's model is
 * lost/empty.
 *
 * The 1M beta is derived purely from the model string: a `-1m` variant becomes
 * `model[1m]`, which the SDK auto-detects. Previously the provider's silent
 * fallback (when `config.model` was empty) was `claude-code:opus-1m`, so an
 * unresolved model invisibly billed 1M while the UI still showed a 200k model.
 *
 * 1M must be strictly opt-in: only an explicitly-selected `-1m` model yields
 * `[1m]`. Any empty/lost model resolves to a standard 200k model.
 */
describe('ClaudeCodeProvider silent fallback model (#631)', () => {
  it('the safe fallback constant is a standard 200k model (no -1m)', () => {
    expect(CLAUDE_CODE_SAFE_FALLBACK_MODEL.endsWith('-1m')).toBe(false);
  });

  it('does not emit [1m] when the session model is empty', async () => {
    const sessionId = 'fallback-model-test-session';
    const provider = ProviderFactory.createProvider('claude-code', sessionId) as unknown as {
      initialize(config: { model?: string }): Promise<void>;
      resolveModelVariant(): string;
    };
    try {
      // Provider initialized with no model — the lost/empty-model case.
      await provider.initialize({});
      const resolved = provider.resolveModelVariant();
      expect(resolved).not.toContain('[1m]');
    } finally {
      ProviderFactory.destroyProvider(sessionId, 'claude-code');
    }
  });

  it('still emits [1m] when the user explicitly selected a -1m model', async () => {
    const sessionId = 'fallback-model-test-session-1m';
    const provider = ProviderFactory.createProvider('claude-code', sessionId) as unknown as {
      initialize(config: { model?: string }): Promise<void>;
      resolveModelVariant(): string;
    };
    try {
      await provider.initialize({ model: 'claude-code:opus-1m' });
      const resolved = provider.resolveModelVariant();
      expect(resolved).toContain('[1m]');
    } finally {
      ProviderFactory.destroyProvider(sessionId, 'claude-code');
    }
  });
});
