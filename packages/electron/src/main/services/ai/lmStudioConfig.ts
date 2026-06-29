import Store from 'electron-store';
import type { OpenAICompatibleProviderType } from '@nimbalyst/runtime/ai/server/types';

export const DEFAULT_LMSTUDIO_BASE_URL = 'http://127.0.0.1:1234';
export const DUMMY_OPENAI_COMPATIBLE_API_KEY = 'DUMMY_NIMBALYST_KEY';

export const OPENAI_COMPATIBLE_PROVIDER_DEFAULT_BASE_URLS: Partial<Record<OpenAICompatibleProviderType, string>> = {};

function cleanBaseUrl(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

/**
 * LM Studio used to store its endpoint in apiKeys.lmstudio_url. The current
 * settings UI stores it on providerSettings.lmstudio.baseUrl. Prefer the
 * provider config so connection tests, model discovery, and chat all agree.
 */
export function getConfiguredLMStudioBaseUrl(settingsStore: Store<Record<string, unknown>>): string {
  const providerSettings = settingsStore.get('providerSettings', {}) as Record<string, { baseUrl?: string }>;
  const apiKeys = settingsStore.get('apiKeys', {}) as Record<string, string>;

  return (
    cleanBaseUrl(providerSettings['lmstudio']?.baseUrl) ||
    cleanBaseUrl(apiKeys['lmstudio_url']) ||
    DEFAULT_LMSTUDIO_BASE_URL
  );
}

export function getConfiguredOpenAIBaseUrl(settingsStore: Store<Record<string, unknown>>): string | undefined {
  const providerSettings = settingsStore.get('providerSettings', {}) as Record<string, { baseUrl?: string }>;
  return cleanBaseUrl(providerSettings['openai']?.baseUrl);
}

export function getConfiguredOpenAICompatibleBaseUrl(
  settingsStore: Store<Record<string, unknown>>,
  provider: OpenAICompatibleProviderType,
): string | undefined {
  const providerSettings = settingsStore.get('providerSettings', {}) as Record<string, { baseUrl?: string }>;
  return cleanBaseUrl(providerSettings[provider]?.baseUrl) || OPENAI_COMPATIBLE_PROVIDER_DEFAULT_BASE_URLS[provider];
}
