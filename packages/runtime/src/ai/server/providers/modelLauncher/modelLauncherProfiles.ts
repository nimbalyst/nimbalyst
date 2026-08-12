import type { AIModel } from '../../types';

export const MODEL_LAUNCHER_PROVIDER_ID = 'model-launcher' as const;

export interface ModelLauncherProfile {
  readonly modelId: string;
  readonly launcherAlias: string;
  readonly resolvedModel: string;
  readonly approvedProvider: 'ollama_cloud';
  readonly label: string;
}

/**
 * Deliberately small user-selected launcher surface.
 *
 * Other Unified Model Launcher aliases remain available through its CLI by
 * exact argument; they are not promoted into Nimbalyst's picker.
 */
export const MODEL_LAUNCHER_PROFILES: readonly ModelLauncherProfile[] = [
  {
    modelId: 'deepseek-pro',
    launcherAlias: 'ollama-deepseek-pro',
    resolvedModel: 'deepseek-v4-pro:cloud',
    approvedProvider: 'ollama_cloud',
    label: 'DeepSeek Pro (Ollama Cloud)',
  },
  {
    modelId: 'deepseek-flash',
    launcherAlias: 'ollama-deepseek-flash',
    resolvedModel: 'deepseek-v4-flash:cloud',
    approvedProvider: 'ollama_cloud',
    label: 'DeepSeek Flash (Ollama Cloud)',
  },
] as const;

export function getModelLauncherProfile(model: string | undefined): ModelLauncherProfile | undefined {
  if (!model) return undefined;
  const modelId = model.startsWith(`${MODEL_LAUNCHER_PROVIDER_ID}:`)
    ? model.slice(MODEL_LAUNCHER_PROVIDER_ID.length + 1)
    : model;
  return MODEL_LAUNCHER_PROFILES.find((profile) => profile.modelId === modelId);
}

export function getModelLauncherModels(): AIModel[] {
  return MODEL_LAUNCHER_PROFILES.map((profile) => ({
    id: `${MODEL_LAUNCHER_PROVIDER_ID}:${profile.modelId}`,
    name: profile.label,
    provider: MODEL_LAUNCHER_PROVIDER_ID,
  }));
}
