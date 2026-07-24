import { describe, expect, it } from 'vitest';
import { getHelpContent } from '../HelpContent';

describe('DeepSeek controls help', () => {
  it('documents reasoning control', () => {
    expect(getHelpContent('deepseek-reasoning-selector')?.title).toBe('DeepSeek Reasoning');
  });

  it('documents the restricted effort selector', () => {
    expect(getHelpContent('deepseek-effort-selector')?.title).toBe('DeepSeek Effort');
  });
});
