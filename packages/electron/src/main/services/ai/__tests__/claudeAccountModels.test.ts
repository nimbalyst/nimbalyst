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

import http from 'node:http';
import {
  detectAccountModels,
  mergePickerWithDiscovered,
  parseAccountModelRows,
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

describe('parseAccountModelRows', () => {
  it('returns the rows that have an id and skips the rest', () => {
    const models = parseAccountModelRows(FIXTURE.data);
    expect(models).toHaveLength(5);
    expect(models[0]).toEqual({
      id: 'claude-mythos-5-2',
      displayName: 'Claude Mythos 5.2',
      line: 'mythos',
      maxInputTokens: 1_000_000,
      lifecycle: 'active',
    });
  });

  it('skips a row whose id could be read as a command option or a shell command', () => {
    // The id goes word for word to `claude --model <id>`, so it must look like a plain model name.
    const goodIds = ['claude-opus-4-5[1m]', 'Fast.v2_beta', 'a'.repeat(128)];
    const badIds = ['x & calc', '--help', '-x', 'a b', 'a/b', 'a;b', '$(id)', 'a\nb', 'a'.repeat(129), ''];
    const rows = [...goodIds, ...badIds].map((id) => ({ id, display_name: id }));
    expect(parseAccountModelRows(rows).map((m) => m.id)).toEqual(goodIds);
  });

  it('keeps the row but drops a context window that is not a whole number from 1 to 10 million', () => {
    const windows = [1, 10_000_000, 0, -5, 1.5, 10_000_001, '1000000', null, true];
    const rows = windows.map((window, index) => ({ id: `model-${index}`, max_input_tokens: window }));
    const models = parseAccountModelRows(rows);
    expect(models.map((m) => m.id)).toEqual(rows.map((r) => r.id));
    expect(models.map((m) => m.maxInputTokens)).toEqual([
      1, 10_000_000, undefined, undefined, undefined, undefined, undefined, undefined, undefined,
    ]);
  });
});

describe('toDiscoveredOptions', () => {
  const options = toDiscoveredOptions(parseAccountModelRows(FIXTURE.data));

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

  it('gives a model on an unknown line, or on no line, no behavesAs, so the app does not treat it as Opus', () => {
    const [unknownLine, noLine] = toDiscoveredOptions([
      { id: 'claude-zeta-1', displayName: 'Claude Zeta 1', line: 'zeta', maxInputTokens: 500_000 },
      { id: 'claude-plain-1', displayName: 'Claude Plain 1' },
    ]);
    expect(unknownLine).toMatchObject({ model: 'claude-zeta-1', label: 'Claude Zeta 1', contextWindow: 500_000 });
    expect(unknownLine).not.toHaveProperty('behavesAs');
    expect(noLine).not.toHaveProperty('behavesAs');
  });

  it('reads a line name as plain text, so a name such as "constructor" is not a known line', () => {
    const rows = ['constructor', '__proto__', 'toString', 'hasOwnProperty'].map((line) => ({
      id: `claude-${line.toLowerCase()}`,
      displayName: line,
      line,
    }));
    for (const option of toDiscoveredOptions(rows)) {
      expect(option).not.toHaveProperty('behavesAs');
    }
  });

  it('drops retired models', () => {
    const retired = toDiscoveredOptions([{ id: 'claude-old-1', displayName: 'Old', lifecycle: 'retired' }]);
    expect(retired).toEqual([]);
  });
});

describe('mergePickerWithDiscovered', () => {
  const discovered = toDiscoveredOptions(parseAccountModelRows(FIXTURE.data));

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
    // Only the models are saved, with no extra fields beside them.
    expect(storeData.claudeCode).toEqual({ discoveredModels: [a] });
  });

  it('keeps a model the user hid hidden when it comes back', () => {
    // The id comes from the real pipeline, so a change to how rows are built shows here.
    const [mythos] = toDiscoveredOptions(parseAccountModelRows(FIXTURE.data));
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
    return { deps: { getToken, fetchImpl, save, clearModelCache, getSaved: () => [] }, save, clearModelCache };
  };
  // Anthropic answers with a JSON content type, and the SDK reads the body by that type.
  const jsonResponse = (status: number, body: unknown) =>
    new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
  const answer = (status: number, body: unknown = FIXTURE) =>
    vi.fn(async () => jsonResponse(status, body)) as unknown as typeof fetch;
  /** The request the SDK sent on its n-th call: the address and the headers. */
  const sentRequest = (fetchImpl: typeof fetch, call = 0) => {
    const [url, init] = (fetchImpl as unknown as ReturnType<typeof vi.fn>).mock.calls[call] as [string, RequestInit];
    return { url: String(url), init, headers: new Headers(init.headers) };
  };
  /** Rows with plain ids, for the tests about how many rows are kept. */
  const manyRows = (count: number) => Array.from({ length: count }, (_, i) => ({ id: `model-${i}`, display_name: `Model ${i}` }));

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

    const { url, headers } = sentRequest(fetchImpl);
    expect(url).toBe('https://api.anthropic.com/v1/models?limit=1000');
    expect(headers.get('authorization')).toBe(`Bearer ${TOKEN}`);
    expect(headers.get('anthropic-beta')).toBe('oauth-2025-04-20');
    expect(headers.get('anthropic-version')).toBe('2023-06-01');
    expect(headers.get('x-api-key')).toBeNull();
    expect(JSON.stringify(result)).not.toContain(TOKEN);
    expect(JSON.stringify(save.mock.calls)).not.toContain(TOKEN);
  });

  it('sends only the sign-in token to api.anthropic.com, whatever the environment variables say', async () => {
    // A shell that sets these must not change where the token goes or how it is sent.
    vi.stubEnv('ANTHROPIC_API_KEY', 'env-api-key-must-not-be-sent');
    vi.stubEnv('ANTHROPIC_AUTH_TOKEN', 'env-auth-token-must-not-be-sent');
    vi.stubEnv('ANTHROPIC_BASE_URL', 'https://other-host.example.com');
    try {
      const fetchImpl = answer(200);
      await detectAccountModels(setup(fetchImpl).deps);

      const { url, headers } = sentRequest(fetchImpl);
      expect(url).toBe('https://api.anthropic.com/v1/models?limit=1000');
      expect(headers.get('x-api-key')).toBeNull();
      expect(headers.get('authorization')).toBe(`Bearer ${TOKEN}`);
    } finally {
      vi.unstubAllEnvs();
    }
  });

  describe('the shell can add request headers, but only our sign-in token is sent', () => {
    // The Anthropic SDK reads ANTHROPIC_CUSTOM_HEADERS on its own. Header names do not care
    // about letter case, so each case below uses a different spelling of the same names.
    it.each([
      ['the same spelling as the SDK sends', 'x-api-key: bad\nAuthorization: Bearer other'],
      ['another spelling', 'X-Api-Key: bad\nauthorization: Bearer other'],
    ])('ignores a key and a token from the variable (%s)', async (_name, customHeaders) => {
      vi.stubEnv('ANTHROPIC_CUSTOM_HEADERS', customHeaders);
      try {
        // Two pages, so the second request is checked as well.
        const pages = [
          { data: [{ id: 'model-a' }], has_more: true, first_id: 'model-a', last_id: 'model-a' },
          { data: [{ id: 'model-b' }], has_more: false, first_id: 'model-b', last_id: 'model-b' },
        ];
        let call = 0;
        const fetchImpl = vi.fn(async () => jsonResponse(200, pages[call++])) as unknown as typeof fetch;
        await detectAccountModels(setup(fetchImpl).deps);

        expect(fetchImpl).toHaveBeenCalledTimes(2);
        for (const index of [0, 1]) {
          const { headers } = sentRequest(fetchImpl, index);
          expect(headers.get('x-api-key')).toBeNull();
          expect(headers.get('authorization')).toBe(`Bearer ${TOKEN}`);
        }
      } finally {
        vi.unstubAllEnvs();
      }
    });
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

  it.each([404, 429, 500])('answers network on status %i and keeps the saved list', async (status) => {
    const fetchImpl = answer(status, {});
    const { deps, save } = setup(fetchImpl);
    const result = await detectAccountModels(deps);
    expect(result).toMatchObject({
      ok: false,
      error: 'network',
      message: 'Could not reach Anthropic. Check your connection and try again.',
    });
    // One try only: the SDK must not retry on its own.
    expect(fetchImpl).toHaveBeenCalledTimes(1);
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

  it('answers network when the request times out', async () => {
    const { deps, save } = setup(vi.fn(async () => {
      throw Object.assign(new Error('The operation was aborted'), { name: 'AbortError' });
    }) as unknown as typeof fetch);
    const result = await detectAccountModels(deps);
    expect(result).toMatchObject({ ok: false, error: 'network' });
    expect(save).not.toHaveBeenCalled();
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

  describe('two runs at the same time', () => {
    /** An answer that waits until the test lets it go, so a run stays in flight. */
    const heldAnswer = () => {
      let release: () => void = () => {};
      const gate = new Promise<void>((resolve) => { release = resolve; });
      const fetchImpl = vi.fn(async () => {
        await gate;
        return jsonResponse(200, FIXTURE);
      }) as unknown as typeof fetch;
      return { fetchImpl, release };
    };

    it('makes one request, saves once, and gives both callers the same result', async () => {
      const { fetchImpl, release } = heldAnswer();
      const { deps, save, clearModelCache } = setup(fetchImpl);

      const first = detectAccountModels(deps);
      const second = detectAccountModels(deps);
      release();
      const [firstResult, secondResult] = await Promise.all([first, second]);

      expect(fetchImpl).toHaveBeenCalledTimes(1);
      expect(save).toHaveBeenCalledTimes(1);
      expect(clearModelCache).toHaveBeenCalledTimes(1);
      expect(firstResult.ok).toBe(true);
      expect(secondResult).toBe(firstResult);
    });

    it('starts a new request for a call made after the run has finished', async () => {
      const fetchImpl = answer(200);
      const { deps } = setup(fetchImpl);

      await detectAccountModels(deps);
      await detectAccountModels(deps);

      expect(fetchImpl).toHaveBeenCalledTimes(2);
    });

    it('starts a new request after a run that failed', async () => {
      const failing = answer(500, {});
      await detectAccountModels(setup(failing).deps);

      const working = answer(200);
      const result = await detectAccountModels(setup(working).deps);

      expect(result.ok).toBe(true);
      expect(working).toHaveBeenCalledTimes(1);
    });
  });

  describe('the token goes to one address only', () => {
    it('asks fetch to refuse redirects', async () => {
      const fetchImpl = answer(200);
      await detectAccountModels(setup(fetchImpl).deps);
      expect(sentRequest(fetchImpl).init.redirect).toBe('error');
    });

    it('answers network on a 302 answer and makes no second request', async () => {
      const fetchImpl = vi.fn(async () =>
        new Response(null, { status: 302, headers: { location: 'https://other-host.example.com/v1/models' } }),
      ) as unknown as typeof fetch;
      const { deps, save } = setup(fetchImpl);
      const result = await detectAccountModels(deps);
      expect(result).toMatchObject({ ok: false, error: 'network' });
      expect(fetchImpl).toHaveBeenCalledTimes(1);
      expect(save).not.toHaveBeenCalled();
    });

    it('does not follow a real redirect, so the second server never sees the token', async () => {
      const seenBySecondServer: string[] = [];
      const listen = (server: http.Server) =>
        new Promise<number>((resolve) => server.listen(0, '127.0.0.1', () => resolve((server.address() as { port: number }).port)));
      const second = http.createServer((req, res) => {
        seenBySecondServer.push(`${req.url} ${req.headers.authorization ?? ''}`);
        res.setHeader('content-type', 'application/json').end(JSON.stringify(FIXTURE));
      });
      const secondPort = await listen(second);
      const first = http.createServer((_req, res) => {
        res.writeHead(302, { location: `http://127.0.0.1:${secondPort}/stolen` }).end();
      });
      const firstPort = await listen(first);
      try {
        // The real fetch talks to the first local server in place of api.anthropic.com.
        const toFirstServer = ((_url: string, init?: RequestInit) =>
          fetch(`http://127.0.0.1:${firstPort}/v1/models`, init)) as unknown as typeof fetch;
        const { deps, save } = setup(toFirstServer);
        const result = await detectAccountModels(deps);

        expect(result).toMatchObject({ ok: false, error: 'network' });
        expect(seenBySecondServer).toEqual([]);
        expect(save).not.toHaveBeenCalled();
      } finally {
        first.close();
        second.close();
      }
    });
  });

  describe('what is kept from the answer', () => {
    it('never saves a model id that could act as a command option or a shell command', async () => {
      const rows = [{ id: 'x & calc' }, { id: '--help' }, { id: 'claude-mythos-5-2', display_name: 'Claude Mythos 5.2' }];
      const { deps, save } = setup(answer(200, { data: rows }));
      const result = await detectAccountModels(deps);

      expect(result).toMatchObject({ ok: true, totalFromAccount: 1 });
      expect((save.mock.calls[0][0] as { model: string }[]).map((o) => o.model)).toEqual(['claude-mythos-5-2']);
    });

    it('saves at most 1000 models, even when the answer holds more', async () => {
      const { deps, save } = setup(answer(200, { data: manyRows(1500) }));
      const result = await detectAccountModels(deps);

      expect(result.ok).toBe(true);
      expect(save.mock.calls[0][0]).toHaveLength(1000);
    });

    it('reads every page of the list', async () => {
      const pages = [
        { data: [{ id: 'model-a' }, { id: 'model-b' }], has_more: true, first_id: 'model-a', last_id: 'model-b' },
        { data: [{ id: 'model-c' }], has_more: false, first_id: 'model-c', last_id: 'model-c' },
      ];
      let call = 0;
      const fetchImpl = vi.fn(async () => jsonResponse(200, pages[call++])) as unknown as typeof fetch;
      const { deps, save } = setup(fetchImpl);
      await detectAccountModels(deps);

      expect(fetchImpl).toHaveBeenCalledTimes(2);
      expect(sentRequest(fetchImpl, 1).url).toContain('after_id=model-b');
      expect((save.mock.calls[0][0] as { model: string }[]).map((o) => o.model)).toEqual(['model-a', 'model-b', 'model-c']);
    });
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

    it('names only the HTTP status on a sign-in answer', async () => {
      const { deps } = setup(answer(401, { error: { message: `secret ${TOKEN}` } }));
      await detectAccountModels(deps);
      expect(warn).toHaveBeenCalledTimes(1);
      expect(logged()).toContain('401');
      expect(logged()).not.toContain(TOKEN);
      expect(logged()).not.toContain('secret');
    });

    it('names only the error names when fetch throws', async () => {
      const { deps } = setup(vi.fn(async () => {
        throw new TypeError(`fetch failed for Bearer ${TOKEN}`);
      }) as unknown as typeof fetch);
      await detectAccountModels(deps);
      expect(warn).toHaveBeenCalledTimes(1);
      expect(logged()).toContain('APIConnectionError');
      expect(logged()).toContain('TypeError');
      expect(logged()).not.toContain(TOKEN);
    });

    it('names only the error name when the body cannot be read', async () => {
      const unreadable = vi.fn(async () =>
        new Response(`not json ${TOKEN}`, { status: 200, headers: { 'content-type': 'application/json' } }),
      ) as unknown as typeof fetch;
      await detectAccountModels(setup(unreadable).deps);
      expect(warn).toHaveBeenCalledTimes(1);
      expect(logged()).toContain('SyntaxError');
      expect(logged()).not.toContain(TOKEN);
    });
  });
});
