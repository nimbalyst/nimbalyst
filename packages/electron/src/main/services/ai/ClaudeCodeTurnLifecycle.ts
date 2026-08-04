import {
  PROVIDER_CATALOG_RESOLUTION,
  resolveClaudeCodeBackend,
  type AIProvider,
} from '@nimbalyst/runtime/ai/server';
import { CLAUDE_CODE_SAFE_FALLBACK_MODEL } from '@nimbalyst/runtime/ai/modelConstants';
import {
  type ProviderConfig,
  type SessionData,
} from '@nimbalyst/runtime/ai/server/types';
import type { ProviderCatalogControlContext } from '@nimbalyst/runtime/ai/server/providers/claudeCode/providerCatalog';
import {
  resolveEffortLevel,
  resolveThinkingMode,
} from '@nimbalyst/runtime/ai/server/effortLevels';
import { applyDeepSeekClaudeAgentProfile } from '@nimbalyst/runtime/ai/server/deepSeekClaudeAgent';
import { AISessionsRepository } from '@nimbalyst/runtime';
import { getDefaultEffortLevel, getDefaultThinkingMode } from '../../utils/store';
import { logger } from '../../utils/logger';
import { resolveClaudeCodeSessionRoute } from './ClaudeCodeSessionRoute';
import { preflightOllamaClaudeCodeBackend } from './OllamaClaudeCodePreflight';

type ResumableProvider = AIProvider & {
  setProviderSessionData?: (
    sessionId: string,
    data: {
      providerSessionId: string;
      claudeSessionId: string;
      codexThreadId: string;
    },
  ) => void;
  getProviderSessionData?: (
    sessionId: string,
  ) => {
    providerSessionId?: string;
    claudeSessionId?: string;
  } | null;
};

/**
 * Build a Claude Code turn from the freshly persisted canonical identity.
 *
 * Cached provider instances never supply routing truth. Every first, cached,
 * and restored turn re-reads persistence and re-qualifies the exact backend
 * before initialization.
 */
export async function buildClaudeCodeRuntimeConfigForTurn(
  session: SessionData,
  apiKey?: string,
  catalogControlContext: ProviderCatalogControlContext = session.providerSessionId ? 'restart' : 'launch',
): Promise<ProviderConfig> {
  const snapshotModel = session.model || session.providerConfig?.model;
  const route = await resolveClaudeCodeSessionRoute(
    session.id,
    snapshotModel,
    session.metadata as Record<string, unknown> | undefined,
    () => AISessionsRepository.get(session.id),
  );
  const runtimeModel = route.model;
  const metadata = route.metadata;
  const backend = route.backend;
  if (backend) {
    await preflightOllamaClaudeCodeBackend(backend);
  }

  const nestedMetadata = metadata?.metadata as Record<string, unknown> | undefined;
  const legacyBackendId =
    (metadata?.claudeCodeBackend as string | undefined)
    ?? (nestedMetadata?.claudeCodeBackend as string | undefined);
  if (legacyBackendId) {
    const legacyBackend = resolveClaudeCodeBackend(legacyBackendId);
    if (!backend || legacyBackend?.persistedModel !== backend.persistedModel) {
      throw new Error(
        `Claude Code session ${session.id} has backend metadata without the matching canonical model identity`,
      );
    }
  }

  const catalogEntry = PROVIDER_CATALOG_RESOLUTION.entries.find(
    (entry) => entry.model.persistedId === runtimeModel,
  );
  const persistedControlKeys = new Set(
    catalogEntry ? Object.values(catalogEntry.controls).map((control) => control.persistenceKey) : [],
  );
  const storedCatalogControlValues = metadata?.catalogControlValues
    && typeof metadata.catalogControlValues === 'object'
    && !Array.isArray(metadata.catalogControlValues)
      ? metadata.catalogControlValues as Readonly<Record<string, unknown>>
      : {};
  const catalogControlValues: Readonly<Record<string, unknown>> | undefined = catalogEntry
    ? {
        ...storedCatalogControlValues,
        ...(!Object.prototype.hasOwnProperty.call(storedCatalogControlValues, 'effort-level')
          && persistedControlKeys.has('effort-level')
          && metadata?.effortLevel != null
          ? { 'effort-level': metadata.effortLevel }
          : {}),
        ...(!Object.prototype.hasOwnProperty.call(storedCatalogControlValues, 'thinking-mode')
          && persistedControlKeys.has('thinking-mode')
          && metadata?.thinkingMode != null
          ? { 'thinking-mode': metadata.thinkingMode }
          : {}),
      }
    : undefined;
  const effortLevel = backend
    ? undefined
    : resolveEffortLevel(metadata?.effortLevel, getDefaultEffortLevel());
  const config: ProviderConfig = {
    workspacePath: route.workspacePath ?? session.workspacePath,
    maxTokens: (session.providerConfig as any)?.maxTokens,
    temperature: (session.providerConfig as any)?.temperature,
    ...(!backend && apiKey ? { apiKey } : {}),
    ...(effortLevel && { effortLevel }),
    ...(catalogControlValues ? { catalogControlValues } : {}),
    catalogControlContext,
    ...(!backend
      ? { thinkingMode: resolveThinkingMode(metadata?.thinkingMode, getDefaultThinkingMode()) }
      : { claudeCodeBackend: backend.id }),
    model: runtimeModel || CLAUDE_CODE_SAFE_FALLBACK_MODEL,
  };

  if (backend) {
    logger.main.info('[ClaudeCodeBackend] refreshed per-session route', {
      sessionId: session.id,
      backend: backend.id,
      provider: backend.provider,
      requestedModel: backend.model,
      baseUrl: backend.baseUrl,
    });
  }

  // No-op for a non-DeepSeek config (including an Ollama-backend one, per its
  // own isDeepSeekClaudeAgentModel/isDeepSeekClaudeBackend guard) -- DeepSeek
  // and the Ollama fleet are mutually exclusive per-session identities.
  return applyDeepSeekClaudeAgentProfile(config);
}

/**
 * Actual MessageStreamingHandler lifecycle seam for first, cached, and
 * process-restored Claude Code turns.
 */
export async function prepareClaudeCodeProviderTurn(
  provider: AIProvider,
  session: SessionData,
  buildRuntimeConfig: (context: ProviderCatalogControlContext) => Promise<ProviderConfig>,
): Promise<ProviderConfig> {
  const catalogControlContext = resolveClaudeCodeCatalogControlContext(provider, session);
  const config = await buildRuntimeConfig(catalogControlContext);
  config.catalogControlContext = catalogControlContext;
  await provider.initialize(config);

  if (session.providerSessionId) {
    const resumable = provider as ResumableProvider;
    if (!resumable.setProviderSessionData) {
      throw new Error(
        `[AIService] Claude Code provider cannot restore session ${session.id}`,
      );
    }
    resumable.setProviderSessionData(session.id, {
      providerSessionId: session.providerSessionId,
      claudeSessionId: session.providerSessionId,
      codexThreadId: session.providerSessionId,
    });
    const restored = resumable.getProviderSessionData?.(session.id);
    const restoredId = restored?.providerSessionId ?? restored?.claudeSessionId;
    if (restoredId !== session.providerSessionId) {
      throw new Error(
        `[AIService] Provider session restore failed for session ${session.id}: `
        + `DB has providerSessionId="${session.providerSessionId}" but provider reports `
        + `"${restoredId ?? 'undefined'}". Resume would silently start a fresh conversation.`,
      );
    }
  }

  return config;
}

export function resolveClaudeCodeCatalogControlContext(
  provider: AIProvider,
  session: SessionData,
): ProviderCatalogControlContext {
  if (!session.providerSessionId) return 'launch';
  const restored = (provider as ResumableProvider).getProviderSessionData?.(session.id);
  const restoredId = restored?.providerSessionId ?? restored?.claudeSessionId;
  return restoredId === session.providerSessionId ? 'midSession' : 'restart';
}
