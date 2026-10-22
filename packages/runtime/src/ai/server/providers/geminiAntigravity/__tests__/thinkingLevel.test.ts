// @vitest-environment node
/**
 * A family selection ("Gemini 3.8 Flash") runs on the catalog variant for the
 * user's thinking level; explicit variants and catalog gaps behave sensibly.
 * Only the server's RPC surface is mocked.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { GeminiAntigravityProvider } from '../../GeminiAntigravityProvider';
import { AntigravityServerManager, type AntigravityModelInfo } from '../AntigravityServerManager';
import type { StreamChunk } from '../../../types';

async function collect(stream: AsyncIterableIterator<StreamChunk>): Promise<StreamChunk[]> {
  const out: StreamChunk[] = [];
  for await (const chunk of stream) out.push(chunk);
  return out;
}

function catalog(...keys: string[]): Map<string, AntigravityModelInfo> {
  // Empty displayName: labels are derived from the key, as for unlabelled slots.
  return new Map(keys.map((key, i) => [key, {
    key, enum: `MODEL_M${i}`, displayName: '', apiProvider: 'API_PROVIDER_GOOGLE_GEMINI',
  }]));
}

describe('Gemini thinking level', () => {
  let getModelResponse: import('vitest').MockInstance<AntigravityServerManager['getModelResponse']>;
  let provider: GeminiAntigravityProvider;
  let level: 'low' | 'medium' | 'high' | undefined;

  beforeEach(() => {
    level = undefined;
    getModelResponse = vi.spyOn(AntigravityServerManager.prototype, 'getModelResponse').mockResolvedValue('ok');
    vi.spyOn(AntigravityServerManager.prototype, 'getAvailableModels').mockResolvedValue(catalog(
      'gemini-3.8-flash-high', 'gemini-3.8-flash-medium', 'gemini-3.8-flash-low', 'gemini-3.5-flash-lite',
    ));
    GeminiAntigravityProvider.setServerConfigLoader(() => ({ thinkingLevel: level }));
    provider = new GeminiAntigravityProvider();
  });

  afterEach(() => {
    GeminiAntigravityProvider.setServerConfigLoader(null);
    provider.destroy();
    vi.restoreAllMocks();
  });

  it.each([
    ['high', 'gemini-3.8-flash-high'],
    ['low', 'gemini-3.8-flash-low'],
    [undefined, 'gemini-3.8-flash-medium'],
  ] as const)('thinking level %s runs Gemini 3.8 Flash as %s', async (lvl, expected) => {
    level = lvl;
    await provider.initialize({ model: 'antigravity-gemini-agent:gemini-3.8-flash' });
    await collect(provider.sendMessage('hi', undefined, `s-${lvl}`));
    expect(getModelResponse.mock.calls[0][1]).toBe(expected);
  });

  it('runs a family without variants (Flash-Lite) on its own key', async () => {
    level = 'high';
    await provider.initialize({ model: 'antigravity-gemini-agent:gemini-3.5-flash-lite' });
    await collect(provider.sendMessage('hi', undefined, 's-lite'));
    expect(getModelResponse.mock.calls[0][1]).toBe('gemini-3.5-flash-lite');
  });

  it('follows a thinking-level change on the next turn of the same session', async () => {
    await provider.initialize({ model: 'antigravity-gemini-agent:gemini-3.8-flash' });
    level = 'low';
    await collect(provider.sendMessage('one', undefined, 's-change'));
    level = 'high';
    await collect(provider.sendMessage('two', undefined, 's-change'));
    expect(getModelResponse.mock.calls.map((c) => c[1])).toEqual(['gemini-3.8-flash-low', 'gemini-3.8-flash-high']);
  });

  it('lists families from an already-open Antigravity app without spawning a server', async () => {
    const ep = { httpsPort: 1, csrf: 'x', owned: false };
    let current: typeof ep | null = null;
    vi.spyOn(AntigravityServerManager.prototype, 'currentEndpoint').mockImplementation(() => current);
    const attach = vi.spyOn(AntigravityServerManager.prototype, 'attachIfRunning')
      .mockImplementation(async () => { current = ep; return ep; });
    const ensureRunning = vi.spyOn(AntigravityServerManager.prototype, 'ensureRunning');
    vi.spyOn(AntigravityServerManager.prototype, 'getUserStatus').mockResolvedValue({});
    const models = await GeminiAntigravityProvider.getModels();
    expect(attach).toHaveBeenCalledTimes(1);
    expect(ensureRunning).not.toHaveBeenCalled();
    expect(models.map((m) => m.name)).toEqual(['Gemini 3.5 Flash-Lite', 'Gemini 3.8 Flash']);
  });

  it('reports a family the catalog no longer offers instead of substituting another model', async () => {
    await provider.initialize({ model: 'antigravity-gemini-agent:gemini-9-pro' });
    const chunks = await collect(provider.sendMessage('hi', undefined, 's-gone'));
    expect(chunks).toEqual([{ type: 'error', error: expect.stringContaining('not offered by Antigravity') }]);
    expect(getModelResponse).not.toHaveBeenCalled();
  });
});
