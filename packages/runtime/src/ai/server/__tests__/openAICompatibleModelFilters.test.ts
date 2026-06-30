import { describe, expect, it } from 'vitest';

import {
  filterOpenAICompatibleModelIds,
  getOpenAICompatibleModelAllowRegex,
  isOpenAICompatibleModelAllowed,
} from '../openAICompatibleModelFilters';

describe('openAICompatibleModelFilters', () => {
  it('keeps only OpenRouter free models by default', () => {
    expect(filterOpenAICompatibleModelIds('openrouter', [
      'openai/gpt-oss-20b:free',
      'meta-llama/llama-3.3-70b-instruct',
      'anthropic/claude-sonnet-4',
      'google/gemini-2.5-flash:free',
    ])).toEqual([
      'openai/gpt-oss-20b:free',
      'google/gemini-2.5-flash:free',
    ]);
  });

  it('strips provider prefixes before matching', () => {
    expect(isOpenAICompatibleModelAllowed('openrouter', 'openrouter:google/gemini-2.5-flash:free')).toBe(true);
    expect(isOpenAICompatibleModelAllowed('openrouter', 'openrouter:google/gemini-2.5-pro')).toBe(false);
  });

  it('supports regex overrides for keyword bridges', () => {
    expect(filterOpenAICompatibleModelIds(
      'featherless-keyword',
      ['qwen/qwen3-coder', 'meta-llama/llama-3.1-instruct', 'deepseek-ai/deepseek-r1'],
      'deepseek|coder',
    )).toEqual([
      'qwen/qwen3-coder',
      'deepseek-ai/deepseek-r1',
    ]);
  });

  it('matches Featherless official against the provider segment only', () => {
    expect(filterOpenAICompatibleModelIds('featherless-official', [
      'qwen/qwen3-coder',
      'random/qwen-coder',
      'meta-llama/llama-3.1-instruct',
      'unknown/meta-llama-chat',
    ])).toEqual([
      'qwen/qwen3-coder',
      'meta-llama/llama-3.1-instruct',
    ]);
  });

  it('returns a case-insensitive regex when a provider has a built-in filter', () => {
    const regex = getOpenAICompatibleModelAllowRegex('featherless-heretic');
    expect(regex).toBeInstanceOf(RegExp);
    expect(regex?.flags.includes('i')).toBe(true);
  });
});
