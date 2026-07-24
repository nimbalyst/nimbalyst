import { describe, expect, it } from 'vitest';
import { getHelpContent } from '../HelpContent';

describe('DeepSeek model degree-of-freedom help', () => {
  it('defines reasoning without implying a context or token-budget control', () => {
    expect(getHelpContent('deepseek-reasoning-selector')).toEqual({
      title: 'DeepSeek Reasoning',
      body: 'Turn DeepSeek reasoning on or off for the next request.',
    });
  });

  it('defines High and Max as reasoning work rather than context size', () => {
    const help = getHelpContent('deepseek-effort-selector');
    expect(help?.body).toContain('reasoning work');
    expect(help?.body).toContain('does not change the context window');
    expect(help?.body).toContain('fixed token budget');
  });
});
