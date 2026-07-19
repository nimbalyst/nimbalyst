import { BrowserWindow } from 'electron';
import { existsSync, readFileSync } from 'fs';
import { describe, expect, it, vi } from 'vitest';

vi.mock('electron', () => ({
  BrowserWindow: {
    getAllWindows: vi.fn(() => []),
    getFocusedWindow: vi.fn(() => null),
  },
}));
vi.mock('../../utils/logger', () => ({
  logger: { main: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() } },
}));
vi.mock('../CodexAuthService', () => ({
  codexAuthService: {
    onRateLimitsUpdated: vi.fn(() => () => {}),
    getRateLimits: vi.fn(),
  },
}));
vi.mock('fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('fs')>();
  return {
    ...actual,
    existsSync: vi.fn(() => false),
    readFileSync: vi.fn(),
  };
});
vi.mock('../../extensions/PrivilegedExtensionHost', () => ({
  getPrivilegedExtensionHost: vi.fn(),
}));
vi.mock('../../window/windowState', () => ({
  windowStates: new Map(),
  resolveActiveWorkspacePath: vi.fn(() => null),
}));
import {
  ClaudeUsageServiceImpl,
  convertClaudeUsageResponse,
  toClaudeCapacityObservation,
  type ClaudeUsageData,
} from '../ClaudeUsageService';
import {
  CodexUsageServiceImpl,
  convertAccountRateLimitsResponse,
  convertCodexSessionRateLimits,
  codexUsageService,
  toCodexCapacityObservation,
  type CodexRateLimits,
  type CodexUsageData,
} from '../CodexUsageService';
import { codexAuthService } from '../CodexAuthService';
import {
  convertGeminiUsageSnapshot,
  toGeminiCapacityObservation,
  type GeminiUsageData,
} from '../GeminiUsageService';
import { ProviderCapacityService } from '../ProviderCapacityService';

const OBSERVED_AT = Date.parse('2026-07-19T12:00:00.000Z');

function claudeUsage(overrides: Partial<ClaudeUsageData> = {}): ClaudeUsageData {
  return {
    fiveHour: { utilization: 12, resetsAt: '2026-07-19T17:00:00.000Z' },
    sevenDay: { utilization: 40, resetsAt: '2026-07-26T12:00:00.000Z' },
    lastUpdated: OBSERVED_AT,
    ...overrides,
  };
}

function codexUsage(overrides: Partial<CodexUsageData> = {}): CodexUsageData {
  return {
    limits: [{
      id: 'raw-account-bucket-id',
      name: null,
      planType: 'private-plan-name',
      windows: [
        { slot: 'primary', usedPercent: 12, windowDurationMins: 300, resetsAt: '2026-07-19T17:00:00.000Z' },
        { slot: 'secondary', usedPercent: 40, windowDurationMins: 10_080, resetsAt: '2026-07-26T12:00:00.000Z' },
      ],
      credits: { hasCredits: true, unlimited: false, balance: 'secret-balance' },
      individualLimit: null,
      rateLimitReachedType: null,
    }],
    limitsAvailable: true,
    source: 'account',
    lastUpdated: OBSERVED_AT,
    ...overrides,
  };
}

function geminiUsage(overrides: Partial<GeminiUsageData> = {}): GeminiUsageData {
  return {
    fiveHour: { utilization: 90, resetsAt: '2026-07-19T17:00:00.000Z' },
    sevenDay: { utilization: 25, resetsAt: '2026-07-19T18:00:00.000Z' },
    modelQuotas: [
      { model: 'gemini-pro', remainingFraction: 0.1, resetTime: '2026-07-19T17:00:00.000Z' },
      { model: 'gemini-flash', remainingFraction: 0.75, resetTime: '2026-07-19T18:00:00.000Z' },
    ],
    limitsAvailable: true,
    available: true,
    lastUpdated: OBSERVED_AT,
    ...overrides,
  };
}

function accountRateLimits(usedPercent: number) {
  return {
    rateLimits: {
      limitId: 'codex',
      limitName: null,
      primary: { usedPercent, windowDurationMins: 300, resetsAt: 1_784_620_000 },
      secondary: null,
      credits: null,
      individualLimit: null,
      planType: 'pro',
      rateLimitReachedType: null,
    },
    rateLimitsByLimitId: null,
    rateLimitResetCredits: null,
  };
}

describe('Claude capacity adapter', () => {
  it('single-flights concurrent legacy refreshes into one fetch and one commit', async () => {
    vi.mocked(existsSync).mockReturnValue(true);
    vi.mocked(readFileSync).mockReturnValue(JSON.stringify({
      claudeAiOauth: { accessToken: 'redacted-test-token' },
    }) as never);
    let resolveFetch!: (response: Response) => void;
    const providerResult = new Promise<Response>((resolve) => { resolveFetch = resolve; });
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(() => providerResult);
    const send = vi.fn();
    vi.mocked(BrowserWindow.getAllWindows).mockReturnValue([{
      isDestroyed: () => false,
      webContents: { send },
    } as never]);
    const service = new ClaudeUsageServiceImpl();
    const commitSpy = vi.spyOn(
      service as unknown as { commitUsage: (usage: ClaudeUsageData) => void },
      'commitUsage',
    );

    try {
      const first = service.refresh();
      const second = service.refresh();
      expect(fetchMock).toHaveBeenCalledTimes(1);

      resolveFetch(new Response(JSON.stringify({
        five_hour: { utilization: 12, resets_at: '2026-07-19T17:00:00.000Z' },
        seven_day: { utilization: 40, resets_at: '2026-07-26T12:00:00.000Z' },
      }), { status: 200, headers: { 'Content-Type': 'application/json' } }));
      const [firstResult, secondResult] = await Promise.all([first, second]);

      expect(secondResult).toBe(firstResult);
      expect(service.getCachedUsage()).toBe(firstResult);
      expect(commitSpy).toHaveBeenCalledTimes(1);
      expect(BrowserWindow.getAllWindows).toHaveBeenCalledTimes(1);
      expect(send).toHaveBeenCalledTimes(1);
      expect(send).toHaveBeenCalledWith('claude-usage:update', firstResult);
      expect((service as unknown as { inflightRefresh: unknown }).inflightRefresh).toBeNull();
    } finally {
      fetchMock.mockRestore();
      vi.mocked(existsSync).mockReturnValue(false);
      vi.mocked(readFileSync).mockReset();
      vi.mocked(BrowserWindow.getAllWindows).mockReset();
      vi.mocked(BrowserWindow.getAllWindows).mockReturnValue([]);
    }
  });

  it('preserves five-hour, weekly, and model windows with provider resets', () => {
    const result = toClaudeCapacityObservation(claudeUsage({
      sevenDayOpus: { utilization: 100, resetsAt: '2026-07-25T12:00:00.000Z' },
    }), 'claude-code:claude-opus-4-1');

    expect(result).toMatchObject({
      observationState: 'ok',
      capacityState: 'exhausted',
      model: 'claude-code:claude-opus-4-1',
      observedAt: '2026-07-19T12:00:00.000Z',
      source: {
        kind: 'provider-response',
        confidence: 'high',
        collector: 'ClaudeUsageService',
        providerReported: true,
      },
    });
    expect(result.windows.map(({ id, state, resetAt }) => ({ id, state, resetAt }))).toEqual([
      { id: 'five-hour', state: 'available', resetAt: '2026-07-19T17:00:00.000Z' },
      { id: 'weekly', state: 'available', resetAt: '2026-07-26T12:00:00.000Z' },
      { id: 'weekly-opus', state: 'exhausted', resetAt: '2026-07-25T12:00:00.000Z' },
    ]);
  });

  it('does not let an exhausted Opus-only window block a requested Sonnet model', () => {
    const result = toClaudeCapacityObservation(claudeUsage({
      sevenDayOpus: { utilization: 100, resetsAt: '2026-07-25T12:00:00.000Z' },
    }), 'claude-code:sonnet');

    expect(result).toMatchObject({
      model: 'claude-code:sonnet',
      observationState: 'ok',
      capacityState: 'available',
    });
    expect(result.windows.map(({ id }) => id)).toEqual(['five-hour', 'weekly']);
  });

  it('keeps a true zero distinct from a missing utilization', () => {
    const result = toClaudeCapacityObservation(claudeUsage({
      fiveHour: { utilization: 0, resetsAt: null },
      sevenDay: { utilization: 0, utilizationReported: false, resetsAt: null },
    }));
    expect(result.windows[0]).toMatchObject({ usedRatio: 0, remainingRatio: 1, usedUnits: 0 });
    expect(result.windows[1]).toMatchObject({
      state: 'unknown',
      usedRatio: null,
      remainingRatio: null,
      usedUnits: null,
    });
  });

  it('turns malformed ratios into a redacted parse error and malformed resets into lower confidence', () => {
    const malformedRatio = toClaudeCapacityObservation(claudeUsage({
      fiveHour: { utilization: 101, resetsAt: null },
    }));
    expect(malformedRatio).toMatchObject({
      observationState: 'error',
      capacityState: 'unknown',
      error: { code: 'parse-error' },
    });

    const malformedReset = toClaudeCapacityObservation(claudeUsage({
      fiveHour: { utilization: 50, resetsAt: 'tomorrow-ish' },
    }));
    expect(malformedReset.source.confidence).toBe('medium');
    expect(malformedReset.windows[0].resetAt).toBeNull();
  });

  it.each([
    ['Authentication expired. Please re-login.', 'unavailable', 'auth-required'],
    ['Capacity source timed out after 5 seconds', 'error', 'timeout'],
    ['Usage is unsupported for this account', 'unsupported', 'unsupported'],
  ] as const)('maps %s without retaining raw text', (error, observationState, code) => {
    const result = toClaudeCapacityObservation(claudeUsage({ error }));
    expect(result).toMatchObject({ observationState, capacityState: 'unknown', error: { code } });
    expect(JSON.stringify(result)).not.toContain(error);
  });

  it('reports a missing integration as unavailable', () => {
    expect(toClaudeCapacityObservation(null)).toMatchObject({
      observationState: 'unavailable',
      error: { code: 'collector-unavailable' },
    });
  });
});

describe('Codex capacity adapter', () => {
  it('preserves an account-read auth failure when session fallback has no usage', async () => {
    vi.mocked(codexAuthService.getRateLimits).mockRejectedValueOnce(
      new Error('Authentication required token=private-token'),
    );

    const result = await codexUsageService.getCapacityObservation('gpt-5.3-codex');
    expect(result).toMatchObject({
      provider: 'openai-codex',
      model: 'openai-codex:gpt-5.3-codex',
      observationState: 'unavailable',
      capacityState: 'unknown',
      error: { code: 'auth-required', retryable: false },
    });
    expect(JSON.stringify(result)).not.toContain('private-token');
  });

  it('keeps only the newest overlapping refresh generation in the shared cache', async () => {
    let resolveOlder!: (value: ReturnType<typeof accountRateLimits>) => void;
    let resolveNewer!: (value: ReturnType<typeof accountRateLimits>) => void;
    const olderResponse = new Promise<ReturnType<typeof accountRateLimits>>((resolve) => {
      resolveOlder = resolve;
    });
    const newerResponse = new Promise<ReturnType<typeof accountRateLimits>>((resolve) => {
      resolveNewer = resolve;
    });
    vi.mocked(codexAuthService.getRateLimits)
      .mockImplementationOnce(() => olderResponse)
      .mockImplementationOnce(() => newerResponse);
    const service = new CodexUsageServiceImpl();

    const older = service.refresh();
    const newer = service.refresh();
    resolveNewer(accountRateLimits(10));
    await newer;
    resolveOlder(accountRateLimits(90));
    await older;

    expect(service.getCachedUsage()?.limits[0].windows[0].usedPercent).toBe(10);
  });

  it('does not cache or broadcast a delayed capacity read after its signal is aborted', async () => {
    vi.mocked(codexAuthService.getRateLimits).mockResolvedValueOnce(accountRateLimits(10));
    const service = new CodexUsageServiceImpl();
    await service.refresh();

    let resolveDelayed!: (value: ReturnType<typeof accountRateLimits>) => void;
    const delayedResponse = new Promise<ReturnType<typeof accountRateLimits>>((resolve) => {
      resolveDelayed = resolve;
    });
    vi.mocked(codexAuthService.getRateLimits).mockImplementationOnce(() => delayedResponse);
    vi.mocked(BrowserWindow.getAllWindows).mockClear();
    const controller = new AbortController();
    const capacity = service.getCapacityObservation('gpt-5.3-codex', controller.signal);
    controller.abort();
    resolveDelayed(accountRateLimits(90));

    await expect(capacity).rejects.toMatchObject({ name: 'AbortError' });
    expect(service.getCachedUsage()?.limits[0].windows[0].usedPercent).toBe(10);
    expect(BrowserWindow.getAllWindows).not.toHaveBeenCalled();
  });

  it('preserves distinct five-hour and weekly windows and exact true zero', () => {
    const usage = codexUsage();
    usage.limits[0].windows[0].usedPercent = 0;
    const result = toCodexCapacityObservation(usage);

    expect(result.observationState).toBe('ok');
    expect(result.capacityState).toBe('available');
    expect(result.windows.map(({ id }) => id)).toEqual(['five-hour', 'weekly']);
    expect(result.windows[0]).toMatchObject({ usedRatio: 0, remainingRatio: 1, usedUnits: 0 });
    expect(result.windows[1].resetAt).toBe('2026-07-26T12:00:00.000Z');
  });

  it('isolates requested model windows while retaining shared account constraints', () => {
    const fixture = codexUsage();
    fixture.limits.push(
      {
        id: 'healthy-model-bucket',
        name: 'GPT-5.3-Codex-Spark',
        planType: null,
        windows: [{
          slot: 'primary',
          usedPercent: 20,
          windowDurationMins: 300,
          resetsAt: '2026-07-19T17:00:00.000Z',
        }],
        credits: null,
        individualLimit: null,
        rateLimitReachedType: null,
      },
      {
        id: 'exhausted-other-model-bucket',
        name: 'GPT-5.3-Codex-Other',
        planType: null,
        windows: [{
          slot: 'primary',
          usedPercent: 100,
          windowDurationMins: 300,
          resetsAt: '2026-07-19T17:00:00.000Z',
        }],
        credits: null,
        individualLimit: null,
        rateLimitReachedType: 'primary',
      },
    );

    const result = toCodexCapacityObservation(fixture, 'openai-codex:gpt-5.3-codex-spark');
    expect(result).toMatchObject({
      model: 'openai-codex:gpt-5.3-codex-spark',
      observationState: 'ok',
      capacityState: 'available',
    });
    expect(result.windows.some(({ model }) => model === 'openai-codex:gpt-5.3-codex-other'))
      .toBe(false);
    expect(result.windows.some(({ model }) => model === 'openai-codex:gpt-5.3-codex-spark'))
      .toBe(true);
  });

  it('preserves a model-scoped window without exposing bucket, plan, credit, or token fields', () => {
    const fixture = codexUsage();
    fixture.limits[0].name = 'GPT-5.3-Codex-Spark';
    (fixture as CodexUsageData & Record<string, unknown>).accessToken = 'sk-secret';
    const result = toCodexCapacityObservation(fixture, 'openai-codex:GPT-5.3-Codex-Spark');
    const serialized = JSON.stringify(result);

    expect(result.windows.every(({ scope }) => scope === 'model')).toBe(true);
    expect(serialized).not.toContain('raw-account-bucket-id');
    expect(serialized).not.toContain('private-plan-name');
    expect(serialized).not.toContain('secret-balance');
    expect(serialized).not.toContain('sk-secret');
  });

  it('maps exact exhaustion and its reset, including a structured hard-limit receipt', () => {
    const fixture = codexUsage();
    fixture.limits[0].windows[0].usedPercent = 90;
    fixture.limits[0].rateLimitReachedType = 'primary';
    const result = toCodexCapacityObservation(fixture);

    expect(result).toMatchObject({
      observationState: 'ok',
      capacityState: 'exhausted',
      source: { kind: 'provider-error', confidence: 'high' },
    });
    expect(result.windows[0]).toMatchObject({
      state: 'exhausted',
      resetAt: '2026-07-19T17:00:00.000Z',
    });
    expect(result.windows[0].remainingRatio).toBeCloseTo(0.1);
  });

  it('keeps structured hard-limit exhaustion fail-closed when its ratio is malformed', () => {
    const fixture = codexUsage();
    fixture.limits[0].windows[0].usedPercent = Number.NaN;
    fixture.limits[0].rateLimitReachedType = 'primary';
    const result = toCodexCapacityObservation(fixture);

    expect(result).toMatchObject({
      observationState: 'ok',
      capacityState: 'exhausted',
      source: { kind: 'provider-error', confidence: 'low' },
      error: null,
    });
    expect(result.windows[0]).toMatchObject({
      state: 'exhausted',
      usedRatio: null,
      remainingRatio: null,
      usedUnits: null,
      remainingUnits: null,
    });
  });

  it('preserves a spend-control hard limit and exact individual reset', () => {
    const fixture = codexUsage();
    fixture.limits[0].windows = [];
    fixture.limits[0].spendControlReached = true;
    fixture.limits[0].individualLimit = {
      limit: 'private-limit',
      used: 'private-used',
      remainingPercent: 25,
      resetsAt: '2026-08-01T00:00:00.000Z',
    };
    const result = toCodexCapacityObservation(fixture);
    expect(result).toMatchObject({
      observationState: 'ok',
      capacityState: 'exhausted',
      source: { kind: 'provider-error' },
    });
    expect(result.windows[0]).toMatchObject({
      id: 'individual-limit',
      state: 'exhausted',
      resetAt: '2026-08-01T00:00:00.000Z',
    });
    expect(JSON.stringify(result)).not.toContain('private-limit');
    expect(JSON.stringify(result)).not.toContain('private-used');
  });

  it('keeps token-only success unsupported instead of synthesizing available capacity', () => {
    const result = toCodexCapacityObservation(codexUsage({
      limits: [],
      limitsAvailable: false,
      tokenUsage: { totalTokens: 123, lastTokens: 0 },
    }));
    expect(result).toMatchObject({
      observationState: 'unsupported',
      capacityState: 'unknown',
      windows: [],
    });
  });

  it.each([
    ['Authentication required for Codex', 'unavailable', 'auth-required'],
    ['Codex capacity read timed out', 'error', 'timeout'],
    ['This transport is not supported', 'unsupported', 'unsupported'],
  ] as const)('maps %s without retaining raw text', (error, observationState, code) => {
    const result = toCodexCapacityObservation(codexUsage({ error }));
    expect(result).toMatchObject({ observationState, capacityState: 'unknown', error: { code } });
    expect(JSON.stringify(result)).not.toContain(error);
  });

  it('makes malformed ratios a parse error while preserving null reset semantics', () => {
    const fixture = codexUsage();
    fixture.limits[0].windows[0].usedPercent = Number.NaN;
    fixture.limits[0].windows[1].resetsAt = null;
    const result = toCodexCapacityObservation(fixture);
    expect(result).toMatchObject({ observationState: 'error', error: { code: 'parse-error' } });
    expect(result.windows[0].usedRatio).toBeNull();
    expect(result.windows[1].resetAt).toBeNull();
  });

  it('reports a missing integration as unavailable', () => {
    expect(toCodexCapacityObservation(null)).toMatchObject({
      observationState: 'unavailable',
      error: { code: 'collector-unavailable' },
    });
  });
});

describe('Gemini capacity adapter', () => {
  it('preserves only the requested model window instead of collapsing provider evidence', () => {
    const result = toGeminiCapacityObservation(geminiUsage(), 'gemini-cli:gemini-pro');
    expect(result).toMatchObject({
      observationState: 'ok',
      capacityState: 'limited',
      model: 'gemini-cli:gemini-pro',
      source: {
        kind: 'provider-response',
        confidence: 'high',
        collector: 'GeminiUsageService',
        providerReported: true,
      },
    });
    expect(result.windows.map(({ id, remainingRatio, resetAt }) => ({ id, remainingRatio, resetAt })))
      .toEqual([
        { id: 'model:gemini-pro', remainingRatio: 0.1, resetAt: '2026-07-19T17:00:00.000Z' },
      ]);
  });

  it('does not let an exhausted Gemini model block a healthy requested sibling', () => {
    const result = toGeminiCapacityObservation(geminiUsage({
      modelQuotas: [
        { model: 'gemini-pro', remainingFraction: 0, resetTime: '2026-07-19T17:00:00.000Z' },
        { model: 'gemini-flash', remainingFraction: 0.75, resetTime: '2026-07-19T18:00:00.000Z' },
      ],
    }), 'gemini-flash');

    expect(result).toMatchObject({
      model: 'gemini-cli:gemini-flash',
      observationState: 'ok',
      capacityState: 'available',
    });
    expect(result.windows.map(({ model }) => model)).toEqual(['gemini-cli:gemini-flash']);
  });

  it('keeps true zero as exhausted and missing remaining quota as unknown', () => {
    const zero = toGeminiCapacityObservation(geminiUsage({
      modelQuotas: [
        { model: 'zero', remainingFraction: 0, resetTime: null },
        { model: 'missing', remainingFraction: null, resetTime: null },
      ],
    }), 'zero');
    const missing = toGeminiCapacityObservation(geminiUsage({
      modelQuotas: [
        { model: 'zero', remainingFraction: 0, resetTime: null },
        { model: 'missing', remainingFraction: null, resetTime: null },
      ],
    }), 'missing');
    expect(zero.capacityState).toBe('exhausted');
    expect(zero.windows[0]).toMatchObject({ state: 'exhausted', remainingRatio: 0, usedRatio: 1 });
    expect(missing.capacityState).toBe('unknown');
    expect(missing.windows[0]).toMatchObject({ state: 'unknown', remainingRatio: null, usedRatio: null });
  });

  it('rejects malformed ratios and lowers confidence for malformed timestamps', () => {
    const malformedRatio = toGeminiCapacityObservation(geminiUsage({
      modelQuotas: [{ model: 'bad', remainingFraction: -0.1, resetTime: null }],
    }), 'bad');
    expect(malformedRatio).toMatchObject({
      observationState: 'error',
      capacityState: 'unknown',
      error: { code: 'parse-error' },
    });

    const malformedReset = toGeminiCapacityObservation(geminiUsage({
      modelQuotas: [{ model: 'valid', remainingFraction: 0.5, resetTime: 'soon' }],
    }), 'valid');
    expect(malformedReset.source.confidence).toBe('medium');
    expect(malformedReset.windows[0].resetAt).toBeNull();
  });

  it.each([
    ['Authentication required', false, 'unavailable', 'auth-required'],
    ['Backend not started', true, 'unavailable', 'collector-unavailable'],
    ['RPC timed out with private details', false, 'error', 'timeout'],
    ['Capacity is unsupported', false, 'unsupported', 'unsupported'],
  ] as const)('maps %s without retaining raw text', (error, notStarted, observationState, code) => {
    const result = toGeminiCapacityObservation(geminiUsage({
      available: false,
      limitsAvailable: false,
      error,
      notStarted,
    }));
    expect(result).toMatchObject({ observationState, capacityState: 'unknown', error: { code } });
    expect(JSON.stringify(result)).not.toContain(error);
  });

  it('drops account and arbitrary fixture fields from normalized output', () => {
    const fixture = geminiUsage() as GeminiUsageData & Record<string, unknown>;
    fixture.account = { email: 'user@example.com', planName: 'private-plan' };
    fixture.accessToken = 'secret-token';
    const serialized = JSON.stringify(toGeminiCapacityObservation(fixture));
    expect(serialized).not.toContain('user@example.com');
    expect(serialized).not.toContain('private-plan');
    expect(serialized).not.toContain('secret-token');
  });

  it('reports a missing integration and an empty supported payload explicitly', () => {
    expect(toGeminiCapacityObservation(null)).toMatchObject({
      observationState: 'unavailable',
      error: { code: 'collector-unavailable' },
    });
    expect(toGeminiCapacityObservation(geminiUsage({ modelQuotas: [], limitsAvailable: false })))
      .toMatchObject({ observationState: 'unsupported', error: { code: 'unsupported' } });
  });
});

describe('redacted raw-boundary preflight fixtures', () => {
  it('does not let a malformed unfiltered model bucket poison a healthy sibling view', async () => {
    const service = new ProviderCapacityService({
      collectors: {
        'gemini-cli': async ({ model }) => toGeminiCapacityObservation(geminiUsage({
          modelQuotas: [
            {
              model: 'gemini-pro',
              remainingFraction: Number.NaN,
              remainingFractionMalformed: true,
              resetTime: null,
            },
            {
              model: 'gemini-flash',
              remainingFraction: 0.75,
              resetTime: '2026-07-19T18:00:00.000Z',
            },
          ],
        }), model),
      },
      now: () => OBSERVED_AT,
    });

    await expect(service.preflight({
      provider: 'gemini-cli',
      model: 'gemini-flash',
    })).resolves.toMatchObject({
      verdict: 'allow',
      reason: 'fresh-capacity',
      snapshot: {
        observationState: 'ok',
        capacityState: 'available',
        windows: [{ model: 'gemini-cli:gemini-flash' }],
      },
    });
  });

  it('keeps Claude raw zero-plus-missing evidence indeterminate under both policies', async () => {
    const raw = {
      five_hour: {
        utilization: 0,
        resets_at: '2026-07-19T17:00:00.000Z',
        bearer_token: 'claude-secret-token',
      },
      seven_day: {
        resets_at: '2026-07-26T12:00:00.000Z',
        email: 'private@example.com',
      },
      organization_id: 'private-org',
    };
    const service = new ProviderCapacityService({
      collectors: {
        'claude-code': async ({ model }) => toClaudeCapacityObservation(
          convertClaudeUsageResponse(raw, OBSERVED_AT),
          model,
        ),
      },
      now: () => OBSERVED_AT,
    });

    const bestEffort = await service.preflight({
      provider: 'claude-code',
      model: 'claude-code:sonnet',
    });
    const strict = await service.preflight(
      { provider: 'claude-code', model: 'claude-code:sonnet' },
      { policy: 'require-fresh' },
    );
    expect(bestEffort).toMatchObject({
      verdict: 'indeterminate',
      reason: 'no-capacity-evidence',
      snapshot: {
        model: 'claude-code:sonnet',
        observationState: 'ok',
        capacityState: 'unknown',
      },
    });
    expect(strict.verdict).toBe('block');
    expect(JSON.stringify(bestEffort)).not.toMatch(/claude-secret-token|private@example.com|private-org/);
  });

  it('keeps a malformed Codex raw ratio blocked when a structured hard limit is explicit', async () => {
    const raw = {
      rateLimits: {
        limitId: 'private-bucket-id',
        limitName: 'GPT-5.3-Codex-Spark',
        primary: {
          usedPercent: 'not-a-number',
          windowDurationMins: 300,
          resetsAt: (OBSERVED_AT + 60 * 60 * 1_000) / 1_000,
        },
        secondary: null,
        credits: { balance: 'private-balance' },
        individualLimit: null,
        planType: 'private-plan',
        rateLimitReachedType: 'primary',
        accountEmail: 'codex@example.com',
      },
      rateLimitsByLimitId: null,
      rateLimitResetCredits: null,
      accessToken: 'codex-secret-token',
    };
    const service = new ProviderCapacityService({
      collectors: {
        'openai-codex': async ({ model }) => toCodexCapacityObservation(
          convertAccountRateLimitsResponse(raw as never, OBSERVED_AT),
          model,
        ),
      },
      now: () => OBSERVED_AT,
    });

    const decision = await service.preflight({
      provider: 'openai-codex',
      model: 'openai-codex:gpt-5.3-codex-spark',
    });
    expect(decision).toMatchObject({
      verdict: 'block',
      reason: 'known-hard-limit-until-reset',
      snapshot: {
        model: 'openai-codex:gpt-5.3-codex-spark',
        observationState: 'ok',
        capacityState: 'exhausted',
        source: { kind: 'provider-error', confidence: 'low' },
      },
    });
    expect(decision.snapshot.windows[0]).toMatchObject({
      usedRatio: null,
      remainingRatio: null,
    });
    expect(JSON.stringify(decision)).not.toMatch(
      /private-bucket-id|private-balance|private-plan|codex@example.com|codex-secret-token/,
    );
  });

  it('converts a redacted Codex JSONL rate-limit block without reading session files', async () => {
    const raw = {
      limit_id: 'private-session-bucket',
      primary: {
        used_percent: 0,
        window_minutes: 300,
        resets_at: (OBSERVED_AT + 60 * 60 * 1_000) / 1_000,
      },
      raw_headers: { authorization: 'codex-session-secret' },
    } as unknown as CodexRateLimits;
    const service = new ProviderCapacityService({
      collectors: {
        'openai-codex': async ({ model }) => toCodexCapacityObservation(
          convertCodexSessionRateLimits(raw, OBSERVED_AT),
          model,
        ),
      },
      now: () => OBSERVED_AT,
    });

    const decision = await service.preflight({
      provider: 'openai-codex',
      model: 'openai-codex:gpt-5.3-codex-spark',
    });
    expect(decision).toMatchObject({
      verdict: 'allow',
      reason: 'fresh-capacity',
      snapshot: { source: { kind: 'provider-cli' } },
    });
    expect(JSON.stringify(decision)).not.toMatch(/private-session-bucket|codex-session-secret/);
  });

  it('turns malformed Gemini raw fields into a redacted error for only the requested model', async () => {
    const raw = {
      account: {
        email: 'gemini@example.com',
        planName: 'private-plan',
      },
      models: {
        flash: {
          model: 'gemini-flash',
          remainingFraction: 'not-a-ratio',
          resetTime: 12345,
          accessToken: 'gemini-secret-token',
        },
        pro: {
          model: 'gemini-pro',
          remainingFraction: 0,
          resetTime: '2026-07-19T17:00:00.000Z',
        },
      },
      warn: true,
    };
    const service = new ProviderCapacityService({
      collectors: {
        'gemini-cli': async ({ model }) => toGeminiCapacityObservation(
          convertGeminiUsageSnapshot(raw, OBSERVED_AT),
          model,
        ),
      },
      now: () => OBSERVED_AT,
    });

    const decision = await service.preflight({
      provider: 'gemini-cli',
      model: 'gemini-cli:gemini-flash',
    });
    expect(decision).toMatchObject({
      verdict: 'indeterminate',
      reason: 'observation-error',
      snapshot: {
        model: 'gemini-cli:gemini-flash',
        observationState: 'error',
        capacityState: 'unknown',
        error: { code: 'parse-error' },
      },
    });
    expect(decision.snapshot.windows.map(({ model }) => model))
      .toEqual(['gemini-cli:gemini-flash']);
    expect(JSON.stringify(decision)).not.toMatch(
      /gemini@example.com|private-plan|gemini-secret-token/,
    );
  });
});
