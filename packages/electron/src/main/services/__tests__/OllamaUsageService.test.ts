/**
 * OllamaUsageService tests.
 *
 * Ollama Cloud has no account-level usage API (see the service's module
 * doc), so these tests pin the two things that ARE real: the local LiteLLM
 * proxy reachability probe, and that `limitsAvailable` never lies and says
 * `true`.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { ollamaUsageService } from '../OllamaUsageService';

describe('OllamaUsageService', () => {
  const originalFetch = global.fetch;

  beforeEach(() => {
    vi.restoreAllMocks();
  });

  afterEach(() => {
    global.fetch = originalFetch;
  });

  it('reports proxyReachable=false when the local proxy is not running', async () => {
    global.fetch = vi.fn().mockRejectedValue(new Error('ECONNREFUSED'));

    const data = await ollamaUsageService.refresh();

    expect(data.proxyReachable).toBe(false);
    expect(data.configuredAliases).toEqual([]);
    expect(data.limitsAvailable).toBe(false);
    expect(data.note).toContain('not reachable');
  });

  it('reports proxyReachable=false when readiness responds non-OK', async () => {
    global.fetch = vi.fn().mockResolvedValue({ ok: false, status: 503 });

    const data = await ollamaUsageService.refresh();

    expect(data.proxyReachable).toBe(false);
  });

  it('parses configured aliases from /model/info when the proxy is up', async () => {
    global.fetch = vi.fn().mockImplementation((url: string) => {
      if (url.endsWith('/health/readiness')) {
        return Promise.resolve({ ok: true, status: 200 });
      }
      if (url.endsWith('/model/info')) {
        return Promise.resolve({
          ok: true,
          status: 200,
          json: async () => ({
            data: [
              { model_name: 'claude-ollama-gpt-oss-20b' },
              { model_name: 'claude-sonnet-4-5-20250929' },
              { model_name: 42 }, // malformed entry, should be dropped
            ],
          }),
        });
      }
      return Promise.reject(new Error(`unexpected url ${url}`));
    });

    const data = await ollamaUsageService.refresh();

    expect(data.proxyReachable).toBe(true);
    expect(data.configuredAliases).toEqual([
      'claude-ollama-gpt-oss-20b',
      'claude-sonnet-4-5-20250929',
    ]);
    expect(data.limitsAvailable).toBe(false);
  });

  it('always includes static plan-tier reference data regardless of proxy state', async () => {
    global.fetch = vi.fn().mockRejectedValue(new Error('down'));

    const data = await ollamaUsageService.refresh();

    expect(data.planTiers.map((t) => t.tier)).toEqual(['Free', 'Pro', 'Max']);
  });

  it('deduplicates concurrent refresh() calls into a single in-flight promise', async () => {
    let callCount = 0;
    global.fetch = vi.fn().mockImplementation(() => {
      callCount++;
      return new Promise((resolve) => {
        setTimeout(() => resolve({ ok: true, status: 200, json: async () => ({ data: [] }) }), 10);
      });
    });

    const [a, b] = await Promise.all([
      ollamaUsageService.refresh(),
      ollamaUsageService.refresh(),
    ]);

    expect(a).toBe(b);
    // Two endpoints (readiness + model/info) hit once per refresh, not twice.
    expect(callCount).toBe(2);
  });
});
