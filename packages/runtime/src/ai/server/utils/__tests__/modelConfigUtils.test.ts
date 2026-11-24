// @vitest-environment node
import { describe, expect, it } from 'vitest';
import {
  normalizeCodexProviderConfig,
  omitModelsField,
  stripTransientProviderFields,
} from '../modelConfigUtils';

describe('normalizeCodexProviderConfig', () => {
  it('strips stale models allowlists from dynamic-discovery providers including antigravity-gemini-agent', () => {
    const input = {
      'antigravity-gemini-agent': {
        enabled: true,
        models: [
          'antigravity-gemini-agent:gemini-3-flash-agent',
          'antigravity-gemini-agent:gemini-3.5-flash-low',
        ],
        hiddenModels: ['antigravity-gemini-agent:gemini-3.7-flash-low'],
      },
      'openai-codex': {
        enabled: true,
        models: ['openai-codex:old-model'],
      },
      'copilot-cli': {
        enabled: true,
        models: ['copilot-cli:old-model'],
      },
      openai: {
        enabled: true,
        models: ['openai:gpt-5'],
      },
    };

    const result = normalizeCodexProviderConfig(input);

    expect(result['antigravity-gemini-agent']).toEqual({
      enabled: true,
      hiddenModels: ['antigravity-gemini-agent:gemini-3.7-flash-low'],
    });
    expect('models' in result['antigravity-gemini-agent']).toBe(false);
    expect(result['openai-codex']).toEqual({ enabled: true });
    expect(result['copilot-cli']).toEqual({ enabled: true });
    expect(result.openai).toEqual({
      enabled: true,
      models: ['openai:gpt-5'],
    });
  });

  it('returns the original reference when no dynamic-discovery provider has a models field', () => {
    const input = {
      'antigravity-gemini-agent': { enabled: true },
      openai: { enabled: true, models: ['openai:gpt-5'] },
    };

    expect(normalizeCodexProviderConfig(input)).toBe(input);
  });
});

describe('omitModelsField', () => {
  it('removes only the models property', () => {
    expect(omitModelsField({ enabled: true, models: ['a'], extra: 1 })).toEqual({
      enabled: true,
      extra: 1,
    });
  });
});

describe('stripTransientProviderFields', () => {
  it('strips testStatus and testMessage while keeping persistent fields', () => {
    const result = stripTransientProviderFields({
      'antigravity-gemini-agent': {
        enabled: true,
        testStatus: 'success',
        testMessage: 'ok',
      },
    });
    expect(result['antigravity-gemini-agent']).toEqual({ enabled: true });
  });
});
