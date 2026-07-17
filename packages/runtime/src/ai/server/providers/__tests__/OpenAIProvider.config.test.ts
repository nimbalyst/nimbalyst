import { describe, expect, it } from 'vitest';
import { OpenAIProvider } from '../OpenAIProvider';

describe('OpenAIProvider config', () => {
  it('falls back to the default model when initialized without one', async () => {
    const provider = new OpenAIProvider();

    await provider.initialize({ apiKey: 'test-openai-key' });

    expect((provider as any).config.model).toBe(OpenAIProvider.DEFAULT_MODEL);
  });

  it('preserves the selected model when initialized with one', async () => {
    const provider = new OpenAIProvider();

    await provider.initialize({ apiKey: 'test-openai-key', model: 'gpt-5-mini' });

    expect((provider as any).config.model).toBe('gpt-5-mini');
  });
});
