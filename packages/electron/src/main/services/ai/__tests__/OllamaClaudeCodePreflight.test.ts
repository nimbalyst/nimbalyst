import { describe, expect, it, vi } from 'vitest';
import { resolveClaudeCodeBackend } from '@nimbalyst/runtime/ai/server';
import { preflightOllamaClaudeCodeBackend } from '../OllamaClaudeCodePreflight';

const backend = resolveClaudeCodeBackend('ollama-glm-5-2-cloud')!;

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

describe('Ollama Claude Code LiteLLM preflight', () => {
  it('accepts a ready proxy with the exact approved alias mapping', async () => {
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(jsonResponse({ status: 'healthy' }))
      .mockResolvedValueOnce(jsonResponse({
        data: [{
          model_name: 'claude-sonnet-4-5-20250929',
          litellm_params: {
            model: 'openai/glm-5.2:cloud',
            api_base: 'https://ollama.com/v1',
          },
        }],
      }))
      .mockResolvedValueOnce(jsonResponse({
        healthy_count: 1,
        unhealthy_count: 0,
        healthy_endpoints: [{ model: 'openai/glm-5.2:cloud' }],
      }));

    await expect(
      preflightOllamaClaudeCodeBackend(backend, fetchImpl as typeof fetch)
    ).resolves.toBeUndefined();

    expect(fetchImpl).toHaveBeenNthCalledWith(
      1,
      'http://127.0.0.1:4002/health/readiness',
      expect.objectContaining({ method: 'GET' })
    );
    expect(fetchImpl).toHaveBeenNthCalledWith(
      2,
      'http://127.0.0.1:4002/model/info',
      expect.objectContaining({ method: 'GET' })
    );
    expect(fetchImpl).toHaveBeenNthCalledWith(
      3,
      'http://127.0.0.1:4002/health?model=claude-sonnet-4-5-20250929',
      expect.objectContaining({ method: 'GET' })
    );
    expect(fetchImpl).toHaveBeenCalledTimes(3);
  });

  it('rejects a closed or unready proxy', async () => {
    const fetchImpl = vi.fn().mockRejectedValue(new Error('connection refused'));

    await expect(
      preflightOllamaClaudeCodeBackend(backend, fetchImpl as typeof fetch)
    ).rejects.toThrow('no Nimbalyst session was created: connection refused');
  });

  it('rejects a wrong upstream model', async () => {
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(jsonResponse({ status: 'healthy' }))
      .mockResolvedValueOnce(jsonResponse({
        data: [{
          model_name: 'claude-sonnet-4-5-20250929',
          litellm_params: {
            model: 'openai/some-other-model',
            api_base: 'https://ollama.com/v1',
          },
        }],
      }))
      .mockResolvedValueOnce(jsonResponse({ healthy_count: 1 }));

    await expect(
      preflightOllamaClaudeCodeBackend(backend, fetchImpl as typeof fetch)
    ).rejects.toThrow('targets an unexpected upstream model');
  });

  it('rejects a wrong upstream endpoint', async () => {
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(jsonResponse({ status: 'healthy' }))
      .mockResolvedValueOnce(jsonResponse({
        data: [{
          model_name: 'claude-sonnet-4-5-20250929',
          litellm_params: {
            model: 'openai/glm-5.2:cloud',
            api_base: 'https://example.invalid/v1',
          },
        }],
      }))
      .mockResolvedValueOnce(jsonResponse({ healthy_count: 1 }));

    await expect(
      preflightOllamaClaudeCodeBackend(backend, fetchImpl as typeof fetch)
    ).rejects.toThrow('targets an unexpected upstream endpoint');
  });

  it('rejects a targeted LiteLLM deployment health failure', async () => {
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(jsonResponse({ status: 'healthy' }))
      .mockResolvedValueOnce(jsonResponse({
        data: [{
          model_name: 'claude-sonnet-4-5-20250929',
          litellm_params: {
            model: 'openai/glm-5.2:cloud',
            api_base: 'https://ollama.com/v1',
          },
        }],
      }))
      .mockResolvedValueOnce(jsonResponse({
        healthy_count: 0,
        unhealthy_count: 1,
      }, 503));

    await expect(
      preflightOllamaClaudeCodeBackend(backend, fetchImpl as typeof fetch)
    ).rejects.toThrow('targeted upstream health returned HTTP 503');
    expect(fetchImpl).toHaveBeenCalledTimes(3);
  });

  it('rejects a malformed targeted health success with no healthy deployment', async () => {
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(jsonResponse({ status: 'healthy' }))
      .mockResolvedValueOnce(jsonResponse({
        data: [{
          model_name: 'claude-sonnet-4-5-20250929',
          litellm_params: {
            model: 'openai/glm-5.2:cloud',
            api_base: 'https://ollama.com/v1',
          },
        }],
      }))
      .mockResolvedValueOnce(jsonResponse({ healthy_count: 0 }));

    await expect(
      preflightOllamaClaudeCodeBackend(backend, fetchImpl as typeof fetch)
    ).rejects.toThrow('reported no healthy deployment');
  });
});
