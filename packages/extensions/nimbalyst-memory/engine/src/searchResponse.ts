import type {
  ProjectSearchResponse,
  RetrievalCapabilities,
  SearchHit,
} from './types.js';
import type { EngineStatus } from './engine.js';

const LOCAL_FALLBACK_HINT =
  'Keyword search ran locally. If results are insufficient, use normal ' +
  'workspace file/text search over project Markdown.';

export function buildProjectSearchResponse(
  chunks: SearchHit[],
  capabilities: RetrievalCapabilities,
): ProjectSearchResponse {
  return {
    chunks,
    capabilities,
    fallback: {
      used: capabilities.mode === 'keyword-only',
      kind: 'local-keyword-index',
      hint: LOCAL_FALLBACK_HINT,
    },
  };
}

/** Remove diagnostic provider error text before status crosses a user/tool boundary. */
export function buildPublicEngineStatus(
  status: EngineStatus,
): Omit<EngineStatus, 'lastEmbedError'> {
  const { lastEmbedError, ...publicStatus } = status;
  void lastEmbedError;
  return publicStatus;
}
