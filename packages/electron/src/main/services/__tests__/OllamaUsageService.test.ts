/**
 * OllamaUsageService tests.
 *
 * Covers the real (undocumented, verified live 2026-07-30) account-usage API
 * at https://ollama.com/api/usage, plus the independent local LiteLLM
 * brain-swap proxy health check. See the service's module doc for the
 * verified request/response shape this pins.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('../CLIManager', () => ({
  getShellEnvironment: vi.fn(() => ({})),
}));

import { ollamaUsageService } from '../OllamaUsageService';

describe('OllamaUsageService', () => {
  const originalFetch = global.fetch;
  const originalApiKey = process.env.OLLAMA_API_KEY;

  beforeEach(() => {
    vi.restoreAllMocks();
    delete process.env.OLLAMA_API_KEY;
  });

  afterEach(() => {
    global.fetch = originalFetch;
    if (originalApiKey === undefined) {
      delete process.env.OLLAMA_API_KEY;
    } else {
      process.env.OLLAMA_API_KEY = originalApiKey;
    }
  });

  function mockFetch(handlers: { usage?: () => Promise<any>; proxy?: (url: string) => Promise<any> }) {
    global.fetch = vi.fn().mockImplementation((url: string) => {
      if (url === 'https://ollama.com/api/usage') {
        if (!handlers.usage) return Promise.reject(new Error('unexpected usage call'));
        return handlers.usage();
      }
      if (url.startsWith('http://127.0.0.1:4002')) {
        if (!handlers.proxy) return Promise.reject(new Error('ECONNREFUSED'));
        return handlers.proxy(url);
      }
      return Promise.reject(new Error(`unexpected url ${url}`));
    });
  }

  it('reports limitsAvailable=false with no OLLAMA_API_KEY set, without calling the API', async () => {
    mockFetch({});

    const data = await ollamaUsageService.refresh();

    expect(data.limitsAvailable).toBe(false);
    expect(data.error).toContain('OLLAMA_API_KEY not set');
    expect(global.fetch).not.toHaveBeenCalledWith('https://ollama.com/api/usage', expect.anything());
  });

  it('parses the real session/weekly usage shape, converting 0-1 fractions to 0-100 percentages', async () => {
    process.env.OLLAMA_API_KEY = 'test-key-not-real';
    mockFetch({
      usage: async () => ({
        ok: true,
        status: 200,
        json: async () => ({
          activity: {
            cost: '0.00000',
            period: { type: 'last_4_weeks', starting_at: '2026-07-06T00:00:00Z', ending_at: '2026-07-30T06:03:03Z' },
            models: [],
          },
          limits: {
            session: { usage: 0, models: [{ name: 'gpt-oss:120b', request_count: 1 }] },
            weekly: {
              usage: 0.051,
              models: [
                { name: 'glm-5.2', request_count: 253 },
                { name: 'nemotron-3-super', request_count: 528 },
              ],
            },
          },
        }),
      }),
    });

    const data = await ollamaUsageService.refresh();

    expect(data.limitsAvailable).toBe(true);
    expect(data.session?.utilization).toBe(0);
    expect(data.session?.models).toEqual([{ name: 'gpt-oss:120b', requestCount: 1 }]);
    expect(data.weekly?.utilization).toBe(5.1);
    expect(data.weekly?.models).toEqual([
      { name: 'glm-5.2', requestCount: 253 },
      { name: 'nemotron-3-super', requestCount: 528 },
    ]);
    expect(data.costUSD).toBe(0);
    expect(data.costPeriod?.type).toBe('last_4_weeks');
  });

  it('sends the raw API key with no "Bearer " prefix', async () => {
    process.env.OLLAMA_API_KEY = 'raw-key-value';
    let capturedHeaders: HeadersInit | undefined;
    global.fetch = vi.fn().mockImplementation((url: string, init?: RequestInit) => {
      if (url === 'https://ollama.com/api/usage') {
        capturedHeaders = init?.headers;
        return Promise.resolve({
          ok: true,
          status: 200,
          json: async () => ({ limits: { session: { usage: 0, models: [] } } }),
        });
      }
      return Promise.reject(new Error('ECONNREFUSED'));
    });

    await ollamaUsageService.refresh();

    expect((capturedHeaders as Record<string, string>).Authorization).toBe('raw-key-value');
  });

  it('reports limitsAvailable=false with the HTTP status on a non-OK response', async () => {
    process.env.OLLAMA_API_KEY = 'test-key';
    mockFetch({ usage: async () => ({ ok: false, status: 401 }) });

    const data = await ollamaUsageService.refresh();

    expect(data.limitsAvailable).toBe(false);
    expect(data.error).toContain('401');
  });

  it('tracks proxy health independently of account-usage availability', async () => {
    delete process.env.OLLAMA_API_KEY; // account usage unavailable
    mockFetch({
      proxy: async (url: string) => {
        if (url.endsWith('/health/readiness')) return { ok: true, status: 200 };
        if (url.endsWith('/model/info')) {
          return { ok: true, status: 200, json: async () => ({ data: [{ model_name: 'claude-ollama-gpt-oss-20b' }] }) };
        }
        throw new Error(`unexpected ${url}`);
      },
    });

    const data = await ollamaUsageService.refresh();

    expect(data.limitsAvailable).toBe(false); // no key
    expect(data.proxyReachable).toBe(true); // proxy still independently reachable
    expect(data.configuredAliases).toEqual(['claude-ollama-gpt-oss-20b']);
  });

  it('reports proxyReachable=false when the local proxy is not running', async () => {
    process.env.OLLAMA_API_KEY = 'test-key';
    mockFetch({ usage: async () => ({ ok: true, status: 200, json: async () => ({ limits: {} }) }) });

    const data = await ollamaUsageService.refresh();

    expect(data.proxyReachable).toBe(false);
    expect(data.configuredAliases).toEqual([]);
  });

  it('always includes static plan-tier reference data regardless of API/proxy state', async () => {
    mockFetch({});

    const data = await ollamaUsageService.refresh();

    expect(data.planTiers.map((t) => t.tier)).toEqual(['Free', 'Pro', 'Max']);
  });

  it('deduplicates concurrent refresh() calls into a single in-flight promise', async () => {
    process.env.OLLAMA_API_KEY = 'test-key';
    let usageCallCount = 0;
    global.fetch = vi.fn().mockImplementation((url: string) => {
      if (url === 'https://ollama.com/api/usage') {
        usageCallCount++;
        return new Promise((resolve) =>
          setTimeout(() => resolve({ ok: true, status: 200, json: async () => ({ limits: {} }) }), 10)
        );
      }
      return Promise.reject(new Error('ECONNREFUSED'));
    });

    const [a, b] = await Promise.all([ollamaUsageService.refresh(), ollamaUsageService.refresh()]);

    expect(a).toBe(b);
    expect(usageCallCount).toBe(1);
  });
});
