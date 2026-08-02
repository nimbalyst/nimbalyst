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
import {
  ClaudeCodeProvider,
  ProviderFactory,
} from '@nimbalyst/runtime/ai/server';
import type { SessionData } from '@nimbalyst/runtime/ai/server/types';
import type { ClaudeAgentRuntimeRouteBundle } from '@nimbalyst/runtime/ai/server/providers/claudeCode/runtimeRouteResolver';
import { preflightOllamaClaudeCodeBackend } from '../OllamaClaudeCodePreflight';
import {
  buildClaudeCodeRuntimeConfigForTurn,
  prepareClaudeCodeProviderTurn,
} from '../ClaudeCodeTurnLifecycle';

const SESSION_ID = 'ollama-lifecycle-session';
const PROVIDER_SESSION_ID = 'stable-provider-session-id';
const PERSISTED_MODEL = 'claude-code:ollama-glm-5-2-cloud';
const WORKSPACE_PATH = 'D:/workspace-only';
const GENERAL_ROUTE_CASES = [
  {
    label: 'Claudex Sol',
    sessionId: 'claudex-sol-lifecycle-session',
    model: 'claude-code:claudex-sol',
    catalogEntryId: 'claudex-sol',
  },
  {
    label: 'OpenRouter Flash',
    sessionId: 'openrouter-flash-lifecycle-session',
    model: 'claude-code:openrouter-deepseek-v4-flash',
    catalogEntryId: 'deepseek-v4-flash-openrouter',
  },
] as const;

describe('Claude Code MessageStreamingHandler turn lifecycle', () => {
  beforeEach(() => {
    vi.mocked(AISessionsRepository.get).mockReset();
    vi.mocked(preflightOllamaClaudeCodeBackend).mockReset();
    vi.mocked(preflightOllamaClaudeCodeBackend).mockResolvedValue(undefined);
    ProviderFactory.destroyProvider(SESSION_ID, 'claude-code');
    for (const route of GENERAL_ROUTE_CASES) {
      ProviderFactory.destroyProvider(route.sessionId, 'claude-code');
    }
    ClaudeCodeProvider.setProviderCredentialResolver(
      (_credentialRef, context) =>
        context?.workspacePath === WORKSPACE_PATH
          ? 'synthetic-lifecycle-credential-with-forty-characters'
          : undefined,
    );
  });

  afterEach(() => {
    ProviderFactory.destroyProvider(SESSION_ID, 'claude-code');
    for (const route of GENERAL_ROUTE_CASES) {
      ProviderFactory.destroyProvider(route.sessionId, 'claude-code');
    }
    ClaudeCodeProvider.setProviderCredentialResolver(null);
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

  it.each(GENERAL_ROUTE_CASES)(
    'passes $label through the real first, cached, and restored lifecycle',
    async ({ sessionId, model, catalogEntryId }) => {
      let persistedReadVersion = 0;
      vi.mocked(AISessionsRepository.get).mockImplementation(async () => {
        persistedReadVersion += 1;
        return {
          id: sessionId,
          provider: 'claude-code',
          model,
          workspacePath: WORKSPACE_PATH,
          metadata: { persistedReadVersion },
        } as any;
      });
      const firstTurnSession = {
        id: sessionId,
        provider: 'claude-code',
        model,
        workspacePath: WORKSPACE_PATH,
        providerConfig: {},
        metadata: {},
      } as SessionData;
      const firstProvider = ProviderFactory.createProvider(
        'claude-code',
        sessionId,
      );
      const firstInitialize = vi.spyOn(firstProvider, 'initialize');

      const firstConfig = await prepareClaudeCodeProviderTurn(
        firstProvider,
        firstTurnSession,
        () => buildClaudeCodeRuntimeConfigForTurn(firstTurnSession),
      );
      expect(firstConfig).toMatchObject({
        model,
        workspacePath: WORKSPACE_PATH,
      });
      expect(
        (
          firstProvider as unknown as {
            runtimeRoutes: Readonly<ClaudeAgentRuntimeRouteBundle>;
          }
        ).runtimeRoutes.main.model.catalogEntryId,
      ).toBe(catalogEntryId);
      expect(firstInitialize).toHaveBeenCalledTimes(1);

      firstProvider.setProviderSessionData?.(sessionId, {
        providerSessionId: PROVIDER_SESSION_ID,
      });
      const cachedSession = {
        ...firstTurnSession,
        providerSessionId: PROVIDER_SESSION_ID,
      } as SessionData;
      const cachedProvider = ProviderFactory.getProvider(
        'claude-code',
        sessionId,
      );
      expect(cachedProvider).toBe(firstProvider);
      await prepareClaudeCodeProviderTurn(
        cachedProvider!,
        cachedSession,
        () => buildClaudeCodeRuntimeConfigForTurn(cachedSession),
      );
      expect(firstInitialize).toHaveBeenCalledTimes(2);

      ProviderFactory.destroyProvider(sessionId, 'claude-code');
      const restoredProvider = ProviderFactory.createProvider(
        'claude-code',
        sessionId,
      );
      const restoredInitialize = vi.spyOn(restoredProvider, 'initialize');
      const restoredConfig = await prepareClaudeCodeProviderTurn(
        restoredProvider,
        cachedSession,
        () => buildClaudeCodeRuntimeConfigForTurn(cachedSession),
      );

      expect(restoredConfig).toMatchObject({
        model,
        workspacePath: WORKSPACE_PATH,
      });
      expect(restoredInitialize).toHaveBeenCalledTimes(1);
      expect(
        (
          restoredProvider as unknown as {
            runtimeRoutes: Readonly<ClaudeAgentRuntimeRouteBundle>;
          }
        ).runtimeRoutes.main.model.catalogEntryId,
      ).toBe(catalogEntryId);
      expect(restoredProvider.getProviderSessionData?.(sessionId)).toMatchObject(
        { claudeSessionId: PROVIDER_SESSION_ID },
      );
      expect(persistedReadVersion).toBe(3);
      expect(preflightOllamaClaudeCodeBackend).not.toHaveBeenCalled();
    },
  );
});
