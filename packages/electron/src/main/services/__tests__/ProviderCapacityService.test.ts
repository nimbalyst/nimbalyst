import { describe, expect, it, vi } from 'vitest';

vi.mock('../ClaudeUsageService', () => ({
  claudeUsageService: { getCapacityObservation: vi.fn() },
}));
vi.mock('../CodexUsageService', () => ({
  codexUsageService: { getCapacityObservation: vi.fn() },
}));
vi.mock('../GeminiUsageService', () => ({
  geminiUsageService: { getCapacityObservation: vi.fn() },
}));

import {
  ProviderCapacityService,
  type ProviderCapacityCollector,
  type ProviderCapacityCollectorRequest,
} from '../ProviderCapacityService';
import { claudeUsageService } from '../ClaudeUsageService';
import { codexUsageService } from '../CodexUsageService';
import { geminiUsageService } from '../GeminiUsageService';
import {
  decideProviderCapacity,
  type CapacityState,
  type CapacityWindow,
  type ObservationState,
  type ProviderCapacityObservation,
  type ProviderCapacitySnapshotV1,
} from '../provider-capacity-types';

const START = Date.parse('2026-07-19T12:00:00.000Z');

function window(
  state: CapacityState,
  resetAt: string | null = '2026-07-19T17:00:00.000Z',
): CapacityWindow {
  const remainingRatio = state === 'exhausted' ? 0 : state === 'limited' ? 0.1 : state === 'available' ? 0.8 : null;
  return {
    id: 'five-hour',
    scope: 'account',
    state,
    usedRatio: remainingRatio === null ? null : 1 - remainingRatio,
    remainingRatio,
    usedUnits: null,
    remainingUnits: null,
    unit: 'percent',
    resetAt,
    resetConfidence: resetAt ? 'provider-reported' : 'unknown',
  };
}

function observation(
  capacityState: CapacityState = 'available',
  overrides: Partial<ProviderCapacityObservation> = {},
): ProviderCapacityObservation {
  return {
    provider: 'claude-code',
    observationState: 'ok',
    capacityState,
    observedAt: new Date(START).toISOString(),
    source: {
      kind: 'provider-response',
      confidence: 'high',
      collector: 'ClaudeUsageService',
      providerReported: true,
    },
    windows: [window(capacityState)],
    error: null,
    ...overrides,
  };
}

function serviceWith(
  collector: ProviderCapacityCollector,
  getNow: () => number,
): ProviderCapacityService {
  return new ProviderCapacityService({
    collectors: { 'claude-code': collector },
    now: getNow,
    freshness: {
      'claude-code': { staleAfterMs: 1_000, expireAfterMs: 2_000 },
    },
  });
}

describe('ProviderCapacityService cache and freshness', () => {
  it('keeps provider windows distinct and preserves the original observation on a cache hit', async () => {
    let now = START;
    const collector = vi.fn(async () => observation('limited', {
      windows: [
        window('limited', '2026-07-19T17:00:00.000Z'),
        { ...window('available', '2026-07-26T12:00:00.000Z'), id: 'weekly' },
      ],
    }));
    const service = serviceWith(collector, () => now);

    const collected = await service.getCapacity({ provider: 'claude-code' });
    now += 500;
    const cached = await service.getCapacity({ provider: 'claude-code' });

    expect(collector).toHaveBeenCalledTimes(1);
    expect(cached.windows.map(({ id }) => id)).toEqual(['five-hour', 'weekly']);
    expect(cached.observedAt).toBe(collected.observedAt);
    expect(cached.receivedAt).toBe(collected.receivedAt);
    expect(cached.source).toEqual(collected.source);
    expect(collected.cache.hit).toBe(false);
    expect(cached.cache.hit).toBe(true);
    expect(cached.freshness.ageMs).toBe(500);
  });

  it('filters model-scoped evidence to the normalized requested model', async () => {
    const service = serviceWith(async () => observation('exhausted', {
      windows: [
        window('available'),
        {
          ...window('exhausted'),
          id: 'model-a',
          scope: 'model',
          model: 'claude-code:opus',
        },
        {
          ...window('available'),
          id: 'model-b',
          scope: 'model',
          model: 'claude-code:sonnet',
        },
      ],
    }), () => START);

    const snapshot = await service.getCapacity({
      provider: 'claude-code',
      model: 'SONNET',
    });
    expect(snapshot).toMatchObject({
      model: 'claude-code:sonnet',
      capacityState: 'available',
    });
    expect(snapshot.windows.map(({ id }) => id)).toEqual(['five-hour', 'model-b']);
  });

  it('shares one provider-scope refresh across concurrent model-filtered views', async () => {
    let release!: () => void;
    const pending = new Promise<void>((resolve) => { release = resolve; });
    let collectedRequest: ProviderCapacityCollectorRequest | null = null;
    const collector = vi.fn(async (request: ProviderCapacityCollectorRequest) => {
      collectedRequest = request;
      await pending;
      return observation('exhausted', {
        windows: [
          window('available'),
          {
            ...window('exhausted'),
            id: 'opus',
            scope: 'model',
            model: 'claude-code:opus',
          },
          {
            ...window('available'),
            id: 'sonnet',
            scope: 'model',
            model: 'claude-code:sonnet',
          },
        ],
      });
    });
    const service = serviceWith(collector, () => START);

    const opus = service.getCapacity({
      provider: 'claude-code',
      model: 'opus',
      scopeKey: 'profile-a',
      refresh: true,
    });
    const sonnet = service.getCapacity({
      provider: 'claude-code',
      model: 'sonnet',
      scopeKey: 'profile-a',
      refresh: true,
    });
    await Promise.resolve();
    expect(collector).toHaveBeenCalledTimes(1);
    expect(collectedRequest).toMatchObject({ model: undefined, scopeKey: 'profile-a' });
    release();

    await expect(opus).resolves.toMatchObject({
      model: 'claude-code:opus',
      capacityState: 'exhausted',
    });
    await expect(sonnet).resolves.toMatchObject({
      model: 'claude-code:sonnet',
      capacityState: 'available',
    });
  });

  it('invalidates every model view when an account-wide hard limit is recorded', async () => {
    const service = serviceWith(async () => observation('available'), () => START);
    await service.getCapacity({ provider: 'claude-code', model: 'opus', scopeKey: 'profile-a' });
    await expect(service.getCapacity({
      provider: 'claude-code',
      model: 'sonnet',
      scopeKey: 'profile-a',
    })).resolves.toMatchObject({ capacityState: 'available' });

    service.recordObservation(observation('exhausted', {
      source: {
        kind: 'provider-error',
        confidence: 'high',
        collector: 'ClaudeUsageService',
        providerReported: true,
      },
      windows: [window('exhausted')],
    }), 'profile-a');

    await expect(service.getCapacity({
      provider: 'claude-code',
      model: 'sonnet',
      scopeKey: 'profile-a',
    })).resolves.toMatchObject({
      model: 'claude-code:sonnet',
      capacityState: 'exhausted',
      source: { kind: 'provider-error' },
      cache: { hit: true },
    });
  });

  it('moves fresh to stale to expired using only the injected clock', async () => {
    let now = START;
    const service = serviceWith(async () => observation(), () => now);

    expect((await service.getCapacity({ provider: 'claude-code' })).freshness.state).toBe('fresh');
    now += 1_000;
    expect((await service.getCapacity({ provider: 'claude-code' })).freshness.state).toBe('stale');
    now += 1_000;
    expect((await service.getCapacity({ provider: 'claude-code' })).freshness.state).toBe('expired');
  });

  it('lets a shorter provider validity interval shorten freshness', async () => {
    let now = START;
    const service = serviceWith(async () => observation('available', { validForMs: 250 }), () => now);
    await service.getCapacity({ provider: 'claude-code' });
    now += 250;
    const cached = await service.getCapacity({ provider: 'claude-code' });
    expect(cached.freshness.state).toBe('stale');
    expect(cached.freshness.staleAfterMs).toBe(250);
  });

  it('expires an exhausted constraint when its reset is crossed without synthesizing availability', async () => {
    let now = START;
    const resetAt = new Date(START + 500).toISOString();
    const service = serviceWith(async () => observation('exhausted', {
      windows: [window('exhausted', resetAt)],
    }), () => now);
    await service.getCapacity({ provider: 'claude-code' });
    now += 500;

    const cached = await service.getCapacity({ provider: 'claude-code' });
    expect(cached.freshness.state).toBe('expired');
    expect(cached.capacityState).toBe('exhausted');
    expect(cached.effectiveResetAt).toBeNull();
  });

  it.each([
    ['clock rollback', new Date(START).toISOString(), START - 1],
    ['invalid observedAt', 'not-a-time', START],
  ])('reports unknown freshness for %s', async (_name, observedAt, current) => {
    let now = START;
    const service = serviceWith(async () => observation('available', { observedAt }), () => now);
    await service.getCapacity({ provider: 'claude-code' });
    now = current;
    const cached = await service.getCapacity({ provider: 'claude-code' });
    expect(cached.freshness).toEqual({
      state: 'unknown',
      ageMs: null,
      staleAfterMs: null,
      expiresAt: null,
    });
  });

  it('permanently rejects an observation timestamp later than its receipt', async () => {
    let now = START;
    const service = serviceWith(async () => observation('available', {
      observedAt: new Date(START + 500).toISOString(),
    }), () => now);

    expect((await service.getCapacity({ provider: 'claude-code' })).freshness.state).toBe('unknown');
    now = START + 500;
    expect((await service.getCapacity({ provider: 'claude-code' })).freshness.state).toBe('unknown');
  });

  it('selects the earliest future reset among currently constraining windows', async () => {
    const service = serviceWith(async () => observation('limited', {
      windows: [
        { ...window('limited', '2026-07-20T12:00:00.000Z'), id: 'weekly' },
        window('exhausted', '2026-07-19T17:00:00.000Z'),
        { ...window('available', '2026-07-19T13:00:00.000Z'), id: 'healthy' },
      ],
    }), () => START);
    const snapshot = await service.getCapacity({ provider: 'claude-code' });
    expect(snapshot.effectiveResetAt).toBe('2026-07-19T17:00:00.000Z');
  });

  it('single-flights concurrent refreshes only within the same internal scope', async () => {
    let release!: () => void;
    const pending = new Promise<void>((resolve) => { release = resolve; });
    const collector = vi.fn(async () => {
      await pending;
      return observation();
    });
    const service = serviceWith(collector, () => START);

    const sameScope = Array.from({ length: 4 }, () => service.getCapacity({
      provider: 'claude-code',
      scopeKey: 'profile-a',
      refresh: true,
    }));
    const otherScope = service.getCapacity({
      provider: 'claude-code',
      scopeKey: 'profile-b',
      refresh: true,
    });
    await Promise.resolve();
    expect(collector).toHaveBeenCalledTimes(2);
    release();
    await Promise.all([...sameScope, otherScope]);
  });

  it('aborts a timed-out collector, releases single-flight, and permits a later refresh', async () => {
    let timeoutCallback: (() => void) | null = null;
    const firstSignal = { current: null as AbortSignal | null };
    let calls = 0;
    const collector = vi.fn((request: { signal: AbortSignal }) => {
      calls += 1;
      if (calls === 1) {
        firstSignal.current = request.signal;
        return new Promise<ProviderCapacityObservation>(() => {});
      }
      return Promise.resolve(observation('available'));
    });
    const service = new ProviderCapacityService({
      collectors: { 'claude-code': collector },
      now: () => START,
      collectorTimeoutMs: 25,
      scheduleTimeout: (callback) => {
        timeoutCallback = callback;
        return 1 as unknown as ReturnType<typeof setTimeout>;
      },
      cancelTimeout: vi.fn(),
    });

    const timedOutPromise = service.getCapacity({ provider: 'claude-code', refresh: true });
    await Promise.resolve();
    await Promise.resolve();
    expect(timeoutCallback).not.toBeNull();
    timeoutCallback!();

    const timedOut = await timedOutPromise;
    expect(firstSignal.current?.aborted).toBe(true);
    expect(timedOut).toMatchObject({
      observationState: 'error',
      capacityState: 'unknown',
      error: {
        code: 'timeout',
        retryable: true,
        redactedMessage: 'The provider capacity observation timed out.',
      },
    });

    const recovered = await service.getCapacity({ provider: 'claude-code', refresh: true });
    expect(collector).toHaveBeenCalledTimes(2);
    expect(recovered).toMatchObject({ observationState: 'ok', capacityState: 'available' });
  });

  it('does not expose the internal scope key or thrown collector details', async () => {
    const collector = vi.fn(async () => {
      throw new Error('Bearer sk-secret account=user@example.com C:\\private');
    });
    const service = serviceWith(collector, () => START);
    const snapshot = await service.getCapacity({
      provider: 'claude-code',
      scopeKey: 'private-profile-fingerprint',
    });
    const serialized = JSON.stringify(snapshot);

    expect(snapshot.observationState).toBe('error');
    expect(snapshot.capacityState).toBe('unknown');
    expect(snapshot.error?.redactedMessage).toBe('The provider capacity observation failed.');
    expect(serialized).not.toContain('sk-secret');
    expect(serialized).not.toContain('user@example.com');
    expect(serialized).not.toContain('private-profile-fingerprint');
  });

  it('does not let a completed older refresh overwrite a newer recorded observation', async () => {
    let resolveOld!: (value: ProviderCapacityObservation) => void;
    const collector = vi.fn(() => new Promise<ProviderCapacityObservation>((resolve) => {
      resolveOld = resolve;
    }));
    const service = serviceWith(collector, () => START);
    const oldRefresh = service.getCapacity({ provider: 'claude-code', refresh: true });
    await Promise.resolve();

    service.recordObservation(observation('available', {
      observedAt: new Date(START + 100).toISOString(),
    }));
    resolveOld(observation('unknown', {
      observationState: 'error',
      error: { code: 'timeout', retryable: true },
    }));

    const result = await oldRefresh;
    expect(result.observationState).toBe('ok');
    expect(result.capacityState).toBe('available');
    expect(result.observedAt).toBe(new Date(START + 100).toISOString());
  });

  it('returns an explicit unsupported snapshot when no collector is registered', async () => {
    const service = new ProviderCapacityService({ collectors: {}, now: () => START });
    const snapshot = await service.getCapacity({ provider: 'future-provider' });
    expect(snapshot).toMatchObject({
      provider: 'future-provider',
      observationState: 'unsupported',
      capacityState: 'unknown',
      source: { kind: 'unsupported', collector: 'none', providerReported: false },
      error: { code: 'unsupported', retryable: false },
    });
  });

  it.each(['constructor', 'toString'])('treats prototype provider id %s as unsupported', async (provider) => {
    const service = new ProviderCapacityService({ collectors: {}, now: () => START });
    await expect(service.getCapacity({ provider })).resolves.toMatchObject({
      provider,
      observationState: 'unsupported',
      capacityState: 'unknown',
      error: { code: 'unsupported' },
    });
  });

  it('passes the orchestration signal to every default collector without a model filter', async () => {
    vi.mocked(claudeUsageService.getCapacityObservation).mockResolvedValueOnce(observation());
    vi.mocked(codexUsageService.getCapacityObservation).mockResolvedValueOnce(observation('available', {
      provider: 'openai-codex',
      source: {
        kind: 'provider-cli',
        confidence: 'high',
        collector: 'CodexUsageService',
        providerReported: true,
      },
    }));
    vi.mocked(geminiUsageService.getCapacityObservation).mockResolvedValueOnce(observation('available', {
      provider: 'gemini-cli',
      source: {
        kind: 'provider-response',
        confidence: 'high',
        collector: 'GeminiUsageService',
        providerReported: true,
      },
    }));

    const service = new ProviderCapacityService({ now: () => START });
    await service.getCapacity({ provider: 'claude-code', model: 'opus' });
    await service.getCapacity({ provider: 'openai-codex', model: 'gpt-5.3-codex' });
    await service.getCapacity({ provider: 'gemini-cli', model: 'gemini-pro' });

    expect(claudeUsageService.getCapacityObservation)
      .toHaveBeenCalledWith(undefined, expect.any(AbortSignal));
    expect(codexUsageService.getCapacityObservation)
      .toHaveBeenCalledWith(undefined, expect.any(AbortSignal));
    expect(geminiUsageService.getCapacityObservation)
      .toHaveBeenCalledWith(undefined, expect.any(AbortSignal));
  });

  it('enforces the non-ok schema invariant', async () => {
    const states: ObservationState[] = ['unsupported', 'unavailable', 'error'];
    for (const observationState of states) {
      const service = serviceWith(async () => observation('available', {
        observationState,
        error: null,
      }), () => START);
      const snapshot = await service.getCapacity({ provider: 'claude-code' });
      expect(snapshot.capacityState).toBe('unknown');
      expect(snapshot.error).not.toBeNull();
    }
  });

  it('replaces caller-supplied error text with the fixed redacted catalog', () => {
    const service = serviceWith(async () => observation(), () => START);
    const snapshot = service.recordObservation(observation('unknown', {
      observationState: 'error',
      error: {
        code: 'timeout',
        retryable: true,
        redactedMessage: 'Bearer secret user@example.com',
      },
    }));
    expect(snapshot.error).toEqual({
      code: 'timeout',
      retryable: true,
      redactedMessage: 'The provider capacity observation timed out.',
    });
  });
});

describe('deterministic capacity preflight', () => {
  function snapshot(
    capacityState: CapacityState,
    freshness: ProviderCapacitySnapshotV1['freshness']['state'] = 'fresh',
    resetAt: string | null = '2026-07-19T17:00:00.000Z',
  ): ProviderCapacitySnapshotV1 {
    return {
      schemaVersion: 1,
      provider: 'claude-code',
      observationState: 'ok',
      capacityState,
      observedAt: new Date(START).toISOString(),
      receivedAt: new Date(START).toISOString(),
      freshness: { state: freshness, ageMs: 0, staleAfterMs: 1_000, expiresAt: null },
      source: {
        kind: 'provider-response',
        confidence: 'high',
        collector: 'ClaudeUsageService',
        providerReported: true,
      },
      windows: [window(capacityState, resetAt)],
      effectiveResetAt: resetAt,
      error: null,
      cache: { hit: false },
    };
  }

  it.each([
    ['available', false, 'allow', 'fresh-capacity'],
    ['limited', false, 'allow', 'fresh-limited'],
    ['limited', true, 'avoid', 'fresh-limited'],
    ['exhausted', false, 'block', 'known-hard-limit-until-reset'],
  ] as const)('routes fresh %s deterministically', (state, healthier, verdict, reason) => {
    expect(decideProviderCapacity(snapshot(state), { healthierAlternativeAvailable: healthier }))
      .toMatchObject({ verdict, reason });
  });

  it('makes an applicable unknown window dominate an available sibling under both policies', async () => {
    const service = serviceWith(async () => observation('available', {
      windows: [
        window('available'),
        { ...window('unknown'), id: 'weekly', resetAt: null, resetConfidence: 'unknown' },
      ],
    }), () => START);

    const bestEffort = await service.preflight({ provider: 'claude-code' });
    const strict = await service.preflight(
      { provider: 'claude-code' },
      { policy: 'require-fresh' },
    );
    expect(bestEffort).toMatchObject({
      verdict: 'indeterminate',
      reason: 'no-capacity-evidence',
      snapshot: { capacityState: 'unknown' },
    });
    expect(strict).toMatchObject({
      verdict: 'block',
      reason: 'no-capacity-evidence',
      snapshot: { capacityState: 'unknown' },
    });
  });

  it('ignores unknown evidence only when the provider marks it non-constraining', async () => {
    const service = serviceWith(async () => observation('available', {
      windows: [
        window('available'),
        {
          ...window('unknown'),
          id: 'informational',
          routingRelevant: false,
          resetAt: null,
          resetConfidence: 'unknown',
        },
      ],
    }), () => START);

    await expect(service.preflight({ provider: 'claude-code' })).resolves.toMatchObject({
      verdict: 'allow',
      reason: 'fresh-capacity',
      snapshot: { capacityState: 'available' },
    });
  });

  it('keeps a derived reset for display but never routes or retries from it', async () => {
    let now = START;
    const derivedReset = new Date(START + 500).toISOString();
    const service = serviceWith(async () => observation('exhausted', {
      windows: [{
        ...window('exhausted', derivedReset),
        resetConfidence: 'derived',
      }],
    }), () => now);
    await service.getCapacity({ provider: 'claude-code' });
    now += 500;
    const decision = await service.preflight({ provider: 'claude-code' });
    expect(decision.snapshot.windows[0].resetAt).toBe(derivedReset);
    expect(decision).toMatchObject({
      verdict: 'block',
      reason: 'known-hard-limit',
      retryAt: null,
      snapshot: {
        freshness: { state: 'fresh' },
        effectiveResetAt: null,
      },
    });
  });

  it('blocks exhausted capacity without inventing a retry time', () => {
    expect(decideProviderCapacity(snapshot('exhausted', 'fresh', null))).toMatchObject({
      verdict: 'block',
      reason: 'known-hard-limit',
      retryAt: null,
    });
  });

  it.each([
    ['exhausted', 'stale', 'defer'],
    ['exhausted', 'expired', 'defer'],
    ['available', 'stale', 'indeterminate'],
    ['limited', 'expired', 'indeterminate'],
    ['available', 'unknown', 'indeterminate'],
  ] as const)('does not preserve a fresh verdict for %s/%s', (state, freshness, verdict) => {
    expect(decideProviderCapacity(snapshot(state, freshness)).verdict).toBe(verdict);
  });

  it('strict policy blocks stale exhausted evidence', () => {
    expect(decideProviderCapacity(snapshot('exhausted', 'stale'), { policy: 'require-fresh' }))
      .toMatchObject({ verdict: 'block', reason: 'stale-observation' });
  });

  it('becomes indeterminate after an exhausted reset has passed', () => {
    const value = snapshot('exhausted', 'expired', null);
    expect(decideProviderCapacity(value)).toMatchObject({
      verdict: 'indeterminate',
      reason: 'stale-observation',
      retryAt: null,
    });
  });

  it.each([
    ['unsupported', 'unsupported-source'],
    ['unavailable', 'provider-unavailable'],
    ['error', 'observation-error'],
  ] as const)('maps %s observations to an honest reason', (observationState, reason) => {
    const value = snapshot('unknown');
    value.observationState = observationState;
    value.error = { code: 'unknown', retryable: false };
    expect(decideProviderCapacity(value)).toMatchObject({ verdict: 'indeterminate', reason });
    expect(decideProviderCapacity(value, { policy: 'require-fresh' })).toMatchObject({
      verdict: 'block',
      reason,
    });
  });

  it('treats a successful-turn-shaped observation without quota fields as no capacity evidence', () => {
    const value = snapshot('unknown');
    value.windows = [];
    expect(decideProviderCapacity(value)).toMatchObject({
      verdict: 'indeterminate',
      reason: 'no-capacity-evidence',
    });
  });
});
