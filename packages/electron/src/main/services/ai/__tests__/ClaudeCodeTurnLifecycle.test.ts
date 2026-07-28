import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@nimbalyst/runtime', () => ({
  AISessionsRepository: {
    get: vi.fn(),
  },
}));

vi.mock('../../../utils/store', () => ({
  getDefaultEffortLevel: () => 'high',
  getDefaultThinkingMode: () => 'enabled',
}));

vi.mock('../../../utils/logger', () => ({
  logger: {
    main: {
      info: vi.fn(),
    },
  },
}));

vi.mock('../OllamaClaudeCodePreflight', () => ({
  preflightOllamaClaudeCodeBackend: vi.fn().mockResolvedValue(undefined),
}));

import { AISessionsRepository } from '@nimbalyst/runtime';
import { ProviderFactory } from '@nimbalyst/runtime/ai/server';
import type { SessionData } from '@nimbalyst/runtime/ai/server/types';
import { preflightOllamaClaudeCodeBackend } from '../OllamaClaudeCodePreflight';
import {
  buildClaudeCodeRuntimeConfigForTurn,
  prepareClaudeCodeProviderTurn,
} from '../ClaudeCodeTurnLifecycle';

const SESSION_ID = 'ollama-lifecycle-session';
const PROVIDER_SESSION_ID = 'stable-provider-session-id';
const PERSISTED_MODEL = 'claude-code:ollama-glm-5-2-cloud';

describe('Claude Code MessageStreamingHandler turn lifecycle', () => {
  beforeEach(() => {
    vi.mocked(AISessionsRepository.get).mockReset();
    vi.mocked(preflightOllamaClaudeCodeBackend).mockReset();
    vi.mocked(preflightOllamaClaudeCodeBackend).mockResolvedValue(undefined);
    ProviderFactory.destroyProvider(SESSION_ID, 'claude-code');
  });

  afterEach(() => {
    ProviderFactory.destroyProvider(SESSION_ID, 'claude-code');
  });

  it('fresh-reads, preflights, and reinitializes first, cached, and restored turns with a stable provider session id', async () => {
    let persistedReadVersion = 0;
    vi.mocked(AISessionsRepository.get).mockImplementation(async () => {
      persistedReadVersion += 1;
      return {
        id: SESSION_ID,
        provider: 'claude-code',
        model: PERSISTED_MODEL,
        metadata: { persistedReadVersion },
      } as any;
    });

    const firstTurnSession = {
      id: SESSION_ID,
      provider: 'claude-code',
      model: PERSISTED_MODEL,
      providerConfig: {},
      metadata: {},
    } as SessionData;
    const firstProvider = ProviderFactory.createProvider('claude-code', SESSION_ID);
    const firstInitialize = vi.spyOn(firstProvider, 'initialize');

    const firstConfig = await prepareClaudeCodeProviderTurn(
      firstProvider,
      firstTurnSession,
      () => buildClaudeCodeRuntimeConfigForTurn(firstTurnSession),
    );

    expect(firstConfig).toMatchObject({
      model: PERSISTED_MODEL,
      claudeCodeBackend: 'ollama-glm-5-2-cloud',
    });
    expect(firstInitialize).toHaveBeenCalledTimes(1);
    expect(AISessionsRepository.get).toHaveBeenCalledTimes(1);
    expect(preflightOllamaClaudeCodeBackend).toHaveBeenCalledTimes(1);

    // The real provider captures this after the SDK's first result. Seeding the
    // same provider-session map here isolates lifecycle behavior without a live
    // provider call.
    firstProvider.setProviderSessionData?.(SESSION_ID, {
      providerSessionId: PROVIDER_SESSION_ID,
    });
    const cachedSession = {
      ...firstTurnSession,
      providerSessionId: PROVIDER_SESSION_ID,
    } as SessionData;
    const cachedProvider = ProviderFactory.getProvider('claude-code', SESSION_ID);
    expect(cachedProvider).toBe(firstProvider);

    await prepareClaudeCodeProviderTurn(
      cachedProvider!,
      cachedSession,
      () => buildClaudeCodeRuntimeConfigForTurn(cachedSession),
    );

    expect(firstInitialize).toHaveBeenCalledTimes(2);
    expect(AISessionsRepository.get).toHaveBeenCalledTimes(2);
    expect(preflightOllamaClaudeCodeBackend).toHaveBeenCalledTimes(2);
    expect(cachedProvider?.getProviderSessionData?.(SESSION_ID)).toMatchObject({
      claudeSessionId: PROVIDER_SESSION_ID,
    });

    // Simulate an app restart: the provider cache and in-memory resume map are
    // gone, while the persisted Nimbalyst session retains its provider ID.
    ProviderFactory.destroyProvider(SESSION_ID, 'claude-code');
    const restoredProvider = ProviderFactory.createProvider('claude-code', SESSION_ID);
    expect(restoredProvider).not.toBe(firstProvider);
    expect(restoredProvider.getProviderSessionData?.(SESSION_ID)).toMatchObject({
      claudeSessionId: undefined,
    });
    const restoredInitialize = vi.spyOn(restoredProvider, 'initialize');

    const resumeConfig = await prepareClaudeCodeProviderTurn(
      restoredProvider,
      cachedSession,
      () => buildClaudeCodeRuntimeConfigForTurn(cachedSession),
    );

    expect(resumeConfig.model).toBe(PERSISTED_MODEL);
    expect(restoredInitialize).toHaveBeenCalledTimes(1);
    expect(AISessionsRepository.get).toHaveBeenCalledTimes(3);
    expect(preflightOllamaClaudeCodeBackend).toHaveBeenCalledTimes(3);
    expect(restoredProvider.getProviderSessionData?.(SESSION_ID)).toMatchObject({
      claudeSessionId: PROVIDER_SESSION_ID,
    });
    expect(persistedReadVersion).toBe(3);
  });
});
