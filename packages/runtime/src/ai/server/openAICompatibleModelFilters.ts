import type { OpenAICompatibleProviderType } from './types';

export const OPENAI_COMPATIBLE_MODEL_ALLOW_REGEXES: Partial<Record<OpenAICompatibleProviderType, string>> = {
  openrouter: '(^|[-/:])free($|[-/:])|:free$',
  'featherless-official': '^(qwen|cohere|mistralai|meta-llama|google|microsoft|nvidia|nousresearch|deepseek-ai|moonshotai|z-ai|openai|01-ai|allenai|tiiuae|ibm-granite|writer)$',
  'featherless-sane': '^(qwen|cohere|mistralai|meta-llama|google|microsoft|nvidia|nousresearch|deepseek-ai|moonshotai|z-ai|openai|01-ai|allenai|tiiuae|ibm-granite|writer)/|hermes|qwen.*coder|coder|instruct|chat',
  'featherless-heretic': '(heretic|abliterat|ablated|uncensor|dolphin|lexi|libre|orthodox|dark|venice|wizard-vicuna|openhermes|nous-hermes|deephermes)',
  'featherless-keyword': '(code|coder|coding)',
};

function stripProviderPrefix(provider: OpenAICompatibleProviderType, modelId: string): string {
  const prefix = `${provider}:`;
  return modelId.startsWith(prefix) ? modelId.slice(prefix.length) : modelId;
}

function getModelProvider(modelId: string): string {
  return modelId.split('/', 1)[0] || modelId;
}

function getFilterTarget(provider: OpenAICompatibleProviderType, modelId: string): string {
  const stripped = stripProviderPrefix(provider, modelId);
  return provider === 'featherless-official'
    ? getModelProvider(stripped)
    : stripped;
}

export function getOpenAICompatibleModelAllowRegex(provider: OpenAICompatibleProviderType, overrideRegex?: string): RegExp | null {
  const regex = overrideRegex || OPENAI_COMPATIBLE_MODEL_ALLOW_REGEXES[provider];
  if (!regex) return null;
  return new RegExp(regex, 'i');
}

export function isOpenAICompatibleModelAllowed(
  provider: OpenAICompatibleProviderType,
  modelId: string,
  overrideRegex?: string,
): boolean {
  const allowRegex = getOpenAICompatibleModelAllowRegex(provider, overrideRegex);
  if (!allowRegex) return true;
  return allowRegex.test(getFilterTarget(provider, modelId));
}

export function filterOpenAICompatibleModelIds(
  provider: OpenAICompatibleProviderType,
  modelIds: string[],
  overrideRegex?: string,
): string[] {
  return modelIds.filter((modelId) => isOpenAICompatibleModelAllowed(provider, modelId, overrideRegex));
}
