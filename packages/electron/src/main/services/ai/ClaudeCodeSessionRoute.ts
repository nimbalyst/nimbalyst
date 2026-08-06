import {
  isCatalogPersistedModelId,
  resolveClaudeCodeBackendFromModel,
  type ClaudeCodeBackend,
} from '@nimbalyst/runtime/ai/server';

export interface PersistedClaudeCodeRouteRow {
  model?: string | null;
  metadata?: unknown;
  workspacePath?: string;
}

export interface ResolvedClaudeCodeSessionRoute {
  model: string | undefined;
  metadata: Record<string, unknown> | undefined;
  backend: ClaudeCodeBackend | undefined;
  workspacePath: string | undefined;
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
  const snapshotCatalogModel = snapshotModel
    ? isCatalogPersistedModelId(snapshotModel)
    : false;
  let fresh: PersistedClaudeCodeRouteRow | null;
  try {
    fresh = await loadPersisted();
  } catch (error) {
    if (snapshotCatalogModel) {
      const reason = error instanceof Error ? error.message : String(error);
      throw new Error(
        `Catalog-routed Claude Code session ${sessionId} cannot refresh its persisted model identity: ${reason}`
      );
    }
    return {
      model: snapshotModel,
      metadata: snapshotMetadata,
      backend: undefined,
      workspacePath: undefined,
    };
  }

  if (!fresh) {
    if (snapshotCatalogModel) {
      throw new Error(
        `Catalog-routed Claude Code session ${sessionId} has no persisted session row`
      );
    }
    return {
      model: snapshotModel,
      metadata: snapshotMetadata,
      backend: undefined,
      workspacePath: undefined,
    };
  }

  const model = fresh.model || undefined;
  const backend = resolveClaudeCodeBackendFromModel(model);
  if (
    snapshotCatalogModel &&
    (model !== snapshotModel ||
      (snapshotBackend &&
        backend?.persistedModel !== snapshotBackend.persistedModel))
  ) {
    throw new Error(
      `Catalog-routed Claude Code session ${sessionId} persisted model identity changed or was lost`
    );
  }

  return {
    model,
    metadata: fresh.metadata as Record<string, unknown> | undefined,
    backend,
    workspacePath: fresh.workspacePath,
  };
}
