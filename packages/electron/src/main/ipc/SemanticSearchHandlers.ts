import { safeHandle } from '../utils/ipcRegistry';
import {
  SemanticCatalogService,
  type SemanticSearchResult,
} from '../services/SemanticCatalogService';

/**
 * IPC for Quick Open global semantic search. Workspace-scoped: the renderer
 * passes its `workspacePath` explicitly (no module-level "current workspace").
 * Both handlers return safely when the memory engine isn't running so the
 * renderer can hide the Memory tab without special-casing errors.
 */
export function registerSemanticSearchHandlers() {
  safeHandle(
    'semantic-search:available',
    async (_event, workspacePath: string): Promise<boolean> => {
      if (!workspacePath) return false;
      return SemanticCatalogService.getInstance().isAvailable(workspacePath);
    },
  );

  safeHandle(
    'semantic-search:query',
    async (
      _event,
      workspacePath: string,
      query: string,
      k?: number,
      sourceClasses?: string[],
    ): Promise<SemanticSearchResult[]> => {
      if (!workspacePath || !query?.trim()) return [];
      return SemanticCatalogService.getInstance().query(
        workspacePath,
        query,
        k ?? 20,
        Array.isArray(sourceClasses) && sourceClasses.length ? sourceClasses : undefined,
      );
    },
  );

  // Session indexing opt-in (off by default). Toggled from the Project Memory
  // settings panel; flipping it (un)backfills sessions across wired workspaces.
  safeHandle('semantic-search:get-index-sessions', async (): Promise<boolean> => {
    return SemanticCatalogService.getInstance().sessionsEnabled();
  });

  safeHandle(
    'semantic-search:set-index-sessions',
    async (_event, enabled: boolean): Promise<{ ok: true }> => {
      await SemanticCatalogService.getInstance().setSessionsEnabled(!!enabled);
      return { ok: true };
    },
  );
}
