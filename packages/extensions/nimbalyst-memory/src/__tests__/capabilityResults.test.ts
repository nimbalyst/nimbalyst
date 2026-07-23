import { describe, expect, it } from 'vitest';
import {
  buildOptionalAiUnavailableResult,
  retrievalKindForOptionalProvider,
} from '../capabilityResults';

describe('optional provider availability results', () => {
  it('selects local sparse retrieval unless a provider was explicitly configured', () => {
    expect(retrievalKindForOptionalProvider(false)).toBe('sparse');
    expect(retrievalKindForOptionalProvider(true)).toBe('openai');
  });

  it('returns a structured manual fallback without soliciting credentials', () => {
    const result = buildOptionalAiUnavailableResult('plans');

    expect(result).toEqual({
      candidates: [],
      sources: [],
      sourceClass: 'plans',
      capability: {
        available: false,
        reason: 'optional-ai-provider-unavailable',
      },
      fallback: {
        used: true,
        kind: 'manual-remember',
        hint: 'Use remember to store durable facts manually.',
      },
    });
    expect(JSON.stringify(result)).not.toMatch(/api key|credential|configure.*settings/i);
  });
});
