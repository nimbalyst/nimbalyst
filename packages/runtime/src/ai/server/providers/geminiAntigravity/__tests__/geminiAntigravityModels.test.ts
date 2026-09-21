// @vitest-environment node
import { describe, expect, it } from 'vitest';

import {
  DEFAULT_GEMINI_MODEL_KEY,
  SEED_GEMINI_MODELS,
  isOfferedFlashModel,
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

  it('excludes unlabelled tiered slots and non-Google entries', () => {
    const catalog = catalogOf(['gemini-3.7-flash-tiered', '']);
    catalog.set('claude-something', model({
      key: 'claude-something',
      enum: 'MODEL_CLAUDE',
      displayName: 'Gemini 3.8 Flash (High)',
      apiProvider: 'API_PROVIDER_ANTHROPIC',
    }));

    expect(selectGeminiModels(catalog, new Set())).toEqual([]);
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

describe('seed catalog', () => {
  it('defaults to a key the seed actually offers', () => {
    // A default absent from the catalog is the #1519 failure mode, so the two
    // must not drift apart.
    expect(SEED_GEMINI_MODELS.map((m) => m.key)).toContain(DEFAULT_GEMINI_MODEL_KEY);
  });

  it('seeds only models the picker would accept from live discovery', () => {
    for (const { displayName } of SEED_GEMINI_MODELS) {
      expect(isOfferedFlashModel(displayName)).toBe(true);
    }
  });
});
