// @vitest-environment node

import { describe, expect, it } from 'vitest';
import {
  getModelLauncherModels,
  getModelLauncherProfile,
  MODEL_LAUNCHER_PROFILES,
} from '../modelLauncherProfiles';

describe('model launcher preferred profiles', () => {
  it('exposes exactly DeepSeek Pro and Flash through Ollama Cloud aliases', () => {
    expect(MODEL_LAUNCHER_PROFILES).toEqual([
      expect.objectContaining({
        modelId: 'deepseek-pro',
        launcherAlias: 'ollama-deepseek-pro',
        resolvedModel: 'deepseek-v4-pro:cloud',
      }),
      expect.objectContaining({
        modelId: 'deepseek-flash',
        launcherAlias: 'ollama-deepseek-flash',
        resolvedModel: 'deepseek-v4-flash:cloud',
      }),
    ]);
    expect(getModelLauncherModels().map((model) => model.id)).toEqual([
      'model-launcher:deepseek-pro',
      'model-launcher:deepseek-flash',
    ]);
  });

  it('fails closed for all other exact launcher arguments', () => {
    expect(getModelLauncherProfile('model-launcher:deepseek-pro')?.launcherAlias).toBe('ollama-deepseek-pro');
    expect(getModelLauncherProfile('deepseek-flash')?.launcherAlias).toBe('ollama-deepseek-flash');
    expect(getModelLauncherProfile('ollama-qwen35-397b')).toBeUndefined();
    expect(getModelLauncherProfile('deepseek-v4-pro')).toBeUndefined();
  });
});
