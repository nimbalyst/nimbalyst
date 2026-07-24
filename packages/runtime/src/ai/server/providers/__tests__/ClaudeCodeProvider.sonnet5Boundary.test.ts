import { describe, expect, it } from 'vitest';
import { ProviderFactory } from '../../ProviderFactory';

type ProviderBoundary = {
  initialize(config: { model?: string }): Promise<void>;
  resolveModelVariant(): string;
};

describe('ClaudeCodeProvider persisted Sonnet 5 launch boundary', () => {
  for (const model of ['claude-code:sonnet-5', 'claude-code:sonnet-5-1m']) {
    it(`launches persisted ${model} through the single one-mega route`, async () => {
      const sessionId = `sonnet5-boundary-${model}`;
      const provider = ProviderFactory.createProvider('claude-code', sessionId) as unknown as ProviderBoundary;
      try {
        await provider.initialize({ model });
        expect(provider.resolveModelVariant()).toBe('sonnet[1m]');
      } finally {
        ProviderFactory.destroyProvider(sessionId, 'claude-code');
      }
    });
  }
});
