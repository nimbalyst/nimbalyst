import {
  ModelIdentifier,
  type AIProviderType,
} from '@nimbalyst/runtime/ai/server/types';

export interface SessionModelSelection {
  provider: AIProviderType;
  model: string;
}

/**
 * Keep the persisted session provider aligned with a provider-qualified model.
 * The model is authoritative when it carries a valid provider prefix; otherwise
 * the requested provider is preserved for legacy/raw model selections.
 */
export function resolveSessionModelSelection(
  requestedProvider: AIProviderType,
  requestedModel?: string | null,
): SessionModelSelection {
  if (!requestedModel) {
    return {
      provider: requestedProvider,
      model: ModelIdentifier.getDefaultModelId(requestedProvider),
    };
  }

  const parsedModel = ModelIdentifier.tryParse(requestedModel);
  return {
    provider: parsedModel?.provider ?? requestedProvider,
    model: requestedModel,
  };
}
