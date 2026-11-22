// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Narrow mock of the settings file: a plain in-memory object stands in for electron-store.
const storeData = vi.hoisted(() => ({}) as Record<string, unknown>);
vi.mock('../../../utils/privateSettingsStore', () => ({
  default: class {
    get(key: string, fallback?: unknown) {
      return key in storeData ? storeData[key] : fallback;
    }
    set(key: string, value: unknown) {
      storeData[key] = value;
    }
  },
}));

import {
  AccountModelsError,
  detectAccountModels,
  mergePickerWithDiscovered,
  parseAccountModelsResponse,
  toDiscoveredOptions,
} from '../claudeAccountModels';
import { toClaudeCustomModelSegment } from '@nimbalyst/runtime/ai/claudeCustomModels';
import { isModelEnabled } from '../modelEnablementFilter';
import { logger } from '../../../utils/logger';
import { getClaudeCodeDiscoveredModels, setClaudeCodeDiscoveredModels } from '../../../utils/store';

// A shortened copy of the real /v1/models answer for a Claude account on 2026-11-22.
const FIXTURE = {
  data: [
    { id: 'claude-mythos-5-2', display_name: 'Claude Mythos 5.2', line: 'mythos', max_input_tokens: 1_000_000, lifecycle: 'active', type: 'model' },
    { id: 'claude-mythos-5-1', display_name: 'Claude Mythos 5.1', line: 'mythos', max_input_tokens: 1_000_000, lifecycle: 'active' },
    { id: 'claude-opus-5-5', display_name: 'Claude Opus 5.5', line: 'opus', max_input_tokens: 1_000_000, lifecycle: 'active' },
    { id: 'claude-haiku-4-5-20251001', display_name: 'Claude Haiku 4.5', line: 'haiku', max_input_tokens: 200_000, lifecycle: 'active' },
    { id: 'claude-opus-4-5-20251101', display_name: 'Claude Opus 4.5', line: 'opus', max_input_tokens: 200_000, lifecycle: 'active' },
    { display_name: 'Row without an id' },
  ],
};

describe('parseAccountModelsResponse', () => {
  it('returns the rows that have an id and skips the rest', () => {
    const models = parseAccountModelsResponse(FIXTURE);
    expect(models).toHaveLength(5);
    expect(models[0]).toEqual({
      id: 'claude-mythos-5-2',
      displayName: 'Claude Mythos 5.2',
      line: 'mythos',
      maxInputTokens: 1_000_000,
      lifecycle: 'active',
    });
  });

  it('throws bad-response when data is missing', () => {
    expect(() => parseAccountModelsResponse({})).toThrow(AccountModelsError);
    try {
      parseAccountModelsResponse({});
    } catch (error) {
      expect((error as AccountModelsError).code).toBe('bad-response');
    }
  });
});

describe('toDiscoveredOptions', () => {
  const options = toDiscoveredOptions(parseAccountModelsResponse(FIXTURE));

  it('keeps models without a built-in row and drops the ones that have one', () => {
    expect(options.map((o) => o.model)).toEqual(['claude-mythos-5-2', 'claude-mythos-5-1', 'claude-opus-4-5-20251101']);
  });

  it('maps Mythos to the Opus 5.5 behavior and keeps its 1M window', () => {
    expect(options[0]).toEqual({
      model: 'claude-mythos-5-2',
      label: 'Claude Mythos 5.2',
      contextWindow: 1_000_000,
      behavesAs: 'claude-opus-5-5',
    });
  });

  it('maps a known line to the pinned id of that line', () => {
    expect(options[2].behavesAs).toBe('claude-opus-5-5');
  });

  it('drops retired models', () => {
    const retired = toDiscoveredOptions([{ id: 'claude-old-1', displayName: 'Old', lifecycle: 'retired' }]);
    expect(retired).toEqual([]);
  });
});

describe('mergePickerWithDiscovered', () => {
  const discovered = toDiscoveredOptions(parseAccountModelsResponse(FIXTURE));

  it('lets a settings entry win over a discovered entry with the same model', () => {
    const merged = mergePickerWithDiscovered(
      { options: [{ model: 'claude-mythos-5-2', label: 'My Mythos' }], replaceBuiltInOptions: true },
      discovered,
    );
    expect(merged.options.filter((o) => o.model === 'claude-mythos-5-2')).toEqual([
      { model: 'claude-mythos-5-2', label: 'My Mythos' },
    ]);
    expect(merged.options.map((o) => o.model)).toEqual(['claude-mythos-5-2', 'claude-mythos-5-1', 'claude-opus-4-5-20251101']);
    expect(merged.replaceBuiltInOptions).toBe(true);
  });
});

describe('discovered models in the store', () => {
  beforeEach(() => {
    for (const key of Object.keys(storeData)) delete storeData[key];
  });

  it('replaces the saved list on each run instead of appending', () => {
    const a = { model: 'a', label: 'A' };
    const b = { model: 'b', label: 'B' };
    expect(getClaudeCodeDiscoveredModels()).toEqual([]);
    setClaudeCodeDiscoveredModels([a, b]);
    setClaudeCodeDiscoveredModels([a]);
    expect(getClaudeCodeDiscoveredModels()).toEqual([a]);
    expect((storeData.claudeCode as { discoveredModelsAt?: string }).discoveredModelsAt).toEqual(expect.any(String));
  });

  it('keeps a model the user hid hidden when it comes back', () => {
    // The id comes from the real pipeline, so a change to how rows are built shows here.
    const [mythos] = toDiscoveredOptions(parseAccountModelsResponse(FIXTURE));
    const id = `claude-code:${toClaudeCustomModelSegment(mythos.model)}`;
    expect(id).toBe('claude-code:custom/claude-mythos-5-2');

    const entry = { enabled: true, hiddenModels: [id] };
    expect(isModelEnabled({ id, provider: 'claude-code' }, entry)).toBe(false);
    expect(isModelEnabled({ id, provider: 'claude-code' }, { enabled: true, hiddenModels: [] })).toBe(true);
  });
});

describe('detectAccountModels', () => {
  const TOKEN = 'fake-token-for-tests-1234';

  /** Builds the outside pieces. `fetchImpl` records the request it receives. */
  const setup = (fetchImpl: typeof fetch, token: string | null = TOKEN) => {
    const save = vi.fn();
    const clearModelCache = vi.fn();
    const getToken = vi.fn(async () => token);
    return { deps: { getToken, fetchImpl, save, clearModelCache }, save, clearModelCache };
  };
  const answer = (status: number, body: unknown = FIXTURE) =>
    vi.fn(async () => new Response(JSON.stringify(body), { status })) as unknown as typeof fetch;

  it('saves the new models and reports them on a 200 answer', async () => {
    const fetchImpl = answer(200);
    const { deps, save, clearModelCache } = setup(fetchImpl);
    const result = await detectAccountModels(deps);

    expect(result).toEqual({
      ok: true,
      added: [
        { model: 'claude-mythos-5-2', label: 'Claude Mythos 5.2' },
        { model: 'claude-mythos-5-1', label: 'Claude Mythos 5.1' },
        { model: 'claude-opus-4-5-20251101', label: 'Claude Opus 4.5' },
      ],
      totalFromAccount: 5,
    });
    expect(save).toHaveBeenCalledTimes(1);
    expect(clearModelCache).toHaveBeenCalledTimes(1);

    const [url, init] = (fetchImpl as unknown as ReturnType<typeof vi.fn>).mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://api.anthropic.com/v1/models?limit=1000');
    expect(init.headers).toMatchObject({
      Authorization: `Bearer ${TOKEN}`,
      'anthropic-beta': 'oauth-2025-04-20',
      'anthropic-version': '2023-06-01',
    });
    expect(JSON.stringify(result)).not.toContain(TOKEN);
    expect(JSON.stringify(save.mock.calls)).not.toContain(TOKEN);
  });

  it('lists only models that the last saved list lacked', async () => {
    const { deps } = setup(answer(200));
    const result = await detectAccountModels({
      ...deps,
      getSaved: () => [{ model: 'claude-mythos-5-2' }],
    });
    expect(result.ok && result.added.map((a) => a.model)).toEqual(['claude-mythos-5-1', 'claude-opus-4-5-20251101']);
  });

  it('answers not-signed-in without a request when there is no token', async () => {
    const fetchImpl = answer(200);
    const { deps, save } = setup(fetchImpl, null);
    const result = await detectAccountModels(deps);
    expect(result).toMatchObject({ ok: false, error: 'not-signed-in', message: 'Sign in to Claude Code first.' });
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(save).not.toHaveBeenCalled();
  });

  it.each([401, 403])('answers sign-in-expired on status %i and keeps the saved list', async (status) => {
    const { deps, save, clearModelCache } = setup(answer(status, {}));
    const result = await detectAccountModels(deps);
    expect(result).toMatchObject({
      ok: false,
      error: 'sign-in-expired',
      message: 'Claude sign-in expired. Run `claude` to sign in again.',
    });
    expect(save).not.toHaveBeenCalled();
    expect(clearModelCache).not.toHaveBeenCalled();
    expect(JSON.stringify(result)).not.toContain(TOKEN);
  });

  it('answers network on status 500 and keeps the saved list', async () => {
    const { deps, save } = setup(answer(500, {}));
    const result = await detectAccountModels(deps);
    expect(result).toMatchObject({
      ok: false,
      error: 'network',
      message: 'Could not reach Anthropic. Check your connection and try again.',
    });
    expect(save).not.toHaveBeenCalled();
    expect(JSON.stringify(result)).not.toContain(TOKEN);
  });

  it('answers network when fetch throws', async () => {
    const { deps, save } = setup(vi.fn(async () => {
      throw new TypeError('fetch failed');
    }) as unknown as typeof fetch);
    const result = await detectAccountModels(deps);
    expect(result).toMatchObject({ ok: false, error: 'network' });
    expect(save).not.toHaveBeenCalled();
    expect(JSON.stringify(result)).not.toContain(TOKEN);
  });

  it('answers bad-response when the body has no data list', async () => {
    const { deps, save } = setup(answer(200, { nope: true }));
    const result = await detectAccountModels(deps);
    expect(result).toMatchObject({
      ok: false,
      error: 'bad-response',
      message: 'Anthropic sent an answer Nimbalyst could not read.',
    });
    expect(save).not.toHaveBeenCalled();
  });

  it.each([
    ['an empty data list', { data: [] }],
    ['a data list with no readable rows', { data: [{ display_name: 'no id' }, { id: 42 }] }],
  ])('answers bad-response and keeps the saved list on %s', async (_name, body) => {
    const { deps, save, clearModelCache } = setup(answer(200, body));
    const result = await detectAccountModels(deps);
    expect(result).toMatchObject({ ok: false, error: 'bad-response' });
    expect(save).not.toHaveBeenCalled();
    expect(clearModelCache).not.toHaveBeenCalled();
  });

  describe('warning log', () => {
    const warn = vi.spyOn(logger.main, 'warn').mockImplementation(() => {});
    beforeEach(() => warn.mockClear());
    afterEach(() => warn.mockClear());

    /** All text passed to the logger, so a test can check what it holds. */
    const logged = () => JSON.stringify(warn.mock.calls);

    it('names only the HTTP status on a failed answer', async () => {
      const { deps } = setup(answer(500, { error: { message: `secret ${TOKEN}` } }));
      await detectAccountModels(deps);
      expect(warn).toHaveBeenCalledTimes(1);
      expect(logged()).toContain('500');
      expect(logged()).not.toContain(TOKEN);
      expect(logged()).not.toContain('secret');
    });

    it('names only the error name when fetch throws', async () => {
      const { deps } = setup(vi.fn(async () => {
        throw new TypeError(`fetch failed for Bearer ${TOKEN}`);
      }) as unknown as typeof fetch);
      await detectAccountModels(deps);
      expect(warn).toHaveBeenCalledTimes(1);
      expect(logged()).toContain('TypeError');
      expect(logged()).not.toContain(TOKEN);
    });

    it('names only the error name when the body cannot be read', async () => {
      const { deps } = setup(vi.fn(async () => new Response(`not json ${TOKEN}`, { status: 200 })) as unknown as typeof fetch);
      await detectAccountModels(deps);
      expect(warn).toHaveBeenCalledTimes(1);
      expect(logged()).toContain('SyntaxError');
      expect(logged()).not.toContain(TOKEN);
    });
  });
});
