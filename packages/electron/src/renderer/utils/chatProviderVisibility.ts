export const DIRECT_CHAT_PROVIDER_IDS = ['claude', 'openai', 'lmstudio'] as const;

export type DirectChatProviderId = typeof DIRECT_CHAT_PROVIDER_IDS[number];

export const DEFAULT_LM_STUDIO_BASE_URL = 'http://127.0.0.1:8234';

const directChatProviderIds = new Set<string>(DIRECT_CHAT_PROVIDER_IDS);

const apiKeyNames: Partial<Record<DirectChatProviderId, string>> = {
  claude: 'anthropic',
  openai: 'openai',
};

export interface ChatProviderConfigSnapshot {
  enabled?: boolean;
  apiKey?: string;
  baseUrl?: string;
  models?: string[];
}

export interface ChatProviderSettingsSnapshot {
  providers: Record<string, ChatProviderConfigSnapshot | undefined>;
  apiKeys: Record<string, string | undefined>;
}

export interface DirectChatProviderVisibilityOptions {
  revealAll: boolean;
  settings: ChatProviderSettingsSnapshot;
  preserveProviderId?: string | null;
  hasProjectOverride?: boolean;
}

export function isDirectChatProvider(providerId: string): providerId is DirectChatProviderId {
  return directChatProviderIds.has(providerId);
}

function hasText(value: string | undefined): boolean {
  return typeof value === 'string' && value.trim().length > 0;
}

function normalizeBaseUrl(value: string): string {
  return value.trim().replace(/\/+$/, '').toLowerCase();
}

export function isDirectChatProviderMeaningfullyConfigured(
  providerId: DirectChatProviderId,
  settings: ChatProviderSettingsSnapshot,
): boolean {
  const config = settings.providers[providerId];
  if (config?.enabled || (config?.models?.length ?? 0) > 0 || hasText(config?.apiKey)) {
    return true;
  }

  const apiKeyName = apiKeyNames[providerId];
  if (apiKeyName && hasText(settings.apiKeys[apiKeyName])) {
    return true;
  }

  if (providerId !== 'lmstudio') {
    return false;
  }

  const defaultBaseUrl = normalizeBaseUrl(DEFAULT_LM_STUDIO_BASE_URL);
  return [config?.baseUrl, settings.apiKeys.lmstudio_url].some((baseUrl) =>
    hasText(baseUrl) && normalizeBaseUrl(baseUrl!) !== defaultBaseUrl,
  );
}

export function hasConfiguredDirectChatProvider(settings: ChatProviderSettingsSnapshot): boolean {
  return DIRECT_CHAT_PROVIDER_IDS.some((providerId) =>
    isDirectChatProviderMeaningfullyConfigured(providerId, settings),
  );
}

export function shouldShowDirectChatProviderSettings(
  revealAll: boolean,
  settings: ChatProviderSettingsSnapshot,
): boolean {
  return revealAll || hasConfiguredDirectChatProvider(settings);
}

export function isProviderVisible(
  providerId: string,
  options: DirectChatProviderVisibilityOptions,
): boolean {
  if (!isDirectChatProvider(providerId)) {
    return true;
  }

  return options.revealAll
    || options.preserveProviderId === providerId
    || options.hasProjectOverride === true
    || isDirectChatProviderMeaningfullyConfigured(providerId, options.settings);
}
