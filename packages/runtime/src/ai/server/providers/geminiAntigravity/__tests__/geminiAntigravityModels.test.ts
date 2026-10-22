// @vitest-environment node
import { describe, expect, it } from 'vitest';

import {
  bareGeminiModelKey,
  discoverGeminiModels,
  geminiFamilyKey,
  geminiVariantCandidates,
  isOfferedFlashModel,
  selectGeminiFamilies,
  selectGeminiModels,
} from '../geminiAntigravityModels';
import type { AntigravityModelInfo } from '../AntigravityServerManager';

function model(overrides: Partial<AntigravityModelInfo>): AntigravityModelInfo {
  return {
    key: 'model-key',
    enum: 'MODEL_PLACEHOLDER',
    displayName: 'Gemini 3.7 Flash (Medium)',
    apiProvider: 'API_PROVIDER_GOOGLE_GEMINI',
    ...overrides,
  };
}

function catalogOf(...entries: Array<[key: string, displayName: string]>) {
  return new Map<string, AntigravityModelInfo>(
    entries.map(([key, displayName], i) => [
      key,
      model({ key, displayName, enum: `MODEL_PLACEHOLDER_M${i}` }),
    ]),
  );
}

/** Keys/labels below are verbatim from GetAvailableModels on Antigravity 2.12.2. */
describe('selectGeminiModels', () => {
  it('drops retired Flash tiers that the catalog still lists and the account is still entitled to', () => {
    // The #1519 case: the backend refuses these at request time, but they are
    // present in the catalog and present in clientModelConfigs, so entitlement
    // filtering alone leaves them in the picker.
    const catalog = catalogOf(
      ['gemini-3-flash-agent', 'Gemini 3.5 Flash (High)'],
      ['gemini-3.5-flash-low', 'Gemini 3.5 Flash (Medium)'],
      ['gemini-3.6-flash-high', 'Gemini 3.6 Flash (High)'],
      ['gemini-3.7-flash-medium', 'Gemini 3.7 Flash (Medium)'],
    );
    const entitled = new Set([...catalog.values()].map((m) => m.enum));

    expect(selectGeminiModels(catalog, entitled)).toEqual([
      { key: 'gemini-3.7-flash-medium', displayName: 'Gemini 3.7 Flash (Medium)' },
    ]);
  });

  it('offers every 3.7 and 3.8 Flash tier', () => {
    const catalog = catalogOf(
      ['gemini-3.7-flash-high', 'Gemini 3.7 Flash (High)'],
      ['gemini-3.7-flash-low', 'Gemini 3.7 Flash (Low)'],
      ['gemini-3.7-flash-medium', 'Gemini 3.7 Flash (Medium)'],
      ['gemini-3.8-flash-high', 'Gemini 3.8 Flash (High)'],
      ['gemini-3.8-flash-low', 'Gemini 3.8 Flash (Low)'],
      ['gemini-3.8-flash-medium', 'Gemini 3.8 Flash (Medium)'],
    );

    expect(selectGeminiModels(catalog, new Set()).map((m) => m.key)).toEqual([
      'gemini-3.7-flash-high',
      'gemini-3.7-flash-low',
      'gemini-3.7-flash-medium',
      'gemini-3.8-flash-high',
      'gemini-3.8-flash-low',
      'gemini-3.8-flash-medium',
    ]);
  });

  it('offers a recognized unlabelled tiered slot without offering non-Google entries', () => {
    const catalog = catalogOf(['gemini-3.7-flash-tiered', '']);
    catalog.set('claude-something', model({
      key: 'claude-something',
      enum: 'MODEL_CLAUDE',
      displayName: 'Gemini 3.8 Flash (High)',
      apiProvider: 'API_PROVIDER_ANTHROPIC',
    }));

    expect(selectGeminiModels(catalog, new Set())).toEqual([
      { key: 'gemini-3.7-flash-tiered', displayName: 'Gemini 3.7 Flash (Tiered)' },
    ]);
  });

  it('offers entitled Flash Lite, 3.8 Flash tiered, and Pro using real catalog keys', () => {
    const catalog = catalogOf(
      ['gemini-3.5-flash-lite', 'Gemini 3.5 Flash Lite'],
      ['gemini-3.8-flash-tiered', ''],
      ['gemini-3.1-pro-high', 'Gemini 3.1 Pro (High)'],
      ['gemini-4-argon', 'Argon 4'],
      ['gemini-3.1-flash-image', 'Gemini 3.1 Flash Image'],
      ['experimental-unknown', ''],
    );
    expect(selectGeminiModels(catalog, new Set()).map(m => m.key).sort()).toEqual([
      'gemini-3.1-pro-high', 'gemini-3.5-flash-lite', 'gemini-3.8-flash-tiered',
    ]);
    expect(selectGeminiModels(catalog, new Set(['MODEL_PLACEHOLDER_M1']))).toEqual([
      { key: 'gemini-3.8-flash-tiered', displayName: 'Gemini 3.8 Flash (Tiered)' },
    ]);
  });

  it('offers entitled Gemini 4 Argon tiers by their real labels (Antigravity 2.24.0)', () => {
    const catalog = catalogOf(
      ['gemini-4-argon-high', 'Gemini 4 Argon (High)'],
      ['gemini-4-argon-low', 'Gemini 4 Argon (Low)'],
      ['gemini-4-argon-medium', 'Gemini 4 Argon (Medium)'],
      ['gemini-3.1-flash-image', 'Gemini 3.1 Flash Image'],
    );
    expect(selectGeminiModels(catalog, new Set()).map((m) => m.key)).toEqual([
      'gemini-4-argon-high', 'gemini-4-argon-low', 'gemini-4-argon-medium',
    ]);
  });

  it('groups variants into one entry per family like the Gemini app (Antigravity 2.24.0 catalog)', () => {
    const catalog = catalogOf(
      ['gemini-2.5-flash-lite', 'Gemini 3.5 Flash Lite'], // mislabelled legacy slot
      ['gemini-3.1-flash-lite', 'Gemini 3.1 Flash Lite'],
      ['gemini-3.5-flash-lite', 'Gemini 3.5 Flash Lite'],
      ['gemini-3.7-flash-medium', 'Gemini 3.7 Flash (Medium)'],
      ['gemini-3.8-flash-high', 'Gemini 3.8 Flash (High)'],
      ['gemini-3.8-flash-low', 'Gemini 3.8 Flash (Low)'],
      ['gemini-3.8-flash-medium', 'Gemini 3.8 Flash (Medium)'],
      ['gemini-3.8-flash-tiered', ''],
      ['gemini-4-argon-high', 'Gemini 4 Argon (High)'],
      ['gemini-4-argon-medium', 'Gemini 4 Argon (Medium)'],
      ['gemini-3.1-flash-image', 'Gemini 3.1 Flash Image'],
    );
    // Entitlement lists only the agent variants (as clientModelConfigs does);
    // the newest Flash-Lite is offered anyway because GetModelResponse serves it.
    const entitled = new Set([...catalog.values()]
      .filter((m) => /flash-(high|low|medium)$|argon/.test(m.key))
      .map((m) => m.enum));
    expect(selectGeminiFamilies(catalog, entitled)).toEqual([
      { key: 'gemini-3.5-flash-lite', displayName: 'Gemini 3.5 Flash-Lite' },
      { key: 'gemini-3.8-flash', displayName: 'Gemini 3.8 Flash' },
      { key: 'gemini-4-argon', displayName: 'Gemini 4 Argon' },
    ]);
  });

  it('resolves a family to the thinking-level variant, and keeps explicit variants', () => {
    expect(geminiVariantCandidates('gemini-3.8-flash', 'high')[0]).toBe('gemini-3.8-flash-high');
    expect(geminiVariantCandidates('gemini-3.5-flash-lite', 'low').slice(0, 2))
      .toEqual(['gemini-3.5-flash-lite-low', 'gemini-3.5-flash-lite']);
    expect(geminiVariantCandidates('gemini-3.8-flash-medium', 'high')).toEqual(['gemini-3.8-flash-medium']);
    expect(geminiVariantCandidates('gemini-3.8-flash-tiered', 'low')).toEqual(['gemini-3.8-flash-tiered']);
    expect(geminiFamilyKey('gemini-4-argon-low')).toBe('gemini-4-argon');
  });

  it('still honours entitlement for a current generation', () => {
    const catalog = catalogOf(['gemini-3.8-flash-medium', 'Gemini 3.8 Flash (Medium)']);

    expect(selectGeminiModels(catalog, new Set(['MODEL_SOMETHING_ELSE']))).toEqual([]);
  });
});

describe('isOfferedFlashModel', () => {
  it('accepts a generation newer than the floor without a code change', () => {
    // The point of a floor rather than an allowlist: the next generation is
    // offered the moment the server reports it.
    expect(isOfferedFlashModel('Gemini 3.9 Flash (High)')).toBe(true);
    expect(isOfferedFlashModel('Gemini 4.0 Flash')).toBe(true);
    // Compared component-wise, so a two-digit minor sorts after 3.9, not before 3.2.
    expect(isOfferedFlashModel('Gemini 3.10 Flash')).toBe(true);
  });

  it('rejects lookalike products that merely share the prefix', () => {
    // Real labels from the 2.12.2 catalog -- different products, not Flash tiers.
    expect(isOfferedFlashModel('Gemini 3.5 Flash Lite')).toBe(false);
    expect(isOfferedFlashModel('Gemini 3.1 Flash Image')).toBe(false);
    expect(isOfferedFlashModel('Gemini 3.1 Pro (High)')).toBe(false);
  });
});

describe('discovery and explicit selection', () => {
  it('does not invent models before discovery or after a successful empty catalog', async () => {
    const server = {
      currentEndpoint: () => null,
      getAvailableModels: async () => new Map(),
      getUserStatus: async () => ({}),
    };
    expect(await discoverGeminiModels(server as any)).toEqual([]);
    expect(await discoverGeminiModels({ ...server, currentEndpoint: () => ({ port: 1 }) } as any)).toEqual([]);
  });

  it('surfaces a catalog transport error without substituting models', async () => {
    const server = {
      currentEndpoint: () => ({ port: 1 }),
      getAvailableModels: async () => { throw new Error('Antigravity unreachable'); },
      getUserStatus: async () => ({}),
    };
    await expect(discoverGeminiModels(server as any)).rejects.toThrow('Antigravity unreachable');
  });

  it('requires an explicit model and never turns a foreign provider into a Gemini selection', () => {
    for (const value of [undefined, null, '', 'opencode:gemini-3.8-flash-tiered']) {
      expect(() => bareGeminiModelKey(value)).toThrow();
    }
    expect(bareGeminiModelKey('antigravity-gemini-agent:gemini-3.8-flash-tiered')).toBe('gemini-3.8-flash-tiered');
    expect(bareGeminiModelKey('gemini-3.8-flash-tiered')).toBe('gemini-3.8-flash-tiered');
  });
});
