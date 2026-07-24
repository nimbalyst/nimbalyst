import { describe, expect, it } from 'vitest';

import {
  DEFAULT_LM_STUDIO_BASE_URL,
  hasConfiguredDirectChatProvider,
  isDirectChatProviderMeaningfullyConfigured,
  isProviderVisible,
  shouldShowDirectChatProviderSettings,
  type ChatProviderSettingsSnapshot,
} from '../chatProviderVisibility';

function settings(
  providers: ChatProviderSettingsSnapshot['providers'] = {},
  apiKeys: ChatProviderSettingsSnapshot['apiKeys'] = {},
): ChatProviderSettingsSnapshot {
  return { providers, apiKeys };
}

describe('chat provider visibility policy', () => {
  it('treats untouched direct chat providers as unconfigured', () => {
    const snapshot = settings({
      claude: { enabled: false },
      openai: { enabled: false, models: [] },
      lmstudio: { enabled: false, baseUrl: DEFAULT_LM_STUDIO_BASE_URL },
    }, {
      anthropic: '   ',
      openai: '',
      lmstudio_url: `${DEFAULT_LM_STUDIO_BASE_URL}/`,
    });

    expect(hasConfiguredDirectChatProvider(snapshot)).toBe(false);
    expect(shouldShowDirectChatProviderSettings(false, snapshot)).toBe(false);
  });

  it.each([
    ['enabled provider', settings({ claude: { enabled: true } }), 'claude'],
    ['selected models', settings({ openai: { models: ['openai:gpt-5'] } }), 'openai'],
    ['relevant API key', settings({}, { anthropic: 'sk-ant-test' }), 'claude'],
    ['provider API key', settings({ openai: { apiKey: 'sk-project' } }), 'openai'],
    ['non-default LM Studio URL', settings({ lmstudio: { baseUrl: 'http://localhost:1234' } }), 'lmstudio'],
    ['legacy LM Studio URL', settings({}, { lmstudio_url: 'http://localhost:1234' }), 'lmstudio'],
  ] as const)('recognizes %s as meaningful configuration', (_label, snapshot, providerId) => {
    expect(isDirectChatProviderMeaningfullyConfigured(providerId, snapshot)).toBe(true);
    expect(shouldShowDirectChatProviderSettings(false, snapshot)).toBe(true);
  });

  it('reveals all direct providers only when requested, while preserving configured and project providers', () => {
    const snapshot = settings({ openai: { enabled: true } });

    expect(isProviderVisible('claude', { revealAll: false, settings: snapshot })).toBe(false);
    expect(isProviderVisible('openai', { revealAll: false, settings: snapshot })).toBe(true);
    expect(isProviderVisible('lmstudio', {
      revealAll: false,
      settings: snapshot,
      hasProjectOverride: true,
    })).toBe(true);
    expect(isProviderVisible('claude', {
      revealAll: false,
      settings: snapshot,
      preserveProviderId: 'claude',
    })).toBe(true);
    expect(isProviderVisible('claude', { revealAll: true, settings: snapshot })).toBe(true);
    expect(isProviderVisible('claude-code', { revealAll: false, settings: snapshot })).toBe(true);
  });
});
