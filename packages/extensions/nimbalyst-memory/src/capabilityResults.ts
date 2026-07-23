export interface OptionalAiUnavailableResult {
  candidates: [];
  sources: [];
  sourceClass: string;
  capability: {
    available: false;
    reason: 'optional-ai-provider-unavailable';
  };
  fallback: {
    used: true;
    kind: 'manual-remember';
    hint: 'Use remember to store durable facts manually.';
  };
}

export function retrievalKindForOptionalProvider(
  explicitlyConfigured: boolean,
): 'openai' | 'sparse' {
  return explicitlyConfigured ? 'openai' : 'sparse';
}

export function buildOptionalAiUnavailableResult(
  sourceClass: string,
): OptionalAiUnavailableResult {
  return {
    candidates: [],
    sources: [],
    sourceClass,
    capability: {
      available: false,
      reason: 'optional-ai-provider-unavailable',
    },
    fallback: {
      used: true,
      kind: 'manual-remember',
      hint: 'Use remember to store durable facts manually.',
    },
  };
}
