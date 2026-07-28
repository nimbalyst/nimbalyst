import {
  resolveClaudeCodeBackendFromModel,
  type ClaudeCodeBackend,
} from '@nimbalyst/runtime/ai/server';

export interface PersistedClaudeCodeRouteRow {
  model?: string | null;
  metadata?: unknown;
}

export interface ResolvedClaudeCodeSessionRoute {
  model: string | undefined;
  metadata: Record<string, unknown> | undefined;
  backend: ClaudeCodeBackend | undefined;
}

/**
 * Resolve routing from a fresh persisted model identity. An Ollama-marked
 * snapshot cannot use stale memory if persistence is unavailable or changed.
 */
export async function resolveClaudeCodeSessionRoute(
  sessionId: string,
  snapshotModel: string | undefined,
  snapshotMetadata: Record<string, unknown> | undefined,
  loadPersisted: () => Promise<PersistedClaudeCodeRouteRow | null>
): Promise<ResolvedClaudeCodeSessionRoute> {
  const snapshotBackend = resolveClaudeCodeBackendFromModel(snapshotModel);
  let fresh: PersistedClaudeCodeRouteRow | null;
  try {
    fresh = await loadPersisted();
  } catch (error) {
    if (snapshotBackend) {
      const reason = error instanceof Error ? error.message : String(error);
      throw new Error(
        `Ollama Claude Code session ${sessionId} cannot refresh its persisted model identity: ${reason}`
      );
    }
    return { model: snapshotModel, metadata: snapshotMetadata, backend: undefined };
  }

  if (!fresh) {
    if (snapshotBackend) {
      throw new Error(`Ollama Claude Code session ${sessionId} has no persisted session row`);
    }
    return { model: snapshotModel, metadata: snapshotMetadata, backend: undefined };
  }

  const model = fresh.model || undefined;
  const backend = resolveClaudeCodeBackendFromModel(model);
  if (snapshotBackend && backend?.persistedModel !== snapshotBackend.persistedModel) {
    throw new Error(
      `Ollama Claude Code session ${sessionId} persisted model identity changed or was lost`
    );
  }

  return {
    model,
    metadata: fresh.metadata as Record<string, unknown> | undefined,
    backend,
  };
}
