import { describe, it, expect } from 'vitest';
import {
  AI_PROVIDER_TYPES,
  isAgentProvider,
  shouldBlockStartedSessionProviderSwitch,
  resolveClaudeCodeModelVariant,
} from '../types';
import { ModelIdentifier } from '../ModelIdentifier';
import { ProviderFactory } from '../ProviderFactory';

/**
 * Phase 0 wiring for the subscription/CLI Claude provider `claude-code-cli`
 * (NIM-805 / NIM-806). This is the new provider ID that runs the genuine
 * `claude` CLI on the user's subscription, alongside `claude-code` (Agent SDK,
 * API billing). It mirrors the openai-codex / openai-codex-acp precedent and
 * shares the Claude model variant namespace.
 */
describe('claude-code-cli provider wiring (Phase 0)', () => {
  it('is a registered provider type', () => {
    expect((AI_PROVIDER_TYPES as readonly string[]).includes('claude-code-cli')).toBe(true);
  });

  it('is treated as an agent provider', () => {
    expect(isAgentProvider('claude-code-cli')).toBe(true);
  });

  it('locks billing: cannot switch between claude-code and claude-code-cli once a session has messages', () => {
    // Switching across the billing axis mid-session must be blocked.
    expect(shouldBlockStartedSessionProviderSwitch('claude-code', 'claude-code-cli', true)).toBe(true);
    expect(shouldBlockStartedSessionProviderSwitch('claude-code-cli', 'claude-code', true)).toBe(true);
    // No messages yet -> creation-time choice is allowed.
    expect(shouldBlockStartedSessionProviderSwitch('claude-code', 'claude-code-cli', false)).toBe(false);
  });

  describe('model identifiers share the Claude variant namespace', () => {
    it('parses claude-code-cli variants', () => {
      const id = ModelIdentifier.parse('claude-code-cli:fable');
      expect(id.provider).toBe('claude-code-cli');
      expect(id.model).toBe('fable');
      expect(id.baseVariant).toBe('fable');
      expect(id.isExtendedContext).toBe(false);
    });

    it('supports the -1m extended-context suffix', () => {
      const id = ModelIdentifier.parse('claude-code-cli:sonnet-1m');
      expect(id.baseVariant).toBe('sonnet');
      expect(id.isExtendedContext).toBe(true);
    });

    it('rejects invalid variants', () => {
      expect(() => ModelIdentifier.parse('claude-code-cli:not-a-variant')).toThrow('Invalid Claude Code variant');
    });

    it('has a parseable default model', () => {
      const id = ModelIdentifier.getDefaultModelId('claude-code-cli');
      expect(id).toBe('claude-code-cli:opus-1m');
      expect(() => ModelIdentifier.parse(id)).not.toThrow();
    });
  });

  describe('resolveClaudeCodeModelVariant accepts claude-code-cli', () => {
    it('resolves a plain variant', () => {
      expect(resolveClaudeCodeModelVariant('claude-code-cli:fable', 'opus')).toBe('fable');
    });

    it('appends the [1m] beta marker for extended context', () => {
      expect(resolveClaudeCodeModelVariant('claude-code-cli:sonnet-1m', 'opus')).toBe('sonnet[1m]');
    });
  });

  it('the factory can construct a claude-code-cli provider', () => {
    const provider = ProviderFactory.createProvider('claude-code-cli', 'wiring-test-session') as unknown as {
      getProviderName(): string;
    };
    expect(provider).toBeTruthy();
    expect(provider.getProviderName()).toBe('claude-code-cli');
    ProviderFactory.destroyProvider('wiring-test-session', 'claude-code-cli');
  });
});
