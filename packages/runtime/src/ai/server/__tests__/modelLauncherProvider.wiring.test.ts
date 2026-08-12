// @vitest-environment node

import { describe, expect, it, vi } from 'vitest';
import { ModelRegistry } from '../ModelRegistry';
import { ProviderFactory } from '../ProviderFactory';
import { ModelLauncherProvider } from '../providers/ModelLauncherProvider';

describe('ModelLauncherProvider wiring', () => {
  it('registers exactly the two preferred DeepSeek pointers', async () => {
    const models = await ModelRegistry.getModelsForProvider('model-launcher');
    expect(models.map((model) => model.id)).toEqual([
      'model-launcher:deepseek-pro',
      'model-launcher:deepseek-flash',
    ]);
  });

  it('dispatches the selected profile and reviewed effort without fallback', async () => {
    const invoke = vi.fn(async () => ({ output: 'answer', artifactPath: 'audit.json' }));
    const provider = new ModelLauncherProvider({ invoke });
    await provider.initialize({ model: 'model-launcher:deepseek-flash', effortLevel: 'xhigh' });
    const chunks = [];
    for await (const chunk of provider.sendMessage('question', undefined, 'session', [], 'D:\\CLAUDE')) {
      chunks.push(chunk);
    }
    expect(invoke).toHaveBeenCalledWith(expect.objectContaining({
      profile: expect.objectContaining({ launcherAlias: 'ollama-deepseek-flash' }),
      effort: 'xhigh',
      task: 'question',
    }));
    expect(chunks).toEqual([
      { type: 'text', content: 'answer' },
      { type: 'complete', content: 'answer', isComplete: true },
    ]);
  });

  it('constructs through the provider factory and rejects unapproved profiles', async () => {
    const provider = ProviderFactory.createProvider('model-launcher', 'launcher-test');
    expect(provider).toBeInstanceOf(ModelLauncherProvider);
    await expect(provider.initialize({ model: 'model-launcher:other' })).rejects.toThrow('Unsupported');
    ProviderFactory.destroyProvider('launcher-test');
  });
});
