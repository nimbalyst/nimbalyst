import type { ClaudeCodeBackend } from '@nimbalyst/runtime/ai/server';

type FetchLike = typeof fetch;

interface LiteLLMModelInfo {
  model_name?: unknown;
  litellm_params?: {
    model?: unknown;
    api_base?: unknown;
  };
}

interface LiteLLMModelInfoResponse {
  data?: LiteLLMModelInfo[];
}

interface LiteLLMHealthResponse {
  healthy_count?: unknown;
  unhealthy_count?: unknown;
}

async function fetchWithTimeout(
  fetchImpl: FetchLike,
  url: string,
  authToken: string,
  timeoutMs: number
): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetchImpl(url, {
      method: 'GET',
      headers: { Authorization: `Bearer ${authToken}` },
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Prove that the fixed loopback endpoint is a ready LiteLLM proxy carrying the
 * exact approved alias -> Ollama Cloud mapping.
 *
 * This is deliberately a read-only gate. It neither starts nor repairs the
 * proxy, and callers must run it before creating worktrees, session rows, or
 * queue rows.
 */
export async function preflightOllamaClaudeCodeBackend(
  backend: ClaudeCodeBackend,
  fetchImpl: FetchLike = globalThis.fetch,
  timeoutMs = 5_000
): Promise<void> {
  if (backend.baseUrl !== 'http://127.0.0.1:4002') {
    throw new Error(`Ollama Claude Code route rejected unexpected proxy endpoint: ${backend.baseUrl}`);
  }

  try {
    const readiness = await fetchWithTimeout(
      fetchImpl,
      `${backend.baseUrl}/health/readiness`,
      backend.authToken,
      timeoutMs
    );
    if (!readiness.ok) {
      throw new Error(`readiness returned HTTP ${readiness.status}`);
    }

    const modelInfoResponse = await fetchWithTimeout(
      fetchImpl,
      `${backend.baseUrl}/model/info`,
      backend.authToken,
      timeoutMs
    );
    if (!modelInfoResponse.ok) {
      throw new Error(`model identity returned HTTP ${modelInfoResponse.status}`);
    }

    const payload = await modelInfoResponse.json() as LiteLLMModelInfoResponse;
    const matchingAlias = payload.data?.find(
      (entry) => entry.model_name === backend.claudeModelAlias
    );
    if (!matchingAlias) {
      throw new Error(`required alias ${backend.claudeModelAlias} is absent`);
    }
    if (matchingAlias.litellm_params?.model !== backend.upstreamModel) {
      throw new Error(
        `alias ${backend.claudeModelAlias} targets an unexpected upstream model`
      );
    }
    if (matchingAlias.litellm_params?.api_base !== backend.upstreamBaseUrl) {
      throw new Error(
        `alias ${backend.claudeModelAlias} targets an unexpected upstream endpoint`
      );
    }

    // /health/readiness is local process/DB readiness only. The targeted
    // /health call performs LiteLLM's deployment health check through this
    // exact alias and returns 503 when no matching upstream is healthy.
    const upstreamHealthResponse = await fetchWithTimeout(
      fetchImpl,
      `${backend.baseUrl}/health?model=${encodeURIComponent(backend.claudeModelAlias)}`,
      backend.authToken,
      timeoutMs
    );
    if (!upstreamHealthResponse.ok) {
      throw new Error(`targeted upstream health returned HTTP ${upstreamHealthResponse.status}`);
    }
    const health = await upstreamHealthResponse.json() as LiteLLMHealthResponse;
    if (
      typeof health.healthy_count !== 'number'
      || health.healthy_count < 1
    ) {
      throw new Error(
        `targeted upstream health reported no healthy deployment for ${backend.claudeModelAlias}`
      );
    }
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new Error(
      `Ollama Claude Code preflight failed for ${backend.id}; no Nimbalyst session was created: ${reason}`
    );
  }
}
