export const GEMINI_MODEL_SETTINGS = {
  low: 'ai.gemini.lowModel',
  medium: 'ai.gemini.mediumModel',
  high: 'ai.gemini.highModel',
} as const;

export type GeminiModelTier = keyof typeof GEMINI_MODEL_SETTINGS;

/** Validate saved IDs independently of a changing live catalog. */
export function isGeminiTierModel(tier: GeminiModelTier, id: string): boolean {
  const prefix = 'antigravity-gemini-agent:';
  if (!id.startsWith(prefix)) return false;
  const key = id.slice(prefix.length);
  switch (tier) {
    case 'low': return /^gemini-\d+(?:\.\d+)?-flash-lite(?:-(?:high|medium|low|tiered))?$/.test(key);
    case 'medium': return /^gemini-3\.8-flash(?:-(?:high|medium|low|tiered))?$/.test(key);
    case 'high': return /^gemini-\d+(?:\.\d+)?-pro(?:-(?:high|medium|low|tiered))?$/.test(key);
  }
}

export interface GeminiPickerModel {
  id: string;
  name: string;
  provider: string;
  unavailable?: boolean;
}

/** A missing saved choice remains visible; discovery never chooses its replacement. */
export function geminiPresetModels(
  models: GeminiPickerModel[],
  selections: Record<GeminiModelTier, string>,
): GeminiPickerModel[] {
  if (!Object.values(selections).some(Boolean)) return models;
  return (Object.keys(GEMINI_MODEL_SETTINGS) as GeminiModelTier[]).flatMap(tier => {
    const id = selections[tier];
    if (!id) return [];
    const model = models.find(m => m.id === id);
    const label = tier[0].toUpperCase() + tier.slice(1);
    return [{
      ...(model ?? { id, provider: 'antigravity-gemini-agent' }),
      name: `${label} · ${model?.name ?? id.replace(/^antigravity-gemini-agent:/, '')}${model ? '' : ' (unavailable)'}`,
      unavailable: !model || model.unavailable,
    }];
  });
}
