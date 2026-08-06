import { describe, expect, it } from 'vitest';
import { resolveProviderIcon } from '../ProviderIcons';

describe('resolveProviderIcon', () => {
  it('maps the Codex ACP provider to the shared Codex icon', () => {
    expect(resolveProviderIcon('openai-codex-acp')).toBe('openai-codex');
  });

  it('leaves other provider ids unchanged', () => {
    expect(resolveProviderIcon('openai')).toBe('openai');
    expect(resolveProviderIcon('claude-code')).toBe('claude-code');
  });
});
